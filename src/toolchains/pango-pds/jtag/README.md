# pango_jtag — headless bare-metal JTAG for Pango (Logos2)

A standalone Python tool that talks JTAG to a Pango FPGA **directly over the
FT2232 (USB Cable II) via `ftd2xx.dll` + MPSSE** — no vendor GUI, no `cdt_dbg`,
no `cdt_cfg`-on-cable and no driver swap. The CLI is standalone and the same
path is exposed through the MCP as `fpga_jtag_*`. It **configures the SRAM
(flashes)** by replaying a CRAM SVF and **captures the on-chip FLA waveform**
that the vendor's headless debugger cannot (`cdt_dbg open_cable` hangs).

Proven again through one persistent MCP session on PG2L200H (2026-07-10):
read-only scan `0x10603899` → guarded volatile SRAM flash with done bit → 1024×4
FLA capture, 16 distinct values, only step `[1]`, monotonically wrapping. See
[FINDINGS.md](FINDINGS.md) for the protocol/root-cause story.

## Layout

| file | role |
|------|------|
| `mpsse_jtag.py` | transport: MPSSE TAP walk + `shift_ir`/`write_dr`/`read_dr` + streaming shift |
| `fla_pango.py`  | FLA arm + sample readback (PANGO200 recipe), sample decode |
| `svf_player.py` | SVF parser + player (SIR/SDR/RUNTEST/STATE) — the bare-metal flash |
| `export.py`     | VCD / JSON / CSV writers + summary (pure, no deps) |
| `cli.py`        | the `pango_jtag` CLI (`scan`, `gen-svf`, `flash`, `capture`) |

## Usage

> **Cable ownership rule:** one physical cable must use one driver path at a
> time. For direct CLI use, first close the PDS/Fabric Debugger session that
> owns it; do not kill a process that may belong to another user/session. Inside
> MCP, use the all-bare local sequence `fpga_jtag_scan → fpga_jtag_flash →
> fpga_jtag_capture`; do not precede it with a local PDS/CDT scan or flash in the
> same persistent server. Remote Target Profiles intentionally retain PDS/CDT.

```sh
# detect device(s)
python cli.py scan

# one-shot flash from .sbit: caches a CRAM .svf next to it (mtime-checked,
# auto-regenerated when stale via cdt_cfg) — ~15s @6MHz, verifies done bit
python cli.py flash --sbit verify/.work/pdsblink/.../top.sbit

# or replay a CRAM SVF you already have / shipped
python cli.py flash --svf top_cram.svf

# offline .sbit -> CRAM .svf (no cable, cdt_cfg_shell only)
python cli.py gen-svf --sbit top.sbit

# capture, deriving width/depth/signal-names from the design's .fic
python cli.py capture --fic debug/counter_ila.fic \
    --vcd out.vcd --json out.json --csv out.csv

# or specify the shape explicitly
python cli.py --channel 0 capture --width 8 --depth 1024 \
    --signals 'd[0],d[1],d[2],d[3],d[4],d[5],d[6],d[7]' --vcd out.vcd
```

The MCP mutation surface adds a safety contract around the direct CLI:
`fpga_jtag_flash` requires `confirm:true` and a recognizable `expectIdcode`,
runs a fresh bare read-only scan before replay, compares the lower 28 IDCODE
bits, and still relies on the SVF's in-stream IDCODE and done-bit checks. It
returns without starting Python or touching the cable when confirmation is
missing. `fpga_jtag_capture` returns the compact structured summary
`{idcode,sampleCount,width,distinct,steps,monotonic}` while samples stay in the
requested VCD/JSON/CSV artifacts.

`--fic` reads `triggerChannel<0><i>` (signal names, LSB first) and `dataDepth`
from a Pango Fabric-Inserter `.fic`; explicit `--width/--depth/--signals`
override. Nothing device-specific is baked in.

The VCD opens in GTKWave or the repo's `waveform_viewer.mjs`.

## Generating the CRAM SVF (offline — no cable)

`flash --sbit` does this for you (caches the result next to the `.sbit`). If
you need just the conversion (e.g. to ship the SVF without flashing), use
`gen-svf` — it shells out to `cdt_cfg_shell.exe` with `cfg_one_step_create_svf`,
zero cable touch:

```sh
python cli.py gen-svf --sbit top.sbit                # → top_cram.svf alongside
python cli.py gen-svf --sbit top.sbit --svf out.svf  # explicit output path
```

The PDS bin dir is auto-resolved from `PANGO_MCP_PDS_BIN` / `PANGO_MCP_PDS_2025`
/ `PANGO_MCP_PDS_2022` env (or `--pds-bin`). License from `PANGO_LICENSE_FILE`
(or `--license`). `--property` defaults to `0x40C4E` = mode bits17-16 = 0
(**CRAM/SRAM**) + bit11 (check done) + 1MHz hint; `-jtag_chain 0` is fixed
(single device, skip live scan). SVF is cacheable/shippable.

## Prerequisites

- An **FLA-instrumented bitstream** built (via the MCP ILA flow or PDS) and its
  **CRAM SVF** generated (above). `flash` loads it; nothing else needed.
- The cable's `ftd2xx.dll` (installed with PDS).

## Capture framing and diagnostics

- Always-true and value/edge-triggered capture are supported. Trigger alignment
  comes from the per-sample marker lane; the status-register decode remains a
  diagnostic path and does not gate capture.
- `.fic` exposes the logical width but not the physical JTAG sample stride. A
  standard PDS core uses `width+1`, while a hardware-proven wider protocol shape
  uses additional lanes, so `ceil(width/8)` is only a bounded compatibility
  probe size—not a physical-width formula. The reader starts with the canonical
  `width+1` shape, widens the read only when its protocol lane is inconsistent,
  and infers a candidate solely from padding-lane evidence. Material ambiguity
  fails closed and can be resolved with explicit `--padding-bits`.
- Every CLI/MCP result exposes `paddingOneCounts`, header/tail values, candidate
  scores, exact frame/read lengths, and the selection source. `--raw` persists
  the step-29 TDO stream as LSB-first packed bytes for offline verification.
