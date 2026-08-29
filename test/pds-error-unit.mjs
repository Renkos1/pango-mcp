// Unit test for PDS error/message structuring (R3 increment-2).
// PDS tags lines "E:/W:/C: <Code>: [<file>(line number: N)] <message>".
// Real signatures below (Verilog-4072 from a real blink_broken build).
import assert from "node:assert/strict";
import { evaluatePdsRunSuccess, parsePdsError, parsePdsLog } from "../src/toolchains/pango-pds/reports.mjs";

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

check("structures an error with code + [file(line)]", () => {
  const e = parsePdsError(
    "E: Verilog-4072: [C:/work/p/rtl/top.v(line number: 4)] 'clk_divider' is referenced to undefined module."
  );
  assert.equal(e.severity, "E");
  assert.equal(e.code, "Verilog-4072");
  assert.match(e.file, /top\.v$/);
  assert.equal(e.line, 4);
  assert.match(e.message, /undefined module/);
});

check("structures an error with code but no file/line", () => {
  const e = parsePdsError("E: Flow-0183: license checkout failed.");
  assert.equal(e.severity, "E");
  assert.equal(e.code, "Flow-0183");
  assert.equal(e.file, null);
  assert.equal(e.line, null);
  assert.match(e.message, /license/);
});

check("parsePdsLog exposes errorsDetailed (structured)", () => {
  const log = [
    "I: Analyzing file top.v.",
    "E: Verilog-4072: [C:/work/p/rtl/top.v(line number: 4)] 'clk_divider' is referenced to undefined module.",
    "Program Error Out.",
  ].join("\n");
  const parsed = parsePdsLog(log);
  assert.ok(Array.isArray(parsed.errorsDetailed));
  assert.equal(parsed.errorsDetailed.length, 1);
  assert.equal(parsed.errorsDetailed[0].code, "Verilog-4072");
  assert.equal(parsed.errorsDetailed[0].line, 4);
});

check("gen_bit_stream fails when timing has a negative slack and failing endpoint", () => {
  const verdict = evaluatePdsRunSuccess({
    exitCode: 0,
    errors: [],
    runTarget: "gen_bit_stream",
    bitstreamSuccess: true,
    sbitPresent: true,
    timing: { met: false, worst: -0.007, worstHoldSlack: 0.043, failingEndpoints: 1 },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.timingFailed, true);
});

check("report_timing fails defensively when endpoint count contradicts met flag", () => {
  const verdict = evaluatePdsRunSuccess({
    exitCode: 0,
    errors: [],
    runTarget: "report_timing",
    timing: { met: true, worst: 0.1, worstHoldSlack: 0.04, failingEndpoints: 1 },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.timingFailed, true);
});

check("early compile target ignores an old failed timing report", () => {
  const verdict = evaluatePdsRunSuccess({
    exitCode: 0,
    errors: [],
    runTarget: "compile",
    timing: { met: false, worst: -1, worstHoldSlack: -1, failingEndpoints: 2 },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.timingFailed, false);
});

check("gen_bit_stream passes with a bitstream and clean authoritative timing", () => {
  const verdict = evaluatePdsRunSuccess({
    exitCode: 0,
    errors: [],
    runTarget: "gen_bit_stream",
    bitstreamSuccess: true,
    sbitPresent: true,
    timing: { met: true, worst: 0.083, worstHoldSlack: 0.043, failingEndpoints: 0 },
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.timingFailed, false);
  assert.equal(verdict.timingUnknown, false);
});

check("timing targets fail closed without an authoritative timing verdict", () => {
  const verdict = evaluatePdsRunSuccess({
    exitCode: 0,
    errors: [],
    runTarget: "report_timing",
    timing: { met: null, worst: null },
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.timingFailed, false);
  assert.equal(verdict.timingUnknown, true);
});

console.log(`\npds-error-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
