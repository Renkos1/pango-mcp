"""Pango (Logos2 / PANGO200) headless FLA capture, layered on the proven
MpsseJtag transport (mpsse_jtag.py).

Transport status: PROVEN on hardware (IDCODE 0x10603899 via both default-DR and
shift_ir+read_dr, 10/10). The MPSSE byte-mode 2-byte-length bug is fixed there.

FLA recipe: the vendor's PANGO200 JTAG-FLA access sequence (command steps
0..36), expressed here on shift_ir / write_dr / read_dr. Register/IR map:
  IR 0x283  : scan / pre-amble instruction
  IR 0x286  : FLA main register-access instruction (most config rides on this)
  IR 0x14c / 0x284 / 0x159 / 0x000 : readback + teardown instructions
  DR 0x037/0x036/0x034/0x035/0x030/0x032 : FLA config sub-registers
  DR 0x038  : status register; capture is ready when TDO[31:29] == 0b010
Derived sizes (from the vendor FLA register-width definitions):
  capture_len  = width*3 + 1
  padding_bits = runtime-detected           # PDS storage/JTAG protocol lanes
  sample_stride= width + padding_bits
  all_data_len = sample_stride*depth + 6    # full sample buffer, in BITS
  depth_len    = log2(depth) + 6            # trig-position field width
  trig_position= depth                      # default (end-trigger); tunable

Value/edge triggering: WORKING and HW-proven (2026-06-23). Two things had to be
true: (1) the bitstream's FLA must be built WITH a Match Unit + TriggerCondition
(the generated `.fic` used to omit them → no comparator → free-run; fixed in
ila.mjs renderFic); (2) the trigger point is read from the per-sample padding/
marker field
(`trigger_index`), because the status register is constant on this core and the
buffer is circular (a linear `sample[0]` is a random rotation each arm). The
trigger blob matches the vendor encoder's `i_ila_cmd_data` byte-for-byte. The step-28
status check is NOT used (left in `wait_triggered`/`poll_status` as diagnostics
only — they don't gate capture).
"""

import sys
import time

from mpsse_jtag import MpsseJtag, FtError

# IR opcodes (10-bit unless noted)
IR_SCAN = 0x283
IR_FLA = 0x286       # main FLA register access
IR_READBACK = 0x14C
IR_284 = 0x284
IR_159 = 0x159
IR_BYPASS11 = 0x000  # shifted with len 11 at teardown

STATUS_REG = 0x038
STATUS_READY = 0b010  # expected in the LAST 3 status bits when triggered
# Status-read length: step 27 reads `r_ila_depth_len` bits
# (= log2(depth)+6), NOT 32. The 32-bit DR in the vendor sequence is the loop-RE-ARM dummy
# at the 28→24 transition, not the status read. Reading 32 here (the old bug) put
# the trigger flag — which the HW tests at w_tdo_reg[31:29] = the LAST 3 shifted
# bits — 16 bits out of position, so 010 was never seen and value triggers looked
# like free-run. The correct length is per-depth: self.depth_len.

# Per-channel trigger codes (3 bits each), per the vendor's JTAG-ILA trigger
# encoding: it builds the 0xE5/0x82 frame whose trigger field becomes the FPGA's
# `i_ila_cmd_data` — the same blob that is shifted into the (PDS-inserted) FLA
# over JTAG. This is the encoding the vendor tooling uses to drive the FLA, so
# it is the authoritative mapping for headless replay. NOTE: it differs from the
# internal-LA `LOGIC_ANALYZER_TRIGGER_CODES` (x000/0:001/1:010) — that one is
# for the gw twin's on-die comparator, NOT the JTAG-FLA path. Using the wrong
# one (the bug found 2026-06-23) made every channel a non-matching/don't-care
# code → the FLA free-ran. Bit semantics here: bit0=expected level,
# bit1=level-match-enable, bit2=edge.
TRIG_CODES = {
    "x": 0b000,  # don't care
    "X": 0b000,
    "0": 0b010,  # expect level 0
    "1": 0b011,  # expect level 1
    "r": 0b101,  # rising edge
    "R": 0b101,
    "f": 0b100,  # falling edge
    "F": 0b100,
}


