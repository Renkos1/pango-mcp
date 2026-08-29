# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Stability policy

Pre-1.0, **the MCP tool surface is the public API** — tool names, required
arguments and result shapes matter far more than any JS export (there are none;
`exports` is closed). Those may change in a minor version, and this file will
say so.

One thing will not weaken across any version: the device-write gate. A tool that
writes to silicon will always require `confirm:true`, a matching `expectIdcode`,
and a real prior scan.

## [Unreleased]

Prepared for the first public release.

### Added
- `pnpm test:unit` — 33 deterministic tests that need no toolchain and no board.
- `skills/` — the Pango PDS flow skill now ships with the server, so the
  `fpga_doc_search` chunk corpus is regenerable from a clean clone.
- `tools/jtag-lab/` — FLA bench scripts, fail-closed behind
  `FPGA_JTAG_LAB_CONFIRM=1` because they drive FTDI device index 0 directly.
- `LICENSE` (Apache-2.0), `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`.
- Safe PDS batch runs, PDS license preflight, complete netlist input staging,
  ILA net resolution via the fabric inserter, wide FLA readback framing, and
  server lifecycle cleanup hardening.

### Changed
- **Knowledge corpora store vendor paths relative to the PDS install root.**
  `fpga_doc_search` / `fpga_ip_lookup` resolve them at query time against your
  configured install, so the shipped corpus is identical on every machine.
- `pdsHome()` honours the configured default version instead of array order —
  it previously resolved corpus paths against PDS 2022.2 while the corpus was
  built from 2025.2.
- The offline corpus builders no longer carry a built-in install path. They
  resolve explicit argument → dedicated env var → your configured PDS install,
  then fail with the exact knob to set.
- Default knowledge-vault location is now `~/.pango-mcp/knowledge-vault`.
  Previously it resolved two levels above the package, which for a standalone
  install is outside the user's checkout entirely.
- `pnpm check` walks `src/` instead of a hand-maintained module list that had
  drifted six files out of date.
- `fail closed on PDS timing` — timing results no longer report success when the
  report is missing or unparsable.

### Removed
- **`src/toolchains/modelsim/knowledge/commands.index.json` is no longer
  shipped.** It is built from Siemens EDA product documentation delivered under
  the ModelSim/Questa EULA. Generate it from your own licensed install with
  `pnpm knowledge:build:msim`; `fpga_msim_doc_search` says so until you do.
- The encrypted private-delivery mechanism (`SECURE-DISTRIBUTION.md`,
  `scripts/secure-*.mjs`, `pack:audit`, `pack:secure`) — obsolete once the
  source is public.

### Security
- **The device-write gate could be walked around.** It matched command names in
  the script text, and Tcl does not need to spell one out: `set a cfg_; set b
  program; $a$b` never contains `cfg_program`, so the confirm + `expectIdcode`
  check saw nothing to gate and the write went through. `commands[]` now takes
  one literal `cfg_`/`dbg_`/`ins_` command per entry, with no substitution or
  `;` chaining outside braces — so the first token IS the command. Free-form
  `tcl`, which cannot be analysed at all, needs `PANGO_MCP_ALLOW_RAW_TCL=1`.
  Braced arguments are unaffected: `-net {u/q[3]}` still works.
- **`fpga_msim_do` had the same hole.** A do script is free-form by design, so
  the gate asks for `confirm:true` rather than refusing — but `eval`, `subst`,
  `source`, `uplevel` and substitution in *command position* now trip it, since
  any of them can reach `exec` or `file delete` without those words appearing.
  Substitution in argument position (`set fh [open x r]`) still does not.
- **SSH connected without verifying the host key.** ssh2 has no default
  `hostVerifier`, so anything answering on the network could take the password
  and the bitstream this transport exists to send. Hosts now need
  `hostKeyFingerprint` and fail closed without it; `PANGO_MCP_SSH_INSECURE=1` is
  the explicit, per-run opt-out.
