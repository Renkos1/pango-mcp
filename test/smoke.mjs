// MCP 冒烟测试：以 MCP 客户端连本 server，覆盖软件可测的端到端工具：
// env / sim / assert / project_info / pds_reports / flash confirm gate。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");

const root = join(here, ".work");
const good = join(root, "good");
const bad = join(root, "bad");
const pds = join(root, "pds");
rmSync(root, { recursive: true, force: true });
mkdirSync(good, { recursive: true });
mkdirSync(bad, { recursive: true });
mkdirSync(join(pds, "rtl"), { recursive: true });
mkdirSync(join(pds, "constraints"), { recursive: true });
mkdirSync(join(pds, "generate_bitstream"), { recursive: true });
mkdirSync(join(pds, "place_route"), { recursive: true });
mkdirSync(join(pds, "prj_tasks", "pnr_1", "report_timing"), { recursive: true });

writeFileSync(
  join(good, "counter.v"),
  `module counter(input clk,input rst,output reg [3:0] q);
always @(posedge clk or posedge rst) if(rst) q<=4'd0; else q<=q+4'd1;
endmodule
`
);
writeFileSync(
  join(good, "tb_counter.v"),
  `\`timescale 1ns/1ps
module tb_counter; reg clk=0,rst=1; wire [3:0] q; counter dut(clk,rst,q);
always #5 clk=~clk;
initial begin #12 rst=0; #100; $display("COUNTER q=%0d",q); $display("PASS"); $finish; end
endmodule
`
);
writeFileSync(
  join(bad, "tb_bad.v"),
  `module tb_bad; initial begin $display("checking..."); $fatal(1,"FAIL: bad"); end endmodule
`
);

writeFileSync(join(pds, "rtl", "top.v"), "module top(input clk, output led); assign led = clk; endmodule\n");
writeFileSync(join(pds, "constraints", "top.fdc"), "# smoke fixture\n");
writeFileSync(
  join(pds, "demo.pds"),
  `(_flow demo "2022.2-SP4.2"
    (_comment "smoke")
    (_version "1.1.0")
    (_status "initial")
    (_project (_option prj_work_dir (_string ".")) (_option prj_impl_dir (_string ".")))
    (_task tsk_setup
      (_widget wgt_select_arch (_input (_part (_family Logos2)(_device PG2L100H)(_speedgrade -6)(_package FBG484))))
      (_widget wgt_my_design_src (_input (_file "rtl/top.v" + "top" (_format verilog)(_timespec "2026-06-15T00:00:00"))))
      (_widget wgt_import_logic_con_file (_input (_file "constraints/top.fdc" (_format fdc)(_timespec "2026-06-15T00:00:00")))))
    (_task tsk_compile (_command cmd_compile (_gci_state (_integer 0)))))
`
);
writeFileSync(join(pds, "generate_bitstream", "top.sbit"), "plain smoke bitstream\n");
writeFileSync(join(pds, "place_route", "top_timing_summary_after_hold_fix.txt"), "Clock setup summary\nWNS = 0.125\nTNS = 0\n");
writeFileSync(
  join(pds, "xml_demo.pds"),
  `<?xml version="1.0" encoding="UTF-8"?>
<project name="General" project_version="2.1.0">
  <members category="settings"><task><action><inputs><item type="PART"><part family="Logos2" device="PG2L200H" speedgrade="-6" package="FBB676"/></item></inputs></action></task></members>
  <members category="design_set"><task><options><option name="top_module" type="string" value="top"/></options><action><inputs><item type="FILE" file="rtl/top.v" format="verilog"/></inputs></action></task></members>
  <members category="constraint_set"><task><action><inputs><item type="FILE" file="constraints/top.fdc" format="fdc"/></inputs></action></task></members>
</project>
`
);
writeFileSync(
  join(pds, "prj_tasks", "pnr_1", "report_timing", "top.rtr"),
  `Performance Summary:
 Clock                        Requested       Estimated      Requested      Estimated                Slack
 top|clk                     1.0000 MHz    705.7163 MHz      1000.0000         1.4170        998.583
Design Summary : All Constraints Met.
Setup Summary(Slow Corner):
 Launch Clock           Capture Clock              WNS(ns)     TNS(ns)      Endpoints      Endpoints
 top|clk                top|clk                    998.583       0.000              0             38
Hold Summary(Slow Corner):
 Launch Clock           Capture Clock              WHS(ns)     THS(ns)      Endpoints      Endpoints
 top|clk                top|clk                      0.269       0.000              0             38
 Slack (MET)                                                       998.583
`
);

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));

