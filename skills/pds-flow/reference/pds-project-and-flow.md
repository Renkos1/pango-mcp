# .pds / .fdc / bitstream + the build flow (internals)

## .pds project file (S-expression)
A `.pds` is a parenthesized S-expression tree. The parts you edit programmatically:

```
(_flow fab_demo "2022.2-SP4.2"
    (_project (_option prj_work_dir (_string ".")) (_option prj_impl_dir (_string ".")))
    (_task tsk_setup
        (_widget wgt_select_arch
            (_input (_part (_family Logos2) (_device PG2L100H) (_speedgrade -6) (_package FBG484))))
        (_widget wgt_my_design_src
            (_input
                (_file "rtl/top.v" + "top"             ;; ' + "top"' marks the top module
                    (_format verilog) (_timespec "2026-06-04T21:40:25"))
                (_file "rtl/other.v" (_format verilog) (_timespec "2026-06-04T15:41:18"))
                (_file "ipcore/foo/foo.v" (_format verilog) (_timespec "..."))
                ...))))
```

> ⚠️ The `_part` above (Logos2/PG2L100H/-6/FBG484) is an **example**. The part is board-specific — replace family/device/speedgrade/package with your real target (user / board / Target Profile); the tools ship no default and won't guess. A device has several package options, so the package isn't derivable from the device. Copying the example package onto another device fails the build.

Editing rules:
- **Add a source**: insert a `(_file "<relpath>" (_format verilog) (_timespec "<ISO8601>"))` block
  inside the `wgt_my_design_src` `_input`. Relative paths are fine (`../../shared/x.v`).
- **Set the top**: the top module's file uses `(_file "rtl/top.v" + "top" ...)`.
- **Set the device**: the `_part` under `wgt_select_arch`.
- **Paren balance must stay equal** — count `(` vs `)`; a mismatch breaks parsing. After bulk edits,
  verify `txt.count("(") == txt.count(")")`.
- `pds_shell` **rewrites the `.pds`** on each run (updates timestamps/comments); your source-list and
  device edits are preserved. Don't be alarmed by a post-build diff.
- Keep a control plaintext copy `design.plain.pds` (pointing at `top.plain.fdc`) immune to GUI/agent
  re-encryption; pass it to `pds_shell -project`.