def encode_trigger(width, pattern=None, condition_bit=0,
                   chan_reversed=True, code_msb_first=False):
    """Pack a width-channel trigger spec into the `capture_len = width*3 + 1`
    bit blob shifted (LSB-first, bit[0] first) into the FLA at step 16.

    The exact bit layout PDS's inserted FLA expects is NOT documented; the vendor
    reference encoder packs 128 channels reversed +
    MSB-first-within-channel, but that's for a different (256-wide) core. So the
    layout is parameterized and calibrated on hardware (test/fla-trig-cal.py):
      - `chan_reversed` (DEFAULT True, hardware-calibrated 2026-06-24): True =>
        ch0 occupies the HIGH 3-bit slot (reversedIdx), matching the host; this is
        what the real PG2L200H FLA uses (blob slot s drives counter bit width-1-s).
        False (the old default) silently mis-matched every non-palindrome value to
        its bit-reverse (e.g. asking for 0x50 froze at 0x0A). See test/
        fla-trig-encode-unit.py and jtag/FINDINGS.md "Channel order".
      - `code_msb_first`: True => within a channel, bit[base]=code[2] (MSB);
        False => bit[base]=code[0] (LSB).
      - trailing `+1` bit at index width*3 = global condition bit.

    `pattern` is a string of `x/0/1/r/f`, channel 0 first (same order as a hex
    display of the signal). Defaults to all-X (always-true / free-run).
    Returns (value:int, capture_len:int) — value is LSB-first packed for
    write_dr (so value's bit[0] is shifted onto TDI first)."""
    capture_len = width * 3 + 1
    if pattern is None:
        pattern = "x" * width
    if len(pattern) != width:
        raise ValueError(f"trigger pattern length {len(pattern)} != width {width}")
    bits = [0] * capture_len
    for ch in range(width):
        sym = pattern[ch]
        code = TRIG_CODES.get(sym)
        if code is None:
            raise ValueError(f"channel {ch}: invalid trigger code {sym!r} "
                             f"(allowed: {sorted(set(TRIG_CODES))})")
        slot = (width - 1 - ch) if chan_reversed else ch
        base = slot * 3
        if code_msb_first:
            bits[base + 0] = (code >> 2) & 1
            bits[base + 1] = (code >> 1) & 1
            bits[base + 2] = code & 1
        else:
            bits[base + 0] = code & 1
            bits[base + 1] = (code >> 1) & 1
            bits[base + 2] = (code >> 2) & 1
    bits[width * 3] = condition_bit & 1
    value = 0
    for i, b in enumerate(bits):
        if b:
            value |= 1 << i
    return value, capture_len


def _depth_len(depth):
    n = depth.bit_length() - 1          # log2 for power-of-two depth
    if (1 << n) != depth:
        raise ValueError(f"depth must be a power of two, got {depth}")
    return n + 6                         # matches the vendor width table


def sample_padding_bits(width):
    """Conservative legacy upper bound for per-sample protocol bits.

    PDS 2025.2 does *not* expose the JTAG sample-chain width in ``.fic``.  A
    standard inserted core has one protocol/marker bit (vendor RTL declares
    ``DATA_CHAIN_BIT = DATA_BIT + 1``), while a hardware-proven legacy capture
    needed one lane per up-to-eight logical bits.  The latter is therefore a
    safe bounded fallback read size, not the physical-width formula.
    """
    if not isinstance(width, int) or isinstance(width, bool) or width <= 0:
        raise ValueError(f"width must be a positive integer, got {width!r}")
    return (width + 7) // 8


def sample_padding_candidates(width):
    """Bounded candidate set used after the canonical ``width + 1`` probe.

    Search every value for ordinary FLA widths.  For very wide cores, retain
    the common small lane counts plus the legacy upper bound so inference stays
    bounded; callers can supply an explicit padding override for an unusual
    vendor/core revision.
    """
    maximum = sample_padding_bits(width)
    if maximum <= 16:
        return list(range(1, maximum + 1))
    return sorted({1, 2, 3, 4, 8, 16, maximum})


