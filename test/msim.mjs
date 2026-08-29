// Real ModelSim e2e via the MCP client (needs ModelSim installed, like
// test/n1-compile.mjs needs PDS). Exercises the full toolchain through stdio:
//   good Verilog sim (ok=true) · $fatal sim (ok=FALSE though vsim exits 0) ·
//   VHDL via vcom (ok=true) · VCD → fpga_assert · cache hit · fpga_msim_exe.
// Run: node test/msim.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { pdsHome } from "../src/toolchains/pango-pds/install.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");
// PDS install root, for the encrypted-IP (.vp) leg only. Resolved from the
// same config the server uses, so this test carries no machine path of its own.
const PDS_HOME = pdsHome();
const root = join(here, ".msim");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

writeFileSync(join(root, "dut.v"), `module dut(input a, input b, output y);
  assign y = a & b;
endmodule
`);
writeFileSync(join(root, "tb.v"), `module tb;
  reg a, b; wire y; dut u(a, b, y);
  initial begin
    a=0; b=0; #1; if (y!==1'b0) $fatal(1,"f00");
    a=1; b=1; #1; if (y!==1'b1) $fatal(1,"f11");
    $display("SIM PASS"); $finish;
  end
endmodule
`);
writeFileSync(join(root, "tb_bad.v"), `module tb_bad;
  reg a, b; wire y; dut u(a, b, y);
  initial begin
    a=1; b=0; #1; if (y!==1'b1) $fatal(1,"ASSERT_FAIL");
    $display("UNREACHABLE"); $finish;
  end
endmodule
`);
writeFileSync(join(root, "and2.vhd"), `library ieee; use ieee.std_logic_1164.all;
entity and2 is port(a,b: in std_logic; y: out std_logic); end entity;
architecture rtl of and2 is begin y <= a and b; end architecture;
`);
writeFileSync(join(root, "tb_vhd.vhd"), `library ieee; use ieee.std_logic_1164.all;
entity tb_vhd is end entity;
architecture sim of tb_vhd is signal a,b,y: std_logic:='0'; begin
  uut: entity work.and2 port map(a,b,y);
  process begin a<='1'; b<='1'; wait for 1 ns;
    assert y='1' report "FAIL" severity failure;
    report "VHDL SIM PASS" severity note; wait; end process;
end architecture;
`);
writeFileSync(join(root, "uvm_tb.sv"), `\`include "uvm_macros.svh"
import uvm_pkg::*;
class my_test extends uvm_test;
  \`uvm_component_utils(my_test)
  function new(string name, uvm_component parent); super.new(name, parent); endfunction
  task run_phase(uvm_phase phase);
    phase.raise_objection(this);
    \`uvm_info("MY_TEST", "hello from uvm run_phase", UVM_LOW)
    #10; phase.drop_objection(this);
  endtask
endclass
class my_test_fail extends uvm_test;
  \`uvm_component_utils(my_test_fail)
  function new(string name, uvm_component parent); super.new(name, parent); endfunction
  task run_phase(uvm_phase phase);
    phase.raise_objection(this);
    \`uvm_error("MY_TEST", "deliberate failure for anti-hallucination check")
    #10; phase.drop_objection(this);
  endtask
endclass
module top; initial run_test(); endmodule
`);

const client = new Client({ name: "msim", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));
const callTool = async (name, args = {}, options = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, options)).content[0].text);

let fail = false;
const check = (cond, msg, extra) => { if (!cond) { console.error(`✗ ${msg}`, extra ?? ""); fail = true; } else console.log(`✓ ${msg}`); };

const env = await callTool("fpga_env");
const hasMsim = !!env.modelsim?.tools?.vsim;
console.log(`modelsim home=${env.modelsim?.home} vsim=${hasMsim}`);
if (!hasMsim) { console.log("ModelSim 不可用，跳过 e2e（设 PANGO_MCP_MODELSIM_HOME）。"); await client.close(); process.exit(0); }

