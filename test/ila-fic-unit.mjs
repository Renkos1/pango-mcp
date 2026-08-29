// Unit tests for the renderFic device-agnostic contract (V4 cleanup): the .fic
// generator assumes NO device — the part (family/device/speedgrade/package) is
// the board's physical identity and must be supplied in full; no field is
// defaulted/guessed. A complete part of ANY device is emitted verbatim.
import assert from "node:assert/strict";
import { renderFic } from "../src/toolchains/pango-pds/ila.mjs";

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log("ok  ", n); pass += 1; } catch (e) { console.error("FAIL", n, "-", e.message); fail += 1; } };

const base = { clockNet: "clk", signals: ["s0"] };

check("renderFic rejects part missing family (no Logos2 default)", () =>
  assert.throws(() => renderFic({ ...base, part: { device: "DevY", package: "PkgZ", speedgrade: "-3" } }), /family/));
check("renderFic rejects part missing package (no empty default)", () =>
  assert.throws(() => renderFic({ ...base, part: { family: "FabX", device: "DevY", speedgrade: "-3" } }), /package/));
check("renderFic rejects part missing speedgrade (no -6 default)", () =>
  assert.throws(() => renderFic({ ...base, part: { family: "FabX", device: "DevY", package: "PkgZ" } }), /speedgrade/));
check("renderFic emits a complete part verbatim (device-agnostic, any device)", () => {
  const fic = renderFic({ ...base, part: { family: "FabX", device: "DevY", speedgrade: "-3", package: "PkgZ" } });
  assert.match(fic, /deviceFamily=FabX/);
  assert.match(fic, /deviceModel=DevY/);
  assert.match(fic, /devicePackage=PkgZ/);
  assert.match(fic, /deviceSpeedGrade=-3/);
});

console.log(`\nila-fic-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