class FlaFramingError(RuntimeError):
    """The raw read completed, but its physical sample boundary was ambiguous."""

    def __init__(self, message, raw):
        super().__init__(message)
        self.raw = raw


class PangoFla:
    # Step-29 framing is four leading bits, `depth` physical frames, then two
    # trailing bits. The per-frame padding count is width-dependent; see
    # sample_padding_bits().
    HEADER_BITS = 4
    TRAILING_BITS = 2
    # A normal single-window capture has zero padding bits, or one trigger
    # marker.  Keep one spare for observed implementation noise; anything denser
    # is not a trustworthy frame boundary and triggers the wider probe.
    MAX_PROTOCOL_ONE_BITS = 2

    def __init__(self, jtag: MpsseJtag, width, depth, trig_position=None,
                 trigger=None, condition_bit=0, chan_reversed=True,
                 code_msb_first=False, padding_bits=None):
        self.j = jtag
        self.width = width
        self.depth = depth
        self.capture_len = width * 3 + 1
        self.max_padding_bits = sample_padding_bits(width)
        if padding_bits is not None:
            if (not isinstance(padding_bits, int) or isinstance(padding_bits, bool)
                    or padding_bits <= 0 or padding_bits > width):
                raise ValueError(
                    f"padding_bits must be an integer in 1..{width}, got {padding_bits!r}")
        self.padding_override = padding_bits
        # Preserve the old pre-capture shape for direct diagnostic scripts.  A
        # real capture starts with the canonical one-bit probe and replaces these
        # fields with the verified physical geometry before decoding/export.
        self.padding_bits = padding_bits or self.max_padding_bits
        self.sample_stride = width + self.padding_bits
        self.all_data_len = self._framed_bit_length(
            padding_bits or self.max_padding_bits)
        self.frame_bit_length = self._framed_bit_length(self.padding_bits)
        self.last_read_bit_length = None
        self.last_read_padding_bits = None
        self.read_passes = 0
        self.padding_one_counts = []
        self.framing_candidates = []
        self.framing_source = "explicit" if padding_bits is not None else "upper_bound"
        self.header_value = None
        self.trailing_value = None
        self.last_raw = None
        self.depth_len = _depth_len(depth)
        self.trig_position = depth if trig_position is None else trig_position
        # Trigger spec: None / "x"*width = all-X = always-true (legacy behavior).
        # Else a length-`width` string of x/0/1/r/f, channel 0 first.
        self.trigger_pattern = trigger
        self.trigger_value, _ = encode_trigger(
            width, trigger, condition_bit,
            chan_reversed=chan_reversed, code_msb_first=code_msb_first)
        self.condition_bit = condition_bit

    def _framed_bit_length(self, padding_bits):
        return (self.HEADER_BITS
                + (self.width + padding_bits) * self.depth
                + self.TRAILING_BITS)

    def framing(self):
        """Machine-readable logical/physical readback geometry and evidence."""
        read_bits = self.last_read_bit_length or self.all_data_len
        return {
            "logicalWidth": self.width,
            "paddingBits": self.padding_bits,
            "sampleStride": self.sample_stride,
            "headerBits": self.HEADER_BITS,
            "trailingBits": self.TRAILING_BITS,
            "frameBitLength": self.frame_bit_length,
            "readBitLength": read_bits,
            "overreadBits": max(0, read_bits - self.frame_bit_length),
            "maxPaddingBits": self.max_padding_bits,
            "paddingOneCounts": list(self.padding_one_counts),
            "headerValue": self.header_value,
            "trailingValue": self.trailing_value,
            "selection": self.framing_source,
            "readPasses": self.read_passes,
            "candidates": list(self.framing_candidates),
        }

    # --- recipe steps 0..22: arm the FLA ------------------------------------
    def arm(self):
        j = self.j
        j.reset_to_rti()
        # 0..4  pre-amble scan
        j.shift_ir(IR_SCAN, 10)
        j.write_dr(0x0, 33)
        j.write_dr(0x36, 9)
        j.write_dr(0x36, 8)
        j.write_dr(0x0, 6)
        # 5..9  enter FLA, program 0x037 / 0x036
        j.shift_ir(IR_FLA, 10)
        j.write_dr(0x037, 9)
        j.write_dr(0x0, 36)
        j.write_dr(0x036, 9)
        j.write_dr(0x036, 8)
        # 10..15  program 0x034, select status, set capture value 0x20
        j.shift_ir(IR_FLA, 10)
        j.write_dr(0x034, 9)
        j.write_dr(0x034, 8)
        j.write_dr(STATUS_REG, 9)
        j.write_dr(0x0, 14)
        j.write_dr(0x20, 9)            # key: arm capture value
        # 16  trigger-spec blob. `trigger_value` packs the per-channel TRIG_CODES
        # with chan_reversed=True (ch0 in the HIGH slot) — the hardware-calibrated
        # channel order (blob slot s drives counter bit width-1-s). `trigger=None`
        # = zeros = always-true capture. HARDWARE-PROVEN: a value trigger freezes
        # the FLA exactly at the match (marker at counter==value), PROVIDED the
        # bitstream's FLA was built with a Match Unit + TriggerCondition (ila.mjs
        # renderFic — the old comparator-less .fic was the real blocker). Read the
        # trigger point via the padding/marker field (trigger_index), NOT the status register
        # or a linear sample[0]. NOTE the channel order was wrong (False) until
        # 2026-06-24: every value HW-tested before then (0xA5, 0x3C) was a bit-
        # palindrome and matched either way. See FINDINGS.md "Channel order".
        j.write_dr(self.trigger_value, self.capture_len)
        # 17..22  trigger config: 0x30, 0x2, 0x32, trig_position, 0x35 x2
        j.write_dr(0x30, 9)
        j.write_dr(0x2, 3)
        j.write_dr(0x32, 9)
        j.write_dr(self.trig_position, self.depth_len)
        j.write_dr(0x35, 9)
        j.write_dr(0x35, 8)

    # --- recipe steps 23..28: poll until triggered --------------------------
    def poll_status(self, nbits=None):
        """One shot of recipe steps 23..27: re-enter FLA, select status (0x038),
        read it back. Returns the raw `nbits`-bit value (LSB-first packed).
        Pure diagnostic — does not advance teardown; safe to call repeatedly.

        `nbits` defaults to `self.depth_len` (= r_ila_depth_len, the step-27
        read length). The HW tests `w_tdo_reg[31:29]` =
        the LAST 3 bits shifted in, so the trigger flag lands in this value's
        top 3 bits (bits [depth_len-1 : depth_len-3])."""
        if nbits is None:
            nbits = self.depth_len
        j = self.j
        j.shift_ir(IR_FLA, 10)             # 23 / loop top
        j.write_dr(0x037, 9)               # 24
        j.write_dr(0x0, 63)                # 25
        j.write_dr(STATUS_REG, 9)          # 26 tail: select status reg
        return j.read_dr(nbits)            # 27: read status field (depth_len bits)

    def wait_triggered(self, timeout_s=10.0, poll_wait_s=0.01, debug=False):
        """Loop poll_status until ready. r_tdo_reg is a 32-bit right-shift
        register (`{i_tdo, r_tdo_reg[31:1]}` in the vendor TAP); after an
        N-bit shift, the LAST TDO bit sits at HW bit 31, the first at bit 32-N.
        The HW test `w_tdo_reg[31:29] == 0b010` therefore looks at the last 3
        bits shifted in. poll_status reads `depth_len` bits packed so bit
        [depth_len-1] = last shifted, so those 3 bits are
        [depth_len-1 : depth_len-3]. Returns True if ready, False on timeout.
        `debug=True` prints each raw read."""
        end = time.time() + timeout_s
        attempt = 0
        shift = self.depth_len - 3
        while True:
            attempt += 1
            time.sleep(poll_wait_s)        # 26: reference waits 400 RTI clocks
            status = self.poll_status()
            top3 = (status >> shift) & 0b111
            if debug:
                print(f"  poll #{attempt}: status=0x{status:0{(self.depth_len + 3) // 4}X} "
                      f"top3=0b{top3:03b} (ready=0b{STATUS_READY:03b})")
            if top3 == STATUS_READY:
                return True
            if time.time() > end:
                return False

    # --- recipe steps 29..36: read back the sample buffer + teardown --------
    def read_samples(self, padding_bits=None):
        j = self.j
        j.shift_ir(IR_FLA, 10)
        j.write_dr(0x03c, 9)               # 28-branch: select sample readout
        # 29: the actual waveform.  Direct callers retain the conservative legacy
        # length; capture() passes an exact probe/candidate padding count.
        use_padding = ((self.padding_override or self.max_padding_bits)
                       if padding_bits is None else padding_bits)
        bit_length = self._framed_bit_length(use_padding)
        raw = j.read_dr(bit_length)
        self.last_read_padding_bits = use_padding
        self.last_read_bit_length = bit_length
        self.read_passes += 1
        self.last_raw = raw
        # teardown 30..36
        j.shift_ir(IR_READBACK, 10)
        j.write_dr(0x0, 97)
        j.shift_ir(IR_284, 10)
        j.write_dr(0x0, 33)
        j.shift_ir(IR_159, 10)
        j.write_dr(0x0, 33)
        j.shift_ir(IR_BYPASS11, 11)
        return raw

    def _padding_counts(self, raw, padding_bits):
        stride = self.width + padding_bits
        counts = []
        for lane in range(padding_bits):
            count = 0
            for sample_index in range(self.depth):
                bit = (self.HEADER_BITS + sample_index * stride
                       + self.width + lane)
                count += (raw >> bit) & 1
            counts.append(count)
        return counts

    def _unpack_with_padding(self, raw, padding_bits):
        stride = self.width + padding_bits
        mask = (1 << self.width) - 1
        return [
            (raw >> (self.HEADER_BITS + sample_index * stride)) & mask
            for sample_index in range(self.depth)
        ]

    def _candidate(self, raw, padding_bits):
        counts = self._padding_counts(raw, padding_bits)
        return {
            "paddingBits": padding_bits,
            "sampleStride": self.width + padding_bits,
            "paddingOneCounts": counts,
            "paddingOnes": sum(counts),
        }

    @staticmethod
    def _public_candidates(candidates):
        return [dict(candidate) for candidate in candidates]

    def _set_framing(self, raw, padding_bits, source, candidates=None):
        self.padding_bits = padding_bits
        self.sample_stride = self.width + padding_bits
        self.frame_bit_length = self._framed_bit_length(padding_bits)
        self.padding_one_counts = self._padding_counts(raw, padding_bits)
        self.header_value = raw & ((1 << self.HEADER_BITS) - 1)
        self.trailing_value = (
            raw >> (self.HEADER_BITS + self.sample_stride * self.depth)
        ) & ((1 << self.TRAILING_BITS) - 1)
        self.framing_source = source
        self.framing_candidates = self._public_candidates(candidates or [
            self._candidate(raw, padding_bits)
        ])

    def _is_all_ones_read(self, raw):
        if not self.last_read_bit_length:
            return False
        return raw == (1 << self.last_read_bit_length) - 1

    def infer_framing(self, raw, read_padding_bits=None):
        """Infer a physical boundary from a conservative superset read.

        Only protocol-lane sparsity is used; no assumptions are made about DUT
        values, buses, device, or signal semantics.  Equal-score candidates that
        decode differently fail closed and can be resolved with ``padding_bits``.
        """
        available = read_padding_bits or self.max_padding_bits
        candidates = [
            self._candidate(raw, padding)
            for padding in sample_padding_candidates(self.width)
            if padding <= available
        ]
        best_ones = min(candidate["paddingOnes"] for candidate in candidates)
        best = [candidate for candidate in candidates
                if candidate["paddingOnes"] == best_ones]
        if best_ones > self.MAX_PROTOCOL_ONE_BITS:
            chosen = min(best, key=lambda candidate: candidate["paddingBits"])
            self._set_framing(raw, chosen["paddingBits"], "unresolved", candidates)
            raise FlaFramingError(
                "FLA framing 无可信候选：所有候选的 protocol padding 均过密；"
                "请保存 raw 并显式传 paddingBits。",
                raw,
            )
        if len(best) > 1:
            decoded = [
                self._unpack_with_padding(raw, candidate["paddingBits"])
                for candidate in best
            ]
            if any(samples != decoded[0] for samples in decoded[1:]):
                chosen = min(best, key=lambda candidate: candidate["paddingBits"])
                self._set_framing(raw, chosen["paddingBits"], "ambiguous", candidates)
                raise FlaFramingError(
                    "FLA framing 候选并列且解码不同；拒绝猜测。"
                    "请保存 raw 并显式传 paddingBits。",
                    raw,
                )
            source = "equivalent"
        else:
            source = "inferred"
        chosen = min(best, key=lambda candidate: candidate["paddingBits"])
        self._set_framing(raw, chosen["paddingBits"], source, candidates)
        return self.framing()

    def _has_real_trigger(self):
        """True if a non-trivial (not all-don't-care) trigger pattern is set."""
        p = self.trigger_pattern
        return bool(p) and any(c not in ("x", "X") for c in p)

    def trigger_index(self, raw):
        """Physical index of a set per-sample padding/marker lane in the readout
        — the FLA's TRIGGER MARKER. Returns None if no sample is marked (the trigger
        has not fired yet). This — NOT the status register (constant on this
        core) and NOT a linear `sample[0]` (the buffer is CIRCULAR, so its
        physical start is a random rotation each arm) — is the authoritative
        "did/where did it trigger" signal. HW-proven 2026-06-23: with a value
        trigger the marker lands exactly at the match boundary every arm
        (counter==0xA5 → marker at the 0xA4 sample, 0x3C → at 0x3B, …)."""
        for k in range(self.depth):
            if self._frame_padding(raw, k):
                return k
        return None

    def _frame_padding(self, raw, sample_index):
        """Return all physical protocol lanes for one sample as a bit field."""
        base = self.HEADER_BITS + sample_index * self.sample_stride + self.width
        return (raw >> base) & ((1 << self.padding_bits) - 1)

    def _is_degenerate_readback(self, raw):
        """True for the no-design / floating-bus signature: EVERY sample's
        padding/marker field is nonzero (an all-1s read). A real FLA trigger marks
        essentially one sample, so a healthy capture has a tiny marker count; this
        all-marked shape can only mean
        the FLA isn't there (e.g. SRAM config lost to a power-cycle -> the bus
        reads 0xFF…). Without this, the all-1s read makes trigger_index falsely
        return 0 and capture() would lie 'triggered'. HW-seen 2026-06-24."""
        marked_count = sum(
            self._frame_padding(raw, k) != 0
            for k in range(self.depth))
        return marked_count == self.depth

    def capture(self, attempts=6, settle_s=0.05, align=True):
        """Arm + read the trigger-aligned sample buffer.

        Detects "triggered" via the per-sample padding/trigger marker
        (`trigger_index`), not the (useless, constant) status register. For a
        real value/edge trigger: arm, let it fire, read; if no marker is set the
        trigger hasn't fired yet → re-arm and retry. Because the buffer is
        circular, the marker's physical position is a random rotation each arm,
        so with `align=True` the returned samples are rotated to put the trigger
        sample at index 0 — a stable, chronological, trigger-aligned window.
        Sets `self.last_trigger_index` (rotated frame: 0 when aligned). Returns
        `(raw, samples)`. always-true triggers fire immediately (marker present
        at the arm-time sample) and return at once."""
        real = self._has_real_trigger()
        last = None
        read_padding = self.padding_override or 1
        inferred_padding = None
        inferred_candidates = None
        self.read_passes = 0
        for _ in range(attempts):
            self.arm()
            if real and settle_s:
                time.sleep(settle_s)          # let the match occur + freeze
            raw = self.read_samples(read_padding)

            if self.padding_override is not None:
                self._set_framing(raw, read_padding, "explicit")
            elif inferred_padding is not None:
                candidate = self._candidate(raw, read_padding)
                if (candidate["paddingOnes"] > self.MAX_PROTOCOL_ONE_BITS
                        and not self._is_all_ones_read(raw)):
                    self._set_framing(
                        raw, read_padding, "unresolved", inferred_candidates)
                    raise FlaFramingError(
                        "FLA framing 精确复读未通过 protocol padding 校验；"
                        "请保存 raw 并显式传 paddingBits。",
                        raw,
                    )
                self._set_framing(
                    raw, read_padding, "inferred", inferred_candidates)
                inferred_padding = None
            elif read_padding == 1:
                candidate = self._candidate(raw, 1)
                if (self.max_padding_bits > 1
                        and candidate["paddingOnes"] > self.MAX_PROTOCOL_ONE_BITS
                        and not self._is_all_ones_read(raw)):
                    # The canonical width+1 read is misframed.  Re-arm and read a
                    # conservative superset, then infer solely from padding lanes.
                    read_padding = self.max_padding_bits
                    continue
                source = "degenerate" if self._is_all_ones_read(raw) else "canonical"
                self._set_framing(raw, 1, source, [candidate])
            else:
                self.infer_framing(raw, read_padding_bits=read_padding)
                inferred_candidates = list(self.framing_candidates)
                if self.padding_bits != read_padding:
                    # Superset reads are diagnostic only.  Re-arm and return a
                    # final raw whose bit length/tail exactly match the selected
                    # physical frame.
                    inferred_padding = self.padding_bits
                    read_padding = inferred_padding
                    continue

            ti = self.trigger_index(raw)
            samples = self.unpack(raw)
            last = (raw, samples)
            if self._is_degenerate_readback(raw):
                # Every padding/marker field set = no design / floating bus (all-1s). The
                # marker is meaningless here; never claim a trigger. Re-arm/retry
                # in case it was transient, else fall through to "never fired".
                continue
            if ti is None:
                if not real:
                    # no marker on an always-true arm = degenerate read; retry
                    uniq = len(set(samples))
                    if uniq > 2 and not all(s == (1 << self.width) - 1 for s in samples):
                        self.last_trigger_index = None
                        return raw, samples
                continue                      # not triggered yet → re-arm
            if align:
                samples = samples[ti:] + samples[:ti]
                self.last_trigger_index = 0
            else:
                self.last_trigger_index = ti
            return raw, samples
        self.last_trigger_index = None
        return last  # never triggered in budget — return last read for inspection

    def unpack(self, raw):
        """Split the step-29 buffer into `depth` samples of `width` bits."""
        return self._unpack_with_padding(raw, self.padding_bits)