// 1) good Verilog sim, with VCD
const good = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], vcd: true, timeoutSec: 120 }, { timeout: 180000 });
console.log(`good -> ok=${good.ok} errors=${good.errorCount} finished=${good.run?.finished} vcd=${!!good.artifacts?.vcd} cached=${good.cached}`);
check(good.ok === true, "good Verilog sim ok=true", { errors: good.errors });
check(good.run?.summary?.errors === 0, "good: vsim Errors:0");
check(!!good.artifacts?.vcd, "good: VCD produced");

// 2) cache hit (identical inputs)
const cached = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], vcd: true, timeoutSec: 120 }, { timeout: 180000 });
check(cached.cached === true && cached.ok === true, "cache hit on identical inputs", { cached: cached.cached });

// 3) VCD → fpga_assert (reuse the sim toolchain's judge)
if (good.artifacts?.vcd) {
  const asserted = await callTool("fpga_assert", { log: good.log || "", vcdPath: good.artifacts.vcd, assertions: [{ name: "y_final", type: "vcd_final_eq", signal: "y", value: 1 }] });
  check(asserted.ok === true, "fpga_assert on ModelSim VCD (y final=1)", asserted.results);
}

// 4) NEGATIVE CONTROL — $fatal tb, vsim exits 0 but ok must be false
const bad = await callTool("fpga_msim_sim", { workdir: root, top: "tb_bad", sources: ["dut.v", "tb_bad.v"], timeoutSec: 120 }, { timeout: 180000 });
console.log(`bad  -> ok=${bad.ok} exitCode=${bad.exitCode} fatal=${bad.run?.fatal} errors=${bad.run?.summary?.errors}`);
check(bad.ok === false, "bad $fatal sim ok=FALSE (despite likely exit 0)", { exitCode: bad.exitCode });
check(bad.run?.fatal === true, "bad: ** Fatal detected");

// 5) VHDL via vcom
const vhdl = await callTool("fpga_msim_sim", { workdir: root, top: "tb_vhd", sources: ["and2.vhd", "tb_vhd.vhd"], timeoutSec: 120 }, { timeout: 180000 });
console.log(`vhdl -> ok=${vhdl.ok} languages=${(vhdl.languages || []).join("+")}`);
check(vhdl.ok === true, "VHDL (vcom) sim ok=true", { errors: vhdl.errors });
check((vhdl.languages || []).includes("vhdl"), "VHDL: language detected");

// 6) fpga_msim_exe probe (runs an allowlisted util) + allowlist gate
const exe = await callTool("fpga_msim_exe", { exe: "vdir", args: ["-help"] });
check(exe.helpOnly === true && (exe.log || "").length > 0, "fpga_msim_exe vdir -help returns output", exe);
const gated = await callTool("fpga_msim_exe", { exe: "vsim", args: ["-c"] });
check(gated.ok === false && gated.phase === "blocked", "fpga_msim_exe gates non-allowlisted vsim (non -help)", gated);

// 7) fpga_msim_do confirm gate — host-reaching script without confirm is blocked
//    (returns before any vsim runs; install-independent policy gate).
const doGated = await callTool("fpga_msim_do", { workdir: root, doScript: 'exec echo hi\nfile delete C:/nope\nrun -all' });
check(doGated.ok === false && doGated.phase === "confirm", "do: suspicious script without confirm gated", doGated);
check(Array.isArray(doGated.suspicious) && doGated.suspicious.includes("exec"), "do: gate reports suspicious tokens", doGated.suspicious);

// 8) with confirm:true the gate is bypassed and a real sim runs. Earlier sims
//    overwrite `work` (compileSources wipes the lib), so recompile the Verilog
//    design first, then drive the (now-present) work.tb through the do gate.
await callTool("fpga_msim_compile", { workdir: root, sources: ["dut.v", "tb.v"] }, { timeout: 120000 });
const buildRoot = join(root, "._fpga_msim");
const doConfirm = await callTool("fpga_msim_do", { workdir: buildRoot, top: "tb", doScript: "file mkdir gatecheck\nrun -all", confirm: true }, { timeout: 120000 });
console.log(`do   -> ok=${doConfirm.ok} phase=${doConfirm.phase} finished=${doConfirm.run?.finished}`);
check(doConfirm.ok === true, "do: suspicious script WITH confirm runs real sim", { errors: doConfirm.errors, phase: doConfirm.phase });

