// Unit test for ModelSim transcript message structuring (R5).
// Real vlog/vsim error shapes:
//   ** Error: <file>(<line>): (vlog-2730) Undefined variable: 'x'.
//   ** Error: (vsim-19) Failed to access library 'work' ...   (no file/line)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseModelsimLog } from "../src/toolchains/modelsim/logparse.mjs";

// Real ModelSim SE-64 2020.4 transcripts captured on this machine (provoked
// failures: missing work lib, wrong top, missing SDF, cleared license env).
const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "msim");
const fx = (name) => readFileSync(join(FX, name), "utf8");
const codes = (p) => p.diagnostics.map((d) => d.code);

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

check("structures a compile error with file(line) + code", () => {
  const transcript = [
    "-- Compiling module bad",
    "** Error: D:\\p\\sub\\bad.v(2): (vlog-2730) Undefined variable: 'missing_sig'.",
    "Errors: 1, Warnings: 0",
  ].join("\n");
  const p = parseModelsimLog(transcript);
  assert.equal(p.errorCount, 1);
  assert.ok(Array.isArray(p.errorsDetailed), "errorsDetailed array expected");
  assert.equal(p.errorsDetailed.length, 1);
  const e = p.errorsDetailed[0];
  assert.equal(e.severity, "Error");
  assert.match(e.file, /bad\.v$/);
  assert.equal(e.line, 2);
  assert.equal(e.code, "vlog-2730");
  assert.match(e.message, /missing_sig/);
});

check("structures a no-file runtime error (file/line null)", () => {
  const p = parseModelsimLog("** Error: (vsim-19) Failed to access library 'work' at \"work\".");
  assert.equal(p.errorsDetailed.length, 1);
  const e = p.errorsDetailed[0];
  assert.equal(e.severity, "Error");
  assert.equal(e.file, null);
  assert.equal(e.line, null);
  assert.equal(e.code, "vsim-19");
  assert.match(e.message, /library/);
});

// --- R5 Defect-2: a corrupt/missing license aborts vsim load, so the transcript
//     carries BOTH a license error AND a downstream "Error loading design"
//     (msim-no-design-unit) FALSE positive. License is the root cause → suppress
//     the no-design-unit noise when a license diagnostic is present. ---
check("Defect-2: license error suppresses no-design-unit false positive", () => {
  const c = codes(parseModelsimLog(fx("license_loaderr.txt")));
  assert.ok(c.includes("msim-license"), `expected msim-license, got ${c}`);
  assert.ok(!c.includes("msim-no-design-unit"), `no-design-unit must be suppressed, got ${c}`);
});

check("Defect-2: pure no-design-unit (no license) is still diagnosed", () => {
  const c = codes(parseModelsimLog(fx("no_design_unit.txt")));
  assert.ok(c.includes("msim-no-design-unit"), `expected msim-no-design-unit, got ${c}`);
  assert.ok(!c.includes("msim-license"), `no license present, got ${c}`);
});

// --- msim-license extension: the previous pattern only caught "Failure to
//     obtain a license"; real FlexLM/vsim license failures also read
//     "Invalid license environment" / "Unable to checkout a license" / "Invalid
//     host" (all observed). Without the extension these would slip through. ---
check("msim-license catches Invalid-license-environment family", () => {
  const t = [
    "# Unable to checkout a license.  Vsim is closing.",
    "# ** Error: Invalid license environment. Application closing.",
  ].join("\n");
  assert.ok(codes(parseModelsimLog(t)).includes("msim-license"));
});

// --- new rule msim-lib-access (F13): vsim can't access the work library
//     (vmap missing / wrong workdir). Previously produced no diagnostic. ---
check("msim-lib-access on 'Failed to access library'", () => {
  assert.ok(codes(parseModelsimLog(fx("lib_access.txt"))).includes("msim-lib-access"));
});
check("msim-lib-access: benign library line is not flagged", () => {
  const benign = "# Loading work.tb\n# Errors: 0, Warnings: 0";
  assert.ok(!codes(parseModelsimLog(benign)).includes("msim-lib-access"));
});

// --- new rule msim-sdf: gate-level/timing sim can't find the SDF file. ---
check("msim-sdf on 'Failed to find SDF file'", () => {
  assert.ok(codes(parseModelsimLog(fx("sdf_missing.txt"))).includes("msim-sdf"));
});
check("msim-sdf: benign SDF annotation line is not flagged", () => {
  const benign = "# Reading SDF file gate_sim.sdf, annotated 12 timing checks\n# Errors: 0, Warnings: 0";
  assert.ok(!codes(parseModelsimLog(benign)).includes("msim-sdf"));
});

console.log(`\nmsim-logparse-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
