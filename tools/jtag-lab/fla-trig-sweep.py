"""Sweep the FLA trigger-blob encoding against the STATUS oracle.

New decisive oracle (found 2026-06-23): with the corrected depth_len status read,
an armed-but-waiting FLA reads status top3 == 0b001; a TRIGGERED one reads 0b010.
(The free-running counter passes every 8-bit value every 256 design clocks, so a
correctly-encoded value trigger fires within microseconds — long before the first
poll.) So for each candidate encoding we arm and poll status a few times; the combo
whose status reaches 0b010 (and whose buffer then freezes) is the correct one.

This replaces the old buffer-constancy sweep (fla-trig-cal.py), which used a blind
sleep+read and couldn't see the 001-vs-010 distinction.

Degrees of freedom swept: channel slot order, within-channel bit order, the trailing
condition/enable bit, and a whole-blob bit reversal.

  python fla-trig-sweep.py            # width 8 depth 1024 value 0xA5
  python fla-trig-sweep.py 8 1024 0x5A
"""
import sys
import time

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla, encode_trigger  # noqa: E402


def value_to_pattern(value, width):
    return "".join("1" if (value >> b) & 1 else "0" for b in range(width))


def probe(j, width, depth, pattern, chan_rev, msb, cond, blob_rev, polls=12):
    """Arm with one encoding variant; poll status; return (max_top3, reached_010,
    froze_const). froze_const = sample[0] constant across 2 reads after waiting."""
    fla = PangoFla(j, width=width, depth=depth, trigger=pattern,
                   condition_bit=cond, chan_reversed=chan_rev, code_msb_first=msb)
    if blob_rev:
        # reverse the capture_len-bit blob end-for-end
        n = fla.capture_len
        v = fla.trigger_value
        fla.trigger_value = sum(((v >> i) & 1) << (n - 1 - i) for i in range(n))
    fla.arm()
    seen = set()
    reached = False
    for _ in range(polls):
        st = fla.poll_status()
        top3 = (st >> (fla.depth_len - 3)) & 0b111
        seen.add(top3)
        if top3 == 0b010:
            reached = True
            break
        time.sleep(0.01)
    # if it reached 010, read twice and check the window froze (constant first sample)
    froze = None
    if reached:
        a = fla.unpack(fla.read_samples())[0]
        b = fla.unpack(fla.read_samples())[0]
        froze = (a == b, a)
    return seen, reached, froze


def run(width, depth, value):
    pattern = value_to_pattern(value, width)
    print(f"width={width} depth={depth} target=0x{value:02X} pattern={pattern!r}")
    print("sweeping encodings; oracle: status top3 -> 0b010 == TRIGGERED\n")
    with MpsseJtag(index=0) as j:
        print(f"IDCODE=0x{j.read_idcode():08X}\n")
        hits = []
        for blob_rev in (False, True):
            for chan_rev in (False, True):
                for msb in (False, True):
                    for cond in (0, 1):
                        seen, reached, froze = probe(
                            j, width, depth, pattern, chan_rev, msb, cond, blob_rev)
                        seen_s = "{" + ",".join(f"{t:03b}" for t in sorted(seen)) + "}"
                        tag = ""
                        if reached:
                            tag = f"  <== 010 REACHED; froze={froze}"
                            hits.append((blob_rev, chan_rev, msb, cond, froze))
                        print(f"blob_rev={blob_rev!s:5} chan_rev={chan_rev!s:5} "
                              f"msb={msb!s:5} cond={cond}: top3_seen={seen_s}{tag}")
        print()
        if hits:
            print(f"TRIGGERED combos ({len(hits)}):")
            for h in hits:
                print(f"  blob_rev={h[0]} chan_rev={h[1]} msb={h[2]} cond={h[3]} froze={h[4]}")
        else:
            print("No combo reached 010. Trigger comparator not engaging via the "
                  "blob alone — investigate step-15 0x20 capture-value or a missing "
                  "enable DR, or P2 (this FLA build has no runtime comparator).")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    run(w, d, v)