// 9) coverage: structured % (branch/statement/toggle) + ucdb artifact. Needs
//    -cover compile + vsim -coverage -onfinish stop (so $finish returns to the
//    do-file for coverage report/save) + +cover vopt — all auto-injected.
const cov = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], coverage: true, timeoutSec: 120 }, { timeout: 180000 });
console.log(`cov  -> ok=${cov.ok} total=${cov.coverage?.total} metrics=${Object.keys(cov.coverage?.metrics || {}).join(",")} ucdb=${!!cov.artifacts?.coverageUcdb}`);
check(cov.ok === true, "coverage sim ok=true", { errors: cov.errors });
check(cov.coverage && typeof cov.coverage.total === "number", "coverage: total % present", cov.coverage);
check(typeof cov.coverage?.metrics?.statement?.pct === "number", "coverage: statement metric present", cov.coverage?.metrics);
check(!!cov.artifacts?.coverageUcdb, "coverage: ucdb artifact saved", cov.artifacts);

// 10) UVM via precompiled mtiUvm (no gcc/DPI) — passing test ok=true
const uvmPass = await callTool("fpga_msim_sim", { workdir: root, top: "top", sources: ["uvm_tb.sv"], uvm: true, uvmTest: "my_test", timeoutSec: 120 }, { timeout: 180000 });
console.log(`uvm  -> ok=${uvmPass.ok} uvm=${JSON.stringify(uvmPass.uvm)}`);
check(uvmPass.ok === true, "UVM passing test ok=true", { errors: uvmPass.errors, uvm: uvmPass.uvm });
check(uvmPass.uvm?.error === 0 && uvmPass.uvm?.fatal === 0, "UVM: report parsed (error 0, fatal 0)", uvmPass.uvm);

// 11) NEGATIVE — uvm_error makes ok FALSE even though ModelSim prints Errors: 0
const uvmFail = await callTool("fpga_msim_sim", { workdir: root, top: "top", sources: ["uvm_tb.sv"], uvm: true, uvmTest: "my_test_fail", timeoutSec: 120 }, { timeout: 180000 });
console.log(`uvmF -> ok=${uvmFail.ok} uvm.error=${uvmFail.uvm?.error} msimErrors=${uvmFail.run?.summary?.errors}`);
check(uvmFail.ok === false, "UVM failing test ok=FALSE (UVM_ERROR>0 though ModelSim Errors:0)", { uvm: uvmFail.uvm, msim: uvmFail.run?.summary });
check(uvmFail.uvm?.error >= 1, "UVM: UVM_ERROR counted in report", uvmFail.uvm);

// 12) fpga_msim_doc_search — exact command + keyword + summary (corpus-based)
const docCmd = await callTool("fpga_msim_doc_search", { command: "vsim" });
console.log(`doc  -> vsim ok=${docCmd.ok} desc?=${!!docCmd.command?.description}`);
check(docCmd.ok === true && /VSIM simulator/i.test(docCmd.command?.description || ""), "doc_search: exact command vsim", docCmd.command);
const docQ = await callTool("fpga_msim_doc_search", { query: "examine", kind: "command", limit: 5 });
check((docQ.commands || []).some((c) => c.command === "examine"), "doc_search: query 'examine' finds examine (name-weighted)", (docQ.commands || []).map((c) => c.command));
const docSum = await callTool("fpga_msim_doc_search", {});
check(docSum.commandCount > 100 && docSum.manualCount >= 1 && (docSum.manuals || []).some((m) => /modelsim_se_ref/.test(m.title)), "doc_search: summary (commands + manual registry)", { cmds: docSum.commandCount, manuals: docSum.manualCount });

