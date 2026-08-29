// Live end-to-end of the refactored ILA tool surface: registers the real handlers
// via a mock server and exercises fpga_ila_list_nets + the fpga_ila_build resolve
// gate (the self-correcting early-fail before instrumenting with a bad name).
// Requires local PDS; skips cleanly otherwise.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { choosePdsInstall } from "../src/toolchains/pango-pds/install.mjs";
import { dirname, join } from "node:path";
// No baked-in install path: configure PANGO_MCP_PDS_2025 (or config.pdsInstalls[].shell).
// Resolve through the same config chain the server uses (env OR pango-mcp.env OR
// pango-mcp.config.json) — never a baked-in path.
const PDS_SHELL = choosePdsInstall({ pdsVersion: "2025" })?.shell;
if (!PDS_SHELL) {
  console.log("SKIP ila-tools-live: no PDS 2025 install configured");
  process.exit(0);
}
process.env.PANGO_MCP_PDS_2025 = PDS_SHELL;
const here = dirname(fileURLToPath(import.meta.url));
const SHELL = process.env.PANGO_MCP_PDS_2025;
const PDS = process.env.NL_PDS || join(here, "fixtures", "nl-project", "fab_demo.pds");
if (!existsSync(SHELL) || !existsSync(PDS)) { console.log("SKIP ila-tools-live (no local pds_shell or project)"); process.exit(0); }

const { register } = await import("../src/toolchains/pango-pds/index.mjs");
const tools = {};
register({ registerTool: (name, schema, handler) => { tools[name] = handler; } });

let fail = 0;
const sc = (r) => r?.structuredContent ?? r;

console.log("fpga_ila_list_nets registered:", !!tools.fpga_ila_list_nets);
console.log("fpga_ila_build registered    :", !!tools.fpga_ila_build);

// 1) list_nets discovers + resolves
const ln = sc(await tools.fpga_ila_list_nets({ pdsPath: PDS, signals: ["tx_int", "tx", "clk", "cnt"] }));
console.log("\n[list_nets] ok:", ln.ok, "| clocks:", ln.clocks, "| top:", ln.topModule);
console.log("  tappable:", (ln.tappable || []).map((t) => t.net + (t.bus || "")).join(", "));
console.log("  resolved:", JSON.stringify(ln.resolved));
if (!ln.ok || !ln.clocks?.includes("nt_clk")) { console.error("FAIL list_nets"); fail++; }
if (!(ln.resolved?.find((r) => r.name === "tx")?.net === "nt_led[0]")) { console.error("FAIL tx not resolved to nt_led[0]"); fail++; }
const cnt = (ln.resolved || []).filter((r) => /^u_beacon\/cnt\[\d+\]$/.test(r.net || ""));
if (cnt.length !== 8 || cnt.some((r) => !r.verified)) { console.error("FAIL hierarchical bus was not expanded to 8 Inserter-verified bits"); fail++; }

// 2) build resolve-gate: a bogus signal must fail BEFORE building, with guidance
const bd = sc(await tools.fpga_ila_build({ pdsPath: PDS, signals: ["tx_int", "definitely_not_a_net"] }));
console.log("\n[build resolve-gate] ok:", bd.ok, "| stage:", bd.stage, "| pruned:", bd.pruned);
console.log("  hint:", (bd.hint || "").slice(0, 80));
if (bd.ok !== false || bd.stage !== "resolve" || !(bd.pruned || []).includes("definitely_not_a_net")) { console.error("FAIL build did not gate on pruned signal"); fail++; }
if (!Array.isArray(bd.tappable)) { console.error("FAIL build did not return tappable list for self-correction"); fail++; }

console.log(`\nila-tools-live: ${fail ? "FAILED " + fail : "all passed"}`);
process.exit(fail ? 1 : 0);
