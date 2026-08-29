# Validated configurations

The maintainer owns exactly one board, so this table is short by construction —
that is a statement about test coverage, not about what the tools support. The
code is device-agnostic: `fpga_pds_create_project` requires a complete target
(device, package, speedgrade, pins, clock frequency) and never defaults or
guesses one.

If you run this on anything else, please file a
[hardware report](https://github.com/Renkos1/pango-mcp/issues/new?template=hardware-report.yml) —
negative results are as useful as positive ones.

| Device | Package | PDS | Cable | Scan | SRAM | SPI | ILA | IDCODE | Date |
|---|---|---|---|---|---|---|---|---|---|
| PG2L200H | FBB676 | 2025.2-SP1 | PDS `cdt_js` | ✅ | ✅ | — | ✅ | `0x00603899` | 2026-06-15 |
| PG2L200H | FBB676 | 2025.2-SP1 | bare-metal FT2232 | ✅ | ✅ | — | ✅ | `0x10603899` | 2026-06-23 |

## PG2L200H — details

- Board `PG2L200H6FB676`; project package `FBB676`.
- Clock `D18`; LEDs `A20`, `C19`, `C18`, `E18`, `A17`.
- Full chain exercised end to end through MCP:
  `fpga_pds_create_blink_project` → `fpga_project_info` →
  `fpga_pds_compile(gen_bit_stream)` → `fpga_pds_reports` → `fpga_pds_scan` →
  `fpga_flash_sram(confirm:true)`.
- SRAM download: `ok=true`, PDS log contains `The done bit is 1`.
- Post-compile XML `.pds` parses to PG2L200H/FBB676/top; `top.rtr` yields
  `timing.met=true` with worst slack ≈ `0.171ns`.

### IDCODE: two paths, two readings

The same silicon reads `0x00603899` through PDS `cdt_js` and `0x10603899`
bare-metal. **This is expected.** The top 4 bits are the silicon revision, and
the two paths report it differently. All IDCODE comparison in this project masks
to the low 28 bits, so `expectIdcode: "PG2L200H"` matches either reading.

The corollary matters for safety: the IDCODE gate distinguishes **device types**,
not individual boards. It will not save you from flashing the right device model
on the wrong desk.

## Cable ownership

The PDS `cdt_js` path and the bare-metal FT2232 path are **mutually exclusive on
the cable**. `cdt_js` holds the FTDI device open; a bare-metal
`fpga_jtag_scan` in the same session will fail until it exits. The integration
loop's local Target Profile deliberately stays on the bare-metal driver end to
end for this reason.

## PDS version notes

- **2025.2** defaults `cdt_js` to port **65425**. PDS 2022.2 commonly used
  **65420** — connecting to the wrong one produces a version-mismatch
  diagnostic, not a silent failure.
- **2025.2** may rewrite `.pds` as XML after a compile. Both forms parse.
- Single-FPGA boards should keep `maxDevices=1`. Probing a device index that
  does not exist puts `cdt_cfg` into an error state that outlives the call.
