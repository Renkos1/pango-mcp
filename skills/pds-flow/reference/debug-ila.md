# Pango on-chip debug (ILA + virtual-IO), fully scriptable — Fabric Inserter + Fabric Debugger

Pango's on-chip logic analyzer ("debug core" / ILA) and virtual-IO are driven by two console tools the
GUI hides but that are **fully Tcl-scriptable headless**, exactly like `cdt_cfg`:
- **`cdt_ins.exe`** — Fabric **Inserter**: taps post-synthesis nets, builds a debug core, writes a `.fic`.
- **`cdt_dbg.exe`** — Fabric **Debugger**: at runtime programs the instrumented bitstream, arms/triggers,
  and dumps captured samples (VCD/ASCII/WDF). Also virtual-IO (`dbg_dvio_*`) and SerDes (`dbg_hsst_*`).

Both connect to the same resident `cdt_js.exe -port N` JTAG server used for flashing. Authoritative
manuals: `doc/Fabric_Inserter_User_Guide.pdf`, `doc/Fabric_Debugger_User_Guide.pdf` (+ `ips_debug_core`,
`ips_jtag_hub` system IPs). This is device-agnostic — works for any PC-connected Pango FPGA.

## End-to-end flow (headless, no GUI)
1. **Synthesize** (pds_shell) → `synthesize/<top>_syn.adf` (the inserter's input netlist).
2. **Author a `.fic`** naming nets to capture + a sample clock + depth + trigger (format below; hand-write it).
3. **Register the `.fic` in the project** — fill the `wgt_my_fic_src` widget inside the **`tsk_synthesis`**
   task of the `.pds`:
   ```
   (_widget wgt_my_fic_src
       (_input (_file "debug/<name>.fic" (_format text) (_timespec "<ISO>"))))
   ```
   Then a normal `pds_shell -run gen_bit_stream` inserts the core during the flow → instrumented bitstream.
   (If the design's nets change later, update the `.fic`'s net names or the inserter errors
   `E: Inserter-0005: Net '...' cannot be found` and halts dev_map — pds_shell still exits 0.)
4. **Flash** the instrumented `.sbit` (`cfg_program`).
5. **Capture** with `cdt_dbg` (program → import_fic → trigger → run → VCD).

## cdt_ins (Inserter) — invocation + commands
`cdt_ins.exe -netlist <syn.adf> -device <D> -package <P> -speedgrade <S> [-fic <in.fic>] [-file <tcl>]`
(do NOT pass `-batch`; an unknown flag makes it just print help and exit.) Tcl API:
| command | purpose |
|---|---|
| `ins_new <name>` | new project (creates `<name>.fic`) |
| `ins_set_device -family -device -package -speedgrade` | target part — **example** values, replace with YOUR target (e.g. `-family Logos2 -device PG2L100H -package FBG484 -speedgrade -6`) |
| `ins_set_file -input <adf>` | input netlist (parses → populates net DB; ~30–60 s) |
| `ins_list_nets` | print all tappable nets, `<idx> : <name> <celltype>` |
| `ins_add_core <n>` / `ins_remove_core <n>` | add/remove debug cores |
| `ins_set_core -core 0 -data_depth N -clock_edge Rising -trig_num 1 -data_same true` | core config |
| `ins_operate -core 0` | select default target core |
| `ins_set_net -connect -core 0 -clock <netidx>` | connect sample clock |
| `ins_set_net -connect -core 0 -trig 0 -channel <ch> <netidx>` | connect a trigger/data channel |
| `ins_set_trig / ins_set_unit / ins_set_condition / ins_set_capture` | trigger / match-unit / capture cfg |
| `ins_core_info -core 0` | dump the core's RESOLVED config (use to verify) |
| `ins_open <fic>` / `ins_save <name>` | open / save `.fic` |

**Big gotcha:** `ins_set_net` takes the net's **integer index**, not its name — and those indices are
**not stable across processes** (a re-parse renumbers). So scripted index-based connects are unreliable.
**Hand-write the `.fic` by net name** (names are the `.fic`'s native form), then validate with `ins_open`.

## The `.fic` format (INI; hand-writable)
> The `Project.device.*` block below is an **example** (Logos2/PG2L100H/FBG484/-6). Replace all four `device.*` fields with your real target part — board-specific physical info, no default; the tools won't guess.
```
#Fabric Core Inserter Project File
Project.device.designInputFile=<ABS path to synthesize/<top>_syn.adf>   # forward slashes
Project.device.ScanChain=1
Project.device.UserJtag=0
Project.device.deviceFamily=Logos2
Project.device.deviceModel=PG2L100H
Project.device.devicePackage=FBG484
Project.device.deviceSpeedGrade=-6
Project.Architecture=1 1 1
Project.unit.dimension=1                            # number of ILA cores
Project.unit<0>.clockChannel=<clock net>           # a REAL clock net, running at capture time
Project.unit<0>.clockEdge=Rising
Project.unit<0>.ramType=1
Project.unit<0>.dataDepth=1024                      # samples (uses DRM block RAM)
Project.unit<0>.dataEqualsTrigger=true
Project.unit<0>.enableStorageQualification=false
Project.unit<0>.triggerSequencerLevels=1
Project.unit<0>.enableMultiWindow=false
Project.unit<0>.triggerPortCount=1
Project.unit<0>.triggerChannel<0><i>=<net name>    # one per captured signal, i = 0 .. W-1
Project.unit<0>.triggerMatchCount<0>=1
Project.unit<0>.triggerMatchType<0>=1
Project.unit<0>.triggerPortIsData<0>=true
Project.unit<0>.triggerPortWidth<0>=<W>
Project.unit<0>.triggerBus<0><lo><hi>=<busbasename>            # optional display grouping
Project.unit<0>.busInserter<0><0/1/.../n>=<busbasename>
```
Net names are post-synth hierarchical names from `ins_list_nets`/`ins_core_info`, e.g.
`u_sub/u_inner/sig[0]`. (2022.2 uses NO space before `[`; older 2020.x put a space before `[` for
sub-module buses.) **Validate before building** (no rebuild needed):
`cdt_ins -netlist <adf> -device ... -file val.tcl`, where `val.tcl = { ins_open <fic>; ins_core_info -core 0 }`
— every channel must echo back its resolved name and the clock must resolve.

## cdt_dbg (Debugger) — invocation + capture recipe
`cdt_dbg.exe -file <tcl>` (Tcl-batch, like cdt_cfg). 2025.2 headless capture → VCD (every command targets a core via `-fla <n>` — there is no per-session "current core"):
```tcl
dbg_connect -ip 127.0.0.1 -port 65420
dbg_scan_chain                                    ;# no args
dbg_program -device 0 -file <instrumented.sbit>   ;# path: '/' or '\\', never a single '\'
dbg_import_fic -device 0 -file <name>.fic
dbg_fla_set_capture -fla 0 -type n -samples 1024  ;# type N/n/1=Nsamples, W/w/0=Windows
dbg_fla_run -device 0 -fla 0                       ;# BLOCKS until capture done; default cond 0 = immediate trigger
dbg_fla_export_wf_data -device 0 -fla 0 -format vcd -file <path>   ;# -format is required
dbg_disconnect
dbg_close
```
Triggered (vs immediate) capture — **order matters**, you must `-add` the condition first (the default cond 0 is all-don't-care and fires immediately):
```tcl
dbg_fla_set_trig_cond -fla 0 -add <Cond>
dbg_fla_set_trig_unit -fla 0 -unit 0 -func 0 -radix 2 -value <v>   ;# func 0..7 = == <> > >= < <= InRange OutOfRange ; radix 0..3 = Bin/Oct/Hex/UDec
dbg_fla_set_trig_cond -fla 0 -select <Cond> -set {TU0}
dbg_fla_set_trig_cond -fla 0 -active <Cond>
dbg_fla_run -device 0 -fla 0
```
Do **not** use `-async` + `dbg_fla_trig_immd` (latches an error state); after any error run `clean` to clear the latch or later commands fail. **ADC**: `dbg_adc_read_reg -address <hex>` / `dbg_adc_write_reg -address <hex> -value <v>`. Reads: `dbg_read_device_id`,
`dbg_read_user_code`, `dbg_read_status_register`, `dbg_list -core *`.
**Virtual-IO** (drive/read live signals over JTAG, no rebuild to change values):
`dbg_select_current_dvio -device 0 -dvio 0`; `dbg_dvio_set_output -probe_out 0 -value <v>` +
`dbg_dvio_commit_output -probe_out 0`; `dbg_dvio_refresh_input` + `dbg_dvio_print`.
**SerDes/HSST**: `dbg_hsst_start -scan 0` / `dbg_hsst_stop`, `dbg_read/write_hsst_register`.

## Gotchas (shared by cdt_ins / cdt_dbg)
- **Paths: use `/` (or `\\`), never a single `\`** — the Tcl layer strips lone backslashes
  ("couldn't read file ...D:Admin..."), and `dbg_program` says so explicitly.
- GUI-subsystem exes but run **headless** with `-file`; launch hidden + a `WaitForExit(ms)`+`Kill` guard.
  `puts` goes to stdout (capture via `-RedirectStandardOutput`). They may not exit cleanly after the
  script — end the tcl with `catch {exit}` and keep the timeout backstop.
- **Every command supports `-help`**, and `<tool>_help` lists all commands — probe a fresh install's exact
  syntax by running each `<cmd> -help` in a `-file` script (zero hardware needed).
- After ANY command error, cdt_ins **latches** ("please run command clean before running again") and
  ignores the rest of the script. There is no working `clean` command — fix the offending line and relaunch.
- Brace net names in Tcl so `[..]` isn't command-substituted: `{u_sub/.../sig[0]}`.
- Budget: an ILA adds a debug core + JTAG hub + capture RAM (`dataDepth × width` bits of DRM). Check
  utilization headroom first (`device_map/<top>_dmr.prt` / `place_route/<top>.prr` "Device Utilization Summary").

## Worked example
A 16-channel core tapping a DMA datapath (data buses + a few control strobes), sample clock = the PCIe
`pclk_div2` net, depth 1024, registered in the `.pds` `wgt_my_fic_src` and built by the normal headless
flow (log shows `>Generating core DebugCore0...` and `u_CORES/u_debug_core_0/...` instances; the ILA
added ~FF +446 / LUT +316 / +1 USCM for the JTAG hub). Flashed, exercised the design, then captured with
`dbg_connect → dbg_scan_chain → dbg_import_fic` (**"Import Core: 0 OK"**) `→ dbg_list`
(**"CORE:MyFLA0"**) `→ dbg_fla_set_capture -fla 0 -type n -samples 1024 → dbg_fla_run -device 0 -fla 0` → wrote `data.wf` = 1024 samples ×
17 bits (16 channels + 1). **Liveness proof:** two captures seconds apart while the design ran differ in
all bytes — the ILA reads live internal state over JTAG. The native `.wf` is bit-packed (W+1 bits/sample,
MSB-first); for legible values decode by channel order or export a VCD. If your capture window
(`depth / clk`) is shorter than the event you watch, the signal looks static within one window — deepen
the capture or trigger on a strobe and re-capture.
