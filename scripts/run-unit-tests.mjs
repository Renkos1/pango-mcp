#!/usr/bin/env node
// The one command a contributor runs to know they did not break anything.
//
// Everything here is deterministic and needs NO FPGA toolchain, NO simulator
// and NO board — that is the entry criterion for this list. Tests that require
// iverilog / ModelSim / PDS / hardware / an SSH host stay out and keep their own
// npm scripts (see test/README.md for the full matrix).

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const NODE_TESTS = [
  "cdt-command-guard-unit.mjs",
  "cdt-ok-unit.mjs",
  "coverage-unit.mjs",
  "diagnostics-unit.mjs",
  "embed-unit.mjs",
  "ila-capture-unit.mjs",
  "ila-fic-unit.mjs",
  "ila-write-guard-unit.mjs",
  "jtag-cli-unit.mjs",
  "jtag-flash-guard-unit.mjs",
  "jtag-unit.mjs",
  "msim-logparse-unit.mjs",
  "msim-unit.mjs",
  "netlist-unit.mjs",
  "pds-batch-unit.mjs",
  "pds-create-top-module-unit.mjs",
  "pds-error-unit.mjs",
  "pds-license-unit.mjs",
  "pds-project-reports-unit.mjs",
  "power-unit.mjs",
  "project-fdc-unit.mjs",
  "resource-unit.mjs",
  "server-lifecycle-unit.mjs",
  "static-gate.mjs",
  "timing-unit.mjs",
  "trace-unit.mjs",
  "vault-unit.mjs",
  "waveform-unit.mjs",
];

const PYTHON_TESTS = [
  "fla-framing-unit.py",
  "fla-trig-degenerate-unit.py",
  "fla-trig-encode-unit.py",
  "jtag-d2xx-unit.py",
  "jtag-export-unit.py",
  "svf-parse-unit.py",
];

function run(cmd, args, label) {
  try {
    execFileSync(cmd, args, { cwd: PACKAGE_ROOT, stdio: "pipe" });
    return { label, ok: true };
  } catch (err) {
    return { label, ok: false, output: String(err.stdout || "") + String(err.stderr || err.message) };
  }
}

const results = [];
for (const t of NODE_TESTS) results.push(run(process.execPath, [join("test", t)], t));

// Python is optional: the JTAG layer is Python, but a contributor touching only
// the Node side should get a clear skip rather than a "command not found" that
// reads like a flaky suite.
let python = null;
for (const candidate of ["python3", "python"]) {
  try {
    execFileSync(candidate, ["--version"], { stdio: "pipe" });
    python = candidate;
    break;
  } catch {
    /* try next */
  }
}
if (python) for (const t of PYTHON_TESTS) results.push(run(python, [join("test", t)], t));

const failed = results.filter((r) => !r.ok);
for (const r of failed) console.error(`\nFAIL ${r.label}\n${r.output.split("\n").slice(-15).join("\n")}`);

const passed = results.length - failed.length;
console.log(`\nunit: ${passed}/${results.length} passed${python ? "" : `  (SKIPPED ${PYTHON_TESTS.length} Python tests — no python3/python on PATH)`}`);
if (failed.length) process.exit(1);
