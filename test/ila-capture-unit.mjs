// Unit tests for the ILA runtime capture-config exposure (V4 F-ila-config fix):
// dbg_fla_set_capture emission + the "no transition / all-zeros" detector that
// steers the agent to reconfigure capture instead of mutating the DUT.
import assert from "node:assert";
import { captureTcl, captureHasTransition, parseCoresAndDevice } from "../src/toolchains/pango-pds/ila_capture.mjs";

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log("PASS", n); pass += 1; } catch (e) { console.error("FAIL", n, "-", e.message); fail += 1; } };

// captureTcl — omitted = no command (project default applies)
check("captureTcl(null) -> []", () => assert.deepStrictEqual(captureTcl(0, null), []));

// Nsamples mode
check("captureTcl n + samples", () =>
  assert.deepStrictEqual(captureTcl(0, { type: "n", samples: 4096 }), ["dbg_fla_set_capture -device 0 -fla 0 -type n -samples 4096"]));
check("captureTcl n without samples (no trailing flag)", () =>
  assert.deepStrictEqual(captureTcl(2, { type: "n" }), ["dbg_fla_set_capture -device 0 -fla 2 -type n"]));
check("captureTcl defaults to Nsamples when type omitted", () =>
  assert.deepStrictEqual(captureTcl(0, { samples: 1024 }), ["dbg_fla_set_capture -device 0 -fla 0 -type n -samples 1024"]));

// Windows mode (frame a rare/slow event around the trigger)
check("captureTcl w + windows + position", () =>
  assert.deepStrictEqual(captureTcl(0, { type: "w", windows: 3, position: 512 }), ["dbg_fla_set_capture -device 0 -fla 0 -type w -windows 3 -position 512"]));
check("captureTcl w bare", () =>
  assert.deepStrictEqual(captureTcl(1, { type: "w" }), ["dbg_fla_set_capture -device 0 -fla 1 -type w"]));

// captureHasTransition — the all-zeros trap detector
check("transition: a group's bus values change", () =>
  assert.strictEqual(captureHasTransition({ groups: [{ values: [0, 0, 1, 2] }], scalars: {} }), true));
check("no transition: all-constant group (the all-zeros trap)", () =>
  assert.strictEqual(captureHasTransition({ groups: [{ values: [0, 0, 0, 0] }], scalars: {} }), false));
check("transition: a scalar changes", () =>
  assert.strictEqual(captureHasTransition({ groups: [{ values: [5, 5] }], scalars: { rst: { values: [1, 0] } } }), true));
check("no transition: empty capture", () =>
  assert.strictEqual(captureHasTransition({ groups: [], scalars: {} }), false));

// parseCoresAndDevice — the GUI open-stage detection (V4-round2: the device+core
// ARE in the UIA tree; the bug was a single early dump before it populated → poll).
check("parseCoresAndDevice finds DEV + CORE in a real UIA tree dump", () => {
  const tree = [
    "  [ControlType.Window] id='' name='Device'",
    "    [ControlType.TreeItem] id='' name='DEV:0 MyDevice0(Logos2-PG2L200H)'",
    "    [ControlType.TreeItem] id='' name='CORE:0 MyFLA0'",
    "    [ControlType.TreeItem] id='' name='Trigger Setup'",
  ].join("\n");
  const { cores, device } = parseCoresAndDevice(tree);
  assert.strictEqual(cores.length, 1);
  assert.strictEqual(cores[0].index, 0);
  assert.strictEqual(cores[0].name, "MyFLA0"); // trailing tcl/UIA quote stripped
  assert.match(device, /DEV:0 MyDevice0\(Logos2-PG2L200H\)/);
});
check("parseCoresAndDevice dedups a twice-listed core", () => {
  assert.strictEqual(parseCoresAndDevice("name='CORE:0 MyFLA0'\nname='CORE:0 MyFLA0'").cores.length, 1);
});
check("parseCoresAndDevice empty tree -> none (the early-dump race the poll handles)", () => {
  const r = parseCoresAndDevice("");
  assert.strictEqual(r.cores.length, 0);
  assert.strictEqual(r.device, null);
});

console.log(`\nila-capture-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