// A tool that fails returns PLAIN TEXT, not JSON — JSON.parse then dies on the
// first character of a Chinese error message, which reads as "the smoke test is
// broken" rather than "you have no iverilog". This is the second command the
// README tells a new user to run, so it has to say which one it is.
const jsonTool = async (name, args = {}) => {
  const text = (await client.callTool({ name, arguments: args })).content[0].text;
  try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
};

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const env = await jsonTool("fpga_env");
console.log("fpga_env ->", JSON.stringify(env).replace(/\s+/g, " ").slice(0, 160));

// Everything from here to the PDS-log section needs a simulator on PATH. Say so
// and stop, rather than reporting a cascade of failures that all mean this.
if (!env.tools?.iverilog) {
  console.log("\nSKIP: no iverilog on PATH — the simulation legs need one.");
  console.log("      Install Icarus Verilog and re-run, or use `pnpm test:unit`,");
  console.log("      which covers the parsers and guards with no toolchain at all.");
  await client.close();
  process.exit(0);
}

const g = await jsonTool("fpga_sim", { workdir: good, top: "tb_counter", vcd: true });
console.log("good  -> ok=", g.ok, "phase=", g.phase, "exit=", g.exitCode, "vcd=", existsSync(g.artifacts.vcd));

const a = await jsonTool("fpga_assert", {
  log: g.log,
  vcdPath: g.artifacts.vcd,
  assertions: [
    { name: "log_pass", type: "log_contains", pattern: "PASS" },
    { name: "q_final", type: "vcd_final_eq", signal: "q", value: 10 },
  ],
});
console.log("assert -> ok=", a.ok, "passed=", a.passed, "failed=", a.failed);

const b = await jsonTool("fpga_sim", { workdir: bad, top: "tb_bad" });
console.log("bad   -> ok=", b.ok, "phase=", b.phase, "exit=", b.exitCode);

const info = await jsonTool("fpga_project_info", { pdsPath: join(pds, "demo.pds") });
console.log("project -> ok=", info.ok, "device=", info.part?.device, "sources=", info.sources.length);

const xmlInfo = await jsonTool("fpga_project_info", { pdsPath: join(pds, "xml_demo.pds") });
console.log("xml project -> ok=", xmlInfo.ok, "device=", xmlInfo.part?.device, "top=", xmlInfo.topSource);

const reportLog = 'W: benign warning\\nThe bitstream file is "generate_bitstream/top.sbit"\\n';
const reports = await jsonTool("fpga_pds_reports", { pdsPath: join(pds, "xml_demo.pds"), log: reportLog });
console.log("reports -> ok=", reports.ok, "device=", reports.project?.part?.device, "sbit=", reports.artifacts.sbit, "timingMet=", reports.timing.met, "worst=", reports.timing.worst);

const flashGate = await jsonTool("fpga_flash_sram", {
  sbit: join(pds, "generate_bitstream", "top.sbit"),
  expectIdcode: "PG2L100H",
});
console.log("flash gate -> phase=", flashGate.phase, "ok=", flashGate.ok);

// N1: log hook — extract key info from a synthetic pds_shell log (Place-0084 +
// benign fifo warning). The agent should get the stage, error code, the
// known-issue diagnosis, and benign-warning classification — not the raw log.
const pdsLog = [
  "Analyzing module top",
  "Placement done",
  "E: Place-0084: GLOBAL_CLOCK: the driver clk_ibuf is unreasonable",
  "W: IPSpecCheck warning on fifo signal WR_ADDR_WIDTH mismatch",
].join("\n");
const ex = await jsonTool("fpga_log_extract", { profile: "pds", log: pdsLog });
console.log("log_extract(pds) -> stage=", ex.stage, "errors=", ex.errorCount, "known=", (ex.diagnostics?.knownIssues || []).map((i) => i.code).join("|"), "benign=", ex.warnings?.benignCount);

