// Unit test for the resource high-utilization alert (brief 003): highUtilization()
// surfaces resource classes whose occupancy crosses a threshold (P&R / timing
// pressure), sorted by occupancy. The util fixture is REAL pds_shell Device
// Utilization Summary output (post-map, blink demo) — not hand-authored; see
// test/fixtures/resource/util-blink-devmap.txt (captured from a real build).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseUtilization, highUtilization } from "../src/toolchains/pango-pds/diagnostics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, "fixtures", "resource", "util-blink-devmap.txt"), "utf8");
const util = parseUtilization(fixture);

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

// ---- sanity: the real fixture parses (CCS is genuinely 1/1 = 100%) ----
check("fixture parses; CCS is the one real high-util class", () => {
  assert.ok(util && Object.keys(util).length >= 20);
  assert.deepEqual(util["CCS"], { used: 1, total: 1, pct: 100 });
  assert.equal(util["FF"].pct, 0);
});

// ---- forward (real data): only CCS@100% crosses threshold 90 ----
check("highUtilization(util, 90) flags only CCS at 100%", () => {
  const hot = highUtilization(util, 90);
  assert.equal(hot.length, 1);
  assert.equal(hot[0].name, "CCS");
  assert.equal(hot[0].pct, 100);
  assert.equal(hot[0].used, 1);
  assert.equal(hot[0].total, 1);
});

// ---- threshold boundary (real data): 0%-rows like FF must NOT be flagged ----
check("FF (0%) is excluded at threshold 90", () => {
  const hot = highUtilization(util, 90);
  assert.ok(!hot.some((r) => r.name === "FF"));
});

// ---- descending order (real data): with threshold 0 every class returns,
// CCS (100%) leads and the list is non-increasing by pct ----
check("results are sorted by occupancy descending", () => {
  const all = highUtilization(util, 0);
  assert.equal(all.length, Object.keys(util).length);
  assert.equal(all[0].name, "CCS");
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i - 1].pct >= all[i].pct);
});

// ---- pct-null branch: parseUtilization yields pct:null when the table omits
// the Utilization(%) value; highUtilization must derive used/total*100. Input is
// the function's documented util-object contract, not a fabricated PDS log. ----
check("pct null is computed from used/total", () => {
  const hot = highUtilization({ "LUT": { used: 9, total: 10, pct: null } }, 90);
  assert.equal(hot.length, 1);
  assert.equal(hot[0].name, "LUT");
  assert.equal(hot[0].pct, 90);
  assert.equal(hot[0].used, 9);
  assert.equal(hot[0].total, 10);
});

// ---- a just-under-threshold null-pct class must NOT be flagged ----
check("computed pct below threshold is excluded", () => {
  const hot = highUtilization({ "LUT": { used: 89, total: 100, pct: null } }, 90);
  assert.equal(hot.length, 0);
});

// ---- defensive: null/empty util -> [] (no throw) ----
check("null util returns empty array", () => {
  assert.deepEqual(highUtilization(null, 90), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
