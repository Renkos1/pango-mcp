// Code fingerprint for the running server, computed ONCE at process start.
//
// Why: the MCP is a long-lived stdio server — it does NOT hot-reload source. An
// edit to a tool's .mjs only takes effect after a restart, so an agent that just
// fixed a bug can't tell whether the instance serving it is running the new code
// or stale. Establishing that by hand costs minutes every time — list the node
// PIDs, re-import via `node -e`, probe the generated output. Every
// tool surface that an agent reaches for first (fpga_env, fpga_capabilities) now
// carries this stamp, so staleness is a one-glance check: compare `git` here with
// the working tree's HEAD; if they differ, restart the server.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function compute() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = join(here, "..", ".."); // src/core -> package root
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version || null;
  } catch {}
  let git = null;
  let gitFull = null;
  let dirty = null;
  try {
    const opts = { cwd: pkgRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    git = execSync("git rev-parse --short HEAD", opts).trim() || null;
    gitFull = execSync("git rev-parse HEAD", opts).trim() || null;
    dirty = execSync("git status --porcelain", opts).trim().length > 0;
  } catch {}
  return {
    version,
    git,
    gitFull,
    dirty, // true = working tree has uncommitted changes vs this HEAD
    startedAt: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    srcPresent: existsSync(join(pkgRoot, "src", "index.mjs")),
  };
}

// Frozen snapshot — reflects the code as loaded, never re-read mid-process.
export const CODE_VERSION = Object.freeze(compute());

// One-line digest for hints: "v<package-version> @abc1234 (dirty) up 12m".
export function versionLine() {
  const v = CODE_VERSION;
  const up = Math.round((Date.now() - Date.parse(v.startedAt)) / 60000);
  return `v${v.version || "?"} @${v.git || "nogit"}${v.dirty ? " (dirty)" : ""} up ${up}m`;
}
