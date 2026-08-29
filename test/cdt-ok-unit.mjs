// Unit test for the fpga_cdt GBK-decode + ok-misjudgment fix (brief 008 / D-cdt-ok).
// Defect (observed 2026-06-21, remote host): a failed headless cdt_dbg returned its
// localized Windows error as GBK(cp936) bytes ("系统找不到指定的文件。" -> mojibake
// "ϵͳ�Ҳ���…"); the old ok-check only looked for "E:" so it missed the OS-level
// failure and reported ok:true with devices:[].
// Fixtures are REAL cp936 bytes (fixtures/cdt/cdt-fail-gbk.bin), not hand-authored UTF-8.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decodeCdtLog, cdtFailureSignature } from "../src/toolchains/pango-pds/jtag.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (p) => readFileSync(join(here, "fixtures", "cdt", p)); // Buffer (raw bytes)

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

// ---- A: GBK failure log decodes to readable Chinese AND is judged a failure ----
const failBytes = fixture("cdt-fail-gbk.bin");

check("GBK bytes decode to the real Chinese OS error (not mojibake)", () => {
  const text = decodeCdtLog(failBytes);
  assert.ok(text.includes("系统找不到指定的文件"), `decoded text missing Chinese: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("�"), "decoded text still contains U+FFFD replacement chars");
});

check("decoded OS failure signature => ok:false (the bug: was true)", () => {
  const text = decodeCdtLog(failBytes);
  const hint = cdtFailureSignature(text);
  assert.ok(hint, "expected a failure hint for '系统找不到指定的文件。'");
  assert.equal(typeof hint, "string");
});

check("signature does NOT fire on the still-encoded (mojibake) bytes' readable form only after decode", () => {
  // Pre-decode the raw bytes as utf-8 (lossy) -> mojibake -> signature must miss it,
  // which is exactly why decoding first is required.
  const mojibake = new TextDecoder("utf-8").decode(failBytes);
  assert.ok(!cdtFailureSignature(mojibake), "mojibake should not match (proves decode-first is necessary)");
});

// ---- B: a normal success log must NOT be misjudged as failure ----
const okBytes = fixture("cdt-ok.txt");

check("ASCII success log passes through decode unchanged", () => {
  const text = decodeCdtLog(okBytes);
  assert.ok(text.includes("Import Core: 0 OK"));
  assert.ok(text.includes("The done bit is 1"));
});

check("success log has no failure signature => ok:true (no false positive)", () => {
  const text = decodeCdtLog(okBytes);
  assert.equal(cdtFailureSignature(text), null);
});

// ---- extra OS-level signatures the fix must cover (brief 008 step 3) ----
check("covers English 'cannot find', cdt 'E:' code, 'No devices were detected', cable-open failure", () => {
  assert.ok(cdtFailureSignature("The system cannot find the file specified."));
  assert.ok(cdtFailureSignature("E: some cdt error code"));
  assert.ok(cdtFailureSignature("No devices were detected on the chain"));
  assert.ok(cdtFailureSignature("failed to open the JTAG cable"));
});

check("decodeCdtLog passes a string through (local/already-utf8 path)", () => {
  assert.equal(decodeCdtLog("plain ascii"), "plain ascii");
  assert.equal(decodeCdtLog(null), "");
});

console.log(`\ncdt-ok-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
