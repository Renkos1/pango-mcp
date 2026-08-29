# Scenario spec — democount

## Intended behavior
- `democount` is a free-running counter clocked by `clk`.
- Internal register `q[3:0]` increments by **1** every rising clock edge: 0,1,2,…,15,0,…
- `led[3:0]` mirrors `q`; `led[4]` is the parity of `q`.
- Top ports are **`clk` (input) + `led[4:0]` (output) only** — they map to the
  board Target Profile pins. `q` is internal (no pin) and is the signal to observe
  on-chip via ILA.

## The bug (in `democount_buggy.v`)
- `q` increments by **2** (0,2,4,…) instead of 1. The self-checking testbench
  `tb_democount.v` $fatals at the first step. Fix the increment to `+1`.

## How to verify on the real board (ILA)
- Build for the board via the **Target Profile** (`board:lab15` — do NOT hand-type
  device/package/pins; they come from the profile).
- Flash, then ILA-capture the internal **`q`** signal and confirm on real hardware
  that `q` ticks by 1 each clock (0→1→2→…), matching this spec.
- `q` updates every clock (fast) — a default capture window shows it; if you ever
  need to frame a slow/rare signal, configure the capture (samples/windows/trigger),
  do **not** modify the design to suit the debugger.
