// Remote ModelSim e2e: runs fpga_msim_sim on a remote host. Set PANGO_MCP_TEST_HOST
// to a host id from pango-mcp.config.json hosts{}; skipped when unset/unreachable.
// over SSH — stages sources, builds+sims there, pulls the VCD back, feeds
// fpga_assert. Skips cleanly if the host is unreachable. Run: node test/msim-remote.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");
const root = join(here, ".msim-remote");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "dut.v"), `module dut(input a, input b, output y);\n  assign y = a & b;\nendmodule\n`);
writeFileSync(join(root, "tb.v"), `module tb;\n  reg a,b; wire y; dut u(a,b,y);\n  initial begin\n    a=0;b=0;#1; a=1;b=1;#1;\n    if (y!==1'b1) $fatal(1,"FAIL");\n    $display("SIM PASS"); $finish;\n  end\nendmodule\n`);
writeFileSync(join(root, "tb_bad.v"), `module tb_bad;\n  reg a,b; wire y; dut u(a,b,y);\n  initial begin\n    a=1;b=0;#1; if (y!==1'b1) $fatal(1,"ASSERT_FAIL"); $finish;\n  end\nendmodule\n`);

const HOST = process.env.PANGO_MCP_TEST_HOST;
// ModelSim win64 dir ON THE REMOTE HOST — vendor-primitive lib source for the
// libDirs leg. Machine-specific, so it is configuration, not a constant.
const REMOTE_MSIM_WIN64 = process.env.PANGO_MCP_TEST_REMOTE_MSIM_WIN64;
if (!HOST) {
  console.log("SKIP msim-remote: set PANGO_MCP_TEST_HOST to a configured host id (see pango-mcp.config.example.json hosts{})");
  process.exit(0);
}
const client = new Client({ name: "msim-remote", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));
const callTool = async (name, args = {}, opts = {}) => {
  const text = (await client.callTool({ name, arguments: args }, undefined, opts)).content[0].text;
  try { return JSON.parse(text); } catch { return { ok: false, error: text }; } // toolError → plain text
};
let fail = false;
const check = (c, m, x) => { if (!c) { console.error(`✗ ${m}`, x ?? ""); fail = true; } else console.log(`✓ ${m}`); };

// 0) remote env probe (also our reachability gate)
const env = await callTool("fpga_env", { host: HOST });
const unreachable = (s) => s && /(SSH|连接|ECONN|ETIMEDOUT|未配置|未知 host|认证|timed out)/i.test(s);
if (unreachable(env.error) || unreachable((env.hints || []).join(" "))) {
  console.log(`host '${HOST}' 不可达或未配置，跳过远程 e2e。`, env.error || env.hints);
  await client.close();
  process.exit(0);
}
console.log(`remote env -> os=${env.remoteOs} modelsim vsim=${env.modelsim?.tools?.vsim}`);
check(!!env.modelsim?.tools?.vsim, "remote fpga_env reports ModelSim vsim", env.modelsim);

// 1) good sim on the remote host, with VCD pulled back
const good = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], host: HOST, vcd: true, timeoutSec: 120 }, { timeout: 240000 });
console.log(`good remote -> ok=${good.ok} scope=${good.scope} host=${good.host} vcd=${good.artifacts?.vcd} finished=${good.run?.finished} err=${good.error || ""}`);
check(good.ok === true && good.scope === "remote", "remote good sim ok=true (scope=remote)", { errors: good.errors, hint: good.hint });
check(!!good.artifacts?.vcd && existsSync(good.artifacts.vcd), "remote VCD pulled to local mirror", good.artifacts?.vcd);
if (good.artifacts?.vcd && existsSync(good.artifacts.vcd)) {
  const a = await callTool("fpga_assert", { vcdPath: good.artifacts.vcd, assertions: [{ name: "y_final", type: "vcd_final_eq", signal: "y", value: 1 }] });
  check(a.ok === true, "fpga_assert on remote-pulled VCD (y final=1)", a.results);
}

// 2) NEGATIVE — $fatal tb on the remote host: ok must be false
const bad = await callTool("fpga_msim_sim", { workdir: root, top: "tb_bad", sources: ["dut.v", "tb_bad.v"], host: HOST, timeoutSec: 120 }, { timeout: 240000 });
console.log(`bad remote  -> ok=${bad.ok} fatal=${bad.run?.fatal} exitCode=${bad.exitCode}`);
check(bad.ok === false, "remote $fatal sim ok=FALSE", { exitCode: bad.exitCode });
check(bad.run?.fatal === true, "remote: ** Fatal detected", bad.run);

// 3) remote cache hit (identical inputs as case 1)
const good2 = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], host: HOST, vcd: true, timeoutSec: 120 }, { timeout: 240000 });
check(good2.ok === true && good2.cached === true, "remote cache hit on identical inputs", { cached: good2.cached });

// 4) remote compile-only
const rc = await callTool("fpga_msim_compile", { workdir: root, sources: ["dut.v", "tb.v"], host: HOST }, { timeout: 180000 });
console.log(`compile remote -> ok=${rc.ok} scope=${rc.scope}`);
check(rc.ok === true && rc.scope === "remote", "remote compile-only ok=true", { errors: rc.errors });

// 5) remote bin-tool probe (fpga_msim_exe)
const rexe = await callTool("fpga_msim_exe", { exe: "vlib", args: ["-version"], host: HOST });
console.log(`exe remote -> scope=${rexe.scope} exitCode=${rexe.exitCode}`);
check(rexe.scope === "remote" && typeof rexe.exitCode === "number", "remote fpga_msim_exe ran on host", { ok: rexe.ok });

// 6) remote do (self-contained: stages dut/tb, compiles+sims inside the do)
const rdo = await callTool("fpga_msim_do", { workdir: root, host: HOST, doScript: "vlib work\nvlog -quiet dut.v tb.v\nvsim -c work.tb\nrun -all\nquit -f" }, { timeout: 180000 });
console.log(`do remote -> ok=${rdo.ok} scope=${rdo.scope} finished=${rdo.run?.finished}`);
check(rdo.ok === true && rdo.scope === "remote", "remote fpga_msim_do (self-contained vlib/vlog/vsim)", { errors: rdo.errors });

// 7) libDirs remote plumbing (benign remote dir; proves -y arg path doesn't break)
const rlib = await callTool("fpga_msim_sim", { workdir: root, top: "tb", sources: ["dut.v", "tb.v"], host: HOST, libDirs: [REMOTE_MSIM_WIN64], cache: false, timeoutSec: 120 }, { timeout: 240000 });
check(rlib.ok === true, "remote sim with libDirs (-y plumbing) ok=true", { errors: rlib.errors });

await client.close();
console.log(fail ? "\nMSIM-REMOTE: FAIL" : "\nMSIM-REMOTE: PASS");
process.exit(fail ? 1 : 0);
