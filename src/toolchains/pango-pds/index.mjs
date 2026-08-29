// Pango PDS toolchain — MCP tool registration.
// Project parse/create, headless build + report parsing, JTAG/ILA control, and
// guarded device-write paths. Device-mutating actions require explicit confirm
// plus a prior IDCODE read and match.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { toolEnv } from "../../core/config.mjs";
import { run, safeReadText, sleep, toTclPath, toolError, toolResult, which } from "../../core/exec.mjs";
import { getExecutor, getHost } from "../../core/executor.mjs";
import { attachLog, capList, detectStage, splitLines } from "../../core/logparse.mjs";
import { hashFiles, hashParts, loadCachedSummary, loadRunJson, runStoreDir, writeRunJson, writeRunLog, writeRunSummary } from "../../core/runstore.mjs";
import {
  DEFAULT_CDT_STARTUP_TIMEOUT_MS,
  DEFAULT_FLASH_SCAN_RETRIES,
  DEFAULT_FLASH_SCAN_RETRY_DELAY_MS,
  DEFAULT_SCAN_MAX_DEVICES,
  IDCODE_ALIASES,
  aliasForIdcode,
  cdtTool,
  choosePdsInstall,
  defaultPortForInstall,
  resolveTargetPart,
} from "./install.mjs";
import { createBlinkPdsProject, createMinimalPdsProject, parsePdsProject } from "./project.mjs";
import {
  collectPdsReports,
  evaluatePdsRunSuccess,
  moveBuildDirsAside,
  parsePdsLog,
  parseTimingText,
  resolvePdsLogBitstream,
  sbitHasEncryptionMarker,
} from "./reports.mjs";
import {
  PDS_STAGE_MARKERS,
  parseUtilization,
  parseUtilizationFromFiles,
  pdsDiagnostics,
  summarizeWarnings,
} from "./diagnostics.mjs";
import { cdtFailureSignature, diagnoseCdtLog, flashSpiRemote, flashSramRemote, idcodeMatches, normalizeIdcode, parseScanLog, runCdtCfg, runCdtGen, runCdtRemote, runCdtScript, scanJtag, scanJtagRemote } from "./jtag.mjs";
import { analyzeJtagCliOutput, buildBareJtagCliArgs, evaluateBareFlashGate, parseBareJtagCaptureSummary, parseBareJtagIdcodes, stripD2xxInventoryRecord, stripFlaFramingRecord } from "./jtag-cli.mjs";
import { register as registerKnowledge } from "./knowledge.mjs";
import { generateFic, registerFicInPds } from "./ila.mjs";
import { discoverNets, expandBuses, resolveSignal, usableResolution, validateInserterNets } from "./netlist.mjs";
import { preflightPdsLicense } from "./license.mjs";
import { executePdsBatch, MAX_PDS_BATCH_PARALLEL, MAX_PDS_BATCH_VARIANTS, validatePdsBatchVariants } from "./batch.mjs";
import { consoleAdcRead, driveConsole } from "./console.mjs";
import { ilaCapture, ilaOpen } from "./ila_capture.mjs";
import { renderBuildReportHtml } from "./build_report.mjs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { captureVerifiedResult, knowledgeCaptureSchema } from "../../core/vault.mjs";

// Directory of the bare-metal JTAG CLI (cli.py + mpsse_jtag/fla_pango/svf_player).
// The fpga_jtag_* tools shell out to it via `python cli.py <sub>` with cwd set
// here so its sibling-module imports resolve.
const JTAG_DIR = join(dirname(fileURLToPath(import.meta.url)), "jtag");

// cdt_dbg/cdt_js live in the same bin as pds_shell. Resolve that bin dir for a
// remote host from its configured pds map.
function resolveRemoteBinDir(host, pdsVersion) {
  const pdsMap = getHost(host)?.pds || {};
  const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
  return shell ? shell.replace(/[\\/][^\\/]*$/, "") : null;
}

// Strip a verbose cdt_cfg/cdt_js transcript out of a result before it goes to
// the AI: keep only signal lines (IDCODE/done bit/E:/W:/...) as `logDigest`, and
// write the full log to a file (`logPath`). Token-efficient by default.
function digestCdt(result, name = "cdt") {
  if (!result || typeof result.log !== "string") return result;
  const linesArr = result.log.split(/\r?\n/);
  const keep = linesArr
    .filter((l) => /IDCODE|done bit|trigger successful|Program\]|USB Cable|^\s*E:|^\s*W:/i.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30);
  let logPath = result.logPath || null;
  try {
    const dir = join(homedir(), ".pango-mcp", "logs");
    mkdirSync(dir, { recursive: true });
    logPath = join(dir, `${name}-${Date.now().toString(36)}.log`);
    writeFileSync(logPath, result.log, "utf8");
  } catch {}
  const { log: _drop, ...rest } = result;
  return { ...rest, logDigest: keep, logLines: linesArr.length, logPath };
}

// Annotate scanned devices with their friendly IDCODE alias (PG2L200H/...) so an
// agent reading a scan needn't cross-reference idcodeAliases by hand.
function annotateScanAliases(scan) {
  if (scan && Array.isArray(scan.devices)) {
    scan.devices = scan.devices.map((d) => {
      const alias = aliasForIdcode(d.idcode);
      return alias ? { ...d, alias } : d;
    });
  }
  return scan;
}

function netDiscoveryToolError(prefix, phase, disc) {
  const keyDiagnostic = disc.errors?.[0] || disc.diagnostics?.[0] || null;
  const text = `${prefix}: ${disc.error}${keyDiagnostic && !String(disc.error).includes(keyDiagnostic) ? `\n${keyDiagnostic}` : ""}`;
  return toolError(text, {
    phase,
    stage: disc.stage || "discovery",
    errors: disc.errors || [],
    errorsDetailed: disc.errorsDetailed || [],
    diagnostics: disc.diagnostics || [],
    knownIssues: disc.knownIssues || [],
    exitCode: disc.exitCode,
    timedOut: disc.timedOut,
    log: disc.log,
    sidecarDir: disc.work,
    staging: disc.staging,
    artifacts: disc.artifacts,
  });
}

function localPdsLicenseGate(phase) {
  const license = preflightPdsLicense();
  if (!license.blocking) return null;
  return toolError(`PDS license preflight 失败: ${license.hint}`, {
    phase,
    stage: "license_preflight",
    license,
  });
}

// CDT commands that mutate the device (config/flash/efuse). Generic CDT and GUI
// Console entry points both require confirm + a prior IDCODE read and match.
const MUTATING_CDT = [
  /\bcfg_program\b/i,
  /\bcfg_jtag_flash_(erase|program)\b/i,
  /\bcfg_flash_(erase|program)\b/i,
  /\bcfg_efuse_program\b/i,
  /\bdbg_program\b/i,
];

function detectMutatingCdt(text) {
  const found = [];
  for (const re of MUTATING_CDT) {
    const m = re.exec(String(text || ""));
    if (m) found.push(m[0].toLowerCase());
  }
  return [...new Set(found)];
}

export function extractDebuggerIdcode(text) {
  return /\b0x[0-9a-f]{8}\b/i.exec(String(text || ""))?.[0]?.toLowerCase() || null;
}

// Build the cdt Tcl from the request, shared by the local and remote fpga_cdt
// paths (no device-specific script logic). raw tcl gets {{PORT}} substituted;
// commands get wrapped in connect/scan_chain (per interpreter) unless connect:false.
function buildCdtScript({ interpreter, tcl, connect, bodyRaw, usePort }) {
  if (tcl) return bodyRaw.replace(/\{\{PORT\}\}/g, String(usePort));
  if (connect) {
    return interpreter === "cdt_dbg"
      ? `dbg_connect -ip 127.0.0.1 -port ${usePort}\ndbg_scan_chain\n${bodyRaw}\ndbg_disconnect\ndbg_close`
      : `cfg_set_tcl_break -flag true\ncfg_connect -ip 127.0.0.1 -port ${usePort}\ncfg_scan_chain\n${bodyRaw}\ncfg_disconnect\ncfg_close`;
  }
  return bodyRaw;
}

// PDS bin tools fpga_exe may run with arbitrary args (build/analysis, no device
// mutation). Device/JTAG interpreters (cdt_cfg/cdt_dbg/cdt_js/cdt_ins) and the
// GUIs (pds.exe/assistant) are intentionally excluded — use fpga_cdt /
// fpga_pds_run. Any bin exe may still be probed with -help/-version.
const EXE_ALLOWLIST = new Set([
  "ip_generate",
  "ip_compiler",
  "ip_tar",
  "cdt_bts",
  "ppc",
  "ppp",
  "rf_analyzer",
  "evp",
  "pne",
  "state",
  "de",
  "pce",
  "ta",
]);

function isHelpOnlyArgs(args = []) {
  if (!args.length) return false;
  return args.every((a) => /^-{1,2}(h|help|version|v)$/i.test(String(a)));
}

// Re-extract compact key info from an already-captured log (pds/sim/cdt).
// Lets the agent cheaply re-summarize a persisted log without re-running.
function extractLog(profile, text) {
  const log = String(text || "");
  if (profile === "cdt") {
    return {
      profile,
      devices: parseScanLog(log),
      doneBit: /done bit is\s+1/i.test(log),
      verifyOk: /verify.*(success|pass|ok)/i.test(log),
      importCoreOk: /Import Core:\s*\d+\s*OK/i.test(log),
      knownIssues: diagnoseCdtLog(log, {}),
      keyLines: splitLines(log).filter((l) => /ID value is|done bit is|verify|Import Core/i.test(l)).slice(0, 12),
    };
  }
  if (profile === "sim") {
    const failMark = /\b(error|fail|fatal|assertion failed)\b/i.test(log);
    return {
      profile,
      failMark,
      keyLines: splitLines(log).filter((l) => /\b(error|fail|fatal|pass|finish|\$display)\b/i.test(l)).slice(0, 20),
    };
  }
  // default: pds
  const parsed = parsePdsLog(log);
  const errors = capList(parsed.errors, 50);
  return {
    profile: "pds",
    stage: detectStage(log, PDS_STAGE_MARKERS),
    hasBitstreamSuccess: parsed.hasBitstreamSuccess,
    bitstreamFromLog: parsed.bitstreamFromLog,
    errors: errors.items,
    errorCount: errors.count,
    errorsTruncated: errors.truncated,
    warnings: summarizeWarnings(parsed.warnings),
    timing: (() => {
      const t = parseTimingText(log);
      return { met: t.met, worst: t.worst, slackStatus: t.slackStatus };
    })(),
    diagnostics: { knownIssues: pdsDiagnostics(log) },
    keyLines: splitLines(log)
      .filter((l) => /Placement done|Routing done|The bitstream file is|All Constraints Met/i.test(l))
      .slice(0, 12),
  };
}

// Compose the compact pds_shell build result from the raw run + parsed reports.
// Default (detail:"summary") returns extracted findings + a tail + an on-disk
// logPath; detail:"full" additionally inlines the whole log and full reports.
function buildCompileResult({
  comp,
  log,
  parsed,
  reports,
  install,
  runTarget,
  projectInfo,
  pdsPath,
  projectDir,
  sbit,
  encrypted,
  backups,
  durationMs,
  command,
  detail,
  logPath,
  cached = false,
}) {
  const verdict = evaluatePdsRunSuccess({
    exitCode: comp.code,
    errors: parsed.errors,
    encrypted,
    runTarget,
    bitstreamSuccess: parsed.hasBitstreamSuccess,
    sbitPresent: !!sbit && existsSync(sbit),
    timing: reports.timing,
  });
  const { ok, timingFailed, timingUnknown } = verdict;
  const errors = capList(parsed.errors, 50);
  const warnings = summarizeWarnings(parsed.warnings);
  // Pango prints the Device Utilization Summary in the build LOG (the prj_tasks
  // .prt files are pad maps, not a usage table), so parse the log first and only
  // fall back to report files for other/older shapes.
  const utilFromLog = parseUtilization(log);
  const utilFiles = utilFromLog ? null : parseUtilizationFromFiles(reports.reports?.utilization || []);
  const util = utilFromLog || utilFiles?.util || null;
  const utilFile = utilFromLog ? logPath || null : utilFiles?.file || null;
  const stage = detectStage(log, PDS_STAGE_MARKERS);
  const knownIssues = pdsDiagnostics(`${log}${encrypted ? "\neffsoftecrypt" : ""}`);
  const keyLines = splitLines(log)
    .filter((l) => /Placement done|Routing done|The bitstream file is|done bit is|All Constraints Met/i.test(l))
    .slice(0, 12);
  const result = {
    ok,
    phase: "pds_compile",
    source: "pds_shell",
    cached,
    pdsVersion: install.id,
    command,
    pds: { id: install.id, label: install.label, shell: install.shell },
    runTarget,
    exitCode: comp.code,
    timedOut: comp.timedOut,
    durationMs,
    // List the sources the build ACTUALLY compiled (from the .pds source list), so an
    // edit to a file NOT in this set is visible instead of looking like a stale cache
    // (the subtle alog.txt trap: edits to a file the project never compiled).
    project: { pdsPath: resolve(pdsPath), part: projectInfo.part, topSource: projectInfo.topSource, sources: projectInfo.sources.map((s) => s.path) },
    stage,
    errors: errors.items,
    errorsDetailed: parsed.errorsDetailed,
    errorCount: errors.count,
    errorsTruncated: errors.truncated,
    warnings,
    timing: {
      met: reports.timing?.met ?? null,
      worst: reports.timing?.worst ?? null,
      worstHoldSlack: reports.timing?.worstHoldSlack,
      failingEndpoints: reports.timing?.failingEndpoints,
      clockPinsWithoutClock: reports.timing?.clockPinsWithoutClock,
      portsWithoutIoDelay: reports.timing?.portsWithoutIoDelay,
      note: reports.timing?.note,
    },
    utilization: util,
    utilizationFile: utilFile,
    artifacts: { sbit, existingSbit: reports.artifacts?.sbit, backups, reportDir: projectDir },
    diagnostics: { knownIssues },
    keyLines,
    hint: encrypted
      ? "sbit 头部含 effsoftecrypt 标记，疑似透明加密文件，拒绝视为可烧录 bitstream。"
      : timingFailed
        ? `PDS 流程完成但时序未收敛：worst setup=${reports.timing?.worst ?? "unknown"}ns，worst hold=${reports.timing?.worstHoldSlack ?? "unknown"}ns，failing endpoints=${reports.timing?.failingEndpoints ?? "unknown"}。`
      : timingUnknown
        ? "PDS 流程完成但没有可验证的 post-PnR 时序结论；检查 report_timing 产物与时钟约束后重跑。"
      : ok
        ? undefined
        : "PDS 可能退出码为 0 但日志含 E: 或未出现 bitstream success line；读 errors/diagnostics 修 RTL/约束，必要时 detail:'full' 取全文。",
  };
  if (detail === "full") result.reports = reports;
  attachLog(result, log, { detail, logPath });
  return result;
}

const JTAG_CTX = {
  cdtTool,
  choosePdsInstall,
  defaultPortForInstall,
  defaultScanMaxDevices: DEFAULT_SCAN_MAX_DEVICES,
  cdtStartupTimeoutMs: DEFAULT_CDT_STARTUP_TIMEOUT_MS,
  parsePdsLog,
  run,
  toolEnv,
};

