---
name: pds-flow
description: Compile, scan, and flash a Pango Design Suite (PDS) FPGA design fully headlessly (no GUI) — build a bitstream from source, scan the JTAG chain, identify IDCODEs, and program FPGA SRAM or on-board SPI flash, plus scripted on-chip debug (ILA/virtual-IO). Use for any Pango/Logos FPGA build or programming task, or when reading/editing .pds project files, .fdc constraints, or cdt_cfg/cdt_ins/cdt_dbg .tcl scripts. General-purpose / device-agnostic; examples use Logos2 PG2L100H.
---

# Pango Design Suite — headless compile / scan / flash / debug

Everything PDS does from the GUI can be driven headlessly with a handful of console tools. This skill
is the reference for the **control tools, the project/constraint/bitstream file formats, and the exact
cdt_* Tcl** so a fresh session can do the full workflow correctly. Device-specific values below
(IDCODE, device name, flash part, install path) are EXAMPLES — swap for your part/install.

- Toolchain bin dir: your PDS install, e.g. `<PDS_INSTALL>\bin` (`pds_shell.exe`, `cdt_js.exe`,
  `cdt_cfg.exe`, `cdt_ins.exe`, `cdt_dbg.exe` all live there).
- Tested against **PDS 2022.2-SP4.2**; examples use **Logos2 PG2L100H / FBG484 / -6**.

For the exhaustive Tcl command list + ready-to-run scripts see **`reference/cdt-tcl-commands.md`**;
for the .pds/.fdc/.sbit/.sfc formats and the build-stage internals see
**`reference/pds-project-and-flow.md`**; for scripted ILA/virtual-IO debug see **`reference/debug-ila.md`**.

## The control tools (+ the GUI to avoid)
| tool | role | invocation |
|---|---|---|
| **`pds_shell.exe`** | headless flow engine (synth→map→pnr→bitstream) | `pds_shell.exe -project <x.pds> -run <action>` |
| `pds.exe` | Qt **GUI** — **do NOT** use for headless: `-project -run` opens the GUI and idles | (interactive only) |
| **`cdt_js.exe`** | JTAG **download server** (cable daemon) | `cdt_js.exe -port <N>` (default 65420) |
| **`cdt_cfg.exe`** | Fabric **Configuration** tool (the programmer; runs `cfg_*` Tcl) | `cdt_cfg.exe -file <script.tcl>` |
| **`cdt_ins.exe`** | Fabric **Inserter** (build a debug/ILA core → `.fic`) | `cdt_ins.exe -netlist <adf> ... -file <tcl>` |
| **`cdt_dbg.exe`** | Fabric **Debugger** (program + trigger + dump waveform; virtual-IO) | `cdt_dbg.exe -file <tcl>` |

`cdt_cfg`/`cdt_ins`/`cdt_dbg` are Tcl interpreters; `cdt_cfg`/`cdt_dbg` connect to a running `cdt_js`
over TCP. Start `cdt_js` once (it stays resident), then run any number of script invocations.

## 1) Compile (source → bitstream), headless
```
pds_shell.exe -project <design.pds> -run gen_bit_stream
```
- Runs the full flow: **compile → synthesize → device_map → place_route → report_timing →
  generate_bitstream**. Output: `generate_bitstream/<top>.sbit`. Minutes, scales with the design.
- **Use `pds_shell.exe`, never `pds.exe`** for this (pds.exe opens the GUI and hangs).
- Valid `-run` targets: `compile`, `synthesize`, `dev_map` (note: NOT `device_map`), `pnr` (NOT
  `place_route`), `report_timing`, `gen_bit_stream`, `report_power`, `gen_netlist`. Use an early
  target (e.g. `-run dev_map`) for a fast compile+resource check without P&R.
- **pds_shell exits 0 even when a stage errors** — never trust the exit code alone; grep the log for
  `^E:` (errors are `E:`-prefixed) and for the success line `The bitstream file is "...<top>.sbit"`.
- **Encryption caveat (some machines):** if a transparent-encryption agent is present (e.g. a DLP/EDR
  tool that hooks file writes), files written by a *monitored* app (the GUI launched from Explorer)
  may be encrypted at rest — a GUI-built `.sbit` is then garbage to the programmer. Files written by an
  *unmonitored* process (anything you launch from a shell) stay plaintext. **So always (re)build with
  `pds_shell` from a shell; never reuse the GUI's bitstream.** Self-check the `.sbit`: a plaintext one
  must NOT contain the encryptor's ASCII marker in its header.
- Stages leave dirs (`compile/ synthesize/ device_map/ place_route/ report_timing/
  generate_bitstream/ constraint_check/`) — regenerable; gitignore them.

## 2) Scan the JTAG chain (read-only) — ALWAYS before flashing
```tcl
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
cfg_read_device_property -mode 0 -device_index 0   ;# -> "The ID value is: 0x........"
cfg_disconnect
cfg_close
```
Run via `cdt_cfg.exe -file scan.tcl` (start `cdt_js -port 65420` first). The IDCODE identifies the
part and which `-device_index` it is. **Confirm the index before programming so you never flash the
wrong device** (e.g. a 2-FPGA chain: program the right one). Example IDCODEs: PG2L100H=`0x00602899`,
PG2L200H=`0x00603899` (the IDCODE top nibble is a silicon-revision field — the low 28 bits identify
the part, so `0x1060...` vs `0x0060...` are the same part at different revs).

