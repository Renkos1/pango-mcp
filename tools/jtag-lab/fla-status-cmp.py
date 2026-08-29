"""Settle 001-vs-010: compare the FLA status register between an always-true
trigger (which MUST fire immediately) and a value trigger (counter==0xA5).

If always-true shows top3==010 (ready) while the value trigger shows 001
(armed/waiting), then 010 IS reachable and the value comparator simply never
matches -> the core build lacks a working runtime comparator (P2 / fic).
If always-true ALSO shows 001 (never 010), then 010 is never reachable here and
our status-bit position / read length is still off (decode bug, not core).

Reads several lengths around depth_len to see the full status word context.

  python fla-status-cmp.py            # width 8 depth 1024 value 0xA5
"""
import sys

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla            # noqa: E402


def dump(j, label, width, depth, trigger):
    fla = PangoFla(j, width=width, depth=depth, trigger=trigger)
    fla.arm()
    dl = fla.depth_len
    print(f"--- {label} (trigger={trigger!r}, depth_len={dl}) ---")
    for nbits in (dl, dl + 3, 32):
        st = fla.poll_status(nbits=nbits)
        # top3 = last 3 bits shifted, = bits [nbits-1 : nbits-3]
        top3 = (st >> (nbits - 3)) & 0b111
        print(f"   read {nbits:2d} bits: 0x{st:08X}  top3(last3)=0b{top3:03b}  "
              f"full=0b{st:0{nbits}b}")
    print()


def run(width, depth, value):
    pattern = "".join("1" if (value >> b) & 1 else "0" for b in range(width))
    with MpsseJtag(index=0) as j:
        print(f"IDCODE=0x{j.read_idcode():08X}\n")
        dump(j, "ALWAYS-TRUE", width, depth, None)
        dump(j, f"VALUE==0x{value:02X}", width, depth, pattern)
        print("Interpretation: always-true SHOULD reach 010 (ready). If it does and "
              "the value trigger stays 001, 010 is reachable => value comparator "
              "never matches => core/fic issue (P2). If always-true is ALSO 001, the "
              "status decode is still off.")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    run(w, d, v)
