// Unit test for the structured Pango .rtr timing-report parser (R1).
// Fixtures are real PDS 2025.2 report_timing outputs committed under
// test/fixtures/timing/:
//   blink_declared_clk.rtr — a build WITH a (default 1 MHz "Declared") clock:
//     populated Clock/Performance/Setup/Hold tables, 38 endpoints, all met.
//   no_clock.rtr           — a build with NO clock: every table empty, met.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRtr } from "../src/toolchains/pango-pds/timing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, "fixtures", "timing", name), "utf8");

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

// ---- populated report: a Declared 1 MHz clock, all constraints met ----
const t = parseRtr(fx("blink_declared_clk.rtr"));

check("header device/speed/package/design", () => {
  assert.equal(t.header.device, "PG2L200H");
  assert.equal(t.header.speedGrade, "-6");
  assert.equal(t.header.package, "FBB676");
  assert.equal(t.header.design, "top");
});

check("design summary + met", () => {
  assert.match(t.designSummary, /All Constraints Met/);
  assert.equal(t.met, true);
});

check("clock summary parsed", () => {
  assert.equal(t.clocks.length, 1);
  assert.equal(t.clocks[0].name, "top|clk");
  assert.equal(t.clocks[0].period, 1000.0);
  assert.equal(t.clocks[0].type, "Declared");
  assert.equal(t.clocks[0].clockLoads, 29);
  assert.equal(t.clocks[0].nonClockLoads, 0);
  assert.equal(t.clocksConstrained, 1);
});

check("clock groups parsed", () => {
  assert.equal(t.clockGroups.length, 1);
  assert.equal(t.clockGroups[0].type, "asynchronous");
});

check("performance summary (Fmax) parsed", () => {
  assert.equal(t.performance.length, 1);
  const p = t.performance[0];
  assert.equal(p.clock, "top|clk");
  assert.equal(p.reqFreqMHz, 1.0);
  assert.equal(p.estFreqMHz, 705.7163);
  assert.equal(p.reqPeriod, 1000.0);
  assert.equal(p.estPeriod, 1.417);
  assert.equal(p.slack, 998.583);
});

check("setup slow-corner row", () => {
  const rows = t.checks.setup.slow.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].launch, "top|clk");
  assert.equal(rows[0].capture, "top|clk");
  assert.equal(rows[0].worstSlack, 998.583);
  assert.equal(rows[0].totalNegSlack, 0.0);
  assert.equal(rows[0].failingEndpoints, 0);
  assert.equal(rows[0].totalEndpoints, 38);
});

check("setup fast-corner row", () => {
  assert.equal(t.checks.setup.fast.rows[0].worstSlack, 999.133);
});

check("hold corners parsed", () => {
  assert.equal(t.checks.hold.slow.rows[0].worstSlack, 0.269);
  assert.equal(t.checks.hold.fast.rows[0].worstSlack, 0.171);
});

check("derived worst setup/hold + failing total", () => {
  assert.equal(t.worstSetupSlack, 998.583); // min over corners
  assert.equal(t.worstHoldSlack, 0.171);    // min over corners
  assert.equal(t.failingEndpoints, 0);
});

// ---- empty report: no clock constrained, every table empty, still "met" ----
const e = parseRtr(fx("no_clock.rtr"));

check("no-clock report: empty + vacuously met", () => {
  assert.equal(e.clocks.length, 0);
  assert.equal(e.clocksConstrained, 0);
  assert.equal(e.performance.length, 0);
  assert.equal(e.checks.setup.slow.rows.length, 0);
  assert.match(e.designSummary, /All Constraints Met/);
  assert.equal(e.met, true);
  assert.equal(e.worstSetupSlack, null);
});

// ---- violated report: over-constrained clock (1 GHz) -> failing setup paths ----
const v = parseRtr(fx("blink_violated.rtr"));

check("violated report: met=false, negative WNS, failing endpoints", () => {
  assert.equal(v.met, false);
  assert.equal(v.worstSetupSlack, -0.417);
  assert.equal(v.failingEndpoints, 5);
  assert.equal(v.clocksConstrained, 1);
});

check("violated report: worst failing path detail parsed", () => {
  assert.ok(v.failingPaths.length >= 1, "expected >=1 failing path");
  const w = v.failingPaths[0];
  assert.match(w.startpoint, /counter\[4\]/);
  assert.match(w.endpoint, /counter\[25\]/);
  assert.equal(w.slack, -0.417);
  assert.equal(w.status, "VIOLATED");
  assert.equal(w.logicLevels, 6);
  assert.equal(w.pathGroup, "clk");
});

check("failing paths sorted worst (most-negative) first", () => {
  // Two VIOLATED paths in document order -0.100 then -0.500; output must put the
  // most-negative first so failingPaths[0] always agrees with worstSetupSlack.
  const synth = [
    "Slow Corner",
    "Startpoint  : A/CLK",
    "Endpoint    : B/D",
    "Path Group  : clk",
    "Path Type   : max",
    " Data arrival time   2.000   Logic Levels: 1",
    " Slack (VIOLATED)    -0.100",
    "Startpoint  : C/CLK",
    "Endpoint    : D/D",
    "Path Group  : clk",
    "Path Type   : max",
    " Data arrival time   3.000   Logic Levels: 2",
    " Slack (VIOLATED)    -0.500",
  ].join("\n");
  const r = parseRtr(synth);
  assert.equal(r.failingPaths[0].slack, -0.5);
  assert.equal(r.failingPaths[1].slack, -0.1);
});

// ---- compact "summary-only" report: real values, but the layout omits the
// ****/----/==== separators (as captured from a trimmed report_timing run).
// The worst slack lives in the Setup/Hold Summary rows; the parser must still
// extract it instead of returning null just because the dashed rule is missing.
const c = parseRtr(fx("blink_met_summary_compact.rtr"));

check("compact summary report: worst setup/hold slack extracted", () => {
  assert.equal(c.checks.setup.slow.rows.length, 1);
  assert.equal(c.checks.setup.slow.rows[0].worstSlack, 998.583);
  assert.equal(c.checks.hold.slow.rows.length, 1);
  assert.equal(c.checks.hold.slow.rows[0].worstSlack, 0.269);
  assert.equal(c.worstSetupSlack, 998.583);
  assert.equal(c.worstHoldSlack, 0.269);
  assert.equal(c.failingEndpoints, 0);
});

check("compact summary report: met + performance row parsed", () => {
  assert.match(c.designSummary, /All Constraints Met/);
  assert.equal(c.met, true);
  assert.equal(c.performance.length, 1);
  assert.equal(c.performance[0].estFreqMHz, 705.7163);
});

console.log(`\ntiming-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