def main():
    """Smoke entry: arm+poll only makes sense against a loaded ILA bitstream.
    Without one, this just proves the recipe transcription runs end-to-end over
    the proven transport (it will report 'never triggered', which is correct)."""
    if len(sys.argv) < 3:
        print("usage: fla_pango.py <width> <depth> [channel]")
        return 2
    width = int(sys.argv[1])
    depth = int(sys.argv[2])
    ch = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    j = MpsseJtag(index=ch)
    j.open()
    try:
        dt = j.device_type()
        j.sync()
        j.config_clock(dt[0])
        print(f"IDCODE = 0x{j.read_idcode():08X}  (transport check)")
        fla = PangoFla(j, width=width, depth=depth)
        print(f"capture_len={fla.capture_len} padding_bits={fla.padding_bits} "
              f"sample_stride={fla.sample_stride} all_data_len={fla.all_data_len} "
              f"depth_len={fla.depth_len} trig_position={fla.trig_position}")
        raw, samples = fla.capture()
        print(f"captured {fla.depth} samples x {fla.width} bits")
        print("first 24:", [f"{s:02x}" for s in samples[:24]])
        print("last 8:  ", [f"{s:02x}" for s in samples[-8:]])
        diffs = {(samples[i + 1] - samples[i]) & ((1 << width) - 1) for i in range(len(samples) - 1)}
        print(f"distinct step(s) between samples: {sorted(diffs)}")
    finally:
        j.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