### Python helper to bulk-add sources (pattern)
```python
import glob, os, re
PDS = "design.pds"; HERE = os.path.dirname(os.path.abspath(PDS)); TS = "2026-06-05T12:00:00"
files = sorted({os.path.relpath(p, HERE).replace("\\","/")
                for pat in ("rtl/**/*.v","ipcore/**/*.v")
                for p in glob.glob(os.path.join(HERE,pat), recursive=True)
                if not p.endswith(("_tb.v","_tmpl.v"))})
txt = open(PDS, encoding="utf-8").read()
new = [p for p in files if f'"{p}"' not in txt]
block = "".join(f'                (_file "{p}"\n                    (_format verilog)\n'
                f'                    (_timespec "{TS}")\n                )\n' for p in new)
m = re.search(r'(\(_file "rtl/anchor\.v".*?\n\s*\)\n)', txt, re.S)  # insert after an anchor _file
txt = txt[:m.end()] + block + txt[m.end():]
open(PDS,"w",encoding="utf-8").write(txt)
assert txt.count("(") == txt.count(")"), "paren mismatch!"
```
(If the machine's Python `site` module is broken, run with `python -S`.)

## .fdc — constraints
Fabric Design Constraints: pin LOC, IO standard/drive, clock/timing. Referenced by the project (the
`.pds` points at `constraints/top.fdc`). Editing pins/timing happens here, not in the `.pds`.

## Build flow stages (what `pds_shell -run gen_bit_stream` does)
`compile` → `synthesize` (ADS synth) → `device_map` → `place_route` (incl. auto hold-violation fix) →
`report_timing` / `report_power` → `generate_bitstream`. Each leaves a same-named dir. Watch the log:
- `Analyzing module X` / `Elaborating module X` — front end; an `E: Verilog-...: X referenced to
  undefined module` here means a source/IP is missing from the `.pds` list.
- `Placement done` / `Routing done` / `The bitstream file is "...gen.../<top>.sbit"` — success.
- Errors are prefixed `E:`; grep the log for `^E:`. **pds_shell exits 0 even when a stage errors**, so
  the log grep is mandatory — don't trust the exit code.
- `-run` target names: `compile`, `synthesize`, `dev_map`, `pnr`, `report_timing`, `gen_bit_stream`,
  `report_power`, `gen_netlist` (note `dev_map`/`pnr`, not `device_map`/`place_route`).

## Reading the reports (resources + timing)
- **Utilization**: `place_route/<top>.prr` (and `device_map/<top>_dmr.prt`) has a "Device Utilization
  Summary" table (FF / LUT / DRM / GPLL / IO ...). `-run dev_map` is enough to get mapped resources
  without a full P&R.
- **Timing**: `place_route/<top>_timing_summary_after_hold_fix.txt` lists Setup/Hold per clock pair
  with WNS/TNS. `TNS=0` on every row = met. A negative WNS row names the launch→capture clock pair of
  the violation (commonly an unconstrained async clock-domain crossing — fix with synchronizers + a
  false-path/max-delay constraint, not by chasing the path).

## Outputs
- **`generate_bitstream/<top>.sbit`** — bitstream for SRAM (`cfg_program`) or JTAG (`cfg_assign_file`).
- **`<top>.sfc`** — SPI-flash image, produced on demand by `cfg_gen_sfc -sbit ... -sfc ...`.
- A plaintext `.sbit` must not contain a transparent-encryptor's ASCII marker in its head (self-check).

## Creating a NEW project from scratch (minimal S-expr `.pds`)
A minimal hand-written `.pds` that `pds_shell` accepts (it then rewrites/augments it):
```
(_flow fab_demo "2022.2-SP4.2"
    (_comment "anything")              ;; REQUIRED: (_comment) must be the FIRST child of (_flow ...)
    (_version "1.1.0")                  ;; REQUIRED exact: 1.1.0 (1.0.0 -> "version not match" error)
    (_status "initial")
    (_project (_option prj_work_dir (_string ".")) (_option prj_impl_dir (_string ".")))
    (_task tsk_setup
        (_widget wgt_select_arch (_input (_part (_family Logos2)(_device PG2L100H)(_speedgrade -6)(_package FBG484))))
        (_widget wgt_my_design_src (_input (_file "rtl/top.v" + "top" (_format verilog)(_timespec "..."))))
        (_widget wgt_import_logic_con_file (_input (_file "constraints/top.fdc" (_format fdc)(_timespec "...")))))
    (_task tsk_compile     (_command cmd_compile     (_gci_state (_integer 0))))
    (_task tsk_synthesis   (_command cmd_synthesize  (_gci_state (_integer 0))(_option selected_syn_tool_opt (_integer 2))))
    (_task tsk_devmap      (_command cmd_devmap      (_gci_state (_integer 0))))
    (_task tsk_pnr         (_command cmd_pnr         (_gci_state (_integer 0))(_option fix_hold_violation (_switch ON))))
    (_task tsk_gen_bitstream (_command cmd_gen_bitstream (_gci_state (_integer 0)))))
```
Compile any part: `pds_shell.exe -project <x.pds> -run gen_bit_stream` (no GUI). The `_part` above
(Logos2/PG2L100H/-6/FBG484) is an **example** — replace family/device/speedgrade/package with your real
target. It is board-specific physical info (from the user / board / Target Profile); the tools ship no
default and won't guess it. A device has several package options, so the package is **not** derivable
from the device — check `arch/vendor/pango/<family>/.../parts/<part>/bsm/<PART>_<PKG>.bsm` in the
install for the valid packages (e.g. PG2L200H = FBB676 or FFBG1156; PG2L100H = FBG484).

## Clocking from a NON-clock-capable IO (Place-0084) — route through a PLL
If a clock enters on a regular IO pad (not a dedicated GCLK/MCLK), P&R fails with
`E: Place-0084: GLOBAL_CLOCK: the driver clk_ibuf ... is unreasonable` and **no bitstream is generated**.
- `define_attribute {p:clk} {PAP_IO_NONE} {TRUE}` in the `.fdc` is necessary-but-NOT-sufficient.
- **Fix = launder the clock through a PLL** (`GTP_GPLL`): IO → PLL `CLKIN1` → PLL `CLKOUT0` (a clock-capable
  internal source) → global clock → fabric. Reuse a generated PLL wrapper (the common pattern:
  `module pll(output clkout0, input clkin1, output lock)` wrapping `GTP_GPLL` with `CLKIN_FREQ` set to
  the actual input MHz). Add it to the `.pds` sources and clock the design from `clkout0`. (This is why
  board designs almost always PLL their incoming board clock rather than using it directly.)
