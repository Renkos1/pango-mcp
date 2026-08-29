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

### Fixed
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
