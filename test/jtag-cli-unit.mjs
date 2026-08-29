import assert from "node:assert/strict";
import {
  D2XX_INVENTORY_MARKER,
  FLA_FRAMING_MARKER,
  analyzeJtagCliOutput,
  buildBareJtagCliArgs,
  extractD2xxInventory,
  extractFlaFraming,
  parseBareJtagCaptureSummary,
  parseBareJtagIdcodes,
  stripD2xxInventoryRecord,
  stripFlaFramingRecord,
} from "../src/toolchains/pango-pds/jtag-cli.mjs";

function line(inventory) {
  return `${D2XX_INVENTORY_MARKER}${JSON.stringify(inventory)}`;
}

const openedInventory = {
  dll: "C:/Windows/System32/ftd2xx.dll",
  libraryVersion: "2.12.36",
  createStatus: 0,
  count: 2,
  state: "channels_open_elsewhere",
  channels: [
    { index: 0, opened: true, highSpeed: false, status: 0 },
    { index: 1, opened: true, highSpeed: false, status: 0 },
  ],
};
const openedOut = `${line(openedInventory)}\nchannel 0: FT_Open -> FT_STATUS 3\nchannel 1: FT_Open -> FT_STATUS 3`;

assert.deepEqual(extractD2xxInventory(openedOut), openedInventory);
assert.equal(stripD2xxInventoryRecord(openedOut).startsWith("channel 0:"), true);

const framing = {
  logicalWidth: 20,
  paddingBits: 3,
  sampleStride: 23,
  headerBits: 4,
  trailingBits: 2,
  frameBitLength: 23558,
  readBitLength: 23558,
  overreadBits: 0,
  maxPaddingBits: 3,
  paddingOneCounts: [0, 0, 0],
  headerValue: 0,
  trailingValue: 0,
  selection: "inferred",
  readPasses: 2,
  candidates: [],
};
const framing4 = {
  logicalWidth: 4,
  paddingBits: 1,
  sampleStride: 5,
  headerBits: 4,
  trailingBits: 2,
  frameBitLength: 5126,
  readBitLength: 5126,
  overreadBits: 0,
  maxPaddingBits: 1,
  paddingOneCounts: [0],
  headerValue: 0,
  trailingValue: 0,
  selection: "canonical",
  readPasses: 1,
  candidates: [],
};
const framingOut = `${FLA_FRAMING_MARKER}${JSON.stringify(framing)}\nsummary`;
assert.deepEqual(extractFlaFraming(framingOut), framing);
assert.equal(stripFlaFramingRecord(framingOut), "summary");

// Live 2026-07-10 shape: channel 0 is PG2L200H while channel 1 floats. The MCP
// device array must not present the floating all-zero word as a second FPGA.
assert.deepEqual(
  parseBareJtagIdcodes("channel 0: IDCODE = 0x10603899\nchannel 1: IDCODE = 0x00000000  (no device / floating)"),
  [{ channel: 0, idcode: "0x10603899" }],
);

let result = analyzeJtagCliOutput({ out: openedOut, exitCode: 1 });
assert.equal(result.cable.state, "channels_open_elsewhere");
assert.equal(result.cable.count, 2);
assert.deepEqual(result.diagnostics.knownIssues.map((item) => item.code), ["jtag_channels_open_elsewhere"]);
assert.match(result.hint, /serial|JTAG|COM/i);
assert.doesNotMatch(result.hint, /cdt_js.*(?:正|正在|确定|owns).*cable/i);

const absentInventory = { dll: "ftd2xx.dll", createStatus: 0, count: 0, state: "no_ftdi_devices", channels: [] };
result = analyzeJtagCliOutput({ out: line(absentInventory), exitCode: 1 });
assert.equal(result.cable.state, "no_ftdi_devices");
assert.equal(result.diagnostics.knownIssues[0].code, "jtag_no_ftdi_devices");

// A valid IDCODE is the strongest oracle, even if an inventory snapshot carried
// stale/open flags immediately before the CLI acquired its handle.
result = analyzeJtagCliOutput({
  out: openedOut,
  exitCode: 1,
  idcodes: [{ channel: 0, idcode: "0x00603899" }],
});
assert.equal(result.cable.state, "ok");
assert.equal(result.hint, undefined);
assert.deepEqual(result.diagnostics.knownIssues, []);

