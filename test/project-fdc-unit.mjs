// Unit test for generated FDC clock constraint (R8).
// The blink generator must emit a create_clock so the design has a REAL timing
// constraint — otherwise PDS analyzes against a nominal 1 MHz default and
// timing.met is vacuous (the R0.1 F3 finding).
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlinkPdsProject, createMinimalPdsProject, renderFdcFromPins } from "../src/toolchains/pango-pds/project.mjs";
import { resolveTargetPart } from "../src/toolchains/pango-pds/install.mjs";

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

const base = join(tmpdir(), `fpga-r8-${Date.now()}`);

check("blink FDC includes create_clock at the requested period (50 MHz -> 20 ns)", () => {
  const dir = join(base, "p50");
  const c = createBlinkPdsProject({ projectDir: dir, clkPin: "D18", ledPins: ["A20", "C19"], clkFreqMhz: 50, part: { family: "Logos2", device: "PG2L200H", speedgrade: "-6", package: "FBB676" }, force: true });
  const fdc = readFileSync(c.fdcPath, "utf8");
  assert.match(fdc, /create_clock\s+-name\s+clk\s+-period\s+20\b/);
  assert.match(fdc, /\[get_ports\s+clk\]/);
  assert.equal(c.clkFreqMhz, 50);
});

check("default clock frequency emits a create_clock", () => {
  const dir = join(base, "pdef");
  const c = createBlinkPdsProject({ projectDir: dir, clkPin: "D18", ledPins: ["A20"], part: { family: "Logos2", device: "PG2L200H", speedgrade: "-6", package: "FBB676" }, force: true });
  const fdc = readFileSync(c.fdcPath, "utf8");
  assert.match(fdc, /create_clock\s+-name\s+clk\s+-period\s+[\d.]+/);
});

// F-phys (device-agnostic): the tool assumes NO device. The part
// (family/device/speedgrade/package) is the board's physical identity and must
// be supplied in full by the caller (user / Target Profile). Any missing field
// is rejected before files are written — the tool never substitutes a default
// part number. A fully-specified part is emitted verbatim, for ANY device.
const completePart = { family: "FabX", device: "DevY", speedgrade: "-3", package: "PkgZ" };

check("F-phys: empty part is rejected (no FBG484/-6/Logos2 default)", () => {
  assert.throws(() => createMinimalPdsProject({ projectDir: join(base, "g-empty"), part: {}, force: true }), /family|device|speedgrade|package/);
});
check("F-phys: part missing only speedgrade is rejected (no -6 default)", () => {
  assert.throws(() => createMinimalPdsProject({ projectDir: join(base, "g-sg"), part: { family: "FabX", device: "DevY", package: "PkgZ" }, force: true }), /speedgrade/);
});
check("F-phys: part missing only family is rejected (no Logos2 default)", () => {
  assert.throws(() => createMinimalPdsProject({ projectDir: join(base, "g-fam"), part: { device: "DevY", speedgrade: "-3", package: "PkgZ" }, force: true }), /family/);
});
check("F-phys: a complete part is emitted verbatim (device-agnostic, any device)", () => {
  const c = createMinimalPdsProject({ projectDir: join(base, "g-ok"), part: completePart, force: true });
  const pds = readFileSync(c.pdsPath, "utf8");
  assert.match(pds, /_family FabX/);
  assert.match(pds, /_device DevY/);
  assert.match(pds, /_speedgrade -3/);
  assert.match(pds, /_package PkgZ/);
});

