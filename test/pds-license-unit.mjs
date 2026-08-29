import assert from "node:assert/strict";
import { resolveEnvValue } from "../src/core/config.mjs";
import { inspectPdsLicenseValue, parsePdsLicenseText, preflightPdsLicense } from "../src/toolchains/pango-pds/license.mjs";

let pass = 0;
let fail = 0;
const check = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log("ok  ", name);
  } catch (err) {
    fail += 1;
    console.error("FAIL", name, "-", err.message);
  }
};

const now = new Date(2026, 6, 23, 12, 0, 0);
const customLicense = ({ expiry, host = "aabbccddeeff" }) =>
  `feature -feat_name {pango_design_suite} -vendor {PANGO} -version {1.000} -expire_date {${expiry}} -host_id {${host}} -signature {redacted}`;

check("future Pango node-locked license is valid without NIC guessing", () => {
  const result = parsePdsLicenseText(customLicense({ expiry: "2029-07-03" }), { now });
  assert.equal(result.state, "valid");
  assert.equal(result.usable, true);
  assert.equal(result.blocking, false);
  assert.equal(result.expiresOn, "2029-07-03");
  assert.equal(result.hostCheck, "unverified");
  assert.doesNotMatch(JSON.stringify(result), /aabbccddeeff|signature/i);
});

check("expired Pango license is a definite blocking failure", () => {
  const result = parsePdsLicenseText(customLicense({ expiry: "2026-07-14" }), { now });
  assert.equal(result.state, "expired");
  assert.equal(result.usable, false);
  assert.equal(result.blocking, true);
  assert.ok(result.daysRemaining < 0);
});

check("node-lock identity is reported but never guessed from local NICs", () => {
  const result = parsePdsLicenseText(customLicense({ expiry: "2029-07-03" }), { now });
  assert.equal(result.state, "valid");
  assert.equal(result.hostCheck, "unverified");
  assert.equal(result.blocking, false);
});

check("conventional permanent FlexNet feature is accepted", () => {
  const result = parsePdsLicenseText("FEATURE fabric vendor 1.0 permanent 1 SIGN=redacted", { now });
  assert.equal(result.state, "valid");
  assert.equal(result.expiresOn, null);
  assert.equal(result.features[0].permanent, true);
});

check("missing license file is unavailable even when PDS tools exist", () => {
  const result = inspectPdsLicenseValue("C:/licenses/missing.lic", { now, platform: "win32", fileExists: () => false });
  assert.equal(result.state, "missing");
  assert.equal(result.usable, false);
  assert.equal(result.blocking, true);
});

check("floating license server remains unknown and non-blocking", () => {
  const result = inspectPdsLicenseValue("27000@license-host", { now });
  assert.equal(result.state, "unknown");
  assert.equal(result.usable, null);
  assert.equal(result.blocking, false);
  assert.equal(result.validation, "runtime_required");
});

check("environment provenance reports ambient/env-file conflict and precedence", () => {
  const result = resolveEnvValue("PANGO_LICENSE_FILE", {
    processEnv: { PANGO_LICENSE_FILE: "C:/licenses/ambient.lic" },
    envFile: { PANGO_LICENSE_FILE: "C:/licenses/env-file.lic" },
    configEnv: { PANGO_LICENSE_FILE: "C:/licenses/config.lic" },
  });
  assert.equal(result.source, "process_env");
  assert.equal(result.value, "C:/licenses/ambient.lic");
  assert.equal(result.conflict, true);
  assert.deepEqual(result.shadowed, ["env_file", "config_env"]);
});

check("env-file becomes the explicit source when ambient value is absent", () => {
  const result = resolveEnvValue("PANGO_LICENSE_FILE", {
    processEnv: {},
    envFile: { PANGO_LICENSE_FILE: "C:/licenses/env-file.lic" },
    configEnv: { PANGO_LICENSE_FILE: "C:/licenses/config.lic" },
  });
  assert.equal(result.source, "env_file");
  assert.equal(result.conflict, true);
  assert.deepEqual(result.shadowed, ["config_env"]);
});

check("preflight combines source conflict with the effective license failure", () => {
  const resolution = resolveEnvValue("PANGO_LICENSE_FILE", {
    processEnv: { PANGO_LICENSE_FILE: "C:/licenses/expired.lic" },
    envFile: { PANGO_LICENSE_FILE: "C:/licenses/future.lic" },
    configEnv: {},
  });
  const result = preflightPdsLicense({
    resolution,
    now,
    platform: "win32",
    fileExists: () => true,
    readFile: (path) => customLicense({ expiry: /expired/i.test(path) ? "2026-07-14" : "2029-07-03" }),
  });
  assert.equal(result.source, "process_env");
  assert.equal(result.conflict, true);
  assert.equal(result.state, "expired");
  assert.equal(result.blocking, true);
  assert.match(result.hint, /process_env > env_file/);
  assert.match(result.hint, /已过期/);
});

console.log(`\npds-license-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
