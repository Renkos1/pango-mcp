import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  classifyServerProcessRows,
  extractServerSource,
  serverInstanceSnapshot,
  siblingServerHint,
} from "../src/core/server-instances.mjs";
import {
  installStdioLifecycle,
  reapOrphanedServerInstances,
  selectOrphanCleanupCandidates,
} from "../src/core/lifecycle.mjs";

const NOW = Date.parse("2026-07-24T00:00:00.000Z");

const rows = [
  {
    pid: 10,
    parentPid: 1,
    parentName: null,
    startedAt: "2026-07-23T23:00:00.000Z",
    commandLine: '"C:/node.exe" D:/repo/packages/pango-mcp/src/index.mjs',
    privateBytes: 50 * 1024 * 1024,
  },
  {
    pid: 20,
    parentPid: 200,
    parentName: "codex.exe",
    parentStartedAt: "2026-07-23T20:00:00.000Z",
    startedAt: "2026-07-23T23:10:00.000Z",
    commandLine: "node D:\\repo\\packages\\pango-mcp\\src\\index.mjs",
    privateBytes: 55 * 1024 * 1024,
  },
  {
    pid: 30,
    parentPid: 300,
    parentName: null,
    startedAt: "2026-07-23T23:20:00.000Z",
    commandLine: "node packages/pango-mcp/src/index.mjs",
    privateBytes: 56 * 1024 * 1024,
  },
  {
    pid: 40,
    parentPid: 400,
    parentName: "unrelated.exe",
    parentStartedAt: "2026-07-23T23:50:00.000Z",
    startedAt: "2026-07-23T23:30:00.000Z",
    commandLine: "node D:/other/packages/pango-mcp/src/index.mjs",
    privateBytes: 57 * 1024 * 1024,
  },
  {
    pid: 50,
    parentPid: 500,
    parentName: null,
    startedAt: "2026-07-23T23:40:00.000Z",
    commandLine: "node D:/repo/packages/not-fpga/src/index.mjs",
  },
];

assert.equal(extractServerSource(rows[0].commandLine), "D:\\repo\\packages\\pango-mcp\\src\\index.mjs");
assert.equal(extractServerSource(rows[2].commandLine), "packages\\pango-mcp\\src\\index.mjs");
assert.equal(extractServerSource(rows[4].commandLine), null);
assert.equal(extractServerSource("node --trace-warnings D:/repo/packages/pango-mcp/src/index.mjs"), "D:\\repo\\packages\\pango-mcp\\src\\index.mjs");
assert.equal(extractServerSource("node other.mjs D:/repo/packages/pango-mcp/src/index.mjs"), null);

const snapshot = classifyServerProcessRows(rows, { currentPid: 10, nowMs: NOW });
assert.equal(snapshot.count, 4);
assert.equal(snapshot.otherCount, 3);
assert.equal(snapshot.clientOwnedCount, 1);
assert.equal(snapshot.orphanCandidateCount, 2);
assert.equal(snapshot.instances.find((item) => item.pid === 10).ownership, "current");
assert.equal(snapshot.instances.find((item) => item.pid === 20).ownership, "client_owned");
assert.equal(snapshot.instances.find((item) => item.pid === 30).reason, "parent_process_missing");
assert.equal(snapshot.instances.find((item) => item.pid === 40).reason, "parent_pid_reused");
assert.equal(snapshot.totalPrivateMemoryMb, 218);
assert.match(siblingServerHint(snapshot), /2 个.*fpga_server_cleanup/);

const activeOnly = classifyServerProcessRows(rows.slice(0, 2), { currentPid: 10, nowMs: NOW });
assert.match(siblingServerHint(activeOnly), /MCP 客户端父进程均仍存活/);
assert.doesNotMatch(siblingServerHint(activeOnly), /可安全自动清理的孤儿.*建议清理/);