- **`fpga_exe` could escape the PDS bin directory.** `-help`-only arguments skip
  the executable allowlist, and the name was joined onto `binDir` unchecked, so
  `../../../Windows/System32/...` ran. The name must now be a bare filename, and
  the resolved path is asserted to stay under `binDir`.
- **Values interpolated into Tcl and PowerShell are validated.** `deviceName`
  and `flashPart` (unquoted in generated Tcl, on both the local and remote flash
  paths), ILA `trigger.value` / `condName` / `unit` / `func`, `userAddressList`
  entries, the `schtasks /ru <user>` account name, and the `projectDir` /
  `binDir` that land inside PowerShell double-quoted strings — where escaping
  backslashes was never enough, because `"` closes the string and `$(...)` runs
  a command. `opcode` and `sbitStartAddress` on the same tool were validated
  from the start; these were the omission, not the design.

### Fixed
- **`pnpm check`, `pnpm test:unit` and the tools now say what is missing.**
  A tool needing PDS used to die on `The "path" argument must be of type string.
  Received null` when none was configured. It now names the knob to set, which
  is what the README always promised.
- **`pnpm smoke` crashed on a machine with no Icarus Verilog** — it assumed
  every tool result was JSON and hit a `SyntaxError` on the first failure's
  plain-text message. It tolerates non-JSON and skips the simulation legs with
  an actionable message. This is the second command the README hands a new user.
- **Project inputs did not resolve off Windows.** `parsePdsProject` rewrote every
  declared relative path's `/` to `\` before resolving it. On Windows that is a
  no-op worth nothing — `resolve()` accepts forward slashes there — and on
  Linux/macOS a backslash is an ordinary filename character, so `rtl/top.v`
  became a single file named `rtl\top.v` and `fpga_pds_compile` failed with
  "project input missing" on any project that declares its sources. Paths are now
  normalized the other way, to forward slashes, which also means a `.pds` written
  on Windows resolves correctly on a POSIX host.
- **`npx` was broken on Linux/macOS.** npm packs from the working tree, and
  `core.autocrlf` checked out `src/index.mjs` with a `#!/usr/bin/env node\r\n`
  shebang, so `env` looked for an interpreter named `node\r`. `.gitattributes`
  now pins `eol=lf`. Windows never reproduced this.
- Live tests (`msim`, `msim-remote`, `netlist-live`, `ila-tools-live`) resolved
  the maintainer's install paths as fallbacks. They now read the same config
  chain the server does and skip with an actionable message.
- Python unit tests no longer hardcode an absolute path and run anywhere.

## [0.3.1] — 2026-07

Local JTAG hardware proof.

### Added
- Guarded bare-metal JTAG hardware loop (FT2232 MPSSE), independent of `cdt_js`,
  the PDS GUI, and any runtime license.

### Fixed
- The local JTAG loop stays on a single driver, resolving cable-ownership
  conflicts between the `cdt_js` and D2XX paths within one MCP session.
- Floating JTAG IDCODEs are filtered rather than reported as devices.
- Cable health is reported truthfully instead of inferred from a successful
  process exit.

## [0.3.0] — 2026-07

Reproducibility and verified-asset flywheel.

### Added
- Opt-in JSONL trace (`PANGO_MCP_TRACE=1`): one session per MCP process, with
  `session_start` pinning asset/standards/server versions.
- Knowledge vault — `fpga_assert` and `fpga_ila_flow` write a `candidate` entry
  only when the structured result is objectively green. Callers cannot pass a
  "this passed" boolean.
- `fpga_vault` (search/get/validate/recall); `get` records `asset_use` in the
  trace so `recall` can compute a blast radius.
- `test:integration-loop` — the standing closed-loop regression: bad RTL must
  fail, the known fix must pass, a candidate must be written.

[Unreleased]: https://github.com/Renkos1/pango-mcp/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Renkos1/pango-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Renkos1/pango-mcp/releases/tag/v0.3.0
