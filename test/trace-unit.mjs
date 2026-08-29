// Unit tests for the opt-in, session-aware tool-call audit trace.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the trace at a temp file BEFORE importing the module (tracePath reads env).
const traceFile = join(tmpdir(), `fpga-trace-${Date.now()}.jsonl`);
process.env.PANGO_MCP_TRACE_FILE = traceFile;
const {
  TRACE_SCHEMA_VERSION,
  appendTraceEvent,
  summarizeToolArgs,
  appendTrace,
  createSessionHeader,
  getTraceContext,
  installToolTrace,
  tracePath,
} = await import("../src/core/trace.mjs");

let pass = 0, fail = 0;
const check = async (n, f) => {
  try {
    await f();
    console.log("ok  ", n);
    pass += 1;
  } catch (e) {
    console.log("FAIL", n, "-", e.message);
    fail += 1;
  }
};

await check("summarizeToolArgs truncates long strings with their length", () => {
  const out = summarizeToolArgs({ tcl: "x".repeat(300), n: 5 });
  assert.match(out.tcl, /…<300>$/);
  assert.equal(out.n, 5);
});
await check("summarizeToolArgs collapses arrays/objects, keeps primitives", () => {
  const out = summarizeToolArgs({ sources: ["a", "b", "c"], part: { device: "X" }, flag: true });
  assert.equal(out.sources, "[3]");
  assert.equal(out.part, "{…}");
  assert.equal(out.flag, true);
});
await check("tracePath honors PANGO_MCP_TRACE_FILE", () => {
  assert.equal(tracePath(), traceFile);
});
await check("appendTrace writes one JSONL line per call", () => {
  appendTrace({ ts: "T", tool: "fpga_env", ms: 12, ok: true, args: {} });
  appendTrace({ ts: "T2", tool: "fpga_sim", ms: 30, ok: false, args: { top: "tb" } });
  const lines = readFileSync(traceFile, "utf8").trim().split(/\n/);
  assert.equal(lines.length, 2);
  const e0 = JSON.parse(lines[0]);
  assert.equal(e0.tool, "fpga_env");
  assert.equal(e0.ok, true);
  const e1 = JSON.parse(lines[1]);
  assert.equal(e1.tool, "fpga_sim");
  assert.equal(e1.args.top, "tb");
});

await check("session header freezes the reproducibility tuple", () => {
  const gitFull = "0123456789abcdef0123456789abcdef01234567";
  const serverVersion = {
    version: "0.0.2",
    git: "0123456",
    gitFull,
    dirty: false,
    startedAt: "2026-07-10T00:00:00.000Z",
  };
  const header = createSessionHeader({
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    ts: "2026-07-10T01:02:03.000Z",
    serverVersion,
    standardsVersion: "0.1.0",
    cwd: "D:/work",
    pid: 42,
    node: "v24.0.0",
  });
  assert.deepEqual(header, {
    schemaVersion: TRACE_SCHEMA_VERSION,
    type: "session_start",
    ts: "2026-07-10T01:02:03.000Z",
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
    assets: { gitSha: gitFull, dirty: false },
    standardsVersion: "0.1.0",
    serverVersion,
    process: { pid: 42, node: "v24.0.0", cwd: "D:/work" },
  });
});

await check("installToolTrace writes header first and correlates tool calls", async () => {
  const integrationFile = join(tmpdir(), `fpga-trace-session-${Date.now()}.jsonl`);
  process.env.PANGO_MCP_TRACE_FILE = integrationFile;
  const fakeServer = {
    handlers: new Map(),
    registerTool(name, schema, handler) {
      this.handlers.set(name, handler);
      return { name, schema };
    },
  };

  const installed = installToolTrace(fakeServer, { enabled: true });
  fakeServer.registerTool("fpga_env", {}, async () => ({ structuredContent: { ok: true } }));
  await fakeServer.handlers.get("fpga_env")({ host: "lab" }, {});
  assert.equal(appendTraceEvent("asset_use", { entryId: "counter-load", revision: "rev-1" }), true);

  const rows = readFileSync(integrationFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].type, "session_start");
  assert.equal(rows[0].standardsVersion, "0.1.0");
  assert.match(rows[0].assets.gitSha, /^[0-9a-f]{40}$/);
  assert.equal(rows[0].serverVersion.gitFull, rows[0].assets.gitSha);
  assert.match(rows[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(rows[1].type, "tool_call");
  assert.equal(rows[1].schemaVersion, TRACE_SCHEMA_VERSION);
  assert.equal(rows[1].sessionId, rows[0].sessionId);
  assert.equal(rows[1].tool, "fpga_env");
  assert.equal(rows[1].ok, true);
  assert.equal(rows[1].args.host, "lab");
  assert.equal(rows[2].type, "asset_use");
  assert.equal(rows[2].sessionId, rows[0].sessionId);
  assert.equal(rows[2].entryId, "counter-load");
  assert.equal(getTraceContext().sessionId, rows[0].sessionId);
  assert.equal(installed.sessionId, rows[0].sessionId);
  rmSync(integrationFile, { force: true });
});

await check("disabled tracing does not create a session header", () => {
  const disabledFile = join(tmpdir(), `fpga-trace-disabled-${Date.now()}.jsonl`);
  process.env.PANGO_MCP_TRACE_FILE = disabledFile;
  const fakeServer = { registerTool() {} };
  assert.equal(installToolTrace(fakeServer, { enabled: false }), null);
  assert.equal(existsSync(disabledFile), false);
});

rmSync(traceFile, { force: true });
console.log(`\ntrace-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
