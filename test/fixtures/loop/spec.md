# spec — `counter_ld` (closed-loop validation scenario, brief 009)

A 4-bit synchronous up-counter with synchronous load. This is the bounded,
ILA-observable scenario for the v0.2 real-engine closed loop: the agent gets the
**buggy** RTL + this spec, reads the failing sim/assert, fixes the RTL, re-runs to
green; afterwards the architect drives compile → flash → ILA capture to verify the
real-board behavior against this spec.

## Interface (frozen — good, buggy, and TB all share it)

| port | dir | width | meaning |
|------|-----|-------|---------|
| clk  | in  | 1     | clock (rising edge) |
| rst  | in  | 1     | synchronous reset, active-high |
| en   | in  | 1     | count enable |
| ld   | in  | 1     | synchronous load; **priority over `en`** |
| din  | in  | 4     | load value |
| q    | out | 4     | counter value (register output) |

## Behavior (per rising clk edge, priority order)

1. `rst` → `q <= 0`
2. else `ld` → `q <= din`   (load wins over count)
3. else `en` → `q <= q + 1` (wraps 15 → 0)
4. else      → `q` holds

The bug in `counter_ld_buggy.v`: the `ld` branch is missing, so a load is silently
dropped and the counter just keeps counting (or holds). The fix is to restore
`else if (ld) q <= din;` with priority above `en`.

## Expected q sequence (good version, as checked by `tb_counter_ld.v`)

| stage | stimulus before this rising edge | expected q |
|-------|----------------------------------|-----------|
| 1 | rst=1                            | 0  |
| 2 | rst=0, en=1                      | 1  |
| 3 | en=1                             | 2  |
| 4 | en=1                             | 3  |
| 5 | ld=1, din=9, en=1  (**load**)    | 9  |  ← buggy version fails here
| 6 | ld=0, en=1                       | 10 |
| 7 | en=0  (**hold**)                 | 10 |

Self-check rule (no-mock, matches the repo convention): the TB calls `$fatal` on
any mismatch → `fpga_sim` returns `ok:false`; an all-pass run ends in `$finish`
with a log free of error/fail/fatal tokens → `ok:true`.

## ILA observation points (for on-board verification)

- **Capture signal:** `q[3:0]` (plain register output — directly ILA-capturable).
- **Trigger:** rising edge of `ld` (or free-run, then inspect the window around it).
- **Pass criteria on captured waveform:**
  1. After the cycle where `ld=1, din=N`, the very next sample has `q == N`
     (with `din=9` → `q==9`); load is **not** delayed and **not** dropped.
  2. With `ld=0, en=1`, `q` increments by 1 each cycle from the loaded value.
  3. With `en=0, ld=0`, `q` holds.
- The buggy build would instead show `q` ignoring `din` (continuing to count /
  hold through the load cycle) — that is the on-board signature of the bug.
