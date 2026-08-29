# pango-mcp

[English](README.md) · [简体中文](README.zh-CN.md)

**An MCP stdio server that gives any MCP-capable agent — Claude Code, Codex CLI,
or your own client — hands-on control of a real FPGA toolchain: simulate, assert,
synthesize, scan the JTAG chain, capture on-chip waveforms, and configure real
silicon behind explicit confirmation gates.**

> **On the name.** The server is `pango-mcp` because Pango Design Suite is the
> toolchain it drives end to end — synthesis, place & route, bitstream, ILA,
> device configuration. Its MCP tools keep the `fpga_*` prefix: several of them
> (`fpga_sim`, `fpga_msim_*`) drive Icarus Verilog and ModelSim/Questa, which
> have nothing to do with Pango, and naming those `pango_*` would be a lie.

## Who it's for

You already have an FPGA toolchain installed, and you want an agent to *drive*
it — and to be **provably wrong when it is wrong**.

That second half is the point. PDS and ModelSim both exit 0 on failure. Every
tool here decides success by parsing the log (`E:` lines, `Errors: N`, the
bitstream success line, UVM error counts), never by exit code, and returns a
structured verdict — `ok`, parsed errors, timing/utilization, diagnostics —
instead of a raw log the model can narrate its way around.

## What works with what

| Capability | Backend | You need |
|---|---|---|
| Verilog simulation, assertions, waveforms | Icarus Verilog | `iverilog` on PATH |
| VHDL, coverage, UVM, encrypted IP | ModelSim / Questa | install + license |
| Synthesis, P&R, bitstream, reports | Pango Design Suite | install + license |
| JTAG scan, SRAM/SPI configuration | PDS `cdt_js`, **or** bare-metal FT2232 | board + cable |
| On-chip debug (ILA/FLA capture) | PDS fabric inserter + JTAG | board + cable |
| Primitive / IP / doc retrieval | offline corpus | built from your PDS install |

**Platform.** The server runs on any OS with Node ≥18.17 — it starts cleanly
with nothing installed and reports what is missing. The vendor tools it drives
are Windows-first in practice, and the bare-metal JTAG path
(`fpga_jtag_*`, `fpga_ila_*`) is **Windows-only** (it loads `ftd2xx.dll` through
`ctypes.WinDLL`). Python 3 is required for the JTAG layer only.

## Install

```bash
git clone https://github.com/Renkos1/pango-mcp.git
cd pango-mcp
pnpm install
pnpm check          # syntax gate over every module
pnpm test:unit      # 33 tests — no toolchain, no board needed
```

Then point it at your tools. Copy `pango-mcp.env.example` to a file **outside**
the install directory, fill in your paths, and set `PANGO_MCP_ENV_FILE`:

```
PANGO_MCP_PDS_2025=<path>\bin\pds_shell.exe
PANGO_LICENSE_FILE=<path>\pango.lic
PANGO_MCP_MODELSIM_HOME=<modelsim install root>
PANGO_MCP_MODELSIM_LICENSE=<path>\modelsim.lic
```

> The server is spawned over stdio with a safe env subset, so it does **not**
> inherit your shell's `LM_LICENSE_FILE`/`MGLS_LICENSE_FILE`. Setting
> `PANGO_MCP_MODELSIM_LICENSE` is required for real `fpga_msim_*` runs.

Nothing is baked in: every path comes from config or env, and an unset one fails
with a message naming the knob. `pango-mcp.config.json` is an alternative to env
vars and additionally declares remote hosts and board profiles — see
`pango-mcp.config.example.json`.

### Register with an agent

Claude Code:
```bash
claude mcp add pango -- node <ABSOLUTE_PATH_TO_REPO>/src/index.mjs
```

Codex CLI (`~/.codex/config.toml`):
```toml
[mcp_servers.pango]
command = "node"
args = ["<ABSOLUTE_PATH_TO_REPO>/src/index.mjs"]
```

Project-level `.mcp.json`:
```json
{ "mcpServers": { "pango": { "command": "node", "args": ["<ABSOLUTE_PATH_TO_REPO>/src/index.mjs"] } } }
```

## Try it

1. Ask the agent to call `fpga_env` — you should see your iverilog/PDS/ModelSim paths.
2. Have it write a small design + testbench, then call `fpga_sim` with `wave:true`.
3. Have it call `fpga_assert` on the result (`log_contains: PASS`, `vcd_final_eq: q == 10`).
4. **Negative control:** ask for a testbench that `$fatal`s. `ok` must come back
   `false`. If it doesn't, that is the bug worth reporting.

## Tools

43 tools, tiered. Call `fpga_capabilities` for the live catalog — it is the
authoritative list, generated from the same source the tests check.

The six you will actually use:

| Tool | Does |
|---|---|
| `fpga_env` | What toolchains this machine has, with paths |
| `fpga_sim` | iverilog compile + run; optional VCD and one-step waveform |
| `fpga_assert` | Declarative pass/fail over a log or VCD — the real verdict |
| `fpga_wave` | Any VCD → SVG/HTML timing diagram, optionally opened in a browser |
| `fpga_pds_compile` | PDS through `gen_bit_stream`, with parsed errors and timing |
| `fpga_pds_scan` | Read JTAG IDCODEs — read-only, always safe |

Everything else groups into: ModelSim (`fpga_msim_*`), PDS build/report
(`fpga_pds_*`, `fpga_log_extract`), device and flash (`fpga_flash_*`,
`fpga_gen_*`, `fpga_cdt`, `fpga_exe`), bare-metal JTAG (`fpga_jtag_*`), on-chip
debug (`fpga_ila_*`), and retrieval (`fpga_primitive_lookup`, `fpga_ip_lookup`,
`fpga_doc_search`, `fpga_vault`).

Full reference, including every argument: [README.zh-CN.md](README.zh-CN.md).

## Safety

**This server is not a sandbox.** It runs vendor binaries and writes to real
silicon with your privileges. Run it as a local subprocess of a trusted agent;
do not expose it to untrusted callers. Read [SECURITY.md](SECURITY.md) before
wiring it into anything shared.

Every tool that writes to a device stops at a confirmation gate: it requires
`confirm:true`, a matching `expectIdcode`, and a real prior scan before it does
anything. Without confirmation it returns `phase:"confirm"` and touches nothing.
This is enforced in code and covered by tests, not just documented.

SPI flash programming is persistent and can leave a board unable to boot from
flash. SRAM configuration is volatile and recoverable.

## Cost control

Returns are compact by default — errors, timing, utilization, diagnostics, key
lines — with the full log written to disk and reachable via `detail:"full"`.
Builds are cached by a hash of source content plus project semantics, so an
unchanged source returns the previous summary instantly. Knowledge retrieval is
keyword-scored with no embedding model and no API call; semantic search is
opt-in and falls back silently to keyword when unconfigured.

## Docs

- [CONTRIBUTING.md](CONTRIBUTING.md) — three contribution tiers; most of this is testable with no hardware
- [SECURITY.md](SECURITY.md) — threat model, what's in scope, operator guidance
- [test/README.md](test/README.md) — what every test needs and what it does without it
- [CHANGELOG.md](CHANGELOG.md) — including the pre-1.0 stability policy
- [docs/ILA-FINDINGS.md](docs/ILA-FINDINGS.md) — how the headless FLA capture path was derived
- [skills/](skills/) — the Pango PDS flow skill shipped with the server

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) for vendor trademarks and the exact
provenance of the shipped knowledge corpora — this project bundles no vendor
software and no vendor documentation text.
