// Unit tests for the .vm netlist parser + signal resolver — the net-name
// discovery that lets ILA tap the RIGHT post-synth net. Fixture is a REAL
// run_ads netlist (test/fixtures/top_syn.vm) reproducing the alog.txt trap:
//   tx_int  : purely-internal net, survives clean (exact)
//   tx      : RTL reg driving an LED -> renamed to net nt_led[0]
//   clk     : port -> INBUF -> clock net nt_clk
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  discoverNets,
  expandBuses,
  findNetlistArtifacts,
  listInserterNets,
  parseInserterNetList,
  parseVm,
  resolveSignal,
  summarizeNetlist,
  validateInserterNets,
} from "../src/toolchains/pango-pds/netlist.mjs";
import { parsePdsProject } from "../src/toolchains/pango-pds/project.mjs";
import { parseVerilogIncludes, stageProjectInputs } from "../src/toolchains/pango-pds/staging.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vm = readFileSync(join(here, "fixtures", "top_syn.vm"), "utf8");
const parsed = parseVm(vm);
const sum = summarizeNetlist(parsed);
parsed.inserterNets = parseInserterNetList(`
0 : nt_led[0]                               GTP_DFF
1 : nt_led[1]                               GTP_DFF
2 : nt_led[2]                               GTP_DFF
3 : nt_led[3]                               GTP_DFF
4 : nt_led[4]                               GTP_DFF
5 : tx_int                                  uart_beacon
6 : nt_clk                                  GTP_INBUF
7 : u_beacon/cnt[0]                         GTP_DFF
8 : u_beacon/cnt[1]                         GTP_DFF
9 : u_beacon/cnt[2]                         GTP_DFF
10 : u_beacon/cnt[3]                        GTP_DFF
11 : u_beacon/cnt[4]                        GTP_DFF
12 : u_beacon/cnt[5]                        GTP_DFF
13 : u_beacon/cnt[6]                        GTP_DFF
14 : u_beacon/cnt[7]                        GTP_DFF
`);

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log("ok  ", n); pass += 1; } catch (e) { console.error("FAIL", n, "-", e.message); fail += 1; } };
const checkAsync = async (n, f) => { try { await f(); console.log("ok  ", n); pass += 1; } catch (e) { console.error("FAIL", n, "-", e.message); fail += 1; } };

check("topModule is 'top' (not the instantiated uart_beacon)", () => assert.equal(parsed.topModule, "top"));
check("both modules parsed", () => assert.deepEqual(parsed.modules.map((m) => m.name).sort(), ["top", "uart_beacon"]));

check("clock net resolved to nt_clk (renamed from clk)", () => assert.deepEqual(sum.clocks, ["nt_clk"]));
check("tappable top nets include tx_int, nt_clk, nt_led[4:0]", () => {
  const byName = Object.fromEntries(sum.tappable.map((t) => [t.net, t]));
  assert.ok(byName.tx_int, "tx_int present");
  assert.ok(byName.nt_clk, "nt_clk present");
  assert.equal(byName.nt_led.width, 5, "nt_led is a 5-bit bus");
  assert.equal(byName.nt_led.bus, "[4:0]");
});
check("top-level register tx maps to net nt_led[0]", () => {
  const tx = sum.registers.find((r) => r.inst === "tx");
  assert.ok(tx, "found DFF inst tx");
  assert.equal(tx.net, "nt_led[0]");
});
check("submodule u_beacon detected", () => {
  assert.ok(sum.submodules.some((s) => s.inst === "u_beacon" && s.module === "uart_beacon"));
});

