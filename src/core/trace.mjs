// Opt-in, session-aware tool-call audit trace. A traced MCP process first writes
// a session_start row carrying the reproducibility tuple (assets Git SHA,
// standards version, server version), then appends correlated tool_call rows.
// Off by default; enable via PANGO_MCP_TRACE=1 or config { "trace": true }.
// Path: env PANGO_MCP_TRACE_FILE / config.traceFile, else ~/.pango-mcp/trace-<pid>.jsonl.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { CONFIG, PACKAGE_DIR, toolEnv } from "./config.mjs";
import { CODE_VERSION } from "./version.mjs";

export const TRACE_SCHEMA_VERSION = 1;

// Package-local only. A `../../assets` fallback resolved to the enclosing
// monorepo, so a standalone install silently stamped every trace
// standardsVersion:"unversioned" — the exact field the trace exists to pin.
const ASSET_MANIFEST_PATHS = [resolve(PACKAGE_DIR, "assets", "manifest.json")];

function loadAssetManifest() {
  for (const path of ASSET_MANIFEST_PATHS) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {}
  }
  return { schemaVersion: null, standardsVersion: "unversioned" };
}

// Frozen at server start for the same reason as CODE_VERSION: a trace must
// describe the assets the process actually started with, not a later edit.
const ASSET_MANIFEST = Object.freeze(loadAssetManifest());
let ACTIVE_TRACE_CONTEXT = null;

export function traceEnabled() {
  const v = toolEnv().PANGO_MCP_TRACE;
  return v === "1" || v === "true" || CONFIG.trace === true;
}

export function tracePath() {
  return toolEnv().PANGO_MCP_TRACE_FILE || CONFIG.traceFile || join(homedir(), ".pango-mcp", `trace-${process.pid}.jsonl`);
}

export function createSessionHeader({
  sessionId = randomUUID(),
  ts = new Date().toISOString(),
  serverVersion = CODE_VERSION,
  standardsVersion = ASSET_MANIFEST.standardsVersion || "unversioned",
  cwd = process.cwd(),
  pid = process.pid,
  node = process.version,
} = {}) {
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    type: "session_start",
    ts,
    sessionId,
    assets: {
      gitSha: serverVersion.gitFull || serverVersion.git || null,
      dirty: serverVersion.dirty ?? null,
    },
    standardsVersion,
    serverVersion,
    process: { pid, node, cwd },
  };
}

// Compact args for the trace so a 5 KB tcl script doesn't bloat each line:
// long strings truncated with their length, arrays/objects collapsed to a marker.
export function summarizeToolArgs(args, max = 120) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = v.length > max ? `${v.slice(0, max)}…<${v.length}>` : v;
    else if (Array.isArray(v)) out[k] = `[${v.length}]`;
    else if (v && typeof v === "object") out[k] = "{…}";
    else out[k] = v;
  }
  return out;
}

let warned = false;
export function appendTrace(entry) {
  try {
    const f = tracePath();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(entry) + "\n", "utf8");
  } catch (e) {
    if (!warned) {
      warned = true;
      console.error("[fpga trace] write failed:", e.message);
    }
  }
}

export function getTraceContext() {
  return ACTIVE_TRACE_CONTEXT;
}

export function appendTraceEvent(type, payload = {}) {
  if (!ACTIVE_TRACE_CONTEXT) return false;
  appendTrace({
    ...payload,
    schemaVersion: TRACE_SCHEMA_VERSION,
    type,
    ts: new Date().toISOString(),
    sessionId: ACTIVE_TRACE_CONTEXT.sessionId,
  });
  return true;
}

// Wrap an McpServer so every registerTool'd handler is traced. No-op unless
// traceEnabled(). ok is read from the tool result's structuredContent.ok (or
// isError) — best-effort, never throws from the trace path.
export function installToolTrace(server, options = {}) {
  const enabled = options.enabled ?? traceEnabled();
  if (!enabled) return null;

  const header = createSessionHeader(options);
  const { sessionId } = header;
  ACTIVE_TRACE_CONTEXT = Object.freeze({ sessionId, header });
  appendTrace(header);

  const register = server.registerTool.bind(server);
  server.registerTool = (name, schema, handler) =>
    register(name, schema, async (args, extra) => {
      const t0 = Date.now();
      let ok = null;
      try {
        const res = await handler(args, extra);
        ok = res?.structuredContent?.ok ?? (res?.isError ? false : null);
        return res;
      } catch (e) {
        ok = false;
        throw e;
      } finally {
        appendTrace({
          schemaVersion: TRACE_SCHEMA_VERSION,
          type: "tool_call",
          ts: new Date().toISOString(),
          sessionId,
          tool: name,
          ms: Date.now() - t0,
          ok,
          args: summarizeToolArgs(args),
        });
      }
    });
  return { sessionId, header };
}