// Target Profile (ARCHITECTURE §10): board:<name> pulls a complete target from
// config; resolveTargetPart merges profile + explicit overrides; the board's pins
// generate FDC (F-fdc) instead of hand-writing constraints.
check("Target Profile: explicit part passes through, no board → pins null", () => {
  const { part, pins } = resolveTargetPart({ family: "FabX", device: "DevY", package: "PkgZ", speedgrade: "-3" });
  assert.deepEqual(part, { family: "FabX", device: "DevY", package: "PkgZ", speedgrade: "-3" });
  assert.equal(pins, null);
});
check("Target Profile: unknown board name throws a guiding error (not guessed)", () => {
  assert.throws(() => resolveTargetPart({ board: "no_such_board_xyz" }), /board|boards|配置/);
});
check("F-fdc: renderFdcFromPins emits a constraint per pin (loc required)", () => {
  const fdc = renderFdcFromPins({ clk: { loc: "D18" }, "led[0]": { loc: "A20", dir: "OUTPUT", iostd: "LVCMOS33" } });
  assert.match(fdc, /D18/);
  assert.match(fdc, /A20/);
  assert.match(fdc, /clk/);
});
check("F-fdc: renderFdcFromPins(null/empty) -> null (minimal fallback)", () => {
  assert.equal(renderFdcFromPins(null), null);
  assert.equal(renderFdcFromPins({}), null);
});

// F-fdc (round-2): the clock line's frequency is board physical info supplied in
// the Target Profile (pin-level `freqMhz`), never tool-defaulted/guessed. A pin
// carrying freqMhz also emits a create_clock so PDS timing targets the real
// frequency (the round-2 finding: board:<name> projects had only pin constraints).
check("F-fdc: a clock pin with freqMhz emits create_clock at 1000/freq ns (100 MHz -> 10)", () => {
  const fdc = renderFdcFromPins({ clk: { loc: "D18", freqMhz: 100 } });
  assert.match(fdc, /create_clock\s+-name\s+clk\s+-period\s+10\b/);
  assert.match(fdc, /\[get_ports\s+clk\]/);
  assert.match(fdc, /D18/); // still emits the pin IO constraint
});
check("F-fdc: create_clock period divides correctly for a non-round freq (27 MHz -> 37.037)", () => {
  const fdc = renderFdcFromPins({ sysclk: { loc: "P5", freqMhz: 27 } });
  assert.match(fdc, /create_clock\s+-name\s+sysclk\s+-period\s+37\.037\b/);
  assert.match(fdc, /\[get_ports\s+sysclk\]/);
});
check("F-fdc: pins without freqMhz emit NO create_clock (no guessed default frequency)", () => {
  const fdc = renderFdcFromPins({ clk: { loc: "D18" }, "led[0]": { loc: "A20", dir: "OUTPUT" } });
  assert.doesNotMatch(fdc, /create_clock/);
});

// Full board profiles legitimately contain ports unused by a particular top
// (e.g. UART pins on a counter-only design). create_project must let the caller
// explicitly select the logical ports while retaining every physical value from
// the profile; otherwise PDS rejects constraints for nonexistent top ports.
check("Target Profile subset: pinNames emits only the design's selected ports", () => {
  const dir = join(base, "profile-subset");
  const pins = {
    clk: { loc: "D18", freqMhz: 27 },
    uart_rx: { loc: "V14", dir: "INPUT" },
    uart_tx: { loc: "U14", dir: "OUTPUT" },
    "led[0]": { loc: "A20", dir: "OUTPUT" },
  };
  const created = createMinimalPdsProject({
    projectDir: dir,
    top: "democount",
    part: completePart,
    pins,
    pinNames: ["clk", "led[0]"],
    force: true,
  });
  const fdc = readFileSync(created.fdcPath, "utf8");
  assert.match(fdc, /p:clk/);
  assert.match(fdc, /p:led\[0\]/);
  assert.match(fdc, /create_clock\s+-name\s+clk\s+-period\s+37\.037/);
  assert.doesNotMatch(fdc, /uart_rx|uart_tx/);
});

check("Target Profile subset: unknown pinNames are rejected instead of guessed", () => {
  assert.throws(
    () =>
      createMinimalPdsProject({
        projectDir: join(base, "profile-subset-bad"),
        part: completePart,
        pins: { clk: { loc: "D18" } },
        pinNames: ["clk", "missing_port"],
        force: true,
      }),
    /missing_port|pinNames|profile/i
  );
});

rmSync(base, { recursive: true, force: true });
console.log(`\nproject-fdc-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
