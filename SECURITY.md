# Security Policy

## Reporting a vulnerability

Use GitHub's **[Private Vulnerability Reporting](https://github.com/Renkos1/pango-mcp/security/advisories/new)**.
Please do not open a public issue for anything in the "in scope" list below.

Expect a first response within 7 days. This is a solo-maintained project with
one physical board, so a report that includes your PDS/ModelSim version, device,
and the exact tool arguments will be triaged much faster.

Supported: `0.3.x` (latest minor only, pre-1.0).

## Threat model — read this before exposing the server

**pango-mcp is not a sandbox.** It is a driver that runs vendor EDA binaries and
writes to real silicon with the privileges of whoever launched it. Giving an
agent this server is close to giving it a shell on that machine, plus JTAG.

**Run it as a local stdio subprocess of a trusted agent. Do not proxy it to
untrusted callers, and do not expose it over a network.**

Three specific things an operator should know:

1. **Some tools are RCE-equivalent by design.** `fpga_cdt` runs arbitrary
   vendor Tcl; `fpga_msim_do` with `confirm:true` runs arbitrary do-file Tcl
   (including `exec`); `fpga_exe` / `fpga_msim_exe` dispatch allowlisted vendor
   executables. These exist because covering the vendor tool surface with one
   tool per action would be worse. They are not a bug, but they are the reason
   the trust boundary above matters.

2. **Device writes can be irreversible.** `fpga_flash_spi` erases and programs
   on-board SPI flash — a bad image can leave the board unable to boot from
   flash. eFuse operations via `fpga_cdt` are permanent. SRAM configuration
   (`fpga_flash_sram`, `fpga_jtag_flash`) is volatile and recoverable.

3. **There is no filesystem confinement.** Path arguments are checked for
   existence, not containment. The server reads and writes wherever the calling
   user can.

### In scope

- Reaching any device-write path without `confirm:true` + a matching
  `expectIdcode` + a real prior scan
- Escaping the mutating-command detection that arms those gates
  (`MUTATING_CDT` in `pango-pds/index.mjs`, `SUSPICIOUS_DO` in `modelsim/index.mjs`)
- Escaping the `fpga_exe` / `fpga_msim_exe` executable allowlists, including
  path traversal out of the vendor `bin/` directory
- Injection through a tool argument into a generated Tcl script, PowerShell
  driver, or do-file that a caller could not otherwise execute
- Leaking license files, SSH credentials, or config contents into tool results
  or the trace log

### Out of scope

- The server executes vendor tools with the caller's privileges — by design
- An agent instructed by its own operator to run a destructive tool with
  `confirm:true`
- Absence of filesystem confinement (documented above; a stricter mode is
  tracked, not promised)
- Vulnerabilities in Pango PDS, ModelSim/Questa, Icarus Verilog, or FTDI drivers
  — report those to their vendors

## Operator guidance

- Keep license files and SSH credentials **outside** the install directory.
  Point `PANGO_MCP_ENV_FILE` / `PANGO_MCP_CONFIG` at files under your own
  permissions; `pango-mcp.env` and `pango-mcp.config.json` are gitignored so a
  local copy is never committed, but they are plaintext on disk.
- Prefer `privateKeyPath` over `password` for remote hosts. **Note:** SSH host
  keys are currently not verified — treat remote execution as trusted-network
  only until that lands.
- `PANGO_MCP_TRACE=1` writes tool arguments to `~/.pango-mcp/`. Vendor transcripts
  land in `~/.pango-mcp/logs/` regardless. Neither is redacted; exclude them from
  backups if that matters to you.
- Always confirm `expectIdcode` against a board you have physically identified.
  The IDCODE check compares the low 28 bits, ignoring the silicon revision
  nibble — it distinguishes device types, not individual boards.
