"""Brute-force calibrate the PDS-FLA trigger bit-layout against a known stimulus.

The FLA arm/readback recipe (the vendor's PANGO200 sequence) is bit-proven (capture() of
the free-running counter is monotonic). But the layout of the per-channel 3-bit
trigger codes inside the `capture_len = width*3+1` blob (step 16) is NOT
documented for PDS's inserted FLA. The host reference packs 128 channels one way;
our 8-channel core may differ. So we calibrate on hardware:

Decisive tell — if the trigger LOCKS, the FLA FREEZES the buffer at the match,
so sample[trig_pos] == target every run (and first-sample is constant). With a
wrong/ignored trigger the FLA free-runs and the window is RANDOM.

METHODOLOGY (critical): we must let the trigger FIRE before reading. capture()
reads immediately, so for a free-running counter the pre-trigger rolling buffer
is always a valid monotonic window and HIDES whether the trigger works. So here
we arm(), SLEEP (the counter passes every value every 256 design-clocks, so a
short sleep guarantees the match occurs + the FLA freezes), then read_samples()
directly. Sweep the 4 layout combos and report sample[trig_pos] across runs.

Run decoupled: Stop-Process cdt_js first; board must hold an armed, loaded
FLA-instrumented bitstream (flash it via cli.py first).

  python fla-trig-cal.py            # default width 8 depth 1024, value 0xA5
  python fla-trig-cal.py 8 1024 0xA5 512 3
"""
import sys
import time

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla            # noqa: E402


def value_to_pattern(value, width):
    """counter==value, channel 0 first => '0'/'1' per bit, LSB first."""
    return "".join("1" if (value >> b) & 1 else "0" for b in range(width))


def arm_wait_read(j, width, depth, pattern, trig_pos, chan_rev, msb, delay):
    """Arm with a real trigger, let it FIRE (sleep), then read the frozen buffer.
    Does NOT use capture() (which reads immediately, hiding the trigger)."""
    fla = PangoFla(j, width=width, depth=depth, trigger=pattern,
                   trig_position=trig_pos, chan_reversed=chan_rev,
                   code_msb_first=msb)
    fla.arm()
    time.sleep(delay)
    raw = fla.read_samples()
    return fla.unpack(raw)


def run(width, depth, value, trig_pos, runs, delay):
    pattern = value_to_pattern(value, width)
    print(f"width={width} depth={depth} target=0x{value:02X} pattern={pattern!r} "
          f"trig_pos={trig_pos} runs={runs} delay={delay}s\n")
    mask = (1 << width) - 1

    with MpsseJtag(index=0) as j:
        idc = j.read_idcode()
        print(f"IDCODE=0x{idc:08X}\n")
        for chan_rev in (True, False):
            for msb in (True, False):
                firsts, at_pos = [], []
                for _ in range(runs):
                    samples = arm_wait_read(j, width, depth, pattern, trig_pos,
                                            chan_rev, msb, delay)
                    firsts.append(samples[0])
                    idx = trig_pos if trig_pos < len(samples) else len(samples) - 1
                    at_pos.append(samples[idx])
                const_first = len(set(firsts)) == 1
                locked_val = len(set(at_pos)) == 1
                hit = locked_val and (at_pos[0] & mask) == value
                tag = ""
                if const_first:
                    tag = "  <== LOCKED" + ("+VALUE@trig_pos OK" if hit else "")
                # also scan whether target appears at a CONSTANT index across runs
                print(f"chan_reversed={chan_rev!s:5} code_msb_first={msb!s:5}: "
                      f"first={[f'{x:02X}' for x in firsts]} "
                      f"sample[{trig_pos}]={[f'{x:02X}' for x in at_pos]}"
                      f"{tag}")
        print("\n(buffer frozen at trigger => sample[trig_pos]==target const across "
              "runs; free-run => random)")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    tp = int(sys.argv[4]) if len(sys.argv) > 4 else 512
    n = int(sys.argv[5]) if len(sys.argv) > 5 else 3
    dl = float(sys.argv[6]) if len(sys.argv) > 6 else 0.1
    run(w, d, v, tp, n, dl)