async function scanForFlash({ pdsVersion, port, timeoutSec, deviceIndex }) {
  const attempts = [];
  let lastScan = null;
  const maxAttempts = DEFAULT_FLASH_SCAN_RETRIES + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const scan = await scanJtag(JTAG_CTX, {
      pdsVersion,
      port,
      timeoutSec: Math.min(timeoutSec, 60),
      maxDevices: deviceIndex + 1,
    });
    lastScan = scan;
    attempts.push({
      attempt,
      ok: scan.ok,
      timedOut: scan.timedOut,
      devices: scan.devices,
      diagnostics: scan.diagnostics,
      cdtServer: scan.cdtServer,
    });
    const device = scan.devices.find((d) => d.index === deviceIndex);
    if (device) return { scan, device, attempts };
    if (attempt < maxAttempts && DEFAULT_FLASH_SCAN_RETRY_DELAY_MS > 0) await sleep(DEFAULT_FLASH_SCAN_RETRY_DELAY_MS);
  }
  return { scan: lastScan, device: null, attempts };
}

// SPI flash read opcodes cfg_gen_sfc (-opcode) accepts, per cdt_cfg help: 0x0B/
// 0x3B/0x6B (3-byte addressing) and 0x0C/0x3C/0x6C (4-byte). Kept as an open list
// rather than hardcoding one — the caller picks per their flash.
const SFC_OPCODES = [0x0b, 0x3b, 0x6b, 0x0c, 0x3c, 0x6c];

// Wrap a list of file paths as a Tcl list of forward-slash absolute paths.
function tclPathList(items) {
  return `{${items.map((p) => toTclPath(p)).join(" ")}}`;
}

// Shared offline-generation driver for the cfg_gen_* family (sfc / multi_file /
// chain_file). Builds a one-line Tcl invocation, runs it device-free (no cdt_js /
// no cable), and judges success by exit code + absence of an E: line + every
// expected output file present. `outputs` are existence-checked when known.
async function runGen(cmd, args, { pdsVersion, timeoutSec = 120, outputs = [] } = {}) {
  const install = choosePdsInstall({ pdsVersion });
  if (!existsSync(install.shell)) throw new Error(`PDS 安装不可用: ${install.shell}`);
  const script = `${cmd} ${args.join(" ")}`;
  const res = await runCdtGen(JTAG_CTX, install, script, { timeoutSec });
  const log = (res.stdout + res.stderr).trim();
  const hasError = /^\s*E:/im.test(log);
  const produced = outputs.filter((f) => f && existsSync(f));
  const missing = outputs.filter((f) => f && !existsSync(f));
  const ok = res.code === 0 && !hasError && missing.length === 0;
  return digestCdt(
    {
      ok,
      phase: cmd,
      exitCode: res.code,
      timedOut: res.timedOut,
      command: script,
      artifacts: produced,
      missing: missing.length ? missing : undefined,
      log,
      hint: ok
        ? undefined
        : hasError
          ? "cdt_cfg 返回 E: 错误，见 logDigest/logPath。"
          : missing.length
            ? `预期输出未生成: ${missing.join(", ")}`
            : "cdt_cfg 非零退出或超时。",
    },
    cmd,
  );
}

// Drive the bare-metal JTAG CLI (jtag/cli.py): MPSSE scan / SVF-replay flash /
// FLA capture over the FT2232 — no cdt_js, no GUI, no runtime license. Runs with
// cwd=JTAG_DIR so cli.py's `from mpsse_jtag import ...` resolves. python is
// required on PATH (uses ctypes against ftd2xx.dll). The CLI emits a side-effect-
// free D2XX inventory so FT_Open failures can distinguish absence/ownership/
// JTAG read failure without claiming that cdt_js is always the owner.
async function runJtagCli(subArgs, { timeoutSec = 120 } = {}) {
  const py = which("python") || which("py") || "python";
  const res = await run(py, ["cli.py", ...subArgs], { cwd: JTAG_DIR, timeoutSec });
  const rawOut = (res.stdout + res.stderr).trim();
  const idcodes = parseBareJtagIdcodes(rawOut);
  const commands = new Set(["scan", "capture", "poll", "gen-svf", "flash"]);
  const command = subArgs.find((item) => commands.has(item));
  const capture = command === "capture" ? parseBareJtagCaptureSummary(rawOut) : null;
  // gen-svf is deliberately offline: do not report a fictitious cable state
  // when no inventory was requested and no USB handle is needed.
  const analysis = command === "gen-svf"
    ? {}
    : analyzeJtagCliOutput({ out: rawOut, exitCode: res.code, idcodes });
  return {
    ok: res.code === 0,
    exitCode: res.code,
    timedOut: res.timedOut,
    command: `python cli.py ${subArgs.join(" ")}`,
    out: stripFlaFramingRecord(stripD2xxInventoryRecord(rawOut)),
    ...(idcodes.length ? { idcodes } : {}),
    ...(capture ? { capture } : {}),
    ...analysis,
  };
}

// Valid pds_shell -run targets (note dev_map/pnr, not device_map/place_route).
export const PDS_RUN_TARGETS = [
  "compile",
  "synthesize",
  "dev_map",
  "pnr",
  "report_timing",
  "report_power",
  "gen_bit_stream",
  "gen_netlist",
];

// Shared headless pds_shell -run engine: cache lookup -> run -> compact summary
// + persist log/summary/reports. Used by both fpga_pds_run and fpga_pds_compile.
// Emit periodic MCP progress notifications while a long pds_shell run is in
// flight. PDS builds are minutes-level; without progress, any client on the
// SDK's default 60s request timeout aborts the call. Clients that pass a
// progressToken (+ resetTimeoutOnProgress) keep the call alive on each tick.
// No-op when the client did not opt in (no progressToken / sendNotification).
function startBuildHeartbeat(extra, runTarget, intervalMs = 10000) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || typeof extra?.sendNotification !== "function") return () => {};
  const started = Date.now();
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    const sec = Math.round((Date.now() - started) / 1000);
    Promise.resolve(
      extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, message: `pds_shell -run ${runTarget} 运行中（${sec}s）…` },
      })
    ).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// Push only project INPUTS (.pds + sources + constraints + aux like .fic) to a
