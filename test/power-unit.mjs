// Unit test for the Pango `report_power` (.ppr) parser (R2).
// Fixture test/fixtures/power/blink_power.ppr is a real PDS 2025.2 report_power
// output for the PG2L200H blink: 0.586 W total on-chip, mostly static, with a
// "Medium" confidence (internal-node activity < 25% specified).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePower } from "../src/toolchains/pango-pds/power.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, "fixtures", "power", name), "utf8");

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

const p = parsePower(fx("blink_power.ppr"));

check("device settings header", () => {
  assert.equal(p.header.device, "PG2L200H");
  assert.equal(p.header.package, "FBB676");
  assert.equal(p.header.family, "Logos2");
  assert.equal(p.header.powerModel, "Production");
  assert.equal(p.header.confidenceLevel, "Medium");
});

check("power summary parsed", () => {
  assert.equal(p.summary.totalOnChip, 0.586);
  assert.equal(p.summary.static, 0.558);
  assert.equal(p.summary.external, 0);
  assert.equal(p.summary.junctionTemp, 29.089);
  assert.equal(p.summary.thermalMargin, 70.911);
  assert.equal(p.summary.powerMargin, 10.073);
  assert.equal(p.dynamicPower, 0.028); // total - static
});

check("confidence + low-confidence flag + note", () => {
  const internal = p.confidence.find((c) => /internal nodes/i.test(c.name));
  assert.equal(internal.level, "Medium");
  assert.equal(p.lowConfidence, true);
  assert.match(p.note, /置信|动态|activity/i);
});

check("logic device summary (per device type)", () => {
  const io = p.logicDevice.find((d) => d.device === "IO");
  assert.equal(io.power, 0.027);
  assert.equal(io.percent, 0.046);
});

check("power rail summary (per rail)", () => {
  assert.equal(p.powerRail.find((r) => r.rail === "vcca").onChipPower, 0.384);
  assert.equal(p.powerRail.find((r) => r.rail === "vcc").onChipPower, 0.161);
});

check("power hierarchy summary (per module)", () => {
  const top = p.hierarchy.find((h) => h.name === "top");
  assert.equal(top.utilizationW, 0.028);
  assert.equal(top.io, 0.027);
});

console.log(`\npower-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
