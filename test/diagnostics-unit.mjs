// Unit test for PDS diagnostics (R3): warning classification (F2), the
// undefined-module fix hint (F7), and caution (C:) line capture (F4).
// All strings below are REAL signatures observed in actual builds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { summarizeWarnings, pdsDiagnostics } from "../src/toolchains/pango-pds/diagnostics.mjs";
import { parsePdsLog } from "../src/toolchains/pango-pds/reports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Real pds_shell -run output captured by deliberately breaking a minimal Logos2
// project (brief 002): a Verilog syntax error, a create_clock on a missing port,
// and an out-of-package pin LOC. Not hand-authored — see reports/002.md.
const fixture = (p) => readFileSync(join(here, "fixtures", "pds-diag", p), "utf8");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

// ---- F2: expected-noise warnings must classify benign; real ones stay real ----
const warnings = [
  "W: Warning : The license will invalid in 26 days. In order not to affect your usage, please update the license in time.",
  "W: Public-4008: [.../top.v(line number: 3)] Instance 'counter[31]' of 'bmsWIDEDFFRSE' unit is dangling and will be cleaned.",
  "W: Timing-4087: Port 'led[0]' is not constrained, it is treated as combinational output.",
  "W: Synth-9000: Latch inferred for signal 'state' in module 'fsm'.",
];

check("F2: license / dangling / unconstrained-output are benign", () => {
  const s = summarizeWarnings(warnings);
  assert.equal(s.count, 4);
  assert.equal(s.benignCount, 3);
  assert.equal(s.realCount, 1);
  // only the genuinely-real one is sampled for the agent
  assert.ok(s.samples.some((w) => /Latch inferred/.test(w)), "latch warning should be surfaced as real");
  assert.ok(!s.samples.some((w) => /license|dangling|not constrained/i.test(w)), "noise warnings should not be surfaced");
});

check("F2: benign warnings stay visible via benignSamples (not masked)", () => {
  const s = summarizeWarnings(warnings);
  assert.ok(Array.isArray(s.benignSamples), "benignSamples array expected");
  // the 3 deprioritized warnings are still inspectable, not hidden
  assert.ok(s.benignSamples.some((w) => /not constrained/i.test(w)), "unconstrained-output warning should be visible in benignSamples");
});

// ---- F7: undefined-module hint must offer BOTH fixes ----
check("F7: undefined-module hint covers add-source AND remove/fix instantiation", () => {
  const log = "E: Verilog-4072: [D:/p/top.v(line number: 4)] 'clk_divider' is referenced to undefined module.";
  const issues = pdsDiagnostics(log);
  const rule = issues.find((i) => i.code === "verilog_undefined_module");
  assert.ok(rule, "verilog_undefined_module rule should fire");
  assert.match(rule.hint, /源|加入/);          // add the missing source
  assert.match(rule.hint, /删|移除|改正|例化/); // or remove/fix the bad instantiation
});

// ---- F4: caution (C:) lines must be captured, not dropped ----
check("F4: parsePdsLog captures C: caution lines", () => {
  const log = [
    "I: some info",
    "W: a warning",
    'C: Bitstream-2001: SCBV has not been set. Please set SCBV value based on PCB board.',
    'The bitstream file is "D:/p/top.sbit"',
  ].join("\n");
  const parsed = parsePdsLog(log);
  assert.ok(Array.isArray(parsed.cautions), "parsePdsLog should return a cautions array");
  assert.equal(parsed.cautions.length, 1);
  assert.match(parsed.cautions[0], /SCBV/);
});

// ===================================================================
// Brief 002 — PDS diagnostic rules across 3 real failure categories.
// Each positive case feeds a REAL captured fixture; each reverse case feeds a
// benign line *rewritten to an E: prefix* so it tests the rule's precise wording
// (not just the E:-line scoping) — proving we don't fire on bare codes/keywords.
// ===================================================================

