// Unit test for per-instance coverage parsing (R4): locate WHICH module is
// under-covered, not just the overall %. Fixture is a real ModelSim
// `vcover report -details` for a 4-way case whose op=3 arm is never taken
// (branch 60%, statement 80%, toggle 50% on the DUT).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCoverageByInstance, parseCoverageDetails } from "../src/toolchains/modelsim/logparse.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "cov_details", "cov_details.txt"), "utf8");

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

const insts = parseCoverageByInstance(fixture);

check("parses per-instance coverage with design unit + per-type bins", () => {
  assert.ok(insts.length >= 2, "expected >=2 instances");
  const dut = insts.find((i) => i.designUnit === "work.cov_dut");
  assert.ok(dut, "cov_dut instance expected");
  assert.equal(dut.instance, "/cov_tb/dut");
  assert.deepEqual(dut.types.branch, { bins: 5, hits: 3, misses: 2, pct: 60 });
  assert.equal(dut.types.statement.misses, 1);
  assert.equal(dut.types.toggle.misses, 8);
});

check("flags the under-covered instance as a gap", () => {
  const gaps = insts.filter((i) => Object.values(i.types).some((t) => t.misses > 0));
  assert.ok(gaps.some((g) => g.designUnit === "work.cov_dut"), "cov_dut should be a coverage gap");
});

// --- R4 增量2: parseCoverageDetails — the actionable per-item未覆盖详单 ---
// Same real `vcover report -details` fixture: ModelSim flags zero-count rows as
// `***0***`; untoggled toggle nodes show 0/0 transitions. Each miss must surface
// as { instance, type, item, count:0 } pointing at exactly where to add a test.
const details = parseCoverageDetails(fixture);
const pick = (inst, type) =>
  details.filter((d) => d.instance === inst && d.type === type).map((d) => d.item);

check("extracts every Count-0 uncovered item across branch+statement+toggle", () => {
  assert.equal(details.length, 8, `expected 8 uncovered items, got ${details.length}`);
  assert.ok(details.every((d) => d.count === 0), "every detail entry must be a Count-0 miss");
});

check("branch misses locate the uncovered arm + the never-taken default", () => {
  assert.deepEqual(pick("/cov_tb/dut", "branch"), ["line 7", "All False Count"]);
});

check("statement miss locates the uncovered source line", () => {
  assert.deepEqual(pick("/cov_tb/dut", "statement"), ["line 7"]);
});

check("toggle misses list only fully-untoggled nodes, not the 50% one", () => {
  assert.deepEqual(pick("/cov_tb/dut", "toggle"), ["y[7-6]", "y[3-2]"]);
  assert.deepEqual(pick("/cov_tb", "toggle"), ["i[31-4]", "y[7-6]", "y[3-2]"]);
  assert.ok(!pick("/cov_tb", "toggle").includes("i[3]"), "i[3] toggled once -> not a miss");
});

check("a fully-covered section contributes no detail entries", () => {
  assert.equal(pick("/cov_tb", "statement").length, 0);
});

check("no -details section -> [] (no fabrication)", () => {
  assert.deepEqual(parseCoverageDetails("Total coverage: 100.00%\nErrors: 0, Warnings: 0"), []);
  assert.deepEqual(parseCoverageDetails(""), []);
});

console.log(`\ncoverage-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
