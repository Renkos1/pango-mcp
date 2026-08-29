// ModelSim transcript-parser unit test (no ModelSim install needed — always
// runnable). The load-bearing case is the negative control: a $fatal run where
// vsim STILL exits 0, yet ok must be false. Transcripts below are verbatim
// captures from ModelSim SE-64 2020.4 on this machine.
import { judgeModelsimOk, parseCoverageReport, parseModelsimLog, parseUvmReport } from "../src/toolchains/modelsim/logparse.mjs";
import { buildViewDo, detectSuspiciousDo } from "../src/toolchains/modelsim/index.mjs";
import { parseCmdHelp } from "../src/toolchains/modelsim/knowledge.mjs";

let fail = false;
const check = (cond, msg, extra) => {
  if (!cond) {
    console.error(`✗ ${msg}`, extra ?? "");
    fail = true;
  } else {
    console.log(`✓ ${msg}`);
  }
};

const goodSim = `# run -all
# SIM PASS
# ** Note: $finish    : tb.v(10)
#    Time: 2 ns  Iteration: 0  Instance: /tb
# End time: 09:17:19 on Jun 17,2026, Elapsed time: 0:00:02
# Errors: 0, Warnings: 0`;

const badSim = `# run -all
# ** Fatal: ASSERT_FAIL expected y=1
#    Time: 1 ns  Scope: tb_bad File: tb_bad.v Line: 6
# ** Note: $finish    : tb_bad.v(6)
#    Time: 1 ns  Iteration: 0  Instance: /tb_bad
# End time: 09:17:57 on Jun 17,2026, Elapsed time: 0:00:02
# Errors: 1, Warnings: 0`;

const compileErr = `-- Compiling module dut
** Error: dut.v(3): near ";": syntax error, unexpected ';'
Top level modules:
Errors: 1, Warnings: 0`;

const licenseErr = `# ** Error: Failure to obtain a license for the ModelSim feature.
# Errors: 1, Warnings: 0`;

// --- good run: clean transcript, exit 0 ---
const g = parseModelsimLog(goodSim);
check(g.summary?.errors === 0 && g.summary?.warnings === 0, "good: summary Errors:0/Warnings:0", g.summary);
check(g.fatal === false && g.errorCount === 0, "good: no fatal / no error lines");
check(g.finished === true, "good: $finish detected");
check(judgeModelsimOk(g, { exitCode: 0 }) === true, "good: judged ok=true");

// --- NEGATIVE CONTROL: $fatal but vsim exits 0 ---
const b = parseModelsimLog(badSim);
check(b.summary?.errors === 1, "bad: summary Errors:1", b.summary);
check(b.fatal === true, "bad: ** Fatal detected");
check(b.errorCount >= 1, "bad: error line counted", b.errorCount);
check(
  judgeModelsimOk(b, { exitCode: 0 }) === false,
  "bad: judged ok=FALSE despite exitCode 0 (anti-hallucination)",
);

// --- compile syntax error ---
const c = parseModelsimLog(compileErr);
check(c.summary?.errors === 1 && c.errorCount === 1, "compile: 1 error parsed", { s: c.summary, n: c.errorCount });
check(c.diagnostics.some((d) => d.code === "msim-syntax"), "compile: msim-syntax diagnostic", c.diagnostics);
check(judgeModelsimOk(c, { exitCode: 1 }) === false, "compile: ok=false");

// --- license error diagnostic ---
const l = parseModelsimLog(licenseErr);
check(l.diagnostics.some((d) => d.code === "msim-license"), "license: msim-license diagnostic", l.diagnostics);
check(judgeModelsimOk(l, { exitCode: 0 }) === false, "license: ok=false (** Error present)");

// --- timeout always fails ---
check(judgeModelsimOk(g, { exitCode: 0, timedOut: true }) === false, "timeout: ok=false even on clean log");