// ---- 综合 / HDL front-end: Verilog syntax error (real Verilog-4005) ----
check("002-synth: 'Syntax error near' fires verilog_syntax_error", () => {
  const issues = pdsDiagnostics(fixture("synth_syntax.txt"));
  const rule = issues.find((i) => i.code === "verilog_syntax_error");
  assert.ok(rule, "verilog_syntax_error rule should fire on Verilog-4005 'Syntax error near'");
  assert.equal(rule.severity, "error");
  assert.match(rule.hint, /语法|syntax/i);
});
check("002-synth: benign info Verilog line (as E:) does NOT fire syntax rule", () => {
  // A bare /Verilog-\d+:/ would misread this analyzing-module line as a syntax error.
  const benign = "E: Verilog-0002: [top.v(line number: 1)] Analyzing module top (library work).";
  assert.ok(!pdsDiagnostics(benign).some((i) => i.code === "verilog_syntax_error"));
});
check("002-synth: undefined-module error does NOT fire syntax rule (no rule overlap)", () => {
  const log = "E: Verilog-4072: [top.v(line number: 4)] 'clk_divider' is referenced to undefined module.";
  assert.ok(!pdsDiagnostics(log).some((i) => i.code === "verilog_syntax_error"));
});

// ---- 约束 / FDC: failed constraint import (real ConstraintEditor-0046) ----
check("002-fdc: failed import fires fdc_constraint_import_failed", () => {
  const issues = pdsDiagnostics(fixture("fdc_import.txt"));
  const rule = issues.find((i) => i.code === "fdc_constraint_import_failed");
  assert.ok(rule, "fdc_constraint_import_failed rule should fire");
  assert.match(rule.hint, /约束|端口|constraint|port/i);
});
check("002-fdc: benign 'Port not found' caution (as E:) does NOT fire import rule", () => {
  const benign = "E: Timing-4002: [top.fdc(line number: 2)] Port 'no_such_clk' is not found in current design.";
  assert.ok(!pdsDiagnostics(benign).some((i) => i.code === "fdc_constraint_import_failed"));
});

// ---- 约束 / IO: required LOC/VCCIO/IOSTANDARD trio missing (real ConstraintEditor-0040) ----
check("002-io: missing VCCIO/IOSTANDARD fires fdc_io_attr_missing", () => {
  const issues = pdsDiagnostics(fixture("fdc_import.txt"));
  const rule = issues.find((i) => i.code === "fdc_io_attr_missing");
  assert.ok(rule, "fdc_io_attr_missing rule should fire");
  assert.match(rule.hint, /VCCIO|IOSTANDARD|LOC/);
});
check("002-io: benign 'lacks attribute PAP_IO_DRIVE, it's better' (as E:) does NOT fire io rule", () => {
  // The benign "better to set DRIVE/SLEW" warning shares the 'lacks attribute'
  // wording but is NOT the mandatory LOC/VCCIO/IOSTANDARD trio.
  const benign = "E: ConstraintEditor-4042: Port 'p:led' lacks attribute 'PAP_IO_DRIVE', it's better to set the attribute for port.";
  assert.ok(!pdsDiagnostics(benign).some((i) => i.code === "fdc_io_attr_missing"));
});

// ---- DRC / placement: out-of-package pin LOC (real ConstraintEditor-0086) ----
check("002-loc: invalid package pin fires pin_loc_invalid", () => {
  const issues = pdsDiagnostics(fixture("pin_loc.txt"));
  const rule = issues.find((i) => i.code === "pin_loc_invalid");
  assert.ok(rule, "pin_loc_invalid rule should fire");
  assert.match(rule.hint, /引脚|封装|pin|package|LOC/i);
});
check("002-loc: benign 'lacks attribute, it's better' (as E:) does NOT fire pin_loc rule", () => {
  const benign = "E: ConstraintEditor-4042: Port 'p:led' lacks attribute 'PAP_IO_SLEW', it's better to set the attribute for port.";
  assert.ok(!pdsDiagnostics(benign).some((i) => i.code === "pin_loc_invalid"));
});

// ---- F-ilanet: .fic net not found post-flatten (real Inserter-0021) ----
check("F-ilanet: Inserter-0021 fires inserter_0021_net_not_found with net-name fix hint", () => {
  const log = "E: Inserter-0021: Net 'q[0]' which connected to Debug Core 0 Trigger Port 0 Channel 0 cannot be found after flatten.";
  const rule = pdsDiagnostics(log).find((i) => i.code === "inserter_0021_net_not_found");
  assert.ok(rule, "inserter_0021_net_not_found should fire on Inserter-0021");
  assert.match(rule.hint, /网名|clk_g|GTP_CLKBUFG|flatten|综合/);
});
check("F-ilanet: Inserter-0005 does NOT fire the 0021 rule (no code overlap)", () => {
  const log = "E: Inserter-0005: a stale .fic net issue.";
  assert.ok(!pdsDiagnostics(log).some((i) => i.code === "inserter_0021_net_not_found"));
});

console.log(`\ndiagnostics-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
