"""Decisive hardware test for the value-trigger fix (status-read length bug).

Root cause found 2026-06-23: poll_status read 32 bits, but the vendor's step 27
(line 3777) reads `r_ila_depth_len` bits and the HW tests w_tdo_reg[31:29] = the
LAST 3 bits shifted. Reading 32 put the flag 16 bits out of position, so 010 was
never seen and capture() skipped the trigger-wait entirely -> value triggers read
an un-frozen window = random sample[0].

This test, against the loaded free-running counter (width 8 depth 1024):
  1. dumps poll_status at the CORRECTED depth_len length so we can finally SEE the
     status register and whether it reaches 010 (triggered);
  2. runs capture() (which now waits) several times with a value trigger and
     checks sample[trig_pos]==value and that it's CONSTANT across runs.

Decisive: trigger works => buffer freezes => sample[trig_pos]==target, constant
across runs. Free-run => random.

Run decoupled (Stop-Process cdt_js first); board must hold the armed, loaded
FLA-instrumented bitstream.

  python fla-trig-poll.py                 # width 8 depth 1024 value 0xA5 trig_pos 512
  python fla-trig-poll.py 8 1024 0xA5 512 5
"""
import sys
import time

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla            # noqa: E402


def value_to_pattern(value, width):
    """counter==value, channel 0 (LSB) first => '0'/'1' per bit."""
    return "".join("1" if (value >> b) & 1 else "0" for b in range(width))


def run(width, depth, value, trig_pos, runs):
    pattern = value_to_pattern(value, width)
    mask = (1 << width) - 1
    print(f"width={width} depth={depth} target=0x{value:02X} pattern={pattern!r} "
          f"trig_pos={trig_pos} runs={runs}")

    with MpsseJtag(index=0) as j:
        idc = j.read_idcode()
        print(f"IDCODE=0x{idc:08X}  depth_len={PangoFla(j, width, depth).depth_len}\n")

        # --- 1. baseline: always-true capture must still be monotonic ----------
        fla0 = PangoFla(j, width=width, depth=depth)           # all-X trigger
        raw0, s0 = fla0.capture()
        steps = sorted({(s0[i + 1] - s0[i]) & mask for i in range(len(s0) - 1)})
        print(f"[always-true] first8={[f'{x:02X}' for x in s0[:8]]} "
              f"distinct-steps={steps}  (expect [1] monotonic)\n")

        # --- 2. status visibility: arm a value trigger, dump raw poll reads ----
        fla = PangoFla(j, width=width, depth=depth, trigger=pattern,
                       trig_position=trig_pos)
        fla.arm()
        print("[poll dump] raw status reads at corrected depth_len length:")
        seen_ready = False
        for k in range(8):
            st = fla.poll_status()
            top3 = (st >> (fla.depth_len - 3)) & 0b111
            ready = "  <== 010 TRIGGERED" if top3 == 0b010 else ""
            seen_ready = seen_ready or top3 == 0b010
            print(f"   #{k}: status=0x{st:04X} top3=0b{top3:03b}{ready}")
            time.sleep(0.02)
        print(f"   -> reached 010 at least once: {seen_ready}\n")

        # --- 3. decisive: capture() with the wait; sample[trig_pos] constancy --
        firsts, at_pos, fired = [], [], []
        idx = trig_pos if trig_pos < depth else depth - 1
        for _ in range(runs):
            raw, samples = fla.capture()   # auto-waits: real trigger detected
            firsts.append(samples[0])
            at_pos.append(samples[idx])
            # 'fired' = did wait_triggered succeed? re-derive: non-degenerate read
            fired.append(len(set(samples)) > 1)
        const_first = len(set(firsts)) == 1
        locked = len(set(at_pos)) == 1
        hit = locked and (at_pos[0] & mask) == value
        print(f"[value-trig] first={[f'{x:02X}' for x in firsts]}")
        print(f"[value-trig] sample[{idx}]={[f'{x:02X}' for x in at_pos]}")
        print(f"  const_first={const_first} locked@trig_pos={locked} "
              f"value_match={hit}")
        if hit:
            print("\nRESULT: PASS — FLA froze at the value trigger (constant + matches).")
        elif const_first:
            print("\nRESULT: PARTIAL — buffer froze (constant) but value@trig_pos "
                  "!= target; check trig_pos / sample framing offset.")
        else:
            print("\nRESULT: FAIL — still free-running (random). Trigger not engaging "
                  "via this path even with corrected status poll.")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    tp = int(sys.argv[4]) if len(sys.argv) > 4 else 512
    n = int(sys.argv[5]) if len(sys.argv) > 5 else 5
    run(w, d, v, tp, n)