## 3a) Flash FPGA SRAM (volatile, fast — dev default)
```tcl
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
cfg_assign_file -file <design.sbit> -device_index 0
cfg_program -device_index 0          ;# -> "The done bit is 1" on success
cfg_disconnect
cfg_close
```
Loads the bitstream into the FPGA's config SRAM. **Volatile** (cleared on FPGA power-cycle), seconds,
reversible — ideal for iteration. (A PCIe endpoint re-trains its link on reprogram → the host may
need to re-enumerate the device before using it.)

## 3b) Flash on-board SPI flash (persistent)
Program through the FPGA's **JTAG→SPI bridge** (`cfg_jtag_flash_*`), NOT the cable's direct-SPI path
(`cfg_flash_*`, which often reads `0xffffff` on boards where the flash hangs off the FPGA). Needs a
generated `.sfc` (not the raw `.sbit`):
```tcl
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
cfg_set_cable_property -index 0 -freq 5Mhz
cfg_gen_sfc -sbit <design.sbit> -sfc <design.sfc> -device_name <FLASH_PART>
cfg_jtag_flash_scan_device  -device_index 0
cfg_jtag_flash_assign_file  -file <design.sfc> -device_index 0
cfg_jtag_flash_erase        -device_index 0
cfg_jtag_flash_program      -device_index 0
cfg_jtag_flash_verify       -device_index 0     ;# must report success
cfg_disconnect
cfg_close
```
`-device_name` = the on-board flash part (e.g. Winbond `W25Q128Q`, JEDEC 0xEF4018). Persistent
(survives power-cycle). Lower the cable freq (5 MHz) for reliable flash detect/program.

## 4) On-chip debug — ILA capture + virtual-IO (scripted, no GUI)
Everything the GUI's Fabric Inserter/Debugger do is Tcl-scriptable headless via **`cdt_ins.exe`**
(insert a debug core tapping named nets → writes a `.fic`) and **`cdt_dbg.exe`** (program + trigger +
dump a VCD over JTAG; plus runtime virtual-IO `dbg_dvio_*` and SerDes `dbg_hsst_*`). Flow: synth →
author a `.fic` → register it in the `tsk_synthesis` `wgt_my_fic_src` widget of the `.pds` →
`pds_shell -run gen_bit_stream` builds an **instrumented** bitstream → flash → `cdt_dbg` captures.
Full command surface, the hand-writable `.fic` format, and gotchas (paths need `/` not `\`;
`ins_set_net` connect-by-index is unstable so hand-write the `.fic` by net name and validate with
`ins_open`) are in **`reference/debug-ila.md`**.

NB: if a stale `.fic` is registered in `wgt_my_fic_src` and you change the design, the inserter can
fail (`E: Inserter-0005: Net '...' cannot be found after flattened net list`) and **halt dev_map**
(pds_shell still exits 0 → grep the log). Fix: update the net name or empty the `wgt_my_fic_src` widget.

## .pds / .fdc / .sbit / .sfc (the files)
- **`.pds`** — project file, an **S-expression** tree: `(_flow ... (_task tsk_setup
  (_widget wgt_select_arch (_input (_part (_family ..)(_device ..)(_speedgrade ..)(_package ..))))
  (_widget wgt_my_design_src (_input (_file "rtl/x.v" (_format verilog) (_timespec "..")) ...))))`.
  To **add a source**: insert a `(_file "<relpath>" (_format verilog) (_timespec "<ISO>"))` block in
  the `wgt_my_design_src` `_input`. Paren-balance must stay equal. The first source can carry the top:
  `(_file "rtl/top.v" + "top" (_format verilog) ...)`. `pds_shell` rewrites the `.pds` each run
  (normal) — your source-list edits are preserved. You can also **hand-write a minimal `.pds` from
  scratch** (see `reference/pds-project-and-flow.md`).
- **`.fdc`** — Fabric Design Constraints: pin LOC, IO standard, timing. Referenced by the project.
- **`.sbit`** — the bitstream (SRAM/JTAG config).  **`.sfc`** — SPI-flash image (from `cfg_gen_sfc`).
- Keep an independent plaintext control copy (`design.plain.pds` → `top.plain.fdc`) if a GUI / sync
  agent might re-encrypt the originals; point `pds_shell` at the control copy.

## Gotchas
- `pds.exe -project ... -run ...` hangs (GUI). Use `pds_shell.exe`.
- pds_shell exits 0 on stage errors → ALWAYS grep the log for `^E:` (and the bitstream success line).
- A benign `IPSpecCheck ... fifo ... WR_ADDR_WIDTH` warning is non-fatal.
- `cdt_js` must be running before `cdt_cfg`/`cdt_dbg`; it's resident (start once).
- Scan and confirm IDCODE/device_index before any `cfg_program`/`cfg_jtag_flash_*`.
- In Tcl `-file` paths use `/` (or `\\`), never a single `\` (the Tcl layer strips lone backslashes).
- A clock entering on a non-clock-capable IO pad fails P&R (`E: Place-0084`) and produces NO bitstream —
  route it through a PLL (see `reference/pds-project-and-flow.md`).
