"""Unit test for fla_pango degenerate-readback rejection — HARDWARE-FREE.

Guards the false-positive found 2026-06-24: when the SRAM bitstream is gone (e.g.
a power-cycle), the FLA bus reads all-1s. EVERY padding/marker field is then set, so the
naive trigger_index returns 0 and capture() would lie 'triggered'. The synthetic
all-1s raw below is the exact controlled repro of what the hardware produced.
_is_degenerate_readback must flag it so capture() never claims a trigger on an
absent design. See jtag/FINDINGS.md "Degenerate readback".
"""
import sys
from pathlib import Path

JTAG_DIR = Path(__file__).resolve().parents[1] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))
from fla_pango import PangoFla  # noqa: E402


def make_raw(fla, samples, marker=None):
    """Pack `samples` (depth width-bit ints) into a step-29 raw, optionally
    setting the first padding/marker lane on sample index `marker`."""
    raw = 0
    for k, val in enumerate(samples):
        base = fla.HEADER_BITS + k * fla.sample_stride
        for b in range(fla.width):
            if (val >> b) & 1:
                raw |= 1 << (base + b)
        if marker is not None and k == marker:
            raw |= 1 << (base + fla.width)
    return raw


def main():
    fla = PangoFla(None, width=8, depth=64)
    mask = (1 << fla.width) - 1
    fails = []

    def check(name, cond):
        print(f"  [{'OK' if cond else 'FAIL'}] {name}")
        if not cond:
            fails.append(name)

    # 1) all-1s (no design / floating): degenerate, and trigger_index is fooled.
    all_ones = (1 << fla.all_data_len) - 1
    check("all-1s flagged degenerate", fla._is_degenerate_readback(all_ones) is True)
    check("all-1s fools trigger_index -> 0 (why the guard is needed)",
          fla.trigger_index(all_ones) == 0)

    # 2) all-0s: not degenerate, no marker.
    check("all-0s not degenerate", fla._is_degenerate_readback(0) is False)
    check("all-0s trigger_index -> None", fla.trigger_index(0) is None)

    # 3) real capture: a counter ramp with exactly one trigger marker.
    ramp = [(i & mask) for i in range(fla.depth)]
    raw = make_raw(fla, ramp, marker=37)
    check("ramp+1marker not degenerate", fla._is_degenerate_readback(raw) is False)
    check("ramp+1marker trigger_index -> 37", fla.trigger_index(raw) == 37)
    check("ramp unpack round-trips", fla.unpack(raw) == ramp)

    if fails:
        print(f"\n{len(fails)} FAIL(s)")
        return 1
    print("\ndegenerate-readback guard correct")
    return 0


if __name__ == "__main__":
    sys.exit(main())
