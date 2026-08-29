// Stdio-server lifecycle and conservative orphan cleanup.
//
// A client-owned MCP process is never safe to terminate merely because another
// server can see it. Cleanup is restricted to instances whose original parent
// no longer exists (or whose parent PID has demonstrably been reused), and the
// identity is re-probed immediately before termination to close PID-reuse races.

import nodeProcess from "node:process";
import { serverInstanceSnapshot } from "./server-instances.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function installStdioLifecycle({ server, processRef = nodeProcess } = {}) {
  if (!server || typeof server.close !== "function") {
    throw new TypeError("installStdioLifecycle requires a server with close()");
  }

  let shutdownPromise = null;
  let shutdownReason = null;

  const shutdown = (reason, { exit = false } = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownReason = reason;
    shutdownPromise = Promise.resolve()
      .then(() => server.close())
      .catch((error) => {
        try {
          processRef.stderr?.write?.(`[pango-mcp] shutdown(${reason}) failed: ${error?.message || error}\n`);
        } catch {}
      })
      .finally(() => {
        if (exit && typeof processRef.exit === "function") processRef.exit(0);
        else if (processRef.exitCode == null) processRef.exitCode = 0;
      });
    return shutdownPromise;
  };

  const onStdinEnd = () => { void shutdown("stdin_end"); };
  const onStdinClose = () => { void shutdown("stdin_close"); };
  const onSigterm = () => { void shutdown("SIGTERM", { exit: true }); };
  const onSigint = () => { void shutdown("SIGINT", { exit: true }); };

  processRef.stdin?.once?.("end", onStdinEnd);
  processRef.stdin?.once?.("close", onStdinClose);
  processRef.once?.("SIGTERM", onSigterm);
  processRef.once?.("SIGINT", onSigint);

  const dispose = () => {
    processRef.stdin?.off?.("end", onStdinEnd);
    processRef.stdin?.off?.("close", onStdinClose);
    processRef.off?.("SIGTERM", onSigterm);
    processRef.off?.("SIGINT", onSigint);
  };

  return {
    shutdown,
    dispose,
    get reason() { return shutdownReason; },
  };
}

function publicInstance(instance) {
  return {
    pid: instance.pid,
    parentPid: instance.parentPid,
    parentName: instance.parentName,
    startedAt: instance.startedAt,
    ageSec: instance.ageSec,
    sourcePath: instance.sourcePath,
    ownership: instance.ownership,
    reason: instance.reason,
  };
}

export function selectOrphanCleanupCandidates(snapshot, { pids, minAgeSec = 60 } = {}) {
  const requested = Array.isArray(pids) ? new Set(pids.map(Number)) : null;
  const instances = Array.isArray(snapshot?.instances) ? snapshot.instances : [];
  const byPid = new Map(instances.map((item) => [item.pid, item]));
  const candidates = [];
  const skipped = [];

  for (const instance of instances) {
    if (requested && !requested.has(instance.pid)) continue;
    if (instance.ownership !== "orphan_candidate") {
      skipped.push({ ...publicInstance(instance), skipReason: instance.ownership === "current" ? "current_server" : "client_owned" });
      continue;
    }
    if ((instance.ageSec ?? 0) < minAgeSec) {
      skipped.push({ ...publicInstance(instance), skipReason: "younger_than_min_age" });
      continue;
    }
    candidates.push(publicInstance(instance));
  }

  if (requested) {
    for (const pid of requested) {
      if (!byPid.has(pid)) skipped.push({ pid, skipReason: "not_running_fpga_server" });
    }
  }
  return { candidates, skipped };
}

function sameInstance(a, b) {
  return a?.pid === b?.pid && a?.startedAt === b?.startedAt && a?.sourcePath === b?.sourcePath;
}

function uniqueSkipped(...groups) {
  const seen = new Set();
  const out = [];
  for (const item of groups.flat()) {
    const key = `${item.pid}:${item.skipReason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function reapOrphanedServerInstances({
  confirm = false,
  pids,
  minAgeSec = 60,
  snapshotFn = serverInstanceSnapshot,
  killFn = (pid) => nodeProcess.kill(pid, "SIGTERM"),
  waitFn = sleep,
} = {}) {
  const before = snapshotFn();
  if (!before?.available) {
    return {
      ok: false,
      mode: confirm ? "cleanup" : "audit",
      before,
      candidates: [],
      skipped: [],
      terminated: [],
      failures: [{ reason: before?.error || "server instance inventory unavailable" }],
    };
  }

  const initial = selectOrphanCleanupCandidates(before, { pids, minAgeSec });
  if (!confirm) {
    return {
      ok: true,
      mode: "audit",
      before,
      ...initial,
      terminated: [],
      failures: [],
    };
  }

  // Re-probe immediately before mutation. Only the same PID + start time +
  // source path, still classified orphaned, may pass this gate.
  const fresh = snapshotFn();
  if (!fresh?.available) {
    return {
      ok: false,
      mode: "cleanup",
      before,
      candidates: [],
      skipped: initial.skipped,
      terminated: [],
      failures: [{ reason: fresh?.error || "pre-cleanup identity recheck unavailable" }],
      after: fresh,
    };
  }
  const freshSelection = selectOrphanCleanupCandidates(fresh, { pids, minAgeSec });
  const initialByPid = new Map(initial.candidates.map((item) => [item.pid, item]));
  const candidates = freshSelection.candidates.filter((item) => sameInstance(item, initialByPid.get(item.pid)));
  const identityChanged = [];
  for (const item of freshSelection.candidates) {
    if (!initialByPid.has(item.pid) || !sameInstance(item, initialByPid.get(item.pid))) {
      identityChanged.push({ ...item, skipReason: "identity_changed_before_cleanup" });
    }
  }
  const skipped = uniqueSkipped(initial.skipped, freshSelection.skipped, identityChanged);

  if (candidates.length === 0) {
    return {
      ok: true,
      mode: "cleanup",
      before,
      candidates,
      skipped,
      terminated: [],
      failures: [],
      after: fresh,
    };
  }

  const requestedTermination = [];
  const failures = [];
  for (const item of candidates) {
    try {
      killFn(item.pid);
      requestedTermination.push(item);
    } catch (error) {
      if (error?.code === "ESRCH") requestedTermination.push(item);
      else failures.push({ ...item, reason: error?.message || String(error) });
    }
  }

  if (requestedTermination.length) await waitFn(150);
  const after = snapshotFn();
  if (!after?.available) {
    return {
      ok: false,
      mode: "cleanup",
      before,
      candidates,
      skipped,
      terminated: [],
      failures: [
        ...failures,
        ...requestedTermination.map((item) => ({ ...item, reason: "post_cleanup_verification_unavailable" })),
      ],
      after,
    };
  }
  const afterPids = new Set((after?.instances || []).map((item) => item.pid));
  const terminated = requestedTermination.filter((item) => !afterPids.has(item.pid));
  for (const item of requestedTermination) {
    if (afterPids.has(item.pid)) failures.push({ ...item, reason: "process_still_running" });
  }

  return {
    ok: failures.length === 0,
    mode: "cleanup",
    before,
    candidates,
    skipped,
    terminated,
    failures,
    after,
  };
}
