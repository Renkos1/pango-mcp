// N1 real-PDS check (needs PDS installed). Verifies the compact compile
// summary shape + the input-hash cache (second identical call returns cached).
// Run: node test/n1-compile.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");
const proj = join(here, ".n1", "pds");
rmSync(join(here, ".n1"), { recursive: true, force: true });

const client = new Client({ name: "n1", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));
const callTool = async (name, args = {}, options = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, options)).content[0].text);

const created = await callTool("fpga_pds_create_project", { projectDir: proj, name: "n1demo", family: "Logos2", device: "PG2L100H", speedgrade: "-6", package: "FBG484", force: true });
const pdsPath = created.artifacts.pds;

const t0 = Date.now();
const first = await callTool("fpga_pds_compile", { pdsPath, runTarget: "compile", backupOldBuildDirs: false, timeoutSec: 300 }, { timeout: 360000 });
console.log("first  -> ok=", first.ok, "cached=", first.cached, "stage=", first.stage, "errors=", first.errorCount, "logBytes=", first.logBytes, "logPath?", !!first.logPath, "took=", Date.now() - t0, "ms");

const t1 = Date.now();
const second = await callTool("fpga_pds_compile", { pdsPath, runTarget: "compile", backupOldBuildDirs: false, timeoutSec: 300 }, { timeout: 360000 });
console.log("second -> ok=", second.ok, "cached=", second.cached, "took=", Date.now() - t1, "ms");

const full = await callTool("fpga_pds_compile", { pdsPath, runTarget: "compile", backupOldBuildDirs: false, detail: "full", timeoutSec: 300 }, { timeout: 360000 });
console.log("full   -> cached=", full.cached, "hasLog=", typeof full.log === "string", "hasReports=", !!full.reports);

await client.close();

let fail = false;
if (typeof first.ok !== "boolean" || !first.logPath || typeof first.logBytes !== "number") (console.error("✗ first 摘要字段异常", first), (fail = true));
if (first.cached !== false) (console.error("✗ first 不应是 cached", first.cached), (fail = true));
if (second.cached !== true) (console.error("✗ second 应命中缓存", second.cached), (fail = true));
if (full.cached !== true || typeof full.log !== "string" || !full.reports) (console.error("✗ full 应命中缓存且含全文/reports", { cached: full.cached, hasLog: typeof full.log, reports: !!full.reports }), (fail = true));
console.log(fail ? "N1-COMPILE: FAIL" : "N1-COMPILE: PASS（摘要 + 缓存命中 + detail:full 兜底）");
process.exit(fail ? 1 : 0);
