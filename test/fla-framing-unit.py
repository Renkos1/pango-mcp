"""Hardware-free regression for PDS FLA logical-to-physical framing."""

import sys
from pathlib import Path


JTAG_DIR = Path(__file__).resolve().parents[1] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))

from fla_pango import (  # noqa: E402
    FlaFramingError,
    PangoFla,
    sample_padding_bits,
    sample_padding_candidates,
)


def pack_raw(fla, samples, padding=None, padding_bits=None):
    padding = padding or {}
    physical_padding = padding_bits or fla.padding_bits
    stride = fla.width + physical_padding
    raw = 0
    for index, value in enumerate(samples):
        base = fla.HEADER_BITS + index * stride
        raw |= (value & ((1 << fla.width) - 1)) << base
        raw |= (padding.get(index, 0) & ((1 << physical_padding) - 1)) << (base + fla.width)
    return raw


class ReadbackJtag:
    def __init__(self, raw=0):
        self.raw = raw
        self.read_lengths = []

    def reset_to_rti(self):
        pass

    def shift_ir(self, *_args):
        pass

    def write_dr(self, *_args):
        pass

    def read_dr(self, bit_length):
        self.read_lengths.append(bit_length)
        return self.raw & ((1 << bit_length) - 1)


def main():
    assert sample_padding_bits(4) == 1
    assert sample_padding_bits(8) == 1
    assert sample_padding_bits(9) == 2
    assert sample_padding_bits(16) == 2
    assert sample_padding_bits(20) == 3
    assert sample_padding_bits(34) == 5
    assert sample_padding_candidates(34) == [1, 2, 3, 4, 5]

    narrow4 = PangoFla(None, width=4, depth=64)
    narrow8 = PangoFla(None, width=8, depth=64)
    assert narrow4.sample_stride == 5
    assert narrow8.sample_stride == 9

    fla = PangoFla(None, width=20, depth=1024)
    samples = [((index * 0x1021) ^ 0x54321) & 0xFFFFF for index in range(fla.depth)]
    raw = pack_raw(fla, samples)
    assert fla.unpack(raw) == samples
    assert fla.trigger_index(raw) is None
    assert fla._is_degenerate_readback(raw) is False

    # A marker in the final physical padding lane is detected; no logical data
    # bit can be mistaken for a marker, and padding never leaks into samples.
    marker_index = 731
    marked = pack_raw(fla, samples, {marker_index: 1 << (fla.padding_bits - 1)})
    assert fla.trigger_index(marked) == marker_index
    assert fla.unpack(marked) == samples

    data_only = pack_raw(fla, [1 << 19] * fla.depth)
    assert fla.trigger_index(data_only) is None

    all_ones = (1 << fla.all_data_len) - 1
    assert fla._is_degenerate_readback(all_ones) is True
    every_first_lane = pack_raw(fla, [0] * fla.depth, {index: 1 for index in range(fla.depth)})
    assert fla._is_degenerate_readback(every_first_lane) is True

    # Historical 20-bit framing: the canonical width+1 probe is visibly dense,
    # so capture re-arms once, reads the legacy upper bound, and selects p=3.
    jtag20 = ReadbackJtag(raw)
    live20 = PangoFla(jtag20, width=20, depth=1024)
    captured20, decoded20 = live20.capture()
    assert captured20 == raw
    assert decoded20 == samples
    assert jtag20.read_lengths == [21510, 23558]
    framing20 = live20.framing()
    assert framing20["paddingBits"] == 3
    assert framing20["sampleStride"] == 23
    assert framing20["frameBitLength"] == 23558
    assert framing20["readBitLength"] == 23558
    assert framing20["overreadBits"] == 0
    assert framing20["paddingOneCounts"] == [0, 0, 0]
    assert framing20["selection"] == "inferred"
    assert framing20["readPasses"] == 2

    # PDS 2025.2 width=34/depth=64 uses the vendor-canonical DATA_BIT+1 chain.
    # Three arbitrary static words exercise the non-byte-aligned boundary without
    # relying on any project/device/signal semantics.
    static_words = [0x2A155AA55, 0x1552AA55A, 0x000000006]
    samples34 = [static_words[index % len(static_words)] for index in range(64)]
    packing34 = PangoFla(None, width=34, depth=64)
    raw34 = pack_raw(packing34, samples34, padding_bits=1)
    jtag34 = ReadbackJtag(raw34)
    live34 = PangoFla(jtag34, width=34, depth=64)
    captured34, decoded34 = live34.capture()
    assert captured34 == raw34
    assert decoded34 == samples34
    assert jtag34.read_lengths == [2246]
    framing34 = live34.framing()
    assert framing34["paddingBits"] == 1
    assert framing34["sampleStride"] == 35
    assert framing34["frameBitLength"] == 2246
    assert framing34["readBitLength"] == 2246
    assert framing34["paddingOneCounts"] == [0]
    assert framing34["selection"] == "canonical"
    assert framing34["readPasses"] == 1

    # Explicit override is a generic escape hatch for a future/unknown core
    # revision and bypasses inference while retaining the same diagnostics.
    explicit = PangoFla(ReadbackJtag(raw), width=20, depth=1024, padding_bits=3)
    _, explicit_samples = explicit.capture()
    assert explicit_samples == samples
    assert explicit.framing()["selection"] == "explicit"
    assert explicit.framing()["paddingOneCounts"] == [0, 0, 0]

    # Equal padding scores with materially different decoded words must not be
    # broken by a guess; callers receive raw + an explicit override path.
    ambiguous = PangoFla(None, width=9, depth=4)
    try:
        ambiguous.infer_framing(1 << 15, read_padding_bits=2)
    except FlaFramingError as exc:
        assert exc.raw == 1 << 15
        assert ambiguous.framing()["selection"] == "ambiguous"
    else:
        raise AssertionError("materially ambiguous framing did not fail closed")

    for invalid in (0, -1, True, 1.5):
        try:
            sample_padding_bits(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid width accepted: {invalid!r}")

    for invalid in (0, -1, True, 1.5, 21):
        try:
            PangoFla(None, width=20, depth=64, padding_bits=invalid)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid padding override accepted: {invalid!r}")

    print("fla-framing-unit: logical width -> physical stride/read length PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
