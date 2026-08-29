## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

## Verified at tier

<!-- CI only runs tier 1. For tier 2/3 the pasted output below IS the evidence —
     a maintainer with one board has no other way to know it was exercised. -->

- [ ] **Docs only** — no code changed
- [ ] **Tier 1 (no hardware)** — `pnpm check && pnpm test:unit`
- [ ] **Tier 2 (simulator)** — also `pnpm smoke` / `pnpm test:msim`
- [ ] **Tier 3 (hardware)** — also `pnpm test:n1` / `pnpm test:n2` / `pnpm actual`

```
paste the commands you ran and their exit status here
```

## Device-write safety

<!-- Required if this touches fpga_flash_*, fpga_jtag_flash, fpga_ila_flow,
     fpga_ila_console, or fpga_cdt. Delete this section otherwise. -->

- [ ] Every path to a device write still requires `confirm:true` + a matching
      `expectIdcode` + a real prior scan — unchanged or stronger
- [ ] `test/jtag-flash-guard-unit.mjs` and `test/ila-write-guard-unit.mjs` pass
- [ ] A new way to reach the device comes with a new guard test

## Checklist

- [ ] No machine-local path baked into source (config/env, fail closed)
- [ ] New tool → `CAPABILITY_CATALOG` updated (`pnpm test:static` green)
- [ ] `src/toolchains/*/knowledge/*.json` regenerated via `pnpm knowledge:build`,
      not hand-edited
- [ ] Anti-hallucination preserved: nothing reports `ok:true` on a failed run
