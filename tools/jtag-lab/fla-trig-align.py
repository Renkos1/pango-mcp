"""The real trigger oracle: INTER-arm window alignment.

The FLA always captures-then-freezes per arm, so neither status nor intra-arm
freeze distinguishes a working trigger. The true signature is alignment ACROSS
arms: if the value trigger works, every arm freezes with the window locked to the
match, so sample[0] (and the index of the target) is CONSTANT across arms. A
free-running / ignored trigger gives a RANDOM sample[0] each arm.

For each encoding combo we arm `runs` times and record sample[0] and the first
index where the target appears. const sample[0] across runs == LOCKED.

  python fla-trig-align.py            # width 8 depth 1024 value 0xA5 runs 4
"""
import sys
import time

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla            # noqa: E402


def make(j, width, depth, pattern, blob_rev, chan_rev, msb, cond):
    fla = PangoFla(j, width=width, depth=depth, trigger=pattern,
                   condition_bit=cond, chan_reversed=chan_rev, code_msb_first=msb)
    if blob_rev:
        n = fla.capture_len
        v = fla.trigger_value
        fla.trigger_value = sum(((v >> i) & 1) << (n - 1 - i) for i in range(n))
    return fla


def run(width, depth, value, runs):
    pattern = "".join("1" if (value >> b) & 1 else "0" for b in range(width))
    print(f"width={width} depth={depth} target=0x{value:02X} pattern={pattern!r} "
          f"runs={runs}\noracle: sample[0] CONSTANT across arms == trigger LOCKED\n")
    with MpsseJtag(index=0) as j:
        print(f"IDCODE=0x{j.read_idcode():08X}\n")

        # control: always-true sample[0] is whatever the counter was at arm time —
        # also varies across arms (immediate trigger), so it's NOT expected const.
        locked = []
        for blob_rev in (False, True):
            for chan_rev in (False, True):
                for msb in (False, True):
                    for cond in (0, 1):
                        firsts, idxs = [], []
                        for _ in range(runs):
                            fla = make(j, width, depth, pattern,
                                       blob_rev, chan_rev, msb, cond)
                            fla.arm()
                            time.sleep(0.05)
                            s = fla.unpack(fla.read_samples())
                            firsts.append(s[0])
                            idxs.append(next((i for i, x in enumerate(s) if x == value), -1))
                        const_first = len(set(firsts)) == 1
                        const_idx = len(set(idxs)) == 1
                        tag = "  <== LOCKED" if (const_first or const_idx) else ""
                        if const_first or const_idx:
                            locked.append((blob_rev, chan_rev, msb, cond))
                        print(f"blob_rev={blob_rev!s:5} chan_rev={chan_rev!s:5} "
                              f"msb={msb!s:5} cond={cond}: "
                              f"first={[f'{x:02X}' for x in firsts]} "
                              f"tgt_idx={idxs}{tag}")
        print()
        if locked:
            print(f"LOCKED combos: {locked}")
        else:
            print("No combo locks the window across arms. With arm/transport proven "
                  "(always-true monotonic) and the full bit-order space swept, the "
                  "PDS-inserted FLA does not honor a runtime value trigger on this "
                  "build => core/fic issue (P2), not encoding.")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    run(w, d, v, n)
