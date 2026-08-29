# toolchains/vivado — placeholder (future Xilinx backend)

This folder establishes the extension convention for the pango-mcp capability
layer: **a new toolchain is added as `toolchains/<vendor>/`, without touching
existing code.**

A toolchain module owns, self-contained:
- its MCP tools, exposed via an exported `register(server)` (see
  `../pango-pds/index.mjs` and `../sim/index.mjs`);
- its install/capability resolution (`install.mjs`);
- its own knowledge corpus under `knowledge/` (built offline, committed), with
  retrieval served by the backend-agnostic `core/knowledge.mjs`.

To add Vivado later:
1. Add `install.mjs` (locate `vivado` / `vivado -mode batch`, board/part info).
2. Add tool modules registering `fpga_vivado_*` tools that reuse `core/exec.mjs`
   (`run`/`toolResult`/`toolError`), `core/logparse.mjs`, and `core/runstore.mjs`.
3. Export `register(server)` from this folder's `index.mjs`.
4. Wire it in `src/index.mjs` next to the existing toolchains.
5. (Optional) Add `build-knowledge/` + `knowledge/` for Vivado docs/primitives.

Nothing here is loaded at runtime yet.
