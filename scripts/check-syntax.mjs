#!/usr/bin/env node
// Syntax gate: `node --check` every ESM module under src/.
//
// Replaces a hand-maintained 3000-char one-liner in package.json that listed 40
// of 46 modules — a new file was unchecked until someone remembered to add it,
// which is exactly the kind of silent hole a pre-push gate must not have.

import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(PACKAGE_ROOT, "src");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const files = walk(SRC).sort();
const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failures.push({ file: relative(PACKAGE_ROOT, file), message: String(err.stderr || err.message).trim() });
  }
}

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.file}\n${f.message}\n`);
  console.error(`${failures.length} of ${files.length} modules failed --check`);
  process.exit(1);
}
console.log(`check: ${files.length} modules OK`);
