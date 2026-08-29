// Backend-agnostic execution + small utility helpers shared by every toolchain.
// Process exec, the MCP tool-result envelope, path/string helpers, and a
// bounded recursive file finder. No toolchain (PDS/sim/...) specifics here.

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { toolEnv } from "./config.mjs";

export function which(cmd) {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
  for (const d of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const base = join(d, cmd);
    if (existsSync(base)) return base;
    for (const e of exts) if (existsSync(base + e)) return base + e;
  }
  return null;
}

export function toolResult(res) {
  return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }], structuredContent: res };
}

export function toolError(text, extra = {}) {
  return { isError: true, content: [{ type: "text", text }], structuredContent: { ok: false, error: text, ...extra } };
}

export function run(file, args, { cwd, timeoutSec = 30, env } = {}) {
  return new Promise((resolveRun) => {
    execFile(
      file,
      args,
      { cwd, env: toolEnv(env), timeout: timeoutSec * 1000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolveRun({
          code: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
          timedOut: !!(err && err.killed),
        });
      }
    );
  });
}

// Launch a long-lived process (e.g. a GUI) detached from the MCP so it keeps
// running after the tool returns. Returns the child pid (or null). Inherits the
// merged tool env so a spawned vsim GUI sees the license.
export function spawnDetached(file, args = [], { cwd, env } = {}) {
  const child = spawn(file, args, { cwd, env: toolEnv(env), detached: true, stdio: "ignore", windowsHide: false });
  const pid = child.pid;
  child.unref();
  return pid ?? null;
}

export function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function toTclPath(path) {
  return resolve(path).replace(/\\/g, "/");
}

export function readText(path) {
  return readFileSync(path, "utf8");
}

export function safeReadText(path) {
  try {
    return readText(path);
  } catch {
    return "";
  }
}

export function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

export function positiveInt(value, fallback, { min = 1, max = 32 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function findFiles(root, predicate, { maxDepth = 4 } = {}) {
  const out = [];
  function walk(dir, depth) {
    if (depth > maxDepth || !existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (predicate(p, name)) out.push(p);
    }
  }
  walk(root, 0);
  return out;
}

export function cleanToken(s) {
  return (s || "").replace(/^"|"$/g, "").trim();
}

export function xmlAttr(tag, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(tag || "");
  return match ? match[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null;
}