const exSim = await jsonTool("fpga_log_extract", { profile: "sim", log: "checking...\n$fatal: FAIL bad value" });
console.log("log_extract(sim) -> failMark=", exSim.failMark);

// N2: tiered capability catalog.
const caps = await jsonTool("fpga_capabilities");
console.log("capabilities -> tier0=", caps.tiers?.tier0_hot?.length, "howto keys=", Object.keys(caps.howto || {}).length);

// N2: fpga_cdt must stop a device-mutating script at the confirm gate (negative
// control — never reaches hardware).
const cdtGate = await jsonTool("fpga_cdt", { commands: ["cfg_program -device_index 0"] });
console.log("cdt gate -> phase=", cdtGate.phase, "ok=", cdtGate.ok, "mutating=", (cdtGate.mutating || []).join("|"));

// N2: fpga_exe must reject a non-allowlisted exe with non-help args.
const exeRaw = await client.callTool({ name: "fpga_exe", arguments: { exe: "pds_shell", args: ["-project", "x.pds"] } });
console.log("exe guard -> isError=", !!exeRaw.isError);

// N3: primitive knowledge lookup (Logos2 gtp_lib corpus).
const prim = await jsonTool("fpga_primitive_lookup", { name: "GTP_GPLL" });
console.log("primitive GTP_GPLL -> cat=", prim.primitive?.category, "ports=", prim.primitive?.ports?.length, "params=", prim.primitive?.params?.length);
const primQ = await jsonTool("fpga_primitive_lookup", { query: "pll" });
console.log("primitive query pll -> count=", primQ.count, "retrieval=", primQ.retrieval, "top=", primQ.matches?.slice(0, 3).map((m) => m.name).join(","));
const primKwOnly = await jsonTool("fpga_primitive_lookup", { query: "pll", mode: "keyword" });

// N3: IP catalog lookup.
const ipQ = await jsonTool("fpga_ip_lookup", { query: "pll" });
console.log("ip query pll -> count=", ipQ.count, "top=", ipQ.matches?.slice(0, 3).map((m) => m.displayName).join(","));

// N3: doc search — extracted chunk text (Tcl command lives here, not in titles).
const docQ = await jsonTool("fpga_doc_search", { query: "cfg_program" });
console.log("doc search cfg_program -> chunks=", docQ.chunks?.length, "topChunk=", docQ.chunks?.[0]?.title);
// N3: manual PDF registry — title/tool query returns a PDF path to Read.
const docM = await jsonTool("fpga_doc_search", { query: "power calculator", kind: "manual" });
console.log("doc search power(manual) -> docs=", docM.docs?.length, "top=", docM.docs?.[0]?.title, "path?", !!docM.docs?.[0]?.path);

await client.close();