// remote workdir, preserving the relative layout the .pds references. For aux
// files (e.g. .fic for the Fabric Inserter), PDS resolves the relative path
// using the inserter sub-process's CWD which is the user's home, not the
// project — Inserter-0002 results. We rewrite those refs in the .pds copy
// pushed to the remote to absolute remote paths so the inserter finds them.
import { readFileSync as _readFileSync } from "node:fs";
async function stageInputs(exec, projectInfo, pdsPath, rdir, sep) {
  for (const s of projectInfo.sources) await exec.putFile(s.absPath, `${rdir}${sep}${s.path.replace(/\//g, sep)}`);
  for (const c of projectInfo.constraints) await exec.putFile(c.absPath, `${rdir}${sep}${c.path.replace(/\//g, sep)}`);
  let pdsText = _readFileSync(resolve(pdsPath), "utf8");
  for (const a of projectInfo.auxFiles || []) {
    if (!existsSync(a.absPath)) continue;
    const rel = a.path.replace(/\\/g, "/");
    const abs = `${rdir}${sep}${a.path.replace(/\//g, sep)}`;
    const absFwd = abs.replace(/\\/g, "/");
    await exec.putFile(a.absPath, abs);
    // Replace any `file="<rel>"` and sexpr `(_file "<rel>" ...)` with the
    // absolute remote path so PDS sub-processes resolve it correctly.
    const safeRel = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pdsText = pdsText.replace(new RegExp(`file="${safeRel}"`, "g"), `file="${absFwd}"`);
    pdsText = pdsText.replace(new RegExp(`\\(_file\\s+"${safeRel}"`, "g"), `(_file "${absFwd}"`);
  }
  // Write the (possibly-rewritten) .pds to a temp file, then push it.
  const tmp = mkdtempSync(join(tmpdir(), "pds-stage-"));
  const tmpPds = join(tmp, basename(pdsPath));
  writeFileSync(tmpPds, pdsText, "utf8");
  try {
    await exec.putFile(tmpPds, `${rdir}${sep}${basename(pdsPath)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Map a remote absolute path (from the build log) into the pulled local mirror.
function remapToLocal(remotePath, rdir, mirror) {
  if (!remotePath) return null;
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const rp = norm(remotePath);
  const rd = norm(rdir);
  if (!rp.toLowerCase().startsWith(rd.toLowerCase())) return null;
  const rel = rp.slice(rd.length).replace(/^\/+/, "");
  return rel ? join(mirror, ...rel.split("/")) : mirror;
}

// Headless pds_shell -run engine. Local (default) runs in place; with `host` it
// stages the project to a remote device over SSH, runs pds_shell there, pulls
// the build outputs into a local mirror, and parses the mirror — same analysis
// path (buildCompileResult) for both, no device-specific result logic.
async function pdsRun({ pdsPath, pdsVersion, runTarget, host, backupOldBuildDirs = true, detail = "summary", cache = true, timeoutSec = 900 }, extra) {
  if (!isAbsolute(pdsPath) || !existsSync(pdsPath) || extname(pdsPath).toLowerCase() !== ".pds") {
    return toolError(`pdsPath 不存在、非绝对路径或不是 .pds: ${pdsPath}`);
  }
  const projectInfo = parsePdsProject(pdsPath);
  const baseInstall = choosePdsInstall({ pdsVersion, projectInfo });
  const exec = getExecutor(host);
  let install = baseInstall;
  if (exec.isRemote) {
    const pdsMap = getHost(host)?.pds || {};
    const remoteShell = pdsMap[baseInstall.id] || pdsMap["2025.2"] || Object.values(pdsMap)[0];
    if (!remoteShell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
    install = { id: baseInstall.id, label: `${baseInstall.label} @${host}`, shell: remoteShell, binDir: String(remoteShell).replace(/[\\/][^\\/]*$/, "") };
  } else if (!existsSync(install.shell)) {
    return toolError(`未找到 pds_shell.exe: ${install.shell}`, { pds: install });
  }
  if (!exec.isRemote) {
    const licenseError = localPdsLicenseGate("pds_run");
    if (licenseError) return licenseError;
  }
  const projectDir = dirname(resolve(pdsPath));
  const sep = exec.os === "windows" ? "\\" : "/";
  const command = { exe: install.shell, args: ["-project", resolve(pdsPath), "-run", runTarget], cwd: projectDir, host: host || "local" };

  // Cache key = hash of source/constraint CONTENTS + the project's semantic
  // projection (part + source/constraint lists) + target + install. We must
  // NOT hash the raw .pds bytes: pds_shell rewrites it (timestamps/comments)
  // on every run, which would defeat the cache. Source/constraint edits and
  // part/source-list changes still invalidate correctly.
  const inputFiles = [
    ...projectInfo.sources.map((s) => s.absPath),
    ...projectInfo.constraints.map((c) => c.absPath),
    ...(projectInfo.auxFiles || []).map((a) => a.absPath).filter((p) => existsSync(p)),
  ];
  const semantic = {
    part: projectInfo.part,
    top: projectInfo.topSource,
    sources: projectInfo.sources.map((s) => s.path).sort(),
    constraints: projectInfo.constraints.map((c) => c.path).sort(),
    aux: (projectInfo.auxFiles || []).map((a) => a.path).sort(),
  };
  const cacheKey = hashParts([hashFiles(inputFiles), JSON.stringify(semantic), runTarget, install.id, host || "local"]);
  const cacheDir = runStoreDir(projectDir, cacheKey);
  if (cache) {
    const prev = loadCachedSummary(cacheDir);
    const sbitStillThere = !prev?.artifacts?.sbit || existsSync(prev.artifacts.sbit);
    if (prev && prev.ok && sbitStillThere) {
      const hit = { ...prev, cached: true, hint: "命中构建缓存（输入未变），跳过重运行；需重跑用 cache:false。" };
      if (detail === "full") {
        const savedReports = loadRunJson(cacheDir, "reports.json");
        if (savedReports) hit.reports = savedReports;
        if (prev.logPath && existsSync(prev.logPath)) attachLog(hit, safeReadText(prev.logPath), { detail: "full", logPath: prev.logPath });
      }
      return toolResult(hit);
    }
  }

  const started = Date.now();
  let comp;
  let log;
  let buildDir;
  let sbit;
  let backups = [];
  if (exec.isRemote) {
    let rdir;
    const stopHeartbeat = startBuildHeartbeat(extra, runTarget);
    try {
      rdir = await exec.mkdtemp("fpgabuild-");
      await stageInputs(exec, projectInfo, pdsPath, rdir, sep);
      comp = await exec.run(install.shell, ["-project", `${rdir}${sep}${basename(pdsPath)}`, "-run", runTarget], { cwd: rdir, timeoutSec });
    } catch (err) {
      stopHeartbeat();
      await exec.close();
      return toolError(`远程构建失败（host=${host}）: ${err.message}`);
    } finally {
      stopHeartbeat();
    }
    log = (comp.stdout + comp.stderr).trim();
    const mirror = join(projectDir, ".pango-mcp", "remote", String(host));
    try {
      rmSync(mirror, { recursive: true, force: true });
    } catch {}
    mkdirSync(mirror, { recursive: true });
    try {
      await exec.getDir(rdir, mirror);
    } catch (err) {
      await exec.close();
      return toolError(`拉取远程构建产物失败（host=${host}）: ${err.message}`);
    }
    buildDir = mirror;
    sbit = remapToLocal(parsePdsLog(log).bitstreamFromLog, rdir, mirror);
    try {
      await exec.exec(exec.os === "windows" ? `cmd /c rmdir /s /q "${rdir}"` : `rm -rf '${rdir}'`, { timeoutSec: 30 });
    } catch {}
    await exec.close();
  } else {
    try {
      if (backupOldBuildDirs) backups = moveBuildDirsAside(projectDir);
    } catch (err) {
      return toolError(`备份 PDS 构建目录失败: ${err.message}`);
    }
    const stopHeartbeat = startBuildHeartbeat(extra, runTarget);
    try {
      comp = await run(install.shell, ["-project", resolve(pdsPath), "-run", runTarget], { cwd: projectDir, timeoutSec });
    } finally {
      stopHeartbeat();
    }
    log = (comp.stdout + comp.stderr).trim();
    buildDir = projectDir;
    sbit = resolvePdsLogBitstream(parsePdsLog(log).bitstreamFromLog, projectDir);
  }
  const parsed = parsePdsLog(log);
  const reports = collectPdsReports({ pdsPath, buildDir, log });
  const encrypted = sbitHasEncryptionMarker(sbit);

  const logPath = writeRunLog(cacheDir, "build.log", log);
  const result = buildCompileResult({
    comp,
    log,
    parsed,
    reports,
    install,
    runTarget,
    projectInfo,
    pdsPath,
    projectDir: buildDir,
    sbit,
    encrypted,
    backups,
    durationMs: Date.now() - started,
    command,
    detail,
    logPath,
  });
  const cacheCopy = detail === "full"
    ? buildCompileResult({ comp, log, parsed, reports, install, runTarget, projectInfo, pdsPath, projectDir: buildDir, sbit, encrypted, backups, durationMs: result.durationMs, command, detail: "summary", logPath })
    : result;
  writeRunSummary(cacheDir, cacheCopy);
  writeRunJson(cacheDir, "reports.json", reports);
  return toolResult(result);
}

export function register(server) {
  server.registerTool(
    "fpga_project_info",
    {
      title: "PDS 工程信息解析",
      description: "解析 .pds 工程文件，返回目标器件、顶层源文件、源文件列表、约束文件与括号平衡检查。",
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程文件绝对路径"),
      },
    },
    async ({ pdsPath }) => {
      if (!isAbsolute(pdsPath) || !existsSync(pdsPath) || extname(pdsPath).toLowerCase() !== ".pds") {
        return toolError(`pdsPath 不存在、非绝对路径或不是 .pds: ${pdsPath}`);
      }
      const info = parsePdsProject(pdsPath);
      return toolResult({ ok: info.parenBalanced, phase: "project_info", ...info });
    }
  );

  server.registerTool(
    "fpga_pds_create_project",
    {
      title: "创建最小 PDS 工程",
      description: "创建一个可供 pds_shell 尝试编译的最小 .pds 工程（RTL/约束/.pds）。器件无关：目标 family/device/speedgrade/package 是板级物理信息，由用户/Target Profile 给定，工具不内置默认/不猜。**推荐传 board:<name>**(config 的 boards 里一套完整 target，含引脚→自动生成 FDC)；或把 4 个字段全显式给。缺则报错点名所缺。",
      inputSchema: {
        projectDir: z.string().describe("目标工程目录绝对路径；目录不存在则创建"),
        name: z.string().optional().describe("工程名/生成的 .pds 文件名，默认 fpga_mcp_demo"),
        top: z.string().optional().describe("顶层模块名，默认 top"),
        board: z.string().optional().describe("Target Profile 名(config 的 boards[<name>])，一次提供完整 family/device/package/speedgrade(+pins→生成 FDC)。fpga_env 列出已配置 board；未配则向用户询问。"),
        family: z.string().optional().describe("PDS family。传了 board 可省(由 profile 提供)；否则必填。物理信息，工具不猜。"),
        device: z.string().optional().describe("PDS device。传了 board 可省；否则必填。"),
        package: z.string().optional().describe("PDS package 器件封装。传了 board 可省；否则必填(真实封装，工具不猜)。"),
        speedgrade: z.string().optional().describe("PDS speedgrade。传了 board 可省；否则必填。"),
        pinNames: z.array(z.string()).min(1).optional().describe("使用 board 完整 Target Profile 时，本设计实际存在的顶层端口子集；物理 loc/freq/iostd 仍全部取 profile。省略=使用 profile 全部 pins。"),
        force: z.boolean().optional().describe("目标目录非空时是否删除重建，默认 false"),
      },
    },
    async ({ projectDir, name, top, board, family, device, package: pkg, speedgrade, pinNames, force = false }) => {
      if (!isAbsolute(projectDir)) return toolError(`projectDir 必须是绝对路径: ${projectDir}`);
      try {
        const { part, pins } = resolveTargetPart({ board, family, device, package: pkg, speedgrade });
        const created = createMinimalPdsProject({ projectDir, name, top, force, part, pins, pinNames });
        return toolResult({
          ok: created.info.parenBalanced,
          phase: "pds_create_project",
          projectDir: created.projectDir,
          artifacts: {
            pds: created.pdsPath,
            source: created.sourcePath,
            fdc: created.fdcPath,
          },
          project: created.info,
          pinNames: created.pinNames,
        });
      } catch (err) {
        return toolError(`创建 PDS 工程失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_pds_create_blink_project",
    {
      title: "创建 PDS LED Blink 工程",
      description: "创建面向真实板卡的 LED blink PDS 工程，生成 RTL、FDC 和 .pds。器件无关：必须提供完整目标器件 family/device/speedgrade/package（由用户/Target Profile 给定，工具不内置默认）。",
      inputSchema: {
        projectDir: z.string().describe("目标工程目录绝对路径；目录不存在则创建"),
        name: z.string().optional().describe("工程名/flow id，默认 fab_blink"),
        top: z.string().optional().describe("顶层模块名，默认 top"),
        clkPin: z.string().describe("时钟引脚，例如 D18"),
        ledPins: z.array(z.string()).describe("LED 引脚数组，例如 [A20,C19,C18,E18,A17]"),
        family: z.string().describe("PDS family(必填)。目标板物理信息，来自用户/Target Profile，工具不内置默认。"),
        device: z.string().describe("PDS device(必填)。目标板物理信息，由用户/Target Profile 提供，工具不替你猜。"),
        package: z.string().describe("PDS package 器件封装(必填)。必须是该板真实封装，工具不替你猜(猜错会与真实器件错配，构建失败)。"),
        speedgrade: z.string().describe("PDS speedgrade(必填)。目标板物理信息，来自用户/Target Profile。"),
        vccio: z.string().optional().describe("IO VCCIO，默认 3.3"),
        ioStandard: z.string().optional().describe("IO standard，默认 LVCMOS33"),
        counterBit: z.number().optional().describe("LED 分频起始位，默认 24"),
        clkFreqMhz: z.number().optional().describe("板载时钟频率(MHz)，生成 create_clock 的目标频率，默认 50；让时序分析针对真实频率(否则 PDS 按标称默认分析，timing.met 空判)"),
        force: z.boolean().optional().describe("目标目录非空时是否删除重建，默认 false"),
      },
    },
    async ({ projectDir, name, top, clkPin, ledPins, family, device, package: pkg, speedgrade, vccio, ioStandard, counterBit, clkFreqMhz, force = false }) => {
      if (!isAbsolute(projectDir)) return toolError(`projectDir 必须是绝对路径: ${projectDir}`);
      try {
        const created = createBlinkPdsProject({
          projectDir,
          name,
          top,
          clkPin,
          ledPins,
          vccio,
          ioStandard,
          counterBit,
          clkFreqMhz,
          force,
          part: { family, device, package: pkg, speedgrade },
        });
        return toolResult({
          ok: created.info.parenBalanced,
          phase: "pds_create_blink_project",
          projectDir: created.projectDir,
          board: {
            clkPin: created.clkPin,
            ledPins: created.ledPins,
            ioStandard: created.ioStandard,
            vccio: created.vccio,
            counterBit: created.counterBit,
            clkFreqMhz: created.clkFreqMhz,
            clkPeriodNs: created.clkPeriodNs,
          },
          artifacts: {
            pds: created.pdsPath,
            source: created.sourcePath,
            fdc: created.fdcPath,
          },
          project: created.info,
        });
      } catch (err) {
        return toolError(`创建 PDS blink 工程失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_pds_reports",
    {
      title: "PDS 报告解析",
      description: "解析 PDS 构建日志、时序、资源与 bitstream 输出；不运行 PDS。",
      inputSchema: {
        pdsPath: z.string().optional().describe(".pds 工程文件绝对路径"),
        buildDir: z.string().optional().describe("PDS 构建目录；省略时取 pdsPath 所在目录"),
        logPath: z.string().optional().describe("额外日志文件绝对路径"),
        log: z.string().optional().describe("额外日志文本"),
        top: z.string().optional().describe("可选顶层名，仅用于回传标注"),
      },
    },
    async ({ pdsPath, buildDir, logPath, log, top }) => {
      if (pdsPath && (!isAbsolute(pdsPath) || !existsSync(pdsPath))) return toolError(`pdsPath 不存在或非绝对路径: ${pdsPath}`);
      if (buildDir && (!isAbsolute(buildDir) || !existsSync(buildDir))) return toolError(`buildDir 不存在或非绝对路径: ${buildDir}`);
      if (logPath && (!isAbsolute(logPath) || !existsSync(logPath))) return toolError(`logPath 不存在或非绝对路径: ${logPath}`);
      return toolResult(collectPdsReports({ pdsPath, buildDir, logPath, log, top }));
    }
  );

  server.registerTool(
    "fpga_pds_run",
    {
      title: "PDS Headless 运行 (任意 -run 目标)",
      description:
        `用 pds_shell.exe -project <x.pds> -run <target> 运行任意流程阶段。target ∈ {${PDS_RUN_TARGETS.join(", ")}}（注意 dev_map/pnr，非 device_map/place_route；早期目标如 dev_map 可快速拿资源不跑 P&R）。不信退出码，解析 E:/bitstream success line + effsoftecrypt 自检。默认紧凑摘要 + detail:'full' 兜底 + 按输入 hash 缓存。`,
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程文件绝对路径"),
        runTarget: z.string().describe(`PDS -run 目标，如 ${PDS_RUN_TARGETS.join("/")}`),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时自动 stage 工程→远端 pds_shell→拉回产物。"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签，如 2022.2 或 2025.2；省略按工程器件选择"),
        backupOldBuildDirs: z.boolean().optional().describe("构建前备份旧 PDS 输出目录，默认 true"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary(紧凑、省 token)；full 含完整日志与 reports"),
        cache: z.boolean().optional().describe("源文件+target 未变时复用上次摘要，默认 true；false 强制重运行"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 900"),
      },
    },
    async (args, extra) => pdsRun(args, extra)
  );

  server.registerTool(
    "fpga_pds_compile",
    {
      title: "PDS Headless 构建 (gen_bit_stream 预设)",
      description:
        "fpga_pds_run 的出比特流预设：默认 runTarget=gen_bit_stream，跑全流程产 .sbit。其余行为同 fpga_pds_run（紧凑摘要 + detail/cache + effsoftecrypt 自检）。",
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程文件绝对路径"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签，如 2022.2 或 2025.2；省略按工程器件选择"),
        runTarget: z.string().optional().describe("PDS -run 目标，默认 gen_bit_stream"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时自动 stage 工程→远端 pds_shell→拉回产物。"),
        backupOldBuildDirs: z.boolean().optional().describe("构建前备份旧 PDS 输出目录，默认 true"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary(紧凑、省 token)；full 含完整日志与 reports"),
        cache: z.boolean().optional().describe("源文件+target 未变时复用上次构建摘要，默认 true；false 强制重编"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 900"),
      },
    },
    async ({ runTarget = "gen_bit_stream", ...rest }, extra) => pdsRun({ runTarget, ...rest }, extra)
  );

  server.registerTool(
    "fpga_pds_batch",
    {
      title: "PDS 独立工程变体批量运行（最多 2-way）",
      description:
        "并行运行多个已准备好的独立 PDS project clone，并汇总每个 variant 的 timing/errors/artifacts。安全门：每个 pdsPath 必须位于唯一且互不嵌套的项目目录，prj_work_dir/prj_impl_dir 不得外置；同一 .pds 或共享 prj_tasks 会在启动前拒绝。默认且最高 2-way（P&R 内存密集）。任一 variant 失败则顶层 ok=false，但保留全部逐项结果。",
      inputSchema: {
        variants: z.array(z.object({
          id: z.string().describe("variant 稳定标识，仅字母/数字/._-"),
          pdsPath: z.string().describe("该 variant 独立 project clone 内的 .pds 绝对路径"),
          runTarget: z.enum(PDS_RUN_TARGETS).optional().describe("覆盖批次默认 -run target"),
          pdsVersion: z.string().optional().describe("覆盖批次默认 PDS 版本"),
          timeoutSec: z.number().positive().optional().describe("覆盖批次默认超时秒数"),
        })).min(1).max(MAX_PDS_BATCH_VARIANTS).describe("独立 PDS project clone 列表；目录必须唯一且互不嵌套"),
        runTarget: z.enum(PDS_RUN_TARGETS).optional().describe("批次默认 target，默认 gen_bit_stream"),
        pdsVersion: z.string().optional().describe("批次默认 PDS 版本/标签"),
        maxParallel: z.number().int().min(1).max(MAX_PDS_BATCH_PARALLEL).optional().describe("并发数，默认/上限 2"),
        backupOldBuildDirs: z.boolean().optional().describe("每个独立目录构建前备份旧输出，默认 true"),
        cache: z.boolean().optional().describe("每个 variant 使用输入 hash 缓存，默认 true"),
        timeoutSec: z.number().positive().optional().describe("每个 variant 默认超时秒数，默认 900"),
      },
    },
    async ({ variants, runTarget = "gen_bit_stream", pdsVersion, maxParallel = MAX_PDS_BATCH_PARALLEL, backupOldBuildDirs = true, cache = true, timeoutSec = 900 }, extra) => {
      let normalized;
      try {
        normalized = validatePdsBatchVariants(variants).map((variant) => ({
          ...variant,
          runTarget: variant.runTarget || runTarget,
          pdsVersion: variant.pdsVersion ?? pdsVersion,
          timeoutSec: variant.timeoutSec ?? timeoutSec,
        }));
      } catch (error) {
        return toolError(`PDS batch 安全检查失败: ${error.message}`, { phase: "pds_batch_validation" });
      }
      const result = await executePdsBatch(normalized, {
        maxParallel,
        runVariant: (variant) => {
          const variantExtra = extra && typeof extra.sendNotification === "function"
            ? {
                ...extra,
                sendNotification: (notification) => {
                  const params = notification?.params || {};
                  return extra.sendNotification({ ...notification, params: { ...params, message: `[${variant.id}] ${params.message || "PDS 运行中"}` } });
                },
              }
            : extra;
          return pdsRun({
            pdsPath: variant.pdsPath,
            pdsVersion: variant.pdsVersion,
            runTarget: variant.runTarget,
            backupOldBuildDirs,
            detail: "summary",
            cache,
            timeoutSec: variant.timeoutSec,
          }, variantExtra);
        },
      });
      return toolResult(result);
    }
  );

  server.registerTool(
    "fpga_log_extract",
    {
      title: "日志关键信息提取",
      description: "对一段日志(或日志文件)按 profile 抽取关键信息：pds(错误码/阶段/时序/资源/已知问题)、cdt(IDCODE/done bit/verify)、sim(失败标记)。用于对落盘日志二次廉价提取，省 token。",
      inputSchema: {
        profile: z.enum(["pds", "cdt", "sim"]).optional().describe("提取 profile，默认 pds"),
        log: z.string().optional().describe("日志文本(与 logPath 二选一)"),
        logPath: z.string().optional().describe("日志文件绝对路径(与 log 二选一)"),
      },
    },
    async ({ profile = "pds", log, logPath }) => {
      let text = log;
      if (!text && logPath) {
        if (!isAbsolute(logPath) || !existsSync(logPath)) return toolError(`logPath 不存在或非绝对路径: ${logPath}`);
        text = safeReadText(logPath);
      }
      if (!text) return toolError("需要提供 log 文本或 logPath");
      return toolResult({ ok: true, phase: "log_extract", ...extractLog(profile, text) });
    }
  );

  server.registerTool(
    "fpga_pds_scan",
    {
      title: "PDS JTAG 扫链",
      description: "启动/复用 cdt_js，并用 cdt_cfg 扫 JTAG 链、读取 IDCODE。只读动作。默认本机；传 host 则在该远程设备上扫（execution-device layer）。",
      inputSchema: {
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时在该设备上起 cdt_js + 跑 cdt_cfg 扫链。"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签，如 2022.2 或 2025.2"),
        port: z.number().optional().describe("cdt_js 端口，默认来自配置或 65420（远程默认 65425）"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 30"),
        maxDevices: z.number().optional().describe("最多读取多少个 JTAG 设备 IDCODE；默认 1（单板/单 FPGA），多器件链才显式加大"),
        retryOnTransient: z.boolean().optional().describe("遇到 CDT scan 超时/未解析到设备时是否自动短重试一次，默认 false（仅本机）"),
        retryDelayMs: z.number().optional().describe("retryOnTransient 的重试间隔毫秒，默认 1500"),
      },
    },
    async ({ host, pdsVersion, port, timeoutSec = 30, maxDevices, retryOnTransient = false, retryDelayMs = 1500 }) => {
      try {
        if (host) {
          const exec = getExecutor(host);
          const pdsMap = getHost(host)?.pds || {};
          const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
          if (!shell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
          const install = { binDir: String(shell).replace(/[\\/][^\\/]*$/, "") };
          try {
            return toolResult(digestCdt(annotateScanAliases(await scanJtagRemote(exec, install, { port: port ?? 65425, timeoutSec, maxDevices: maxDevices ?? 1 })), "scan"));
          } finally {
            await exec.close();
          }
        }
        return toolResult(digestCdt(annotateScanAliases(await scanJtag(JTAG_CTX, { pdsVersion, port, timeoutSec, maxDevices, retryOnTransient, retryDelayMs })), "scan"));
      } catch (err) {
        return toolError(`JTAG 扫链前置失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_flash_sram",
    {
      title: "烧录 FPGA SRAM",
      description: "烧 .sbit 到 FPGA SRAM。危险动作：必须 confirm=true，且内部先 scan 并校验 expectIdcode。",
      inputSchema: {
        sbit: z.string().describe(".sbit 绝对路径"),
        expectIdcode: z.string().describe("期望 IDCODE 或别名(PG2L100H/PG2L200H/GW/TG)。比较时忽略 IDCODE 高 4 位硅版本。"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时 .sbit 推到该设备后在其上烧录。"),
        deviceIndex: z.number().optional().describe("JTAG 设备索引，默认 0"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        port: z.number().optional().describe("cdt_js 端口，默认来自配置或 65420"),
        confirm: z.boolean().optional().describe("必须为 true 才实际烧录"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ sbit, expectIdcode, host, deviceIndex = 0, pdsVersion, port, confirm, timeoutSec = 120 }) => {
      if (!isAbsolute(sbit) || !existsSync(sbit) || extname(sbit).toLowerCase() !== ".sbit") {
        return toolError(`sbit 不存在、非绝对路径或不是 .sbit: ${sbit}`);
      }
      if (!normalizeIdcode(expectIdcode, IDCODE_ALIASES)) return toolError(`expectIdcode 无法识别: ${expectIdcode}`);
      if (!confirm) {
        return toolResult({
          ok: false,
          phase: "confirm",
          hint: "烧录 SRAM 需要显式 confirm:true；工具将先 scan 并校验 expectIdcode。",
          sbit,
          host: host || "local",
          deviceIndex,
          expectIdcode,
        });
      }
      if (host) {
        const exec = getExecutor(host);
        try {
          const pdsMap = getHost(host)?.pds || {};
          const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
          if (!shell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
          const install = { binDir: String(shell).replace(/[\\/][^\\/]*$/, "") };
          const usePort = port ?? 65425;
          const scan = await scanJtagRemote(exec, install, { port: usePort, timeoutSec: Math.min(timeoutSec, 60), maxDevices: deviceIndex + 1 });
          const device = scan.devices.find((d) => d.index === deviceIndex);
          if (!device) return toolResult({ ok: false, phase: "safety", scope: "remote", host, hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan: digestCdt(scan, "scan") });
          if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
            return toolResult({ ok: false, phase: "safety", scope: "remote", host, hint: `IDCODE 不匹配，拒绝烧录: actual=${device.idcode}, expected=${expectIdcode}`, scan: digestCdt(scan, "scan") });
          }
          const flash = await flashSramRemote(exec, install, { sbit, deviceIndex, port: usePort, timeoutSec });
          return toolResult(digestCdt({ ...flash, host, device, expectIdcode }, "flash"));
        } catch (err) {
          return toolError(`远程 SRAM 烧录失败（host=${host}）: ${err.message}`);
        } finally {
          await exec.close();
        }
      }
      try {
        const { scan, device, attempts } = await scanForFlash({ pdsVersion, port, timeoutSec, deviceIndex });
        if (!device) return toolResult({ ok: false, phase: "safety", hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan, scanAttempts: attempts });
        if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
          return toolResult({ ok: false, phase: "safety", hint: `IDCODE 不匹配，拒绝烧录: actual=${device.idcode}, expected=${expectIdcode}`, scan, scanAttempts: attempts });
        }
        const flashPort = scan.port;
        const install = choosePdsInstall({ pdsVersion });
        const script = `
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port ${Number(flashPort)}
cfg_scan_chain
cfg_assign_file -file ${toTclPath(sbit)} -device_index ${Number(deviceIndex)}
cfg_program -device_index ${Number(deviceIndex)}
cfg_disconnect
cfg_close`;
        const res = await runCdtCfg(JTAG_CTX, install, script, { port: flashPort, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        const ok = res.code === 0 && /done bit is\s+1/i.test(log) && !/^\s*E:/im.test(log);
        return toolResult({
          ok,
          phase: "flash_sram",
          doneBit: /done bit is\s+1/i.test(log),
          exitCode: res.code,
          timedOut: res.timedOut,
          device,
          scanAttempts: attempts,
          artifacts: { sbit },
          log,
          hint: ok ? undefined : "未看到 done bit is 1，或 cdt_cfg 返回错误。",
        });
      } catch (err) {
        return toolError(`SRAM 烧录前置失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_flash_spi",
    {
      title: "烧录板载 SPI Flash",
      description: "通过 FPGA JTAG->SPI bridge 持久烧录。危险动作：必须 confirm=true，且内部先 scan 并校验 expectIdcode。",
      inputSchema: {
        sbit: z.string().describe(".sbit 绝对路径"),
        expectIdcode: z.string().describe("期望 IDCODE 或别名(PG2L100H/PG2L200H/GW/TG)。比较时忽略 IDCODE 高 4 位硅版本。"),
        flashPart: z.string().describe("SPI flash 型号，例如 W25Q128Q"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时 .sbit 推到该设备后在其上烧 SPI flash。"),
        sfcPath: z.string().optional().describe("生成的 .sfc 路径；默认与 sbit 同名（远程时在远端临时目录生成）"),
        deviceIndex: z.number().optional().describe("JTAG 设备索引，默认 0"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        port: z.number().optional().describe("cdt_js 端口，默认来自配置或 65420"),
        confirm: z.boolean().optional().describe("必须为 true 才实际烧录"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 300"),
      },
    },
    async ({ sbit, expectIdcode, flashPart, host, sfcPath, deviceIndex = 0, pdsVersion, port, confirm, timeoutSec = 300 }) => {
      if (!isAbsolute(sbit) || !existsSync(sbit) || extname(sbit).toLowerCase() !== ".sbit") {
        return toolError(`sbit 不存在、非绝对路径或不是 .sbit: ${sbit}`);
      }
      if (!normalizeIdcode(expectIdcode, IDCODE_ALIASES)) return toolError(`expectIdcode 无法识别: ${expectIdcode}`);
      const sfc = sfcPath ? (isAbsolute(sfcPath) ? sfcPath : resolve(dirname(sbit), sfcPath)) : sbit.replace(/\.sbit$/i, ".sfc");
      if (!confirm) {
        return toolResult({
          ok: false,
          phase: "confirm",
          hint: "烧录 SPI flash 是持久动作，需要显式 confirm:true；工具将先 scan 并校验 expectIdcode。",
          sbit,
          host: host || "local",
          sfc,
          flashPart,
          deviceIndex,
          expectIdcode,
        });
      }
      if (host) {
        const exec = getExecutor(host);
        try {
          const pdsMap = getHost(host)?.pds || {};
          const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
          if (!shell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
          const install = { binDir: String(shell).replace(/[\\/][^\\/]*$/, "") };
          const usePort = port ?? 65425;
          const scan = await scanJtagRemote(exec, install, { port: usePort, timeoutSec: Math.min(timeoutSec, 60), maxDevices: deviceIndex + 1 });
          const device = scan.devices.find((d) => d.index === deviceIndex);
          if (!device) return toolResult({ ok: false, phase: "safety", scope: "remote", host, hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan });
          if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
            return toolResult({ ok: false, phase: "safety", scope: "remote", host, hint: `IDCODE 不匹配，拒绝烧录: actual=${device.idcode}, expected=${expectIdcode}`, scan });
          }
          const flash = await flashSpiRemote(exec, install, { sbit, flashPart, deviceIndex, port: usePort, timeoutSec });
          return toolResult({ ...flash, host, device, expectIdcode });
        } catch (err) {
          return toolError(`远程 SPI flash 烧录失败（host=${host}）: ${err.message}`);
        } finally {
          await exec.close();
        }
      }
      try {
        const { scan, device, attempts } = await scanForFlash({ pdsVersion, port, timeoutSec, deviceIndex });
        if (!device) return toolResult({ ok: false, phase: "safety", hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan, scanAttempts: attempts });
        if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
          return toolResult({ ok: false, phase: "safety", hint: `IDCODE 不匹配，拒绝烧录: actual=${device.idcode}, expected=${expectIdcode}`, scan, scanAttempts: attempts });
        }
        const flashPort = scan.port;
        const install = choosePdsInstall({ pdsVersion });
        const script = `
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port ${Number(flashPort)}
cfg_scan_chain
cfg_set_cable_property -index 0 -freq 5Mhz
cfg_gen_sfc -sbit ${toTclPath(sbit)} -sfc ${toTclPath(sfc)} -device_name ${flashPart}
cfg_jtag_flash_scan_device -device_index ${Number(deviceIndex)}
cfg_jtag_flash_assign_file -file ${toTclPath(sfc)} -device_index ${Number(deviceIndex)}
cfg_jtag_flash_erase -device_index ${Number(deviceIndex)}
cfg_jtag_flash_program -device_index ${Number(deviceIndex)}
cfg_jtag_flash_verify -device_index ${Number(deviceIndex)}
cfg_disconnect
cfg_close`;
        const res = await runCdtCfg(JTAG_CTX, install, script, { port: flashPort, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        const ok = res.code === 0 && /verify.*(success|pass|ok)|success/i.test(log) && !/^\s*E:/im.test(log);
        return toolResult({
          ok,
          phase: "flash_spi",
          exitCode: res.code,
          timedOut: res.timedOut,
          device,
          scanAttempts: attempts,
          artifacts: { sbit, sfc },
          log,
          hint: ok ? undefined : "未看到 verify success/pass/ok，或 cdt_cfg 返回错误。",
        });
      } catch (err) {
        return toolError(`SPI flash 烧录前置失败: ${err.message}`);
      }
    }
  );

  // ---- Offline flash-image generation (cfg_gen_*) ---------------------------
  // Pure .sbit→.sfc/.bit transforms. No device, cable, confirm, or IDCODE needed
  // — generation never mutates hardware. Flash part / opcode / addresses are all
  // caller-supplied and parameterized; nothing here is board- or project-specific.

  server.registerTool(
    "fpga_gen_sfc",
    {
      title: "生成 SPI Flash 镜像 (.sfc)",
      description:
        "离线把 .sbit 转成 .sfc（cfg_gen_sfc），不连器件、不需 cable/confirm。flash 型号(-device_name)、读 opcode、起始地址全部参数化，可烧任意所连 FPGA 的配置 flash；不内置任何板级默认。多启动用 fpga_gen_multi_file。",
      inputSchema: {
        sbit: z.string().describe(".sbit 绝对路径"),
        sfc: z.string().optional().describe("输出 .sfc 路径；默认与 sbit 同名换 .sfc"),
        deviceName: z.string().optional().describe("flash 型号(-device_name)；省略=cdt 默认 N25Q256。可接受名随 PDS 版本而异：2025.2 收 W25Q128Q/W25Q256/N25Q128 等(Winbond 带 Q 后缀)，但拒 W25Q128/WINBOND128M；老版(2022.2)接受名不同。型号开放、按实际/兼容片选，未知时先用默认或 W25Q128Q 兼容名试。"),
        opcode: z.number().optional().describe(`flash 读命令码(-opcode)，仅支持 ${SFC_OPCODES.map((o) => `0x${o.toString(16).toUpperCase().padStart(2, "0")}`).join("/")}`),
        sbitStartAddress: z.string().optional().describe("sbit 起始地址(-sbit_start_address)，十六进制如 0x00000000；省略=不传(从 0)"),
        userAddressList: z.array(z.string()).optional().describe("用户数据文件起始地址列表(-user_address_list)，十六进制"),
        fileList: z.array(z.string()).optional().describe("用户数据文件列表(-file_list)，与 userAddressList 对应"),
        fastMode: z.boolean().optional().describe("-fast_mode：下降沿采样"),
        isX8: z.boolean().optional().describe("-is_x8：X8 模式转换"),
        writeChecksum: z.boolean().optional().describe("-write_checksum：写入校验和信息"),
        extraByte: z.boolean().optional().describe("-extra_byte：生成 sfc 时是否补一个额外字节"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ sbit, sfc, deviceName, opcode, sbitStartAddress, userAddressList, fileList, fastMode, isX8, writeChecksum, extraByte, pdsVersion, timeoutSec = 120 }) => {
      if (!isAbsolute(sbit) || !existsSync(sbit) || extname(sbit).toLowerCase() !== ".sbit") {
        return toolError(`sbit 不存在、非绝对路径或不是 .sbit: ${sbit}`);
      }
      if (opcode != null && !SFC_OPCODES.includes(opcode)) {
        return toolError(`opcode 非法: ${opcode}；仅支持 ${SFC_OPCODES.join("/")} (即 0x0B/0x3B/0x6B/0x0C/0x3C/0x6C)`);
      }
      if (sbitStartAddress != null && !/^0x[0-9a-f]+$/i.test(sbitStartAddress)) {
        return toolError(`sbitStartAddress 须为十六进制(如 0x00000000): ${sbitStartAddress}`);
      }
      if ((userAddressList?.length || 0) !== (fileList?.length || 0)) {
        return toolError("userAddressList 与 fileList 长度必须一致");
      }
      const out = sfc ? (isAbsolute(sfc) ? sfc : resolve(dirname(sbit), sfc)) : sbit.replace(/\.sbit$/i, ".sfc");
      const args = [`-sbit ${toTclPath(sbit)}`, `-sfc ${toTclPath(out)}`];
      if (deviceName) args.push(`-device_name ${deviceName}`);
      if (opcode != null) args.push(`-opcode ${opcode}`);
      if (sbitStartAddress != null) args.push(`-sbit_start_address ${sbitStartAddress}`);
      if (userAddressList?.length) args.push(`-user_address_list {${userAddressList.join(" ")}}`);
      if (fileList?.length) args.push(`-file_list ${tclPathList(fileList)}`);
      if (fastMode != null) args.push(`-fast_mode ${fastMode ? "TRUE" : "FALSE"}`);
      if (isX8 != null) args.push(`-is_x8 ${isX8 ? "TRUE" : "FALSE"}`);
      if (writeChecksum != null) args.push(`-write_checksum ${writeChecksum ? "TRUE" : "FALSE"}`);
      if (extraByte != null) args.push(`-extra_byte ${extraByte ? "TRUE" : "FALSE"}`);
      try {
        return toolResult({ ...(await runGen("cfg_gen_sfc", args, { pdsVersion, timeoutSec, outputs: [out] })), sfc: out });
      } catch (err) {
        return toolError(`cfg_gen_sfc 失败: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "fpga_gen_multi_file",
    {
      title: "生成多启动数据流 (cfg_gen_multi_file)",
      description:
        "离线把两个或更多 .sbit 合成多启动/升级数据流（黄金+应用回退、SPI/BPI 升级等）。不连器件。infile 与 sbitStartAddress 由调用方给定，偏移不写死；type 选数据流类型。",
      inputSchema: {
        infile: z.array(z.string()).min(1).describe("输入 .sbit 列表(-infile)，至少一个；顺序即镜像顺序"),
        type: z.number().describe("数据流类型(-type)：0=Multi Boot,1=SPI Upgrade,2=BPI Upgrade,3=Multi Function,4=Remote Upgrade,5=Master Dual Boot"),
        sbitStartAddress: z.array(z.string()).optional().describe("各镜像起始地址(-sbit_start_address)，十六进制，与 infile 对应"),
        outfile: z.string().optional().describe("输出文件(-outfile)，默认取第一个输入文件名"),
        goldenOutFile: z.string().optional().describe("黄金位流输出文件名(-golden_out_file)"),
        appliedOutFile: z.string().optional().describe("应用位流输出文件名(-applied_out_file)"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ infile, type, sbitStartAddress, outfile, goldenOutFile, appliedOutFile, pdsVersion, timeoutSec = 120 }) => {
      for (const f of infile) {
        if (!isAbsolute(f) || !existsSync(f)) return toolError(`infile 不存在或非绝对路径: ${f}`);
      }
      if (!Number.isInteger(type) || type < 0 || type > 5) return toolError(`type 须为 0..5 的整数: ${type}`);
      if (sbitStartAddress?.length) {
        if (sbitStartAddress.length !== infile.length) return toolError("sbitStartAddress 长度须与 infile 一致");
        for (const a of sbitStartAddress) if (!/^0x[0-9a-f]+$/i.test(a)) return toolError(`sbitStartAddress 须为十六进制: ${a}`);
      }
      const args = [`-infile ${tclPathList(infile)}`, `-type ${type}`];
      if (sbitStartAddress?.length) args.push(`-sbit_start_address {${sbitStartAddress.join(" ")}}`);
      const outputs = [];
      const absOut = (p) => (isAbsolute(p) ? p : resolve(dirname(infile[0]), p));
      if (outfile) { const o = absOut(outfile); args.push(`-outfile ${toTclPath(o)}`); outputs.push(o); }
      if (goldenOutFile) { const o = absOut(goldenOutFile); args.push(`-golden_out_file ${toTclPath(o)}`); outputs.push(o); }
      if (appliedOutFile) { const o = absOut(appliedOutFile); args.push(`-applied_out_file ${toTclPath(o)}`); outputs.push(o); }
      try {
        return toolResult(await runGen("cfg_gen_multi_file", args, { pdsVersion, timeoutSec, outputs }));
      } catch (err) {
        return toolError(`cfg_gen_multi_file 失败: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "fpga_gen_chain_file",
    {
      title: "生成 SPI 链式文件 (cfg_gen_chain_file)",
      description:
        "离线把两个或更多 .sbit 合成 SPI chain 文件。不连器件。可选生成 bin 及字节/位反转，全部参数化。",
      inputSchema: {
        infile: z.array(z.string()).min(1).describe("输入 .sbit 列表(-infile)，至少一个"),
        outfile: z.string().optional().describe("输出文件(-outfile)，默认取第一个输入文件名"),
        createBinFile: z.boolean().optional().describe("-create_bin_file：同时生成 bin 文件"),
        reverseBitInAByte: z.boolean().optional().describe("-reverse_bit_in_a_byte：bin 内按字节翻转 bit"),
        reverseByteInAWord: z.boolean().optional().describe("-reverse_byte_in_a_word：bin 内按字翻转 byte"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ infile, outfile, createBinFile, reverseBitInAByte, reverseByteInAWord, pdsVersion, timeoutSec = 120 }) => {
      for (const f of infile) {
        if (!isAbsolute(f) || !existsSync(f)) return toolError(`infile 不存在或非绝对路径: ${f}`);
      }
      const args = [`-infile ${tclPathList(infile)}`];
      const outputs = [];
      if (outfile) {
        const o = isAbsolute(outfile) ? outfile : resolve(dirname(infile[0]), outfile);
        args.push(`-outfile ${toTclPath(o)}`);
        outputs.push(o);
      }
      if (createBinFile) args.push("-create_bin_file");
      if (reverseBitInAByte) args.push("-reverse_bit_in_a_byte");
      if (reverseByteInAWord) args.push("-reverse_byte_in_a_word");
      try {
        return toolResult(await runGen("cfg_gen_chain_file", args, { pdsVersion, timeoutSec, outputs }));
      } catch (err) {
        return toolError(`cfg_gen_chain_file 失败: ${err.message}`);
      }
    },
  );

  // ---- Bare-metal JTAG (FT2232 MPSSE, no cdt_js / GUI / runtime license) -----
  // Wraps the proven jtag/cli.py: faster SVF-replay flash (~15s @6MHz) and
  // headless FLA capture. Decoupled from the cdt_js path — do NOT run these while
  // a cdt_js-backed tool (fpga_pds_scan / fpga_flash_*) holds the cable.

  server.registerTool(
    "fpga_jtag_scan",
    {
      title: "裸机 JTAG 扫描 (MPSSE)",
      description:
        "经 FT2232 直读 IDCODE，不走 cdt_js/PDS、无需 license。只读、设备安全。与 fpga_pds_scan 互斥用 cable：cdt_js 在跑时先停。",
      inputSchema: {
        channel: z.number().optional().describe("FT2232 通道；省略=探测 0 和 1"),
        tckHz: z.number().optional().describe("JTAG TCK(Hz)，默认 1e6"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 60"),
      },
    },
    async ({ channel, tckHz, timeoutSec = 60 }) => {
      const args = buildBareJtagCliArgs("scan", { channel, tckHz });
      const r = await runJtagCli(args, { timeoutSec });
      const idcodes = parseBareJtagIdcodes(r.out);
      return toolResult({ ...r, phase: "jtag_scan", idcodes });
    },
  );

  server.registerTool(
    "fpga_jtag_gen_svf",
    {
      title: "离线 .sbit→CRAM .svf (cdt_cfg)",
      description:
        "经 cdt_cfg `cfg_one_step_create_svf` 把 .sbit 转成 CRAM(SRAM) 配置 SVF。**离线、不连 cable**，给 fpga_jtag_flash 复用。PDS bin/license 默认从 pango-mcp 配置/环境自动发现。",
      inputSchema: {
        sbit: z.string().describe(".sbit 绝对路径"),
        svf: z.string().optional().describe("输出 .svf 路径；默认 <sbit>_cram.svf 同目录"),
        property: z.string().optional().describe("-svf_property，默认 0x40C4E(CRAM+check-done+1MHz)"),
        pdsBin: z.string().optional().describe("含 cdt_cfg_shell.exe 的目录；省略=自动发现"),
        license: z.string().optional().describe("PANGO_LICENSE_FILE；省略=继承环境"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 180"),
      },
    },
    async ({ sbit, svf, property, pdsBin, license, timeoutSec = 180 }) => {
      if (!isAbsolute(sbit) || !existsSync(sbit) || extname(sbit).toLowerCase() !== ".sbit") {
        return toolError(`sbit 不存在、非绝对路径或不是 .sbit: ${sbit}`);
      }
      const out = svf ? (isAbsolute(svf) ? svf : resolve(dirname(sbit), svf)) : sbit.replace(/\.sbit$/i, "_cram.svf");
      const args = ["gen-svf", "--sbit", sbit, "--svf", out];
      if (property) args.push("--property", property);
      if (pdsBin) args.push("--pds-bin", pdsBin);
      if (license) args.push("--license", license);
      const r = await runJtagCli(args, { timeoutSec });
      const ok = r.ok && existsSync(out);
      return toolResult({ ...r, ok, phase: "jtag_gen_svf", svf: out, hint: ok ? undefined : (existsSync(out) ? r.hint : `SVF 未生成: ${out}`) });
    },
  );

  server.registerTool(
    "fpga_jtag_flash",
    {
      title: "裸机 JTAG 烧录 SRAM (SVF 回放)",
      description:
        "经 FT2232 回放 CRAM SVF 配置 FPGA（SRAM、易失/可逆，~15s@6MHz），校验 done bit。危险动作：必须 confirm=true，并先裸机 scan 校验 expectIdcode；SVF 内仍做第二次 IDCODE TDO 检查。给 --sbit 时自动离线生成/缓存 SVF。不走 cdt_js/GUI。",
      inputSchema: {
        svf: z.string().optional().describe("CRAM .svf 路径（与 sbit 二选一，跳过生成）"),
        sbit: z.string().optional().describe(".sbit 路径（与 svf 二选一，自动缓存/生成 CRAM SVF）"),
        expectIdcode: z.string().describe("期望 IDCODE 或别名（如 PG2L200H）；比较时忽略高 4 位硅版本"),
        confirm: z.boolean().optional().describe("必须为 true 才实际烧录"),
        channel: z.number().optional().describe("FT2232 通道，默认 0"),
        tckHz: z.number().optional().describe("JTAG TCK(Hz)，默认 6e6（实测 ≤10e6 安全）"),
        pdsBin: z.string().optional().describe("--sbit 路径用：含 cdt_cfg_shell.exe 的目录"),
        license: z.string().optional().describe("--sbit 路径用：PANGO_LICENSE_FILE"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 180"),
      },
    },
    async ({ svf, sbit, expectIdcode, confirm, channel = 0, tckHz, pdsBin, license, timeoutSec = 180 }) => {
      if ((!svf && !sbit) || (svf && sbit)) return toolError("svf 与 sbit 二选一（必须给且只给一个）");
      const src = svf || sbit;
      if (!isAbsolute(src) || !existsSync(src)) return toolError(`输入不存在或非绝对路径: ${src}`);
      const gate = evaluateBareFlashGate({ confirm, expectIdcode, aliases: IDCODE_ALIASES });
      if (!gate.ok) return toolResult({ ...gate, tool: "fpga_jtag_flash", source: src, channel, expectIdcode });

      const scan = await runJtagCli(["scan", "--channel", String(channel)], { timeoutSec: Math.min(timeoutSec, 60) });
      const device = scan.idcodes?.find((item) => item.channel === channel);
      if (!scan.ok || !device) {
        return toolResult({
          ok: false,
          phase: "safety",
          source: src,
          channel,
          expectIdcode,
          scan,
          hint: `裸机 scan 未在 channel=${channel} 读到有效 IDCODE，拒绝烧录。`,
        });
      }
      if (!idcodeMatches(device.idcode, gate.expected, IDCODE_ALIASES)) {
        return toolResult({
          ok: false,
          phase: "safety",
          source: src,
          channel,
          expectIdcode,
          device,
          hint: `IDCODE 不匹配，拒绝裸机烧录: actual=${device.idcode}, expected=${expectIdcode}`,
        });
      }
      const subArgs = [];
      if (svf) subArgs.push("--svf", svf);
      else subArgs.push("--sbit", sbit);
      if (pdsBin) subArgs.push("--pds-bin", pdsBin);
      if (license) subArgs.push("--license", license);
      const args = buildBareJtagCliArgs("flash", { channel, tckHz, subArgs });
      const r = await runJtagCli(args, { timeoutSec });
      const ok = r.ok && /FLASH OK/i.test(r.out);
      return toolResult({ ...r, ok, phase: "jtag_flash", device, expectIdcode, doneBit: /done bit verified/i.test(r.out), hint: ok ? undefined : r.hint });
    },
  );

  server.registerTool(
    "fpga_jtag_capture",
    {
      title: "本地首选：裸机 JTAG FLA 抓波",
      description:
        "本地 ILA 的默认抓波路径：经 FT2232 武装片上 FLA、读回采样缓冲并导出（VCD/JSON/CSV/可选 raw），不走 cdt_js/GUI。通常先 fpga_jtag_flash，再调用本工具；width/depth/信号名来自设计 .fic 或显式给定。PDS 不在 .fic 暴露物理 stride：reader 先按 vendor 标准 width+1 精确探测，必要时扩大读取并仅凭 protocol padding 稀疏度推断；歧义 fail-closed，也可显式给 paddingBits。capture.framing 始终返回 paddingOneCounts/header/tail/read length。可选值/边沿触发(--trig)，需 ila.mjs 建过 Match-Unit 的 FLA；窗口按触发对齐返回。导出路径的 parent 不存在时自动递归创建。",
      inputSchema: {
        fic: z.string().optional().describe("设计 .fic（推导 signals/depth）"),
        width: z.number().optional().describe("采样位宽；省略则取 .fic/signals"),
        depth: z.number().optional().describe("采样深度（2 的幂）"),
        signals: z.string().optional().describe("逗号分隔位名，LSB 在前（覆盖 .fic）"),
        trig: z.string().optional().describe("每通道触发模式，width 个字符 x/0/1/r/f（从 ch0）；省略/全 x = 始终触发"),
        cond: z.number().optional().describe("条件位(capture_len-1)，0 或 1，默认 0"),
        trigPos: z.number().optional().describe("触发在缓冲中的位置，默认 depth"),
        channel: z.number().optional().describe("FT2232 通道，默认 0"),
        tckHz: z.number().optional().describe("JTAG TCK(Hz)，默认 1e6"),
        vcd: z.string().optional().describe("写 VCD 到此路径"),
        json: z.string().optional().describe("写 JSON 到此路径"),
        csv: z.string().optional().describe("写 CSV 到此路径"),
        raw: z.string().optional().describe("可选：写 step-29 原始 TDO bitstream（二进制，LSB-first packed bytes）到此路径"),
        paddingBits: z.number().int().positive().optional().describe("可选：显式物理 protocol bits/sample；省略则自动探测/推断，歧义会 fail-closed"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ fic, width, depth, signals, trig, cond, trigPos, channel, tckHz, vcd, json, csv, raw, paddingBits, timeoutSec = 120 }) => {
      if (fic && (!isAbsolute(fic) || !existsSync(fic))) return toolError(`fic 不存在或非绝对路径: ${fic}`);
      if (!fic && !(width && depth) && !signals) return toolError("需 fic，或 width+depth，或 signals");
      const subArgs = [];
      if (fic) subArgs.push("--fic", fic);
      if (width != null) subArgs.push("--width", String(width));
      if (depth != null) subArgs.push("--depth", String(depth));
      if (signals) subArgs.push("--signals", signals);
      if (trig) subArgs.push("--trig", trig);
      if (cond != null) subArgs.push("--cond", String(cond));
      if (trigPos != null) subArgs.push("--trig-pos", String(trigPos));
      if (vcd) subArgs.push("--vcd", vcd);
      if (json) subArgs.push("--json", json);
      if (csv) subArgs.push("--csv", csv);
      if (raw) subArgs.push("--raw", raw);
      if (paddingBits != null) subArgs.push("--padding-bits", String(paddingBits));
      const args = buildBareJtagCliArgs("capture", { channel, tckHz, subArgs });
      const r = await runJtagCli(args, { timeoutSec });
      const triggered = /triggered: marker found/i.test(r.out);
      return toolResult({ ...r, phase: "jtag_capture", triggered: trig ? triggered : undefined, artifacts: [vcd, json, csv, raw].filter(Boolean) });
    },
  );

  server.registerTool(
    "fpga_cdt",
    {
      title: "CDT 通用 Tcl 直通 (受护栏)",
      description:
        "对 cdt_js 跑任意 cfg_*(cdt_cfg) 或 dbg_*(cdt_dbg) Tcl，覆盖扫链/读属性/配置/SPI flash/ILA 抓波/virtual-IO 全套。读类(scan/read/list/help)自由；写器件类(cfg_program/cfg_jtag_flash_erase|program/dbg_program 等)需 confirm:true + expectIdcode(先 scan 校验匹配)。connect:true(默认)自动包 connect/scan_chain/disconnect，只需给 commands；raw tcl 用 {{PORT}} 占位端口。",
      inputSchema: {
        interpreter: z.enum(["cdt_cfg", "cdt_dbg"]).optional().describe("解释器，默认 cdt_cfg(cfg_*)；ILA/virtual-IO 用 cdt_dbg(dbg_*)"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时在该设备上跑 cdt_cfg/cdt_dbg。"),
        commands: z.array(z.string()).optional().describe("要执行的命令(每行一条)；connect:true 时自动包 connect/scan_chain"),
        tcl: z.string().optional().describe("原始完整 Tcl 脚本(与 commands 二选一)；用 {{PORT}} 占位 cdt_js 端口；提供时不自动包 connect"),
        connect: z.boolean().optional().describe("是否自动包 connect/scan_chain/disconnect，默认 true(仅对 commands 生效)"),
        expectIdcode: z.string().optional().describe("写器件脚本必填：期望 IDCODE 或别名；运行前 scan 校验匹配"),
        confirm: z.boolean().optional().describe("脚本含写器件命令时必须 true"),
        deviceIndex: z.number().optional().describe("写器件前 scan 校验的设备索引，默认 0"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        port: z.number().optional().describe("cdt_js 端口，默认按版本(2025.2=65425/2022.2=65420)"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 60"),
      },
    },
    async ({ interpreter = "cdt_cfg", host, commands, tcl, connect = true, expectIdcode, confirm, deviceIndex = 0, pdsVersion, port, detail = "summary", timeoutSec = 60 }) => {
      const bodyRaw = tcl ?? (Array.isArray(commands) ? commands.join("\n") : "");
      if (!bodyRaw.trim()) return toolError("需要提供 commands[] 或 tcl 脚本");
      const exeName = interpreter === "cdt_dbg" ? "cdt_dbg.exe" : "cdt_cfg.exe";
      const pfx = interpreter === "cdt_dbg" ? "dbg" : "cfg";

      // Policy gates first (install-independent): never run a device-mutating
      // script without confirm + a recognizable expectIdcode.
      const mutating = detectMutatingCdt(bodyRaw);
      if (mutating.length && !confirm) {
        return toolResult({ ok: false, phase: "confirm", interpreter, host: host || "local", mutating, expectIdcode, hint: "脚本含写器件命令，需 confirm:true + expectIdcode；工具会先 scan 并校验 IDCODE。" });
      }
      if (mutating.length && (!expectIdcode || !normalizeIdcode(expectIdcode, IDCODE_ALIASES))) {
        return toolError(`写器件脚本需要可识别的 expectIdcode；收到: ${expectIdcode}`, { mutating });
      }

      if (host) {
        const exec = getExecutor(host);
        try {
          const pdsMap = getHost(host)?.pds || {};
          const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
          if (!shell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
          const install = { binDir: String(shell).replace(/[\\/][^\\/]*$/, "") };
          const usePort = port ?? 65425;
          if (mutating.length) {
            const scan = await scanJtagRemote(exec, install, { port: usePort, timeoutSec: Math.min(timeoutSec, 60), maxDevices: deviceIndex + 1 });
            const device = scan.devices.find((d) => d.index === deviceIndex);
            if (!device) return toolResult({ ok: false, phase: "safety", scope: "remote", host, mutating, hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan });
            if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
              return toolResult({ ok: false, phase: "safety", scope: "remote", host, mutating, hint: `IDCODE 不匹配，拒绝执行: actual=${device.idcode}, expected=${expectIdcode}`, scan });
            }
          }
          const script = buildCdtScript({ interpreter, tcl, connect, bodyRaw, usePort });
          const { log, timedOut } = await runCdtRemote(exec, install, { makeTcl: () => script, exeName, port: usePort, timeoutSec });
          // log is already GBK-decoded by runCdtRemote; judge ok on OS-level + cdt
          // failure signatures, not just "E:" (a missing-exe error is the localized
          // "系统找不到指定的文件。", which the old "E:"-only check missed -> false ok).
          const failHint = cdtFailureSignature(log);
          const ok = !failHint;
          const out = {
            ok,
            phase: "cdt",
            scope: "remote",
            host,
            interpreter,
            mutating: mutating.length ? mutating : undefined,
            port: usePort,
            timedOut,
            extract: extractLog("cdt", log),
            hint: ok ? undefined : failHint || `${pfx}_* 返回错误(日志含 E:)；读 extract/log 修。`,
          };
          return toolResult(attachLog(out, log, { detail }));
        } catch (err) {
          return toolError(`远程 CDT 执行失败（host=${host}）: ${err.message}`);
        } finally {
          await exec.close();
        }
      }

      const install = choosePdsInstall({ pdsVersion });
      if (!existsSync(cdtTool(install, exeName))) return toolError(`未找到 ${exeName}: ${cdtTool(install, exeName)}`, { pds: install });
      let usePort = port ?? defaultPortForInstall(install);

      if (mutating.length) {
        try {
          const { scan, device, attempts } = await scanForFlash({ pdsVersion, port, timeoutSec, deviceIndex });
          if (!device) return toolResult({ ok: false, phase: "safety", mutating, hint: `scan 未找到 deviceIndex=${deviceIndex}`, scan, scanAttempts: attempts });
          if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) {
            return toolResult({ ok: false, phase: "safety", mutating, hint: `IDCODE 不匹配，拒绝执行: actual=${device.idcode}, expected=${expectIdcode}`, scan, scanAttempts: attempts });
          }
          usePort = scan.port;
        } catch (err) {
          return toolError(`CDT 写器件前置 scan 失败: ${err.message}`);
        }
      }

      const script = buildCdtScript({ interpreter, tcl, connect, bodyRaw, usePort });

      try {
        const res = await runCdtScript(JTAG_CTX, install, exeName, script, { port: usePort, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        // Fail on a non-zero exit OR any OS-level/cdt failure signature (covers the
        // GBK "系统找不到指定的文件。" class), not just "E:".
        const failHint = cdtFailureSignature(log);
        const ok = res.code === 0 && !failHint;
        const out = {
          ok,
          phase: "cdt",
          interpreter,
          mutating: mutating.length ? mutating : undefined,
          port: usePort,
          exitCode: res.code,
          timedOut: res.timedOut,
          extract: extractLog("cdt", log),
          hint: ok ? undefined : failHint || `${pfx}_* 返回错误(exit≠0 或日志含 E:)；读 extract/log 修。`,
        };
        return toolResult(attachLog(out, log, { detail }));
      } catch (err) {
        return toolError(`CDT 执行失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_exe",
    {
      title: "PDS bin 工具直通 (受护栏)",
      description:
        "在 PDS bin 目录跑构建/分析类工具(ip_generate/ip_compiler/ip_tar/cdt_bts/ppc/ppp/rf_analyzer/evp/pne/state/de/pce/ta)并回提取后的输出。任意 bin exe 都可用 -help/-version 探测其用法。器件/JTAG 类(cdt_cfg/cdt_dbg/cdt_js/cdt_ins)与 GUI(pds.exe/assistant) 不在此列——用 fpga_cdt / fpga_pds_run。",
      inputSchema: {
        exe: z.string().describe("bin 目录下的 exe 名(可省略 .exe)，如 ip_generate / ppc / cdt_bts"),
        args: z.array(z.string()).optional().describe("命令行参数；用 ['-help'] 探测用法"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts；省略=本机）。远程时在该设备 bin 目录跑。"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签"),
        cwd: z.string().optional().describe("工作目录绝对路径，默认 bin 目录（仅本机）"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ exe, args = [], host, pdsVersion, cwd, detail = "summary", timeoutSec = 120 }) => {
      const base = String(exe).replace(/\.exe$/i, "");
      const helpOnly = isHelpOnlyArgs(args);
      // Policy first (install-independent): non-allowlisted exes may only be
      // probed read-only with -help/-version.
      if (!EXE_ALLOWLIST.has(base) && !helpOnly) {
        return toolError(`exe '${base}' 不在允许列表；仅允许 -help/-version 探测，或改用 fpga_cdt(设备/JTAG)/fpga_pds_run(构建)。`, {
          allowlist: [...EXE_ALLOWLIST],
        });
      }
      if (host) {
        const exec = getExecutor(host);
        try {
          const pdsMap = getHost(host)?.pds || {};
          const shell = (pdsVersion && pdsMap[pdsVersion]) || pdsMap["2025.2"] || Object.values(pdsMap)[0];
          if (!shell) return toolError(`host '${host}' 未配置 PDS 安装路径（pango-mcp.config.json: hosts.${host}.pds）`);
          const binDir = String(shell).replace(/[\\/][^\\/]*$/, "");
          const sep = exec.os === "windows" ? "\\" : "/";
          const exePath = `${binDir}${sep}${base}.exe`;
          if (!(await exec.exists(exePath))) return toolError(`远端未找到 exe: ${exePath}`, { host });
          const res = await exec.run(exePath, args, { cwd: binDir, timeoutSec });
          const log = (res.stdout + res.stderr).trim();
          const out = { ok: res.code === 0, phase: "exe", scope: "remote", host, exe: base, exePath, args, helpOnly, exitCode: res.code, timedOut: res.timedOut };
          return toolResult(attachLog(out, log, { detail }));
        } catch (err) {
          return toolError(`远程 exe 执行失败（host=${host}）: ${err.message}`);
        } finally {
          await exec.close();
        }
      }
      const install = choosePdsInstall({ pdsVersion });
      const exePath = join(install.binDir, `${base}.exe`);
      if (!existsSync(exePath)) return toolError(`未找到 exe: ${exePath}`, { pds: install });
      if (cwd && (!isAbsolute(cwd) || !existsSync(cwd))) return toolError(`cwd 不存在或非绝对路径: ${cwd}`);
      try {
        const res = await run(exePath, args, { cwd: cwd || install.binDir, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        const out = {
          ok: res.code === 0,
          phase: "exe",
          exe: base,
          exePath,
          args,
          helpOnly,
          exitCode: res.code,
          timedOut: res.timedOut,
        };
        return toolResult(attachLog(out, log, { detail }));
      } catch (err) {
        return toolError(`exe 执行失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_ila_list_nets",
    {
      title: "ILA: 发现可抽头的真实网名(综合→解析网表)",
      description:
        "解决 ILA 抽头的根本问题:综合 flatten 后的网名 ≠ RTL 名。本工具在隔离旁路副本中 compile→run_ads，再调用 Fabric Inserter 的 ins_list_nets 取得 .fic 真正可消费的全层级标量网名；不会从模块定义猜路径。可选 signals 会展开唯一总线并返回 exact/renamed/hierarchical/ambiguous/unverified/pruned，多实例同名必须传完整层级。fpga_ila_build 使用同一权威清单做 FIC 前 fail-fast。",
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程绝对路径(已含 RTL/约束;器件从工程读取)"),
        signals: z.array(z.string()).optional().describe("可选:把期望 RTL 名或完整 flattened 名解析为 Inserter 真网名；唯一总线自动按位展开，多实例同名回 ambiguous+candidates"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本标签(定位 pds_shell);省略按工程器件选择"),
        timeoutSec: z.number().optional().describe("综合超时秒数,默认 300"),
      },
    },
    async ({ pdsPath, signals, pdsVersion, timeoutSec }) => {
      if (!isAbsolute(pdsPath) || !existsSync(pdsPath) || extname(pdsPath).toLowerCase() !== ".pds") return toolError(`pdsPath 不存在/非绝对/非 .pds: ${pdsPath}`);
      const projectInfo = parsePdsProject(pdsPath);
      const install = choosePdsInstall({ pdsVersion, projectInfo });
      if (!existsSync(install.shell)) return toolError(`未找到 pds_shell.exe: ${install.shell}`, { pds: install });
      const licenseError = localPdsLicenseGate("ila_list_nets");
      if (licenseError) return licenseError;
      const disc = await discoverNets({ pdsPath, install, run, timeoutSec: timeoutSec || 300 });
      if (!disc.ok) return netDiscoveryToolError("网名发现失败", "ila_list_nets", disc);
      const expanded = Array.isArray(signals) && signals.length ? expandBuses(disc.parsed, signals) : null;
      const resolved = expanded ? expanded.names.map((s) => resolveSignal(disc.parsed, s)) : undefined;
      const flattenedLimit = 500;
      return toolResult({
        ok: true,
        phase: "ila_list_nets",
        topModule: disc.summary.topModule,
        clocks: disc.summary.clocks,
        tappable: disc.summary.tappable,
        registers: disc.summary.registers,
        submodules: disc.summary.submodules,
        resolved,
        expansions: expanded?.expansions?.length ? expanded.expansions : undefined,
        inserterNetCount: disc.inserterNets.length,
        inserterNets: disc.inserterNets.slice(0, flattenedLimit).map((item) => ({ net: item.name, sourceComponent: item.sourceComponent })),
        inserterNetsTruncated: disc.inserterNets.length > flattenedLimit,
        netlistPath: disc.netlistPath,
        netlistFormat: disc.netlistFormat,
        vmPath: disc.vmPath,
        hint: "resolved 中只有 verified:true 的 exact/renamed/hierarchical 可写入 FIC；ambiguous 请改传 candidates 中的完整层级名，bus 会按 Inserter 实际标量成员展开。",
      });
    }
  );

  server.registerTool(
    "fpga_ila_generate_fic",
    {
      title: "ILA: 生成 .fic 配置(纯本地代码生成,低层原语)",
      description:
        "低层原语:把器件 + 时钟网 + 信号网名清单写成符合 Pango .fic 规范的文本。**入参必须是综合后真实网名**——flatten 会改名(寄存器 tx→nt_led[0]、时钟 clk→nt_clk),勿假设 RTL 名保留;不知真名先用 fpga_ila_list_nets,或直接用 fpga_ila_build(接受期望名并自动解析)。生成后用 fpga_pds_register_fic 注册→fpga_pds_run gen_bit_stream 出仪表化 sbit。",
      inputSchema: {
        ficPath: z.string().describe(".fic 输出绝对路径(建议 <projectDir>/debug/<name>.fic)"),
        part: z
          .object({
            family: z.string(),
            device: z.string(),
            package: z.string(),
            speedgrade: z.string(),
          })
          .describe("完整目标器件 family/device/speedgrade/package(板级物理信息，来自工程/用户/Target Profile，工具不默认、不猜)"),
        designInputFile: z.string().optional().describe("可选:综合网表/.adf 绝对路径,写入 .fic 的 designInputFile 字段;一般留空由工程上下文提供"),
        clockNet: z.string().describe("采样时钟网名(综合后真实网名,如 nt_clk/clk_g;用 fpga_ila_list_nets 的 clocks 取)"),
        signals: z.array(z.string()).describe("要抓的信号网名清单(综合后真实网名;RTL 名未必保留,用 fpga_ila_list_nets 解析)"),
        dataDepth: z.number().optional().describe("采样深度,默认 1024(消耗 DRM 块)"),
        busGroups: z
          .array(z.object({ name: z.string(), low: z.number(), high: z.number() }))
          .optional()
          .describe("可选显示分组(数据 bus 在波形里整体显示)"),
      },
    },
    async (args) => {
      try {
        const r = generateFic(args);
        return toolResult({ ok: true, phase: "ila_generate_fic", ...r });
      } catch (err) {
        return toolError(`生成 .fic 失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_pds_register_fic",
    {
      title: "ILA: 把 .fic 注册到 .pds(Fabric-Inserter widget)",
      description:
        "把已生成的 .fic 写入 .pds 工程的 Fabric-Inserter widget(`<action name='fic'>`/`wgt_my_fic_src`),让接下来的 `fpga_pds_run gen_bit_stream` 走 inserter→生成 instrumented bitstream。自动备份原 .pds 为 .bak_<ts>;支持 PDS 2025.2 的 XML 形态与早期 sexpr 形态。",
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程文件绝对路径"),
        ficPath: z.string().describe("已生成的 .fic 绝对路径(建议位于工程目录之下,工具自动转相对路径写入 .pds)"),
      },
    },
    async ({ pdsPath, ficPath }) => {
      if (!isAbsolute(pdsPath) || !existsSync(pdsPath)) return toolError(`pdsPath 不存在或非绝对路径: ${pdsPath}`);
      if (!isAbsolute(ficPath) || !existsSync(ficPath)) return toolError(`ficPath 不存在或非绝对路径: ${ficPath}`);
      try {
        const r = registerFicInPds({ pdsPath, ficPath });
        return toolResult({ ok: true, phase: "pds_register_fic", ...r });
      } catch (err) {
        return toolError(`注册 .fic 到 .pds 失败: ${err.message}`);
      }
    }
  );

  server.registerTool(
    "fpga_ila_console",
    {
      title: "ILA: 在 Fabric Debugger 的 Tcl Console 里执行 tcl(AI 调试控制台)",
      description:
        "无头 cdt_dbg 开不了 cable(open_cable 死锁,见 docs/ILA-FINDINGS.md);改为驱动 GUI Fabric Debugger 自带的 Tcl Console——它跑同一个 tcl 引擎且 cable 已由 GUI 打开。本工具在 GUI 所在的交互桌面(session 1)用 UIAutomation 把 tcl 打进 Console 并回读 transcript 增量,纯 AI 驱动、零人工点按。本机/远程皆可:本机(MCP 即跑在用户 session 1)直驱,远程经 SSH host 跳 session 1。可跑任意 dbg_* 命令(读 IDCODE/ADC、抓波 dbg_fla_*、import fic、program 等)。前提:目标桌面上 Fabric Debugger GUI 已打开并连好工程。写器件类命令(dbg_program 等)需 confirm:true + expectIdcode；工具先经同一 Console 只读 dbg_read_device_id 并匹配。",
      inputSchema: {
        host: z.string().optional().describe("GUI host id(省略=本机)。本机时 MCP 已在用户交互会话,直接驱动本地 GUI;远程填 pango-mcp.config.json 的 hosts id"),
        tcl: z.string().describe("要在 Tcl Console 里执行的 tcl(可多条语句;工具自动包 catch 让报错回到 transcript)"),
        user: z.string().optional().describe("远程 GUI 所属交互桌面用户(默认取 host 配置的 user;本机忽略)"),
        timeoutSec: z.number().optional().describe("等待 console 执行完成的秒数,默认 60(抓波/慢 JTAG 适当加大)"),
        expectIdcode: z.string().optional().describe("写器件命令必填：期望 IDCODE 或别名；执行前经 GUI Console 只读并匹配"),
        confirm: z.boolean().optional().describe("含写器件命令(dbg_program 等)时必须显式 true"),
      },
    },
    async ({ host, tcl, user, timeoutSec, expectIdcode, confirm }) => {
      const mutating = detectMutatingCdt(tcl);
      if (mutating.length && !confirm) {
        return toolResult({ ok: false, phase: "confirm", host: host || "local", mutating, expectIdcode, hint: "tcl 含写器件命令，需 confirm:true + expectIdcode；工具会先只读 IDCODE。" });
      }
      if (mutating.length && !normalizeIdcode(expectIdcode, IDCODE_ALIASES)) {
        return toolError(`ILA Console 写器件命令需要可识别的 expectIdcode；收到: ${expectIdcode}`, { mutating });
      }
      let exec;
      try {
        exec = getExecutor(host);
      } catch (err) {
        return toolError(err.message);
      }
      try {
        const u = user || getHost(host)?.user || "Administrator";
        let device;
        if (mutating.length) {
          const safety = await driveConsole(exec, { tcl: "dbg_read_device_id", user: u, timeoutSec: timeoutSec || 60 });
          const idcode = extractDebuggerIdcode(`${safety.tclResult || ""}\n${safety.delta || ""}`);
          if (!safety.ok || !idcode) {
            return toolResult({ ok: false, phase: "safety", host: host || "local", mutating, expectIdcode, hint: "写器件前无法经 GUI Console 读到 IDCODE，拒绝执行 dbg_program。", safety: { ok: safety.ok, transcript: safety.delta } });
          }
          if (!idcodeMatches(idcode, expectIdcode, IDCODE_ALIASES)) {
            return toolResult({ ok: false, phase: "safety", host: host || "local", mutating, expectIdcode, device: { idcode }, hint: `IDCODE 不匹配，拒绝 GUI 写入: actual=${idcode}, expected=${expectIdcode}` });
          }
          device = { idcode, alias: aliasForIdcode(idcode) };
        }
        const r = await driveConsole(exec, { tcl, user: u, timeoutSec: timeoutSec || 60 });
        return toolResult({ phase: "ila_console", host: host || "local", user: u, ok: r.ok, mutating, device, transcript: r.delta, raw: r.raw });
      } catch (err) {
        return toolError(`console 执行失败: ${err.message}`);
      } finally {
        try { await exec.close(); } catch {}
      }
    }
  );

  server.registerTool(
    "fpga_ila_adc_read",
    {
      title: "ILA: 读片上 ADC 寄存器(温度/电压等)",
      description:
        "便捷封装:经 GUI Tcl Console 执行 `dbg_adc_read_reg -address <addr>` 读片上 ADC 寄存器(如 die 温度),回读并解析数值。底层同 fpga_ila_console(session-1 UIAutomation 驱动,cable 由 GUI 打开)。",
      inputSchema: {
        host: z.string().optional().describe("GUI host id(省略=本机)"),
        address: z.union([z.string(), z.number()]).describe("ADC 寄存器地址(十六进制字符串如 '0x10' 或十进制数)"),
        user: z.string().optional().describe("远程 GUI 交互桌面用户(默认取 host 配置;本机忽略)"),
        timeoutSec: z.number().optional().describe("等待秒数,默认 40"),
      },
    },
    async ({ host, address, user, timeoutSec }) => {
      let exec;
      try {
        exec = getExecutor(host);
      } catch (err) {
        return toolError(err.message);
      }
      try {
        const u = user || getHost(host)?.user || "Administrator";
        const r = await consoleAdcRead(exec, { address, user: u, timeoutSec: timeoutSec || 40 });
        return toolResult({ phase: "ila_adc_read", host, user: u, ok: r.ok, address: r.address, value: r.value, transcript: r.delta });
      } catch (err) {
        return toolError(`ADC 读取失败: ${err.message}`);
      } finally {
        try { await exec.close(); } catch {}
      }
    }
  );

  server.registerTool(
    "fpga_ila_open",
    {
      title: "ILA GUI fallback: 打开调试器→扫链→检测核",
      description:
        "GUI fallback，不是本地默认路径。本地普通 FLA 抓波优先 fpga_jtag_flash → fpga_jtag_capture；仅当裸机 capture 不支持目标功能，或需要远程交互桌面时使用。本工具把 Fabric Debugger 拉起并就绪:session-1 启动 cdt_dbg → Search JTAG Chain → 处理 Open Cable 弹窗 → 扫描 UIA 树检测 DebugCore。前提:projectDir 是已构建且含 FLA 核的工程目录。",
      inputSchema: {
        host: z.string().optional().describe("GUI host id(省略=本机)"),
        projectDir: z.string().describe("工程目录(已 gen_bit_stream 且含 FLA 核;本机=本地路径,远程=远端路径)"),
        user: z.string().optional().describe("远程 GUI 交互桌面用户(默认取 host 配置;本机忽略)"),
        pdsVersion: z.string().optional().describe("PDS 版本标签(定位 cdt_dbg bin),默认 2025.2"),
      },
    },
    async ({ host, projectDir, user, pdsVersion }) => {
      let exec;
      try {
        exec = getExecutor(host);
      } catch (err) {
        return toolError(err.message);
      }
      const binDir = exec.isRemote ? resolveRemoteBinDir(host, pdsVersion) : choosePdsInstall({ pdsVersion }).binDir;
      if (!binDir) return toolError(exec.isRemote ? `无法解析 host '${host}' 的 PDS bin 目录(检查 hosts.${host}.pds 配置)` : "无法解析本机 PDS bin 目录(检查本地 PDS 安装)");
      try {
        const u = user || getHost(host)?.user || "Administrator";
        const r = await ilaOpen(exec, { binDir, projectDir, user: u });
        return toolResult({ phase: "ila_open", host, user: u, ...r });
      } catch (err) {
        return toolError(`ila_open 失败: ${err.message}`);
      } finally {
        try { await exec.close(); } catch {}
      }
    }
  );

  server.registerTool(
    "fpga_ila_capture",
    {
      title: "ILA GUI fallback: 抓波→导出→交互波形查看器",
      description:
        "GUI fallback，不是本地默认抓波路径；本地普通 FLA 优先 fpga_jtag_capture。仅在裸机 capture 不支持所需功能或远程 GUI 场景下，基于已完成的 fpga_ila_open 跑 dbg_fla_* 序列、导出 VCD、解析分组并生成交互波形查看器。",
      inputSchema: {
        host: z.string().optional().describe("GUI host id(省略=本机)"),
        fla: z.number().optional().describe("DebugCore 序号,默认 0"),
        trigger: z
          .object({
            mode: z.enum(["immediate", "value"]).optional(),
            value: z.union([z.string(), z.number()]).optional(),
            radix: z.enum(["hex", "bin", "dec", "oct"]).optional(),
            unit: z.number().optional(),
          })
          .optional()
          .describe("触发条件:默认 {mode:'immediate'};值触发示例 {mode:'value', value:'0500', radix:'hex'}(对触发端口做值匹配,X=任意)"),
        waitMs: z.number().optional().describe("run 后等待抓取完成的毫秒,默认 1500"),
        outDir: z.string().optional().describe("本地输出目录(viewer/json/vcd),默认 ~/fpga-ila-captures"),
        title: z.string().optional().describe("查看器标题"),
        clock: z.string().optional().describe("采样时钟名(仅展示用)"),
        signalNames: z.array(z.string()).optional().describe("按 bit 顺序的原始信号名,把导出的 DataPort[i] 重标为有意义的名字"),
        busAlias: z.record(z.string()).optional().describe('base 名改名,如 {"DataPort":"counter"}'),
        user: z.string().optional().describe("GUI 交互桌面用户(默认取 host 配置)"),
      },
    },
    async (args) => {
      let exec;
      try {
        exec = getExecutor(args.host);
      } catch (err) {
        return toolError(err.message);
      }
      try {
        const u = args.user || getHost(args.host)?.user || "Administrator";
        const outDir = args.outDir || join(homedir(), "fpga-ila-captures");
        const r = await ilaCapture(exec, {
          fla: args.fla ?? 0,
          user: u,
          trigger: args.trigger || { mode: "immediate" },
          waitMs: args.waitMs || 1500,
          outDir,
          title: args.title || "FLA capture",
          clock: args.clock || null,
          signalNames: args.signalNames || null,
          busAlias: args.busAlias || {},
        });
        if (!r.ok) return toolResult({ phase: "ila_capture", host: args.host, ...r });
        return toolResult({
          phase: "ila_capture",
          host: args.host,
          ok: true,
          summary: r.summary,
          viewer: r.viewerPath,
          data: r.dataPath,
          vcd: r.localVcd,
          hint: "浏览器打开 viewer 看可交互全采样波形;summary 是精简数据供 AI 分析(完整数据在 data json)",
        });
      } catch (err) {
        return toolError(`ila_capture 失败: ${err.message}`);
      } finally {
        try { await exec.close(); } catch {}
      }
    }
  );

  server.registerTool(
    "fpga_ila_build",
    {
      title: "ILA: 仪表化构建(生成 .fic→注册→gen_bit_stream)→ sbit + 构建报告网页",
      description:
        "把 ILA 仪表化构建合并成一次自纠调用:旁路综合→Fabric Inserter ins_list_nets 权威解析→FIC 前精确成员校验→生成/注册 .fic→gen_bit_stream。多实例同名回 ambiguous，未被 Inserter 验证或已优化的信号都会在修改工程前 fail-fast。返回 sbit+fic+报告；本地默认把 sbit 交给 fpga_jtag_flash，再把 fic 交给 fpga_jtag_capture。GUI flow 仅作远程/特殊功能 fallback。",
      inputSchema: {
        pdsPath: z.string().describe(".pds 工程绝对路径(已含 RTL/约束;器件从工程读取)"),
        signals: z.array(z.string()).describe("要抓的期望 RTL 名或 Inserter 完整网名。唯一总线自动按位展开；多实例同名必须传完整层级；未验证/被优化会在写 FIC 前失败。"),
        clockNet: z.string().optional().describe("采样时钟的 RTL 名或 Inserter 完整网名；省略时从已发现且经 Inserter 验证的时钟候选中取第一个。"),
        dataDepth: z.number().optional().describe("采样深度,默认 1024"),
        busGroups: z.array(z.object({ name: z.string(), low: z.number(), high: z.number() })).optional().describe("显示分组,如 [{name:'counter',low:0,high:15}]"),
        ficPath: z.string().optional().describe(".fic 输出路径,默认 <projectDir>/debug/ila.fic"),
        host: z.string().optional().describe("远程构建 host id(省略=本机)。注意:网名发现在本机综合(与板无关),gen_bit_stream 才用 host。"),
        pdsVersion: z.string().optional().describe("可选 PDS 版本/标签，如 2022.2 或 2025.2；省略按工程器件选择"),
        reportDir: z.string().optional().describe("构建报告网页输出目录,默认 ~/fpga-ila-captures"),
      },
    },
    async ({ pdsPath, signals, clockNet, dataDepth, busGroups, ficPath, host, pdsVersion, reportDir }, extra) => {
      if (!isAbsolute(pdsPath) || !existsSync(pdsPath) || extname(pdsPath).toLowerCase() !== ".pds") return toolError(`pdsPath 不存在/非绝对/非 .pds: ${pdsPath}`);
      if (!Array.isArray(signals) || !signals.length) return toolError("signals 不能为空");
      const project = parsePdsProject(pdsPath);
      if (!project.part?.device) return toolError("无法从工程解析器件(part.device)");

      // Discover real post-synth net names first (board-independent local synth), so
      // we never instrument with a guessed/renamed/pruned name (the alog.txt disaster).
      const install = choosePdsInstall({ pdsVersion, projectInfo: project });
      if (!existsSync(install.shell)) return toolError(`未找到 pds_shell.exe: ${install.shell}`, { pds: install });
      const licenseError = localPdsLicenseGate("ila_build");
      if (licenseError) return licenseError;
      const disc = await discoverNets({ pdsPath, install, run, timeoutSec: 300 });
      if (!disc.ok) return netDiscoveryToolError("网名发现失败", "ila_build", disc);

      const clockCandidates = clockNet ? [clockNet] : disc.summary.clocks;
      const clockResolutions = clockCandidates.map((candidate) => resolveSignal(disc.parsed, candidate));
      const clockResolution = clockResolutions.find(usableResolution);
      if (!clockResolution) {
        return toolResult({
          ok: false,
          phase: "ila_build",
          stage: "resolve",
          clockResolution: clockResolutions[0] || null,
          clockCandidates: clockResolutions,
          hint: clockNet
            ? "指定 clockNet 未在 Fabric Inserter flattened net list 中得到唯一、已验证的标量网；请使用完整层级候选。"
            : "未发现经 Fabric Inserter 验证的时钟网，请显式传 clockNet。",
          clocksFound: disc.summary.clocks,
          inserterNetCount: disc.inserterNets.length,
        });
      }
      const clk = clockResolution.net;
      // Auto-expand multi-bit buses (e.g. rx_data -> rx_data[0..7]) to per-bit
      // channels before resolving; the inserter taps scalar nets, so a bare bus
      // name fails. Channel order follows the expanded list.
      const { names: flatSignals, expansions } = expandBuses(disc.parsed, signals);
      const resolved = flatSignals.map((s) => resolveSignal(disc.parsed, s));
      const rejected = resolved.filter((result) => !usableResolution(result));
      if (rejected.length) {
        const pruned = rejected.filter((result) => result.status === "pruned");
        return toolResult({
          ok: false,
          phase: "ila_build",
          stage: "resolve",
          resolved,
          pruned: pruned.map((p) => p.name),
          rejected: rejected.map((item) => ({ name: item.name, status: item.status, candidates: item.candidates, note: item.note })),
          hint: rejected
            .map((item) => `${item.name}: ${item.status}${item.candidates?.length ? ` (${item.candidates.join(", ")})` : ""}`)
            .join("；"),
          tappable: disc.summary.tappable,
          registers: disc.summary.registers,
          inserterNetCount: disc.inserterNets.length,
        });
      }
      const nets = resolved.map((r) => r.net);

      // Last gate before any source-project mutation: every emitted clock/data
      // spelling must be an exact member of the same Inserter DB used above.
      const finalValidation = validateInserterNets(disc.parsed, [clk, ...nets]);
      if (!finalValidation.ok) {
        return toolResult({
          ok: false,
          phase: "ila_build",
          stage: "inserter_validate",
          clockResolution,
          resolved,
          missing: finalValidation.missing,
          availableCount: finalValidation.availableCount,
          hint: "FIC 前最终校验失败；工程与 .fic 均未修改。请重新发现网名并使用 Inserter 返回的完整层级标量名。",
        });
      }

      const fic = ficPath || join(project.projectDir, "debug", "ila.fic");
      try {
        generateFic({ ficPath: fic, part: project.part, clockNet: clk, signals: nets, dataDepth: dataDepth || 1024, busGroups });
        registerFicInPds({ pdsPath, ficPath: fic });
      } catch (err) {
        return toolError(`生成/注册 .fic 失败: ${err.message}`);
      }
      const buildRes = await pdsRun({ pdsPath, runTarget: "gen_bit_stream", host, pdsVersion, detail: "summary" }, extra);
      const r = buildRes.structuredContent || {};
      let report = null;
      try {
        const dir = reportDir || join(homedir(), "fpga-ila-captures");
        mkdirSync(dir, { recursive: true });
        report = join(dir, `build_${Date.now().toString(36)}.html`);
        writeFileSync(report, renderBuildReportHtml(r, { title: `Build report — ${basename(pdsPath)}` }), "utf8");
      } catch {}
      const renamed = resolved.filter((x) => x.status === "renamed" || x.status === "hierarchical");
      return toolResult({
        phase: "ila_build",
        ok: !!r.ok,
        stage: r.stage,
        clockNet: clk,
        clockResolution,
        resolved,
        timing: r.timing,
        errorCount: r.errorCount ?? (r.errors || []).length,
        errors: (r.errors || []).slice(0, 5),
        sbit: r.artifacts?.sbit || null,
        fic,
        report,
        expansions: expansions.length ? expansions.map((e) => ({ bus: e.name, channels: e.bits })) : undefined,
        channelCount: flatSignals.length,
        hint:
          (expansions.length ? `已自动展开总线为按位通道: ${expansions.map((e) => `${e.name}→${e.bits.length}ch`).join(", ")}(共 ${flatSignals.length} 通道,顺序即通道号)。` : "") +
          (renamed.length ? `注意已自动改名: ${renamed.map((x) => `${x.name}→${x.net}`).join(", ")}。` : "") +
          (r.ok ? "本地默认: sbit→fpga_jtag_flash，fic→fpga_jtag_capture；远程/特殊功能才用 GUI flow。report 网页给用户检查构建" : "构建失败,看 errors/stage;report 网页有详情"),
      });
    }
  );

  server.registerTool(
    "fpga_ila_flow",
    {
      title: "ILA GUI fallback: 一键烧录→调试器→抓波",
      description:
        "GUI fallback：仅当裸机 fpga_jtag_flash→fpga_jtag_capture 不支持目标功能，或必须使用远程交互桌面时采用。危险动作必须 confirm:true。流程:可选推送工程→释放 cable→scan+IDCODE→烧录→fpga_ila_open→fpga_ila_capture→teardown；逐 stage 回报。普通本地 FLA 抓波不要优先走本流程。",
      inputSchema: {
        host: z.string().optional().describe("GUI host id；优先用于远程交互桌面。省略仍可本机 fallback，但普通本地抓波应使用 fpga_jtag_flash→fpga_jtag_capture"),
        sbit: z.string().describe("本地已构建的仪表化 .sbit 绝对路径"),
        projectDir: z.string().describe("工程目录(debugger 据此识别核/信号名;本机=本地路径,远程=远端路径)"),
        expectIdcode: z.string().describe("期望 IDCODE 或别名(PG2L200H/TG/...),烧录前校验"),
        confirm: z.boolean().optional().describe("必须为 true 才会访问 cable、烧录并抓波"),
        builtDir: z.string().optional().describe("可选:本地已构建工程目录,流程开始时推送到 projectDir(含 prj_tasks 等)"),
        fla: z.number().optional().describe("DebugCore 序号,默认 0"),
        trigger: z.object({ mode: z.enum(["immediate", "value"]).optional(), value: z.union([z.string(), z.number()]).optional(), radix: z.enum(["hex", "bin", "dec", "oct"]).optional(), unit: z.number().optional() }).optional().describe("触发条件:默认 {mode:'immediate'};值触发示例 {mode:'value', value:'0500', radix:'hex'}(对触发端口做值匹配,X=任意)"),
        capture: z.object({ type: z.enum(["n", "w"]).optional(), samples: z.number().optional(), windows: z.number().optional(), position: z.number().optional() }).optional().describe("运行期捕获配置(无需重建):type 'n'=连续 samples 个样本(≤构建时 .fic dataDepth);type 'w'=窗口模式(windows=2^n 窗口数, position=触发点位置),配 value trigger 可把窗口 frame 到稀有/慢事件。**慢信号'全0'时改这里、勿改 DUT**。省略=工程默认(Nsamples/1024)。"),
        busAlias: z.record(z.string()).optional().describe('base 名改名,如 {"DataPort":"counter"}'),
        signalNames: z.array(z.string()).optional().describe("按 bit 顺序的原始信号名"),
        clock: z.string().optional().describe("采样时钟名(仅展示用)"),
        title: z.string().optional().describe("查看器标题,默认 \"FLA capture\""),
        waitMs: z.number().optional().describe("run 后等待抓取完成的毫秒,默认 1500"),
        outDir: z.string().optional().describe("本地输出目录(viewer/json/vcd),默认 ~/fpga-ila-captures"),
        knowledge: knowledgeCaptureSchema(z).optional(),
        deviceIndex: z.number().optional().describe("JTAG 设备索引，默认 0"),
        pdsVersion: z.string().optional().describe("PDS 版本标签(定位远端 PDS bin),默认 2025.2"),
        port: z.number().optional().describe("cdt_js 端口，默认 65425"),
        user: z.string().optional().describe("远端交互桌面/SSH 用户(默认取 host 配置或 Administrator)"),
      },
    },
    async (args) => {
      const { host, sbit, projectDir, expectIdcode, confirm, builtDir, deviceIndex = 0, pdsVersion, port, user } = args;
      if (!confirm) {
        return toolResult({
          ok: false,
          phase: "confirm",
          host: host || "local",
          hint: "ILA flow 会写入 FPGA SRAM；需显式 confirm:true。确认后工具仍会先 scan 并校验 expectIdcode。",
        });
      }
      if (!isAbsolute(sbit) || !existsSync(sbit) || extname(sbit).toLowerCase() !== ".sbit") return toolError(`sbit 不存在/非绝对/非 .sbit: ${sbit}`);
      if (!normalizeIdcode(expectIdcode, IDCODE_ALIASES)) return toolError(`expectIdcode 无法识别: ${expectIdcode}`);
      let exec;
      try {
        exec = getExecutor(host);
      } catch (err) {
        return toolError(err.message);
      }
      // Host-specific resolution. Local reuses the same proven primitives the
      // standalone local tools use (choosePdsInstall + scanForFlash + cdt_cfg
      // flash script), so scan/flash logic never diverges from fpga_flash_sram.
      const isRemote = exec.isRemote;
      const binDir = isRemote ? resolveRemoteBinDir(host, pdsVersion) : choosePdsInstall({ pdsVersion }).binDir;
      if (!binDir) return toolError(isRemote ? `无法解析 host '${host}' 的 PDS bin 目录` : "无法解析本机 PDS bin 目录(检查本地 PDS 安装)");
      const u = user || getHost(host)?.user || "Administrator";
      const stages = [];
      const fail = (extra) => toolResult({ phase: "ila_flow", host: host || "local", ok: false, stages, hint: extra?.hint || "看 stages[] 中 ok:false 的那一步的 hint/error 定位失败原因", ...extra });
      // Kill any held GUI debugger/server: cdt_dbg holds the cable and blocks the
      // cdt_cfg flash (pre-flash), and again as post-export teardown. The local
      // executor has no .exec — use .run there.
      const killGui = async () => {
        try {
          if (isRemote) await exec.exec("cmd /c taskkill /F /IM cdt_dbg.exe /IM cdt_js.exe 2>nul & echo ok", { timeoutSec: 15 });
          else await exec.run("cmd", ["/c", "taskkill", "/F", "/IM", "cdt_dbg.exe", "/IM", "cdt_js.exe"], { timeoutSec: 15 });
        } catch {}
      };
      try {
        if (builtDir && isRemote) {
          if (!existsSync(builtDir)) return toolError(`builtDir 不存在: ${builtDir}`);
          const n = await exec.putDir(builtDir, projectDir);
          stages.push({ stage: "push", ok: true, files: n });
        }
        // free the cable: a held GUI debugger would block the cdt_cfg flash
        await killGui();
        await new Promise((r) => setTimeout(r, 1500));
        stages.push({ stage: "free_cable", ok: true });

        // scan + IDCODE safety gate (host-specific scan, shared check)
        let device, flashPort;
        if (isRemote) {
          flashPort = port ?? 65425;
          const scan = await scanJtagRemote(exec, { binDir }, { port: flashPort, timeoutSec: 60, maxDevices: deviceIndex + 1 });
          device = scan.devices.find((d) => d.index === deviceIndex);
        } else {
          const s = await scanForFlash({ pdsVersion, port, timeoutSec: 60, deviceIndex });
          device = s.device;
          flashPort = s.scan.port;
        }
        if (!device) { stages.push({ stage: "scan", ok: false, hint: `scan 未找到 deviceIndex=${deviceIndex}(检查供电/cable)` }); return fail(); }
        if (!idcodeMatches(device.idcode, expectIdcode, IDCODE_ALIASES)) { stages.push({ stage: "scan", ok: false, hint: `IDCODE 不匹配: actual=${device.idcode} expected=${expectIdcode}` }); return fail(); }
        stages.push({ stage: "scan", ok: true, idcode: device.idcode });

        // flash instrumented sbit (host-specific; local mirrors fpga_flash_sram)
        let flashOk, flashHint, flashLog;
        if (isRemote) {
          const flash = await flashSramRemote(exec, { binDir }, { sbit, deviceIndex, port: flashPort, timeoutSec: 180 });
          flashOk = flash.ok; flashHint = flash.hint; flashLog = flash.log || "";
        } else {
          const install = choosePdsInstall({ pdsVersion });
          const script = `cfg_set_tcl_break -flag true\ncfg_connect -ip 127.0.0.1 -port ${Number(flashPort)}\ncfg_scan_chain\ncfg_assign_file -file ${toTclPath(sbit)} -device_index ${Number(deviceIndex)}\ncfg_program -device_index ${Number(deviceIndex)}\ncfg_disconnect\ncfg_close`;
          const res = await runCdtCfg(JTAG_CTX, install, script, { port: flashPort, timeoutSec: 180 });
          flashLog = (res.stdout + res.stderr).trim();
          flashOk = res.code === 0 && /done bit is\s+1/i.test(flashLog) && !/^\s*E:/im.test(flashLog);
          flashHint = flashOk ? undefined : "未看到 done bit is 1，或 cdt_cfg 返回错误。";
        }
        stages.push({ stage: "flash", ok: flashOk, doneBit: /done bit is\s+1/i.test(flashLog), hint: flashHint });
        if (!flashOk) return fail();

        const open = await ilaOpen(exec, { binDir, projectDir, user: u });
        stages.push({ stage: "open", ok: open.ok && (open.cores || []).length > 0, cores: open.cores, device: open.device, hint: (open.cores || []).length ? undefined : (open.hint || "open 未返回 DEV:/CORE:；常见因 host 无活动 session-1 桌面或扫描浮窗未关挡住主窗——确认 session-1 活动后重试(headless scan/flash 正常≠GUI 可驱动)") });
        if (!open.ok || !(open.cores || []).length) return fail();

        const cap = await ilaCapture(exec, {
          fla: args.fla ?? 0,
          user: u,
          trigger: args.trigger || { mode: "immediate" },
          capture: args.capture || null,
          waitMs: args.waitMs || 1500,
          outDir: args.outDir || join(homedir(), "fpga-ila-captures"),
          title: args.title || "FLA capture",
          clock: args.clock || null,
          signalNames: args.signalNames || null,
          busAlias: args.busAlias || {},
        });
        stages.push({ stage: "capture", ok: cap.ok, hint: cap.ok ? undefined : cap.hint });
        if (!cap.ok) return fail({ consoleTail: cap.consoleTail });
        // teardown: result is exported, so free the cable + kill the GUI/server
        // (config in → waveform out → processes gone). Only on success — a failed
        // run leaves the GUI up for inspection; the next run's free_cable clears it.
        await killGui();
        stages.push({ stage: "teardown", ok: true });
        const result = {
          phase: "ila_flow",
          host: host || "local",
          ok: true,
          stages,
          cores: open.cores,
          summary: cap.summary,
          viewer: cap.viewerPath,
          data: cap.dataPath,
          hint: "全流程绿;导出后已自动 teardown(cable 已释放);viewer 给用户检查波形,summary 供 AI 分析(完整数据在 data json)",
        };
        if (args.knowledge) {
          try {
            const candidate = captureVerifiedResult({ toolName: "fpga_ila_flow", args: { ...args, host, sbit, expectIdcode }, result });
            if (candidate) result.knowledgeCandidate = candidate;
          } catch (error) {
            return toolError(`真机验证已通过但 candidate 写回失败: ${error.message}`, { phase: "knowledge_write", verification: result });
          }
        }
        return toolResult(result);
      } catch (err) {
        return toolError(`ila_flow 失败(stage=${stages.length}): ${err.message}`);
      } finally {
        try { await exec.close(); } catch {}
      }
    }
  );

  registerKnowledge(server);
}