// --- fpga_msim_do confirm-gate detector ---------------------------------
// Pure-simulation scripts must NEVER trip the gate (sim is non-destructive).
for (const benign of [
  "run -all\nquit -f",
  "force /tb/clk 1 0, 0 50 -repeat 100\nrun 1us\nexamine /tb/y",
  "vcd file {out.vcd}\nvcd add -r /*\nrun -all",            // 'file' not a mutating subcommand
  "coverage save cov.ucdb\nvcover report cov.ucdb",
  "add wave -r /*\nrun -all",
  "examine sh\nexamine /tb/system_clk\nrun -all",            // 'sh'/'system' must not trip
  "# execute the run\nrun -all",                            // 'execute' is not \\bexec\\b
  'set fh [open "in.txt" r]\nrun -all',                     // read-only open is safe
]) {
  const hit = detectSuspiciousDo(benign);
  check(hit.length === 0, `do benign not flagged: ${benign.split("\n")[0]}`, hit);
}

// Host-reaching commands MUST be flagged (so the handler can demand confirm).
check(detectSuspiciousDo("exec rm -rf C:/x\nrun -all").includes("exec"), "do: Tcl exec flagged");
check(detectSuspiciousDo("file delete -force C:/important").some((s) => s.startsWith("file ")), "do: file delete flagged");
check(detectSuspiciousDo("file copy a b").some((s) => s.startsWith("file ")), "do: file copy flagged");
check(detectSuspiciousDo("file mkdir C:/x").some((s) => s.startsWith("file ")), "do: file mkdir flagged");
check(detectSuspiciousDo('set fh [open "log.txt" w]').includes("open(write)"), "do: write-open flagged");
check(detectSuspiciousDo('set fh [open "log.txt" a+]').includes("open(write)"), "do: append-open flagged");

// --- coverage report parser (verbatim ModelSim SE-64 2020.4 captures) -------
// Inline `coverage report -summary` (aggregated, has a Weight column; transcript
// lines are "# "-prefixed by vsim -c).
const covSummary = `# Coverage Report Totals BY INSTANCES: Number of Instances 2
#
#     Enabled Coverage              Bins      Hits    Misses    Weight  Coverage
#     ----------------              ----      ----    ------    ------  --------
#     Branches                         2         1         1         1    50.00%
#     Statements                      13        12         1         1    92.30%
#     Toggles                         10         4         6         1    40.00%
# Total coverage (filtered view): 60.76%`;
const cov = parseCoverageReport(covSummary);
check(cov.metrics.branch?.pct === 50 && cov.metrics.branch.bins === 2 && cov.metrics.branch.misses === 1, "cov: branch 50% (2 bins,1 miss)", cov.metrics.branch);
check(cov.metrics.statement?.pct === 92.3 && cov.metrics.statement.hits === 12, "cov: statement 92.3% (12 hits)", cov.metrics.statement);
check(cov.metrics.toggle?.pct === 40, "cov: toggle 40%", cov.metrics.toggle);
check(cov.total === 60.76, "cov: total 60.76%", cov.total);

// External `vcover report` (per-instance, NO Weight column) — same parser.
const vcov = parseCoverageReport(`    Enabled Coverage              Bins      Hits    Misses  Coverage
    ----------------              ----      ----    ------  --------
    Branches                         2         1         1    50.00%
    Statements                       3         2         1    66.66%
Total Coverage By Instance (filtered view): 60.76%`);
check(vcov.metrics.branch?.pct === 50 && vcov.metrics.statement?.pct === 66.66, "cov: vcover format (no weight col) parses", vcov.metrics);
check(vcov.total === 60.76, "cov: vcover total 60.76%", vcov.total);

// Non-coverage transcript → null (don't fabricate a coverage block).
check(parseCoverageReport("run -all\n** Note: $finish\nErrors: 0, Warnings: 0") === null, "cov: no table → null");

// --- UVM report parser (verbatim ModelSim SE-64 2020.4 / mtiUvm captures) ----
// A failing UVM test reports UVM_ERROR>0 in the summary while ModelSim still
// prints "Errors: 0" — so ok MUST fold in the UVM counts (anti-hallucination,
// same spirit as $fatal+exit0).
const uvmPass = `# UVM_INFO uvm_tb.sv(9) @ 0: uvm_test_top [MY_TEST] hello from uvm run_phase
# --- UVM Report Summary ---
# UVM_INFO :    5
# UVM_WARNING :    0
# UVM_ERROR :    0
# UVM_FATAL :    0
# Errors: 0, Warnings: 0`;
const up = parseUvmReport(uvmPass);
check(up?.info === 5 && up.error === 0 && up.fatal === 0, "uvm: pass report parsed (info 5, error 0)", up);