// --- resolveSignal: the agent-facing contract ---
check("resolve tx_int -> exact (the clean internal oracle)", () => {
  const r = resolveSignal(parsed, "tx_int");
  assert.equal(r.status, "exact");
  assert.equal(r.net, "tx_int");
  assert.equal(r.verified, true);
});
check("resolve tx -> renamed to nt_led[0] (the trap the log hit by hand)", () => {
  const r = resolveSignal(parsed, "tx");
  assert.equal(r.status, "renamed");
  assert.equal(r.net, "nt_led[0]");
});
check("resolve clk -> renamed to clock net nt_clk", () => {
  const r = resolveSignal(parsed, "clk");
  assert.equal(r.status, "renamed");
  assert.equal(r.net, "nt_clk");
});
check("unique submodule bus expands to Inserter's full per-bit hierarchy", () => {
  const expanded = expandBuses(parsed, ["cnt"]);
  assert.deepEqual(expanded.names, Array.from({ length: 8 }, (_, i) => `u_beacon/cnt[${i}]`));
  for (const name of expanded.names) {
    const r = resolveSignal(parsed, name);
    assert.equal(r.status, "exact");
    assert.equal(r.verified, true);
  }
});
check("resolve a nonexistent signal -> pruned + preserve hint", () => {
  const r = resolveSignal(parsed, "does_not_exist");
  assert.equal(r.status, "pruned");
  assert.match(r.note, /syn_preserve|keep/);
});

// --- expandBuses: bus name -> per-bit channels ---
// Real UART netlist: `wire [7:0] rx_data`, `wire [1:0] rx_state_reg`.
const uartParsed = parseVm(readFileSync(join(here, "fixtures", "uart_syn.vm"), "utf8"));
check("expandBuses splits rx_data into 8 LSB-first per-bit channels", () => {
  const { names, expansions } = expandBuses(uartParsed, ["rx_data"]);
  assert.deepEqual(names, ["rx_data[0]", "rx_data[1]", "rx_data[2]", "rx_data[3]", "rx_data[4]", "rx_data[5]", "rx_data[6]", "rx_data[7]"]);
  assert.equal(expansions.length, 1);
  assert.equal(expansions[0].name, "rx_data");
  assert.equal(expansions[0].bits.length, 8);
});
check("expandBuses preserves scalars + explicit bits, expands only buses", () => {
  const { names } = expandBuses(uartParsed, ["rx_valid", "rx_data", "rx_state_reg", "nt_uart_rx"]);
  assert.deepEqual(names, [
    "rx_valid",
    "rx_data[0]", "rx_data[1]", "rx_data[2]", "rx_data[3]", "rx_data[4]", "rx_data[5]", "rx_data[6]", "rx_data[7]",
    "rx_state_reg[0]", "rx_state_reg[1]",
    "nt_uart_rx",
  ]);
});
check("expandBuses leaves an explicit bit (rx_data[3]) untouched", () => {
  const { names, expansions } = expandBuses(uartParsed, ["rx_data[3]"]);
  assert.deepEqual(names, ["rx_data[3]"]);
  assert.equal(expansions.length, 0);
});
check("each expanded bit resolves exact in the netlist", () => {
  const { names } = expandBuses(uartParsed, ["rx_data"]);
  for (const n of names) assert.equal(resolveSignal(uartParsed, n).status, "exact", `${n} should be exact`);
});

// --- Fabric Inserter authority: nested hierarchy, same-leaf ambiguity, buses ---
const inserterFixture = readFileSync(join(here, "fixtures", "inserter-nets.txt"), "utf8");
const inserterNets = parseInserterNetList(inserterFixture);
const authorityParsed = { ...parsed, inserterNets };

check("ins_list_nets parser preserves index/name/component and legacy bus spelling", () => {
  assert.equal(inserterNets.length, 10);
  assert.deepEqual(inserterNets[3], { index: 3, name: "u_left/u_inner/ready", sourceComponent: "GTP_DFF" });
  assert.equal(inserterNets[8].name, "u_legacy/count [0]");
});

check("nested complete flattened name resolves exactly", () => {
  const r = resolveSignal(authorityParsed, "u_left/u_inner/ready");
  assert.equal(r.status, "exact");
  assert.equal(r.net, "u_left/u_inner/ready");
  assert.equal(r.verified, true);
});

check("unique nested leaf resolves to Inserter's complete flattened hierarchy", () => {
  const r = resolveSignal(authorityParsed, "ready");
  assert.equal(r.status, "hierarchical");
  assert.equal(r.net, "u_left/u_inner/ready");
  assert.equal(r.verified, true);
});

