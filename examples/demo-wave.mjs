// Manual demo (pops real windows): drive the MCP end-to-end and surface the
// waveform through BOTH channels — fpga_wave's SVG/HTML in the browser AND the
// ModelSim GUI wave window (auto-grouped by hierarchy, hex bus, zoom-fit).
// Run: node test/demo-wave.mjs   (needs local ModelSim)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const root = join(here, ".wavedemo");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "counter.v"), `module counter(input clk, input rst, output reg [7:0] q);\n  always @(posedge clk) if (rst) q <= 8'h00; else q <= q + 8'd1;\nendmodule\n`);
writeFileSync(join(root, "tb.v"), `module tb;\n  reg clk = 0, rst = 1; wire [7:0] q;\n  counter u(clk, rst, q);\n  always #5 clk = ~clk;\n  initial begin rst = 1; #12 rst = 0; #120 $display("COUNTER DONE q=%0d", q); $finish; end\nendmodule\n`);

const client = new Client({ name: "wave-demo", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(pkg, "src", "index.mjs")] }));
const call = async (n, a = {}, o = {}) => JSON.parse((await client.callTool({ name: n, arguments: a }, undefined, o)).content[0].text);

// Channel A+composite: sim + waveform image + browser pop-up + assertion verdict.
const sim = await call("fpga_msim_sim", { workdir: root, top: "tb", sources: ["counter.v", "tb.v"], wave: true, waveOpen: true, assertions: [{ name: "done", type: "log_contains", pattern: "COUNTER DONE" }], timeoutSec: 120 }, { timeout: 180000 });
console.log(`\n[sim] ok=${sim.ok} assert=${JSON.stringify(sim.assert)} `);
console.log(`[wave→图像] svg=${sim.artifacts?.waveSvg}\n            html=${sim.artifacts?.waveHtml}  browserOpened=${sim.artifacts?.waveOpened}`);

// Channel C: pop the ModelSim GUI wave window (grouped by hierarchy, hex, zoom).
const view = await call("fpga_msim_view", { vcdPath: sim.artifacts?.vcd, radix: "hex", launch: true }, { timeout: 120000 });
console.log(`[ModelSim 波形窗] launched=${view.launched} groups=${view.groups} radix=${view.radix} pid=${view.pid}\n                  wlf=${view.wlf}`);

await client.close();
console.log("\nDEMO: 浏览器应已弹出 SVG 波形；ModelSim 波形窗应已打开(按 /tb 与 /tb/u 分组)。");
