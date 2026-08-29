// Backend-agnostic run store + input-hash caching.
//
// Heavy actions (a ~5 min PDS build, a sim run) persist their raw log + an
// extracted summary under <baseDir>/.pango-mcp/runs/<key>/. When the inputs are
// unchanged the tool returns the cached summary instead of re-running and
// re-emitting the log — saving both compute and tokens.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function hashParts(parts = []) {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(typeof p === "string" ? p : JSON.stringify(p));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function hashFiles(paths = []) {
  const h = createHash("sha256");
  for (const p of [...paths].sort()) {
    h.update(String(p));
    h.update("\0");
    try {
      h.update(readFileSync(p));
    } catch {
      h.update("<missing>");
    }
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

export function runStoreDir(baseDir, key) {
  return join(resolve(baseDir), ".pango-mcp", "runs", key);
}

export function writeRunLog(dir, name, log) {
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, name);
  writeFileSync(logPath, String(log || ""), "utf8");
  return logPath;
}

export function writeRunJson(dir, name, obj) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  return p;
}

export function loadRunJson(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export function writeRunSummary(dir, summary) {
  return writeRunJson(dir, "summary.json", summary);
}

export function loadCachedSummary(dir) {
  return loadRunJson(dir, "summary.json");
}