check("same leaf in two instances is ambiguous instead of picking the first", () => {
  const r = resolveSignal(authorityParsed, "state");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.candidates, ["u_left/state", "u_right/state"]);
  assert.equal(r.net, null);
});

check("same bus leaf in two instances is ambiguous", () => {
  const expanded = expandBuses(authorityParsed, ["data"]);
  assert.deepEqual(expanded.names, ["data"]);
  const r = resolveSignal(authorityParsed, "data");
  assert.equal(r.status, "ambiguous");
  assert.deepEqual(r.candidates, ["u_left/data", "u_right/data"]);
});

check("explicit hierarchical bus expands LSB-first to exact Inserter spellings", () => {
  const expanded = expandBuses(authorityParsed, ["u_right/data"]);
  assert.deepEqual(expanded.names, ["u_right/data[0]", "u_right/data[1]"]);
  assert.equal(resolveSignal(authorityParsed, expanded.names[1]).status, "exact");
});

check("legacy spaced bus accepts normalized input but returns Inserter spelling", () => {
  const expanded = expandBuses(authorityParsed, ["u_legacy/count"]);
  assert.deepEqual(expanded.names, ["u_legacy/count [0]", "u_legacy/count [1]"]);
  assert.equal(resolveSignal(authorityParsed, "u_legacy/count[1]").net, "u_legacy/count [1]");
});

check("FIC preflight rejects any name absent from the Inserter authority", () => {
  const result = validateInserterNets(authorityParsed, ["clk_root", "u_left/state", "u_left/not_real"]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.verified, ["clk_root", "u_left/state"]);
  assert.deepEqual(result.missing, ["u_left/not_real"]);
});

