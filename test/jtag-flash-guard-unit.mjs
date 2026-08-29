import assert from "node:assert/strict";
import { evaluateBareFlashGate } from "../src/toolchains/pango-pds/jtag-cli.mjs";

const aliases = {
  PG2L100H: "0x00602899",
  PG2L200H: "0x00603899",
};

let gate = evaluateBareFlashGate({ confirm: false, expectIdcode: "PG2L200H", aliases });
assert.equal(gate.ok, false);
assert.equal(gate.phase, "confirm");

gate = evaluateBareFlashGate({ confirm: true, expectIdcode: "not-an-id", aliases });
assert.equal(gate.ok, false);
assert.equal(gate.phase, "input");

gate = evaluateBareFlashGate({ confirm: true, expectIdcode: "PG2L200H", aliases });
assert.deepEqual(gate, { ok: true, expected: "0x00603899" });

console.log("jtag-flash-guard-unit: PASS");