const injected = serverInstanceSnapshot({ platform: "win32", currentPid: 10, nowMs: NOW, rows });
assert.equal(injected.orphanCandidateCount, 2);
assert.equal(serverInstanceSnapshot({ platform: "linux", currentPid: 10 }).available, false);

let selection = selectOrphanCleanupCandidates(snapshot, { minAgeSec: 60 });
assert.deepEqual(selection.candidates.map((item) => item.pid), [30, 40]);
assert.equal(selection.skipped.some((item) => item.pid === 20 && item.skipReason === "client_owned"), true);

selection = selectOrphanCleanupCandidates(snapshot, { pids: [20, 30, 999], minAgeSec: 60 });
assert.deepEqual(selection.candidates.map((item) => item.pid), [30]);
assert.equal(selection.skipped.some((item) => item.pid === 999 && item.skipReason === "not_running_fpga_server"), true);
assert.deepEqual(selectOrphanCleanupCandidates(snapshot, { pids: [], minAgeSec: 0 }).candidates, []);

let killed = [];
let calls = 0;
const afterRows = rows.filter((row) => ![30, 40].includes(row.pid));
const afterSnapshot = classifyServerProcessRows(afterRows, { currentPid: 10, nowMs: NOW });
const cleanup = await reapOrphanedServerInstances({
  confirm: true,
  minAgeSec: 60,
  snapshotFn: () => [snapshot, snapshot, afterSnapshot][calls++],
  killFn: (pid) => { killed.push(pid); },
  waitFn: async () => {},
});
assert.deepEqual(killed, [30, 40]);
assert.deepEqual(cleanup.terminated.map((item) => item.pid), [30, 40]);
assert.equal(cleanup.ok, true);
assert.equal(killed.includes(20), false, "client-owned server must never be killed");

killed = [];
const audit = await reapOrphanedServerInstances({
  confirm: false,
  snapshotFn: () => snapshot,
  killFn: (pid) => { killed.push(pid); },
});
assert.equal(audit.mode, "audit");
assert.deepEqual(killed, []);

killed = [];
calls = 0;
const failedRecheck = await reapOrphanedServerInstances({
  confirm: true,
  snapshotFn: () => calls++ === 0 ? snapshot : { available: false, error: "probe failed", instances: [] },
  killFn: (pid) => { killed.push(pid); },
});
assert.equal(failedRecheck.ok, false);
assert.deepEqual(killed, [], "cleanup must fail closed when identity recheck is unavailable");

killed = [];
calls = 0;
const failedPostcheck = await reapOrphanedServerInstances({
  confirm: true,
  snapshotFn: () => [snapshot, snapshot, { available: false, error: "probe failed", instances: [] }][calls++],
  killFn: (pid) => { killed.push(pid); },
  waitFn: async () => {},
});
assert.equal(failedPostcheck.ok, false);
assert.deepEqual(killed, [30, 40]);
assert.deepEqual(failedPostcheck.terminated, [], "unverified termination must not be reported as success");

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new EventEmitter();
    this.stderr = { write: () => {} };
    this.exitCode = null;
    this.exitCalls = [];
  }

  exit(code) {
    this.exitCalls.push(code);
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let closes = 0;
const fake = new FakeProcess();
const lifecycle = installStdioLifecycle({ server: { close: async () => { closes += 1; } }, processRef: fake });
fake.stdin.emit("end");
fake.stdin.emit("close");
await flush();
assert.equal(closes, 1, "stdin end+close must be idempotent");
assert.equal(lifecycle.reason, "stdin_end");
assert.equal(fake.exitCode, 0);
assert.deepEqual(fake.exitCalls, []);
lifecycle.dispose();

closes = 0;
const signaled = new FakeProcess();
installStdioLifecycle({ server: { close: async () => { closes += 1; } }, processRef: signaled });
signaled.emit("SIGTERM");
await flush();
assert.equal(closes, 1);
assert.deepEqual(signaled.exitCalls, [0]);

console.log("server-lifecycle-unit: ownership classification, orphan-only cleanup, stdio shutdown PASS");