await checkAsync("cdt_ins driver stages ins_set_file and parses its authoritative output", async () => {
  const root = join(tmpdir(), `fpga-inserter-list-unit-${Date.now()}`);
  try {
    mkdirSync(root, { recursive: true });
    const adfPath = join(root, "design.adf");
    const exePath = join(root, "cdt_ins.exe");
    writeFileSync(adfPath, "fixture", "utf8");
    writeFileSync(exePath, "fixture", "utf8");
    let invocation = null;
    const result = await listInserterNets({
      adfPath,
      install: { shell: join(root, "pds_shell.exe"), binDir: root },
      part: { device: "GENERIC", package: "PKG", speedgrade: "-1" },
      run: async (file, args, options) => {
        invocation = { file, args, options, script: readFileSync(join(root, "fpga_nl_inserter.tcl"), "utf8") };
        return {
          code: 0,
          timedOut: false,
          stdout: `${inserterFixture}\n==PANGO_MCP_INS_NEW_STATUS==0\n==PANGO_MCP_INS_INPUT_STATUS==0\n==PANGO_MCP_INS_LIST_STATUS==0\n==PANGO_MCP_INS_END==\n`,
          stderr: "",
        };
      },
      workDir: root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 10);
    assert.equal(invocation.file, exePath);
    assert.match(invocation.script, /ins_set_file -input/);
    assert.deepEqual(invocation.args.slice(0, 6), ["-device", "GENERIC", "-package", "PKG", "-speedgrade", "-1"]);
    assert.doesNotMatch(invocation.args.at(-1), /\\/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- Complete sidecar project inputs: XML IP + recursive RTL includes ---
const stagingPds = join(here, "fixtures", "nl-staging", "project.pds");
const stagingInfo = parsePdsProject(stagingPds);

check("XML project parser exposes type=IP as a project input", () => {
  assert.equal(stagingInfo.sources.length, 1);
  assert.equal(stagingInfo.constraints.length, 1);
  assert.equal(stagingInfo.ipFiles.length, 1);
  assert.equal(stagingInfo.ipFiles[0].path, "ip/core.idf");
  assert.equal(stagingInfo.ipFiles[0].library, "core");
  assert.equal(stagingInfo.auxFiles.length, 0);
  assert.ok(stagingInfo.projectInputs.some((item) => item.path === "ip/core.idf"));
});

check("sidecar staging recursively copies RTL includes and IDF source manifest", () => {
  const work = join(tmpdir(), `fpga-netlist-stage-unit-${Date.now()}`);
  try {
    const staged = stageProjectInputs({ projectInfo: stagingInfo, workDir: work });
    assert.deepEqual(staged.includeFiles.map((item) => item.path).sort(), ["rtl/defs.vh", "rtl/nested.vh"]);
    assert.equal(staged.ipFiles.length, 1);
    assert.deepEqual(staged.ipFiles[0].sourceItems.map((item) => item.stagedPath), ["ip/core.v"]);
    for (const path of ["rtl/top.v", "rtl/defs.vh", "rtl/nested.vh", "ip/core.idf", "ip/core.v", "constraints/top.fdc"]) {
      assert.ok(existsSync(join(work, ...path.split("/"))), `${path} staged`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

check("include scanner ignores commented directives", () => {
  assert.deepEqual(
    parseVerilogIncludes('/*\n`include "ignored_block.vh"\n*/\n// `include "ignored_line.vh"\n`include "kept.vh"\n'),
    ["kept.vh"]
  );
});

check("external project inputs are mapped inside a bounded sidecar namespace", () => {
  const base = join(tmpdir(), `fpga-netlist-external-unit-${Date.now()}`);
  const projectDir = join(base, "project");
  const external = join(base, "shared", "external.v");
  const work = join(base, "sidecar");
  try {
    mkdirSync(dirname(external), { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(external, "module external(); endmodule\n", "utf8");
    const staged = stageProjectInputs({
      projectInfo: { projectDir, sources: [{ path: external, absPath: external, format: "verilog", isTop: true }], constraints: [], ipFiles: [] },
      workDir: work,
    });
    assert.match(staged.sources[0].stagedPath, /^_external\//);
    assert.doesNotMatch(staged.sources[0].stagedPath, /(?:^|\/)\.\.(?:\/|$)/);
    assert.ok(existsSync(join(work, ...staged.sources[0].stagedPath.split("/"))));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

await checkAsync("compile E: stops before run_ads and returns structured original diagnostics", async () => {
  let calls = 0;
  let stagedPdsText = "";
  let stagedHeader = false;
  const result = await discoverNets({
    pdsPath: stagingPds,
    install: { shell: "fake-pds-shell" },
    run: async (_file, _args, { cwd }) => {
      calls += 1;
      stagedPdsText = readFileSync(join(cwd, "project.pds"), "utf8");
      stagedHeader = existsSync(join(cwd, "rtl", "defs.vh"));
      return {
        code: 0,
        stdout: "E: Verilog-4104: [rtl/top.v(line number: 1)] Include file 'missing.vh' does not exists.\nProgram Error Out.\n",
        stderr: "",
        timedOut: false,
      };
    },
  });
  try {
    assert.equal(calls, 1, "run_ads must not run after compile error");
    assert.equal(result.ok, false);
    assert.equal(result.stage, "compile");
    assert.equal(result.errorsDetailed[0].code, "Verilog-4104");
    assert.equal(result.errorsDetailed[0].file, "rtl/top.v");
    assert.match(result.errors[0], /Include file 'missing\.vh'/);
    assert.ok(result.diagnostics.some((line) => /Verilog-4104/.test(line)));
    assert.equal(stagedHeader, true);
    assert.match(stagedPdsText, /wgt_my_ips_src/);
    assert.match(stagedPdsText, /\(_ip "ip\/core\.idf"/);
    assert.match(stagedPdsText, /\(_ip_source_item "ip\/core\.v"/);
  } finally {
    if (result.work) rmSync(result.work, { recursive: true, force: true });
  }
});

check("netlist locator accepts nested PDS .vm and .adf output layouts", () => {
  const work = join(tmpdir(), `fpga-netlist-artifact-unit-${Date.now()}`);
  try {
    const out = join(work, "prj_tasks", "custom_run", "synthesize");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "design.adf"), "binary-placeholder", "utf8");
    writeFileSync(join(out, "design_mapped.vm"), "module design(); endmodule\n", "utf8");
    const found = findNetlistArtifacts(work);
    assert.equal(found.vmPath, join(out, "design_mapped.vm"));
    assert.equal(found.adfPath, join(out, "design.adf"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

console.log(`\nnetlist-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
