"""Re-examine the trigger using the PER-SAMPLE GUARD BIT (the +1 in
all_data_len=(width+1)*depth+6), which we have been discarding.

Why the old oracle was wrong: the FLA buffer is CIRCULAR. On trigger-freeze the
write pointer stops at a position set by the (free-running) counter, so a LINEAR
readout puts the trigger sample at a RANDOM physical index — `sample[0]` looks
random even when the value trigger fired correctly. The blob is provably identical
to the lab's (`buildJtagIlaConfigFrame` → i_ila_cmd_data 0x069A4D3 == our encode),
so the trigger may have been firing all along and only our readout oracle was blind.

The guard bit per sample is the candidate trigger MARKER. This dumps, for both an
always-true and a value==0xA5 arm: the index(es) where guard==1 and the data value
there. If value-trigger puts guard==1 (or a structural mark) at the 0xA5 sample
consistently, the trigger WORKS.

  python fla-trig-guard.py            # width 8 depth 1024 value 0xA5
"""
import sys

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla            # noqa: E402


def unpack_with_guard(fla, raw):
    """Return [(data, guard)] for each of depth samples."""
    stride = fla.width + 1
    out = []
    for k in range(fla.depth):
        base = fla.HEADER_BITS + k * stride
        val = 0
        for b in range(fla.width):
            val |= ((raw >> (base + b)) & 1) << b
        guard = (raw >> (base + fla.width)) & 1
        out.append((val, guard))
    return out


def dump(j, label, width, depth, trigger, value):
    fla = PangoFla(j, width=width, depth=depth, trigger=trigger)
    fla.arm()
    raw = fla.read_samples()
    sg = unpack_with_guard(fla, raw)
    guards = [i for i, (_, g) in enumerate(sg) if g == 1]
    print(f"--- {label} (trigger={trigger!r}) ---")
    print(f"   #guard=1: {len(guards)}  at indices (first 8): {guards[:8]}")
    for gi in guards[:4]:
        v = sg[gi][0]
        print(f"     guard@{gi}: data=0x{v:02X}" + ("  == TARGET" if value is not None and v == value else ""))
    # also: where does the target value sit, and is there a structural boundary
    tgt_idx = [i for i, (v, _) in enumerate(sg) if v == value][:6] if value is not None else []
    if value is not None:
        print(f"   target 0x{value:02X} at data indices (first 6): {tgt_idx}")
    # detect the monotonic wrap boundary (where data jumps != +1) — that boundary
    # is the buffer write-pointer seam; its offset to the trigger is the real signal
    mask = (1 << width) - 1
    seams = [i for i in range(depth) if ((sg[i][0] - sg[(i-1) % depth][0]) & mask) != 1]
    print(f"   wrap seam(s) at: {seams[:6]}")
    print()
    return sg, guards, seams


def run(width, depth, value):
    pattern = "".join("1" if (value >> b) & 1 else "0" for b in range(width))
    with MpsseJtag(index=0) as j:
        print(f"IDCODE=0x{j.read_idcode():08X}\n")
        # repeat the value arm a few times: if triggered, the guard/seam sits at a
        # CONSTANT offset from the 0xA5 sample every time (even though absolute index moves)
        print("=== ALWAYS-TRUE (immediate) ===")
        dump(j, "always-true", width, depth, None, None)
        print(f"=== VALUE==0x{value:02X}, 3 arms (look for guard/seam at a constant offset from 0x{value:02X}) ===")
        for r in range(3):
            sg, guards, seams = dump(j, f"value run{r}", width, depth, pattern, value)
            # relative offset: nearest 0xA5 data index to the first guard
            if guards:
                tgt = [i for i, (v, _) in enumerate(sg) if v == value]
                if tgt:
                    g0 = guards[0]
                    off = min(((g0 - t) % depth) for t in tgt)
                    print(f"   >> run{r}: guard0 - nearest(0x{value:02X}) offset = {off}\n")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    run(w, d, v)
