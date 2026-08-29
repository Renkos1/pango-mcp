// Best-effort local inventory for pango-mcp stdio server processes.
// Process count alone does not prove a leak: every MCP client legitimately owns
// a child server. Parent existence + creation time separate client-owned children
// from parents that disappeared or whose PID was later reused.

import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
const CURRENT_SOURCE = normalize(join(CORE_DIR, "..", "index.mjs"));

function parseTime(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeSource(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "").replace(/\//g, "\\");
}

export function extractServerSource(commandLine) {
  const text = String(commandLine || "");
  // The pango-mcp entry must be Node's script argument, not an arbitrary later
  // argument mentioning the path. This anchor is part of the cleanup safety
  // boundary: a different Node program must never become a kill candidate.
  const match = /^\s*(?:"[^"]*node(?:\.exe)?"|'[^']*node(?:\.exe)?'|\S*node(?:\.exe)?)\s+(?:(?:--[\w-]+(?:=\S+)?)\s+)*(?:"([^"]*pango-mcp[\\/]src[\\/]index\.mjs)"|'([^']*pango-mcp[\\/]src[\\/]index\.mjs)'|(\S*pango-mcp[\\/]src[\\/]index\.mjs))(?:\s|$)/i.exec(text);
  return normalizeSource(match?.[1] || match?.[2] || match?.[3] || "") || null;
}

export function classifyServerProcessRows(rows, {
  currentPid = process.pid,
  nowMs = Date.now(),
  currentSource = CURRENT_SOURCE,
} = {}) {
  const instances = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const pid = Number(row?.pid ?? row?.ProcessId);
    const parentPid = Number(row?.parentPid ?? row?.ParentProcessId);
    const sourcePath = extractServerSource(row?.commandLine ?? row?.CommandLine);
    if (!Number.isInteger(pid) || pid <= 0 || !sourcePath) continue;

    const startedMs = parseTime(row?.startedAt ?? row?.CreationDate);
    const parentStartedMs = parseTime(row?.parentStartedAt ?? row?.ParentCreationDate);
    const parentName = row?.parentName ? String(row.parentName) : null;
    let ownership;
    let reason;
    if (pid === currentPid) {
      ownership = "current";
      reason = "this_server";
    } else if (!parentName) {
      ownership = "orphan_candidate";
      reason = "parent_process_missing";
    } else if (startedMs != null && parentStartedMs != null && parentStartedMs > startedMs + 1000) {
      ownership = "orphan_candidate";
      reason = "parent_pid_reused";
    } else {
      ownership = "client_owned";
      reason = "live_parent_process";
    }

    const privateBytes = Number(row?.privateBytes);
    const normalized = normalizeSource(sourcePath);
    instances.push({
      pid,
      parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
      parentName,
      startedAt: startedMs == null ? null : new Date(startedMs).toISOString(),
      parentStartedAt: parentStartedMs == null ? null : new Date(parentStartedMs).toISOString(),
      ageSec: startedMs == null ? null : Math.max(0, Math.floor((nowMs - startedMs) / 1000)),
      sourcePath,
      sameSource: isAbsolute(sourcePath) ? normalize(normalized).toLowerCase() === normalize(currentSource).toLowerCase() : null,
      privateMemoryMb: Number.isFinite(privateBytes) && privateBytes >= 0 ? Math.round(privateBytes / 104857.6) / 10 : null,
      ownership,
      reason,
    });
  }

  instances.sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || "") || a.pid - b.pid);
  const others = instances.filter((item) => item.ownership !== "current");
  const clientOwned = others.filter((item) => item.ownership === "client_owned");
  const orphanCandidates = others.filter((item) => item.ownership === "orphan_candidate");
  const totalPrivateMemoryMb = instances.reduce((sum, item) => sum + (item.privateMemoryMb || 0), 0);
  return {
    available: true,
    platform: "win32",
    currentPid,
    count: instances.length,
    otherCount: others.length,
    clientOwnedCount: clientOwned.length,
    orphanCandidateCount: orphanCandidates.length,
    totalPrivateMemoryMb: Math.round(totalPrivateMemoryMb * 10) / 10,
    instances,
  };
}

function windowsServerRows() {
  const ps = [
    "$all=Get-CimInstance Win32_Process",
    "$servers=$all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*index.mjs*' -and $_.CommandLine -like '*pango-mcp*' }",
    "$rows=@()",
    "foreach($p in $servers){",
    "  $parent=$all | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1",
    "  $gp=Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue",
    "  $rows += [pscustomobject]@{",
    "    pid=[int]$p.ProcessId; parentPid=[int]$p.ParentProcessId; parentName=$(if($parent){[string]$parent.Name}else{$null});",
    "    startedAt=$(if($p.CreationDate){$p.CreationDate.ToUniversalTime().ToString('o')}else{$null});",
    "    parentStartedAt=$(if($parent -and $parent.CreationDate){$parent.CreationDate.ToUniversalTime().ToString('o')}else{$null});",
    "    privateBytes=$(if($gp){[int64]$gp.PrivateMemorySize64}else{$null}); commandLine=[string]$p.CommandLine",
    "  }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress -Depth 3",
  ].join("\n");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
    windowsHide: true,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function serverInstanceSnapshot({
  platform = process.platform,
  currentPid = process.pid,
  nowMs = Date.now(),
  rows,
} = {}) {
  if (platform !== "win32") {
    return {
      available: false,
      platform,
      currentPid,
      count: null,
      otherCount: null,
      clientOwnedCount: null,
      orphanCandidateCount: null,
      instances: [],
      error: "server instance inventory is currently available on Windows only",
    };
  }
  try {
    return classifyServerProcessRows(rows ?? windowsServerRows(), { currentPid, nowMs });
  } catch (error) {
    return {
      available: false,
      platform,
      currentPid,
      count: null,
      otherCount: null,
      clientOwnedCount: null,
      orphanCandidateCount: null,
      instances: [],
      error: `Windows server instance inventory failed${error?.code ? ` (${error.code})` : ""}`,
    };
  }
}

export function siblingServerHint(snapshot = serverInstanceSnapshot()) {
  if (!snapshot?.available || !snapshot.otherCount) return null;
  const pids = snapshot.instances.filter((item) => item.ownership !== "current").map((item) => item.pid);
  if (snapshot.orphanCandidateCount > 0) {
    return `检测到另有 ${snapshot.otherCount} 个 pango-mcp server 实例(PIDs ${pids.join(",")})；其中 ${snapshot.orphanCandidateCount} 个已确认父进程缺失或 PID 被复用，可先用 fpga_server_cleanup 审计，再以 confirm:true 安全清理。`;
  }
  return `检测到另有 ${snapshot.otherCount} 个 pango-mcp server 实例(PIDs ${pids.join(",")})，其 MCP 客户端父进程均仍存活，并非可安全自动清理的孤儿。若任务已不用，请从对应客户端/任务关闭连接；不要跨任务强杀。`;
}