const uvmFail = `# UVM_ERROR uvm_tb.sv(20) @ 0: uvm_test_top [MY_TEST] deliberate failure
# --- UVM Report Summary ---
# UVM_INFO :    4
# UVM_WARNING :    0
# UVM_ERROR :    1
# UVM_FATAL :    0
# Errors: 0, Warnings: 0`;
const uf = parseUvmReport(uvmFail);
check(uf?.error === 1 && uf.fatal === 0, "uvm: fail report UVM_ERROR=1 (inline msg NOT double-counted)", uf);
check(parseUvmReport("run -all\n** Note: $finish\nErrors: 0, Warnings: 0") === null, "uvm: no report → null");

// --- cmd_help corpus parser (Tcl-list `cmd {desc} {args}`, real format) -----
// Comments (#...) and blanks are skipped; descriptions/args are brace-balanced
// and may span lines and contain nested braces (e.g. run's usage).
const cmdHelpSample = `# help command command help
# One entry per line as follows: cmd description arguments

-none- {Type help <command> to get info, or try:
  commands  List all available commands.
} {-nousage-}

add {} {button|dataflow|list|log|memory|watch|wave <args>}
run {The run command advances the simulation by the specified number of timesteps.} {{[<timesteps>[<time_units>]] | -all | -continue} | {-step [<n>]}}
vsim {The vsim command invokes the VSIM simulator or displays results.} {-noargs-}`;
const cmds = parseCmdHelp(cmdHelpSample);
check(cmds.length === 4, "cmdhelp: 4 entries parsed (comments/blanks skipped)", cmds.length);
const byName = Object.fromEntries(cmds.map((c) => [c.command, c]));
check(byName.run?.description.startsWith("The run command advances"), "cmdhelp: run description", byName.run);
check(byName.run?.arguments.includes("-all"), "cmdhelp: run args keep nested-brace usage (-all)", byName.run?.arguments);
check(byName.add?.description === "" && byName.add.arguments.includes("button"), "cmdhelp: empty {} description handled", byName.add);
check(byName.vsim?.arguments === "-noargs-", "cmdhelp: vsim parsed", byName.vsim);
check(byName["-none-"]?.description.includes("Type help"), "cmdhelp: multi-line brace description", byName["-none-"]);
check(!cmds.some((c) => c.command.startsWith("#")), "cmdhelp: comment lines not parsed as commands");

// --- fpga_msim_view do-script: hierarchy grouping + radix + zoom ------------
const viewVcd = {
  signals: [
    { full: "tb.clk", ref: "clk", width: 1, code: "!" },
    { full: "tb.q [7:0]", ref: "q [7:0]", width: 8, code: "#" },
    { full: "tb.u.cnt [7:0]", ref: "cnt [7:0]", width: 8, code: "$" },
  ],
  changes: new Map(), timescale: "1ns", endTime: 10,
};
const dv = buildViewDo(viewVcd, { radix: "hex" });
check(/add wave -group \{tb\} -radix hex [^\n]*\/tb\/clk/.test(dv), "view: auto-group tb by scope (incl /tb/clk)", dv.split("\n").find((l) => l.includes("{tb}")));
check(/add wave -group \{tb\.u\} -radix hex \/tb\/u\/cnt/.test(dv), "view: nested scope group /tb/u/cnt");
check(!/\[7:0\]/.test(dv), "view: bus range stripped from wave path");
check(dv.includes("wave zoom full"), "view: zoom-to-fit appended");
const dg = buildViewDo(null, { groups: [{ name: "clocks", signals: ["/tb/clk"] }], radix: "bin" });
check(/add wave -group \{clocks\} -radix bin \/tb\/clk/.test(dg), "view: explicit groups + radix passthrough");
check(buildViewDo(null, {}).includes("add wave -r /*"), "view: no signals/vcd -> add wave -r /*");

console.log(fail ? "\nMSIM-UNIT: FAIL" : "\nMSIM-UNIT: PASS");
process.exit(fail ? 1 : 0);
