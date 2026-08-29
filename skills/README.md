# Pango Design Suite (PDS) — headless workflow skill

A self-contained, **device-agnostic** Claude skill for driving the Pango Design Suite FPGA toolchain
entirely from the command line (no GUI): build a bitstream from source, scan the JTAG chain, flash
FPGA SRAM or on-board SPI flash, and run scripted on-chip debug (ILA capture + virtual-IO). Distilled
from real bring-up on Logos2 (PG2L100H / PG2L200H), but the commands and file formats apply to any
PC-connected Pango FPGA.

## What's inside
```
pds-flow/
  SKILL.md                              # the skill: the control tools + the full compile/scan/flash/debug workflow
  reference/
    pds-project-and-flow.md             # .pds (S-expr) / .fdc editing, build stages, reports, new project, PLL clocking
    cdt-tcl-commands.md                 # cdt_cfg Tcl command reference + 3 ready-to-run scripts (scan / SRAM / SPI flash)
    debug-ila.md                        # cdt_ins / cdt_dbg: scripted ILA + virtual-IO, the hand-writable .fic format
```

## Highlights / things you won't find in the GUI docs
- **`pds_shell.exe -project <x.pds> -run gen_bit_stream`** builds headlessly; `pds.exe` only opens the
  GUI. `-run` targets: `compile/synthesize/dev_map/pnr/report_timing/gen_bit_stream/...`.
- **pds_shell exits 0 even on stage errors** — always grep the log for `^E:` and the bitstream success line.
- **`cdt_js` (server) + `cdt_cfg` (programmer)** do all flashing via `cfg_*` Tcl. On-board SPI flash goes
  through the FPGA's **JTAG→SPI bridge** (`cfg_jtag_flash_*`), not the cable's direct path.
- **`cdt_ins` / `cdt_dbg`** make the on-chip logic analyzer fully scriptable; the `.fic` debug-core file
  is plain INI you can **hand-write by net name** (the GUI's index-based connect is unstable).
- **Hand-writable minimal `.pds`** to start a project from scratch; **route a non-clock-capable IO clock
  through a PLL** to avoid the `Place-0084` no-bitstream failure.

## Install as a Claude / Claude Code skill
Copy the `pds-flow/` folder into your skills directory:
- Project-local: `<repo>/.claude/skills/pds-flow/`
- User-global:   `~/.claude/skills/pds-flow/`  (Windows: `%USERPROFILE%\.claude\skills\pds-flow\`)

Then invoke it with `/pds-flow` (or it auto-applies on Pango/PDS tasks via the `description` frontmatter).

## Adapt to your setup
The docs use EXAMPLE values — replace with yours:
- **Install path**: `<PDS_INSTALL>\bin` (the example is `D:\pango\PDS_2022.2-SP4.2-ads\bin`).
- **Part**: examples are Logos2 `PG2L100H / FBG484 / -6`.
- **IDCODEs**: `PG2L100H=0x00602899`, `PG2L200H=0x00603899` (top nibble = silicon rev).
- **Flash part**: example `W25Q128Q` (Winbond, JEDEC 0xEF4018).
- **Encryption note**: only relevant if your machine runs a transparent file-encryption / DLP agent;
  if so, always build with `pds_shell` from a shell and never reuse a GUI-written `.sbit`.

Tested against **PDS 2022.2-SP4.2**.
