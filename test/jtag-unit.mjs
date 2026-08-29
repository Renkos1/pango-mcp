import assert from "node:assert/strict";
import { diagnoseCdtLog, idcodeMatches, normalizeIdcode, parseScanLog } from "../src/toolchains/pango-pds/jtag.mjs";

const aliases = {
  PG2L100H: "0x00602899",
  PG2L200H: "0x00603899",
};

assert.equal(normalizeIdcode("PG2L200H", aliases), "0x00603899");
assert.equal(idcodeMatches("0x10603899", "PG2L200H", aliases), true);
assert.equal(idcodeMatches("0x00602899", "PG2L200H", aliases), false);

const scanLog = `
PG2L200H
The ID value is: 0x00603899
IDCODE(0): 00603899
`;
assert.deepEqual(parseScanLog(scanLog), [{ index: 0, idcode: "0x00603899" }]);

const issues = diagnoseCdtLog(`
E: Configuration-0011: The JTAG chain contains 1 devices. The input index '1' is an invalid device index.
W: Public-4023: Error has occurred, please run command clean before running again.
`);
assert.deepEqual(
  issues.map((issue) => issue.code),
  ["cdt_invalid_device_index", "cdt_dirty_error_state"]
);

assert.deepEqual(
  diagnoseCdtLog("", { timedOut: true, devices: [] }).map((issue) => issue.code),
  ["cdt_scan_transient_timeout", "cdt_scan_no_devices"]
);

console.log("JTAG unit: PASS");