// 13) ENCRYPTED IP: a real Pango PCIe sim model (.vp, IEEE-1735 w/ Mentor key)
//     must compile through the MCP — vlog decrypts it natively (no PDS sim driver).
// Encrypted-IP leg: derived from the configured PDS install, never baked in.
const encVp = process.env.PANGO_MCP_ENCRYPTED_VP || (PDS_HOME && join(PDS_HOME, "arch", "vendor", "pango", "verilog", "bsim", "modelsim10.2c", "GTP_PCIEGEN2_DFT.vp"));
if (existsSync(encVp)) {
  const enc = await callTool("fpga_msim_compile", { workdir: root, sources: [encVp] }, { timeout: 120000 });
  console.log(`enc  -> ok=${enc.ok} errors=${enc.errorCount} langs=${(enc.languages || []).join("+")}`);
  check(enc.ok === true, "encrypted .vp (PCIe) compiles via MCP — vlog decrypts IEEE-1735", { errors: enc.errors });
  const flPath = join(root, "ip.f");
  writeFileSync(flPath, `${encVp.replace(/\\/g, "/")}\n`);
  const fl = await callTool("fpga_msim_compile", { workdir: root, fileList: flPath }, { timeout: 120000 });
  check(fl.ok === true, "fileList (-F) compiles encrypted IP model", { errors: fl.errors });
} else {
  console.log("(PDS PCIe .vp 不在本机，跳过加密 IP 用例)");
}

// 14) waveform visualization — wave:true turnkey, fpga_wave, fpga_msim_view
const wv = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], wave: true, waveSignals: ["a", "b", "y"], timeoutSec: 120 }, { timeout: 180000 });
console.log(`wave -> ok=${wv.ok} svg=${!!wv.artifacts?.waveSvg} html=${!!wv.artifacts?.waveHtml} sigs=${wv.wave?.signalCount}`);
check(wv.ok === true && !!wv.artifacts?.waveSvg && existsSync(wv.artifacts.waveSvg), "sim wave:true -> waveform SVG produced", wv.wave);
check(!!wv.artifacts?.waveHtml && existsSync(wv.artifacts.waveHtml), "sim wave:true -> waveform HTML produced");

const theVcd = wv.artifacts?.vcd;
if (theVcd && existsSync(theVcd)) {
  const wave = await callTool("fpga_wave", { vcdPath: theVcd, signals: ["y"], inlineSvg: true });
  console.log(`fpga_wave -> ok=${wave.ok} svgPath=${!!wave.svgPath} inline=${(wave.svg || "").startsWith("<svg")}`);
  check(wave.ok === true && existsSync(wave.svgPath) && (wave.svg || "").includes("<svg"), "fpga_wave renders VCD to SVG (file + inline)", { svgPath: wave.svgPath });

  const view = await callTool("fpga_msim_view", { vcdPath: theVcd, launch: false });
  console.log(`fpga_msim_view(launch:false) -> ok=${view.ok} wlf=${!!view.wlf} launched=${view.launched}`);
  check(view.ok === true && view.launched === false && existsSync(view.wlf), "fpga_msim_view prepares WLF (vcd2wlf) without launching", { wlf: view.wlf });
}

// 15) turnkey composite — one call does compile+sim+waveform+assertions
const combo = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], wave: true, assertions: [{ name: "y_high", type: "vcd_final_eq", signal: "y", value: 1 }], timeoutSec: 120 }, { timeout: 180000 });
console.log(`combo -> ok=${combo.ok} assertPass=${combo.assert?.passed} wave=${!!combo.artifacts?.waveSvg}`);
check(combo.ok === true && combo.assert?.passed === 1 && combo.assert?.failed === 0, "composite sim+wave+assert (passing) ok=true", combo.assert);
check(!!combo.artifacts?.waveSvg, "composite also produced the waveform image");
const comboFail = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], assertions: [{ name: "y_low", type: "vcd_final_eq", signal: "y", value: 0 }], timeoutSec: 120 }, { timeout: 180000 });
console.log(`comboFail -> ok=${comboFail.ok} msimErrors=${comboFail.run?.summary?.errors} assertFail=${comboFail.assert?.failed}`);
check(comboFail.ok === false && comboFail.assert?.failed === 1, "composite: failing assertion flips ok=false (transcript clean)", { msim: comboFail.run?.summary, assert: comboFail.assert });

await client.close();
console.log(fail ? "\nMSIM-E2E: FAIL" : "\nMSIM-E2E: PASS");
process.exit(fail ? 1 : 0);
