// Actual MCP tool-call validation. This intentionally calls every exposed tool.
// It does not pass confirm:true to flash tools, so it cannot program hardware.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");
const root = join(here, ".actual");
const simDir = join(root, "sim");
const pdsDir = join(root, "pds-demo");

rmSync(root, { recursive: true, force: true });
mkdirSync(simDir, { recursive: true });

writeFileSync(
  join(simDir, "counter.v"),
  `module counter(input clk,input rst,output reg [3:0] q);
always @(posedge clk or posedge rst) if(rst) q<=4'd0; else q<=q+4'd1;
endmodule
`
);
writeFileSync(
  join(simDir, "tb_counter.v"),
  `\`timescale 1ns/1ps
module tb_counter; reg clk=0,rst=1; wire [3:0] q; counter dut(clk,rst,q);
always #5 clk=~clk;
initial begin #12 rst=0; #100; $display("PASS q=%0d", q); $finish; end
endmodule
`
);

const client = new Client({ name: "actual-tools", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));

const call = async (name, args = {}, options = {}) => {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, options);
    const parsed = JSON.parse(result.content[0].text);
    return { name, isError: !!result.isError, result: parsed };
  } catch (err) {
    return { name, isError: true, result: { ok: false, phase: "client_error", error: err.message, code: err.code, data: err.data } };
  }
};

const calls = [];
const push = async (name, args = {}, options = {}) => {
  const res = await call(name, args, options);
  calls.push(res);
  console.log(`${name}: ok=${res.result.ok} phase=${res.result.phase || ""}${res.isError ? " isError=true" : ""}`);
  return res.result;
};

const tools = await client.listTools();
calls.push({ name: "listTools", result: { ok: true, tools: tools.tools.map((t) => t.name) } });
console.log(`listTools: ${tools.tools.map((t) => t.name).join(", ")}`);

const env = await push("fpga_env");
const sim = await push("fpga_sim", { workdir: simDir, top: "tb_counter", vcd: true });
await push("fpga_assert", {
  log: sim.log,
  vcdPath: sim.artifacts.vcd,
  assertions: [
    { name: "log_pass", type: "log_contains", pattern: "PASS" },
    { name: "q_final", type: "vcd_final_eq", signal: "q", value: 10 },
  ],
});

const created = await push("fpga_pds_create_project", { projectDir: pdsDir, name: "fab_demo", family: "Logos2", device: "PG2L100H", speedgrade: "-6", package: "FBG484", force: true });
const pdsPath = created.artifacts.pds;
await push("fpga_project_info", { pdsPath });
await push("fpga_pds_reports", { pdsPath, log: 'W: actual validation injected warning\nThe bitstream file is "generate_bitstream/top.sbit"\n' });

const pdsTargets = ["compile", "synthesize", "dev_map", "pnr", "report_timing", "gen_bit_stream"];
for (const runTarget of pdsTargets) {
  const compiled = await push("fpga_pds_compile", {
    pdsPath,
    runTarget,
    backupOldBuildDirs: false,
    timeoutSec: runTarget === "gen_bit_stream" ? 900 : 300,
  }, { timeout: runTarget === "gen_bit_stream" ? 960000 : 420000 });
  if (!compiled.pdsVersion || !compiled.command?.exe) throw new Error(`compile missing audit fields for ${runTarget}`);
}

await push("fpga_pds_scan", { timeoutSec: 20 });

const dummySbit = join(pdsDir, "dummy.sbit");
writeFileSync(dummySbit, "not a real bitstream; used only for confirm-gate validation\n");
await push("fpga_flash_sram", { sbit: dummySbit, expectIdcode: "PG2L100H" });
await push("fpga_flash_spi", { sbit: dummySbit, expectIdcode: "PG2L100H", flashPart: "W25Q128Q" });

await client.close();

const summary = {
  ok: calls.every((c) => c.name.startsWith("fpga_pds_compile") ? true : !c.isError),
  generatedAt: new Date().toISOString(),
  envHints: env.hints || [],
  pdsPath,
  calls,
};
const reportPath = join(root, "actual-tools-report.json");
writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf8");
console.log(`report: ${reportPath}`);

const hardFailures = calls.filter((c) => c.isError || (c.result?.phase === "compile" && c.name === "fpga_sim"));
if (!existsSync(reportPath) || hardFailures.length) process.exit(1);
