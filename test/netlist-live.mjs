// Live integration: drive pds_shell run_ads + parse, on a representative project.
// Requires a local PDS install; skips cleanly if absent (like the msim live tests).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { choosePdsInstall } from "../src/toolchains/pango-pds/install.mjs";
import { dirname, join } from "node:path";
import { discoverNets, resolveSignal } from "../src/toolchains/pango-pds/netlist.mjs";
import { run } from "../src/core/exec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Resolve through the same config chain the server uses (env OR pango-mcp.env OR
// pango-mcp.config.json) — never a baked-in path.
const SHELL = choosePdsInstall({ pdsVersion: "2025" })?.shell;
if (!SHELL) {
  console.log("SKIP: no PDS 2025 install configured (PANGO_MCP_PDS_2025 / config.pdsInstalls[].shell)");
  process.exit(0);
}
const PDS = process.env.NL_PDS || join(here, "fixtures", "nl-project", "fab_demo.pds");
if (!existsSync(SHELL) || !existsSync(PDS)) { console.log("SKIP netlist-live (no local pds_shell or project)"); process.exit(0); }

const r = await discoverNets({ pdsPath: PDS, install: { shell: SHELL }, run, timeoutSec: 300 });
console.log("ok:", r.ok, r.error || "");
if (!r.ok) { console.log("log tail:\n" + (r.log || "")); process.exit(1); }
console.log("topModule:", r.topModule);
console.log("clocks   :", r.summary.clocks.join(", "));
console.log("tappable :", r.summary.tappable.map((t) => t.net + (t.bus || "")).join(", "));
console.log("registers:", r.summary.registers.map((x) => x.inst + "->" + x.net).join(", "));
for (const s of ["tx_int", "tx", "clk", "nope"]) console.log("  resolve", s, "=>", JSON.stringify(resolveSignal(r.parsed, s)));
process.exit(0);
