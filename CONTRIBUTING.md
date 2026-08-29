# Contributing

Most of this project is testable without any FPGA hardware or EDA license. If
that surprises you, that is the point — the parsers, guards and retrieval layers
are where the bugs live, and they are all deterministic.

## Three contribution tiers

Pick the highest tier you can actually run, and say which one in your PR.

| Tier | You need | Run before pushing |
|---|---|---|
| **1 — no hardware** | Node ≥18.17, Python 3 | `pnpm check && pnpm test:unit` |
| **2 — simulator** | + Icarus Verilog or ModelSim/Questa | `pnpm smoke`, `pnpm test:msim` |
| **3 — hardware** | + a Pango board and cable | `pnpm test:n1`, `pnpm test:n2`, `pnpm actual` |

CI runs tier 1 only. Tier 2 and 3 results must be **pasted into the PR** —
there is no other way for a maintainer with one board to know your change was
exercised against a real toolchain. See [test/README.md](test/README.md) for
what every test file requires.

```bash
pnpm install
pnpm check       # syntax gate over every src module
pnpm test:unit   # 33 deterministic tests, no toolchain, no board
```

## Rules that are not obvious

**Device-write gates never weaken.** Any change touching `fpga_flash_*`,
`fpga_jtag_flash`, `fpga_ila_flow`, `fpga_ila_console` or `fpga_cdt` must keep
`confirm:true` + `expectIdcode` + a real prior scan on every path to the write,
and `test/jtag-flash-guard-unit.mjs` + `test/ila-write-guard-unit.mjs` must stay
green. If you are adding a new way to reach a device, add a guard test with it.

**Never bake a machine path into source.** Install locations come from config or
env and fail closed with a message naming the knob (see
`pango-pds/install.mjs`). A hardcoded default silently shadows a user's config —
that is why there are none left.

**`src/toolchains/*/knowledge/*.json` is generated.** Rebuild it with
`pnpm knowledge:build`; do not hand-edit it in a PR. Paths inside it are stored
relative to the vendor install root so the corpus is identical on every machine.

**A new toolchain is a new folder.** `src/toolchains/<vendor>/` with its own
`register()`, without touching the others — `src/toolchains/vivado/README.md` is
the worked example.

**New tool → update `CAPABILITY_CATALOG`.** `pnpm test:static` enforces the
bidirectional match between registered tools and the catalog in
`src/core/capabilities.mjs`.

**Do not trust exit codes.** PDS and ModelSim both exit 0 on failure. Success is
decided by parsing the log (`E:` lines, `Errors: N`, bitstream success line).
Anti-hallucination is the product; a tool that returns `ok:true` on a failed run
is the worst bug class here.

## Style

Plain ESM JavaScript (`.mjs`), no build step, no TypeScript — the project must
stay `git clone && node src/index.mjs`. Match the surrounding comment density:
comments here explain *why* a non-obvious guard exists, not what the line does.

Runtime strings and tool descriptions are currently Chinese. Keeping that
consistent is fine; an i18n pass is welcome as its own PR.

## Releasing (maintainer)

Publishing is the only irreversible action here — npm's unpublish window is
narrow, so a bad `0.3.x` is public for good. It therefore goes through
[`.github/workflows/release.yml`](.github/workflows/release.yml) rather than a
laptop, which is also what makes the npm provenance attestation possible
(`publishConfig.provenance` needs `id-token: write`, and only Actions has it).

One-time: store an npm **automation** token as the `NPM_TOKEN` repository secret.

```bash
npm version patch      # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags # the tag is what triggers the release workflow
```

The workflow re-runs `pnpm check` and `pnpm test:unit` on Node 22 and 24 against
the tagged commit, refuses to continue if the tag and `package.json` disagree on
the version, re-asserts the tarball contents and the LF shebang, then installs
the packed tarball into a scratch project and starts the server from it — the
`npx pango-mcp` path a user actually gets. Only then `npm publish`.

To exercise all of that without publishing, run the workflow manually from the
Actions tab with `dry_run` left checked.

## Reporting

Bugs: use the issue templates — PDS/ModelSim version, device, and the failing
tool's `diagnostics.knownIssues` are what make a report actionable.
Security: see [SECURITY.md](SECURITY.md), not the issue tracker.
