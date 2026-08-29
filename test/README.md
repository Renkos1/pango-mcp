# Test matrix

What each file needs, and what happens if you do not have it. Classification is
from actually running every file on a machine with no EDA toolchain and no board.

`pnpm test:unit` runs everything in the first table — 33 tests, all green with
nothing installed but Node and Python. That is the CI set and the bar for a PR.

## Tier 1 — nothing required

| File | Covers |
|---|---|
| `cdt-ok-unit.mjs` | cdt success/failure discrimination, GBK transcripts |
| `coverage-unit.mjs` | ModelSim coverage bins/hits/misses parsing |
| `diagnostics-unit.mjs` | PDS `E:`/`W:` classification, known-issue rules |
| `embed-unit.mjs` | embedding cache + silent keyword fallback |
| `ila-capture-unit.mjs` | FLA capture decode, trigger index, monotonicity |
| `ila-fic-unit.mjs` | `.fic` render: match unit + trigger condition |
| `ila-write-guard-unit.mjs` | **ILA device-write confirm gate** |
| `jtag-cli-unit.mjs` | Python JTAG CLI argument contract |
| `jtag-flash-guard-unit.mjs` | **flash confirm + expectIdcode gate** |
| `jtag-unit.mjs` | IDCODE parse, alias masking, cable diagnostics |
| `msim-logparse-unit.mjs` | transcript verdict (`$fatal` with exit 0) |
| `msim-unit.mjs` | UVM summary, cmd_help parsing, coverage totals |
| `netlist-unit.mjs` | netlist net discovery + signal resolution |
| `pds-batch-unit.mjs` | safe PDS batch run construction |
| `pds-create-top-module-unit.mjs` | generated top module |
| `pds-error-unit.mjs` | PDS error extraction |
| `pds-license-unit.mjs` | license preflight states |
| `pds-project-reports-unit.mjs` | `.pds` (legacy + XML) and report parsing |
| `power-unit.mjs` | power report parsing |
| `project-fdc-unit.mjs` | `.fdc` constraint handling |
| `resource-unit.mjs` | utilization parsing |
| `server-lifecycle-unit.mjs` | server instance cleanup |
| `static-gate.mjs` | tool ↔ `CAPABILITY_CATALOG` match, dangling doc refs |
| `timing-unit.mjs` | `.rtr` timing, `met`/`worst` slack |
| `trace-unit.mjs` | JSONL trace schema + session header |
| `vault-unit.mjs` | vault frontmatter, tiers, candidate-only writes |
| `waveform-unit.mjs` | VCD → SVG rendering |
| `fla-framing-unit.py` | FLA sample framing / padding inference |
| `fla-trig-degenerate-unit.py` | degenerate trigger patterns |
| `fla-trig-encode-unit.py` | trigger blob channel order + bit order |
| `jtag-d2xx-unit.py` | D2XX inventory normalization |
| `svf-parse-unit.py` | SVF parsing |

`integration-loop.mjs --selftest` also runs here: it checks the negative verdict,
first-failure cutoff and hardware pre-gate without starting the MCP server.

## Tier 2 — a simulator

| File | Needs | Without it |
|---|---|---|
| `smoke.mjs` | Icarus Verilog | fails partway (see note) |
| `msim.mjs` | ModelSim/Questa + license | skips |
| `n4-semantic.mjs` | an embeddings provider | skips cleanly |

> `pnpm smoke` is the README's second command but currently dies on a
> `JSON.parse` of a plain-text tool error when `iverilog` is absent, instead of
> skipping. Known; PRs welcome.

## Tier 3 — real hardware or a remote host

None of these run in CI. Paste results into your PR instead.

| File | Needs |
|---|---|
| `n1-compile.mjs` | PDS install (real `gen_bit_stream`) |
| `n2-control.mjs` | PDS install (`fpga_exe` passthrough, cdt read paths) |
| `actual-tools.mjs` | PDS install |
| `netlist-live.mjs` | PDS install — skips if unconfigured |
| `ila-tools-live.mjs` | PDS install — skips if unconfigured |
| `msim-remote.mjs` | `PANGO_MCP_TEST_HOST` + a remote ModelSim over SSH — skips if unset |
| `integration-loop.mjs` | `FPGA_INTEGRATION_LEVEL=digital\|hardware` + a board |

`integration-loop` at `hardware` level additionally requires
`FPGA_INTEGRATION_CONFIRM=1` and `FPGA_INTEGRATION_EXPECT_IDCODE=<id>`. It never
writes to a device just because one is detected.

## Not tests

`tools/jtag-lab/*.py` are FLA bench scripts. They open FTDI device index 0 and
shift real JTAG IR/DR — with no VID/PID filter, so an unrelated FT2232/FT232 on
your machine can receive it. They refuse to touch a cable without
`FPGA_JTAG_LAB_CONFIRM=1`. `examples/` holds demos with no assertions.