// Legacy/malformed CLI output must stay useful and must not invent a cdt owner.
for (const out of ["channel 0: FT_Open -> FT_STATUS 3", `${D2XX_INVENTORY_MARKER}{bad json}\nchannel 0: FT_Open -> FT_STATUS 3`]) {
  result = analyzeJtagCliOutput({ out, exitCode: 1 });
  assert.equal(result.cable.state, "channel_open_failed");
  assert.equal(result.cable.inventoryAvailable, false);
  assert.equal(result.diagnostics.knownIssues[0].code, "jtag_channel_open_failed");
  assert.doesNotMatch(result.hint, /cdt_js.*(?:正|正在|确定|owns).*cable/i);
}

const availableInventory = {
  dll: "ftd2xx.dll",
  createStatus: 0,
  count: 1,
  state: "available",
  channels: [{ index: 0, opened: false, status: 0 }],
};
result = analyzeJtagCliOutput({
  out: `${line(availableInventory)}\nchannel 0: IDCODE = 0xFFFFFFFF (no device / floating)`,
  exitCode: 1,
});
assert.equal(result.cable.state, "jtag_no_valid_idcode");
assert.equal(result.diagnostics.knownIssues[0].code, "jtag_no_valid_idcode");

result = analyzeJtagCliOutput({ out: line(availableInventory), exitCode: 0 });
assert.equal(result.cable.state, "ok");
assert.deepEqual(result.diagnostics.knownIssues, []);

const liveCapture = `channel 0: IDCODE = 0x10603899  (TCK 1.000 MHz)
1024 samples x 4 bit, 16 distinct
first16: 3 4 5 6 7 8 9 a b c d e f 0 1 2
last8:   b c d e f 0 1 2
inter-sample step(s): [1] (monotonic)`;
assert.deepEqual(parseBareJtagCaptureSummary(liveCapture), {
  idcode: "0x10603899",
  sampleCount: 1024,
  width: 4,
  distinct: 16,
  steps: [1],
  monotonic: true,
});
assert.deepEqual(
  parseBareJtagCaptureSummary(`${FLA_FRAMING_MARKER}${JSON.stringify(framing4)}\n${liveCapture}`),
  {
    idcode: "0x10603899",
    sampleCount: 1024,
    width: 4,
    distinct: 16,
    steps: [1],
    monotonic: true,
    framing: framing4,
  },
);
assert.deepEqual(
  parseBareJtagCaptureSummary(`channel 0: IDCODE = 0x10603899\n${FLA_FRAMING_MARKER}${JSON.stringify({
    ...framing,
    selection: "ambiguous",
  })}\nerror: FLA framing candidates disagree`),
  {
    idcode: "0x10603899",
    framing: { ...framing, selection: "ambiguous" },
  },
);
assert.equal(parseBareJtagCaptureSummary("channel 0: IDCODE = 0x10603899"), null);

assert.deepEqual(buildBareJtagCliArgs("scan", { channel: 1, tckHz: 2_000_000 }), [
  "--tck-hz", "2000000", "scan", "--channel", "1",
]);
assert.deepEqual(buildBareJtagCliArgs("flash", { channel: 0, tckHz: 6_000_000, subArgs: ["--sbit", "top.sbit"] }), [
  "--channel", "0", "flash", "--sbit", "top.sbit", "--tck-hz", "6000000",
]);
assert.deepEqual(buildBareJtagCliArgs("capture", { channel: 0, tckHz: 1_000_000, subArgs: ["--fic", "ila.fic"] }), [
  "--channel", "0", "--tck-hz", "1000000", "capture", "--fic", "ila.fic",
]);
assert.deepEqual(buildBareJtagCliArgs("capture", {
  channel: 0,
  tckHz: 1_000_000,
  subArgs: ["--width", "34", "--depth", "64", "--raw", "capture.bin", "--padding-bits", "1"],
}), [
  "--channel", "0", "--tck-hz", "1000000", "capture", "--width", "34", "--depth", "64",
  "--raw", "capture.bin", "--padding-bits", "1",
]);

console.log("jtag-cli-unit: PASS");