let fail = false;
const has = (name) => tools.tools.find((t) => t.name === name);
for (const name of ["fpga_sim", "fpga_assert", "fpga_project_info", "fpga_pds_reports", "fpga_pds_scan", "fpga_flash_sram"]) {
  if (!has(name)) (console.error(`✗ 缺 ${name}`), (fail = true));
}
if (g.ok !== true || !existsSync(g.artifacts.vcd)) (console.error("✗ good 期望 ok=true 且有 VCD", g), (fail = true));
if (a.ok !== true) (console.error("✗ assert 期望 ok=true", a), (fail = true));
if (b.ok !== false) (console.error("✗ bad 期望 ok=false(负向对照)", b), (fail = true));
if (info.ok !== true || info.part?.device !== "PG2L100H" || info.sources.length !== 1) {
  console.error("✗ project_info 解析异常", info);
  fail = true;
}
if (xmlInfo.ok !== true || xmlInfo.part?.device !== "PG2L200H" || xmlInfo.topSource !== "rtl/top.v" || xmlInfo.sources.length !== 1) {
  console.error("✗ XML project_info 解析异常", xmlInfo);
  fail = true;
}
if (reports.ok !== true || reports.project?.part?.device !== "PG2L200H" || !reports.artifacts.sbit || reports.timing.met !== true || reports.timing.worst !== 998.583) {
  console.error("✗ pds_reports 解析异常", reports);
  fail = true;
}
if (flashGate.phase !== "confirm" || flashGate.ok !== false) {
  console.error("✗ flash_sram 未停在确认门", flashGate);
  fail = true;
}
if (!has("fpga_log_extract")) (console.error("✗ 缺 fpga_log_extract"), (fail = true));
const exKnown = (ex.diagnostics?.knownIssues || []).map((i) => i.code);
if (ex.stage !== "place" || ex.errorCount !== 1 || !exKnown.includes("place_0084_nonclock_io") || ex.warnings?.benignCount !== 1) {
  console.error("✗ log_extract(pds) 关键信息提取异常", ex);
  fail = true;
}
if (exSim.failMark !== true) (console.error("✗ log_extract(sim) 未检出失败标记(负向对照)", exSim), (fail = true));
if (g.truncated !== false || typeof g.logBytes !== "number") (console.error("✗ fpga_sim 缺 attachLog 元数据", { truncated: g.truncated, logBytes: g.logBytes }), (fail = true));
for (const name of ["fpga_pds_run", "fpga_cdt", "fpga_exe", "fpga_capabilities"]) {
  if (!has(name)) (console.error(`✗ 缺 ${name}`), (fail = true));
}
if (!(caps.tiers?.tier0_hot?.length > 0) || !caps.howto) (console.error("✗ capabilities 目录异常", caps), (fail = true));
if (cdtGate.phase !== "confirm" || cdtGate.ok !== false || !(cdtGate.mutating || []).includes("cfg_program")) {
  console.error("✗ fpga_cdt 未在写器件确认门拦截(负向对照)", cdtGate);
  fail = true;
}
if (exeRaw.isError !== true) (console.error("✗ fpga_exe 未拦截非允许列表 exe(负向对照)", exeRaw), (fail = true));
if (!has("fpga_primitive_lookup")) (console.error("✗ 缺 fpga_primitive_lookup"), (fail = true));
if (prim.primitive?.category !== "clock_pll" || !(prim.primitive?.ports?.length > 0) || !(prim.primitive?.params?.length > 0)) {
  console.error("✗ primitive_lookup(GTP_GPLL) 异常", prim);
  fail = true;
}
if (!(primQ.count > 0) || !primQ.matches?.some((m) => m.name === "GTP_GPLL")) {
  console.error("✗ primitive_lookup(query pll) 未召回 GTP_GPLL", primQ);
  fail = true;
}
// retrieval mode is reported and (without an embed provider configured) falls back to keyword.
if (!["keyword", "semantic"].includes(primQ.retrieval)) (console.error("✗ primitive_lookup 未报告 retrieval 模式", primQ.retrieval), (fail = true));
if (primKwOnly.retrieval !== "keyword") (console.error("✗ mode:keyword 未走关键词路径", primKwOnly.retrieval), (fail = true));
for (const name of ["fpga_ip_lookup", "fpga_doc_search"]) if (!has(name)) (console.error(`✗ 缺 ${name}`), (fail = true));
if (!(ipQ.count > 0) || !ipQ.matches?.some((m) => /PLL/i.test(m.displayName || m.name || ""))) {
  console.error("✗ ip_lookup(query pll) 未召回 PLL 核", ipQ);
  fail = true;
}
if (!(docQ.chunks?.length > 0) || !/cfg_program/i.test(JSON.stringify(docQ.chunks || []))) {
  console.error("✗ doc_search(cfg_program) 未从抽取文本召回", docQ);
  fail = true;
}
if (!(docM.docs?.length > 0) || !docM.docs?.[0]?.path) {
  console.error("✗ doc_search(power, manual) 未返回带路径的手册", docM);
  fail = true;
}

console.log(fail ? "SMOKE: FAIL" : "SMOKE: PASS（sim/assert/PDS报告/确认门 + 日志hook + cdt/exe护栏 + 原语/IP/文档检索）");
process.exit(fail ? 1 : 0);
