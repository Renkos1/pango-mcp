// Pango PDS toolchain — log/timing/report parsing + build-artifact helpers.
// pds_shell exits 0 even on stage errors, so these extractors (E:/W:, the
// bitstream success line, timing, utilization) are the real success oracle.

import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { findFiles, nowStamp, safeReadText, unique } from "../../core/exec.mjs";
import { BUILD_DIRS } from "./install.mjs";
import { parseUtilization, highUtilization } from "./diagnostics.mjs";
import { parsePdsProject } from "./project.mjs";
import { parseRtr } from "./timing.mjs";
import { parsePower } from "./power.mjs";

function isHistoricalPdsPath(path) {
  return /[\\/](_pds_build_bak_[^\\/]+|\.pango-mcp|logbackup|bak)[\\/]/i.test(path || "");
}

function liveFiles(root, predicate, opts) {
  return findFiles(root, (file, name) => !isHistoricalPdsPath(file) && predicate(file, name), opts);
}

// Structure a PDS "E:/W:/C: <Code>: [<file>(line number: N)] <message>" line into
// { severity, code, file, line, message }. code/file/line are null when absent
// (license/flow errors carry no source location).
export function parsePdsError(line) {
  const m = /^\s*([EWC]):\s*(.*)$/i.exec(String(line));
  if (!m) return null;
  const severity = m[1].toUpperCase();
  let rest = m[2];
  let code = null;
  let file = null;
  let lineNo = null;
  const cd = /^([A-Za-z][A-Za-z0-9]*-\d+):\s*(.*)$/.exec(rest); // Code:
  if (cd) {
    code = cd[1];
    rest = cd[2];
  }
  const fl = /^\[(.+?)\(line number:\s*(\d+)\)\]\s*(.*)$/.exec(rest); // [file(line number: N)]
  if (fl) {
    file = fl[1].trim();
    lineNo = Number(fl[2]);
    rest = fl[3];
  }
  return { severity, code, file, line: lineNo, message: rest.trim() };
}

export function parsePdsLog(log) {
  const text = log || "";
  const lines = text.split(/\r?\n/);
  const errors = lines.filter((l) => /^\s*E:/i.test(l));
  const warnings = lines.filter((l) => /^\s*W:/i.test(l));
  // C: = caution lines (e.g. "C: Bitstream-2001: SCBV has not been set ... based
  // on PCB board") — board-relevant, but pds_shell tags them C: (not E:/W:), so
  // they were being dropped entirely.
  const cautions = lines.filter((l) => /^\s*C:/i.test(l));
  const success = /The bitstream file is\s+"([^"]+\.sbit)"/i.exec(text);
  return {
    errors,
    errorsDetailed: errors.map(parsePdsError).filter(Boolean),
    warnings,
    cautions,
    bitstreamFromLog: success ? success[1] : null,
    hasBitstreamSuccess: !!success,
  };
}

// pds_shell can generate a bitstream and exit 0 even when post-PnR timing has
// failing endpoints. Keep stage-report parsing separate from the build verdict,
// then apply this policy only to targets that promise an authoritative timing
// report. Earlier targets must not be failed by a stale report left on disk.
export function evaluatePdsRunSuccess({
  exitCode,
  errors = [],
  encrypted = false,
  runTarget,
  bitstreamSuccess = false,
  sbitPresent = false,
  timing = null,
}) {
  const wantsBitstream = runTarget === "gen_bit_stream";
  const timingTarget = runTarget === "report_timing" || wantsBitstream;
  const negativeSetup = Number.isFinite(timing?.worst) && timing.worst < 0;
  const negativeHold = Number.isFinite(timing?.worstHoldSlack) && timing.worstHoldSlack < 0;
  const failingEndpoints = Number.isFinite(timing?.failingEndpoints) && timing.failingEndpoints > 0;
  const timingFailed = timingTarget && (timing?.met === false || negativeSetup || negativeHold || failingEndpoints);
  const timingUnknown = timingTarget && timing?.met !== true && !timingFailed;
  const ok =
    exitCode === 0 &&
    errors.length === 0 &&
    !encrypted &&
    !timingFailed &&
    !timingUnknown &&
    (!wantsBitstream || (bitstreamSuccess && sbitPresent));
  return { ok, timingFailed, timingUnknown, timingTarget, wantsBitstream };
}

export function parseTimingText(text) {
  const margins = [];
  const totals = [];
  for (const match of text.matchAll(/\b(WNS|WHS|WPWS|Slack)\s*[=:]?\s*(-?\d+(?:\.\d+)?)/gi)) margins.push(Number(match[2]));
  for (const match of text.matchAll(/\b(TNS|THS|TPWS)\s*[=:]?\s*(-?\d+(?:\.\d+)?)/gi)) totals.push(Number(match[2]));
  for (const match of text.matchAll(/\bSlack\s*\((MET|VIOLATED|FAILED)\)\s*(-?\d+(?:\.\d+)?)/gi)) margins.push(Number(match[2]));
  for (const match of text.matchAll(/\bW[HN]S\(ns\)\s+T[HN]S\(ns\)[\s\S]{0,300}?\n\s+\S+\s+\S+\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/gi)) {
    margins.push(Number(match[1]));
    totals.push(Number(match[2]));
  }
  const values = [...margins, ...totals];
  const negative = values.filter((n) => Number.isFinite(n) && n < 0);
  const summary = /Design Summary\s*:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim() || null;
  const explicitMet = /All Constraints Met/i.test(summary || "") || /\bSlack\s*\(MET\)/i.test(text);
  const explicitViolated = !!(summary && !/All Constraints Met/i.test(summary)) || /\bSlack\s*\((VIOLATED|FAILED)\)/i.test(text);
  return {
    values,
    margins,
    totals,
    met: explicitViolated ? false : values.length ? negative.length === 0 : explicitMet ? true : null,
    worst: margins.length ? Math.min(...margins) : values.length ? Math.min(...values) : null,
    slackStatus: /\bSlack\s*\((MET|VIOLATED|FAILED)\)/i.exec(text)?.[1]?.toUpperCase() || null,
  };
}

function boolFromMet(met) {
  return met === true ? true : met === false ? false : null;
}

const countFrom = (text, pattern) => {
  const match = pattern.exec(String(text || ""));
  return match ? Number(match[1]) : null;
};

// PDS reports clock coverage and external I/O delay coverage as separate timing
// checks. Do not collapse Timing-4086/4087 (an input/output delay is absent) into
// "create_clock is missing": asynchronous or board-level I/O can legitimately
// have no external delay while all internal clocks and four-corner paths are
// fully constrained.
export function parseTimingConstraintCoverage({ log = "", checkTimingText = "", checkTimingFile = null } = {}) {
  const summary = String(checkTimingText || "");
  const clockCount = countFrom(summary, /There are\s+(\d+)\s+clock pins with no clock driven/i);
  const inputCount = countFrom(summary, /There are\s+(\d+)\s+input ports with no input delay specified/i);
  const outputCount = countFrom(summary, /There are\s+(\d+)\s+output ports with no output delay specified/i);
  const ports = [];
  const seen = new Set();
  for (const line of String(log || "").split(/\r?\n/)) {
    const match = /^\s*[EWC]:\s*(Timing-4086|Timing-4087):\s*Port\s+['"]([^'"]+)['"]\s+is not constrained,\s*it is treated as combinational\s+(input|output)\.?/i.exec(line);
    if (!match) continue;
    const item = { port: match[2], direction: match[3].toLowerCase(), code: match[1] };
    const key = `${item.direction}:${item.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      ports.push(item);
    }
  }
  const summaryIoCount = inputCount === null && outputCount === null ? null : (inputCount || 0) + (outputCount || 0);
  const explicitClockConstraintWarnings = unique(
    String(log || "")
      .split(/\r?\n/)
      .filter((line) => /^\s*[EWC]:/i.test(line) && /clock (?:net|pin).*need(?:s)? (?:a )?clock constraint/i.test(line) && /create_clock/i.test(line))
  );
  return {
    clockPinsWithoutClock: {
      count: clockCount,
      summaryFile: checkTimingFile,
      explicitWarnings: explicitClockConstraintWarnings,
    },
    portsWithoutIoDelay: {
      count: summaryIoCount === null ? ports.length : Math.max(summaryIoCount, ports.length),
      inputCount,
      outputCount,
      ports,
      summaryFile: checkTimingFile,
    },
  };
}

function makePdsReportHealth({ parsedLog, timing, needsClockConstraint, portsWithoutIoDelay, sbit, highUtilization }) {
  const warningCount = unique(parsedLog.warnings || []).length;
  const cautionCount = unique(parsedLog.cautions || []).length;
  const logOk = parsedLog.errors.length === 0;
  const timingOk = boolFromMet(timing?.met);
  const clockConstraintOk = needsClockConstraint ? false : timingOk === null ? null : true;
  const bitstreamPresent = !!sbit && existsSync(sbit);
  const issues = [];

  if (!logOk) {
    issues.push({
      severity: "error",
      code: "pds_log_errors",
      message: `${parsedLog.errors.length} PDS E: log error(s) were found.`,
    });
  }
  if (timingOk === false) {
    const summary = timing?.designSummary ? ` (${timing.designSummary})` : "";
    issues.push({
      severity: "error",
      code: "timing_not_met",
      message: `Timing report says constraints are not met${summary}.`,
    });
  }
  if (needsClockConstraint) {
    issues.push({
      severity: "error",
      code: "clock_constraint_missing",
      message: "PDS reported missing create_clock constraints; timing may be based on a nominal/default clock.",
    });
  }
  if (timingOk === null) {
    issues.push({
      severity: "info",
      code: "timing_unknown",
      message: "No authoritative timing verdict was found in collected reports.",
    });
  }
  if ((portsWithoutIoDelay?.count || 0) > 0) {
    issues.push({
      severity: "warning",
      code: "ports_without_io_delay",
      message: `${portsWithoutIoDelay.count} input/output port(s) have no external I/O delay; this is distinct from a missing clock constraint.`,
    });
  }
  if (warningCount || cautionCount) {
    issues.push({
      severity: "warning",
      code: "pds_warnings",
      message: `${warningCount} W: warning(s) and ${cautionCount} C: caution(s) were found.`,
    });
  }
  if ((highUtilization || []).length) {
    issues.push({
      severity: "warning",
      code: "high_utilization",
      message: `${highUtilization.length} resource class(es) are at or above the high-utilization threshold.`,
    });
  }

  const verdict =
    !logOk ? "errors"
    : timingOk === false ? "timing_failed"
    : needsClockConstraint ? "constraint_risk"
    : timingOk === null ? "unknown"
    : warningCount || cautionCount || (highUtilization || []).length ? "warnings"
    : "pass";
  const primary = issues.find((i) => i.severity === "error") || issues.find((i) => i.severity === "warning") || issues[0] || null;

  return {
    verdict,
    okMeaning: "ok means no collected PDS E: log lines; use health.verdict for overall report status.",
    logOk,
    timingOk,
    clockConstraintOk,
    bitstreamPresent,
    warningCount,
    cautionCount,
    issueCount: issues.length,
    issues,
    hint: primary?.message,
  };
}

export function collectPdsReports({ pdsPath, buildDir, logPath, log, top }) {
  const root = buildDir ? resolve(buildDir) : pdsPath ? dirname(resolve(pdsPath)) : null;
  const projectInfo = pdsPath && existsSync(pdsPath) ? parsePdsProject(resolve(pdsPath)) : null;
  const logs = [];
  if (log) logs.push({ path: null, text: log });
  if (logPath && existsSync(logPath)) logs.push({ path: resolve(logPath), text: safeReadText(logPath) });
  if (root && existsSync(root)) {
    for (const p of liveFiles(root, (file, name) => /\.(log|rpt|txt)$/i.test(name), { maxDepth: 3 })) {
      const text = safeReadText(p);
      if (/^\s*[EW]:/m.test(text) || /bitstream file is|Device Utilization|WNS|TNS/i.test(text)) logs.push({ path: p, text });
    }
  }

  const allLog = logs.map((l) => l.text).join("\n");
  const parsedLog = parsePdsLog(allLog);
  const bitstreams = [];
  if (parsedLog.bitstreamFromLog) {
    bitstreams.push(isAbsolute(parsedLog.bitstreamFromLog) ? parsedLog.bitstreamFromLog : root ? resolve(root, parsedLog.bitstreamFromLog) : parsedLog.bitstreamFromLog);
  }
  if (root && existsSync(root)) bitstreams.push(...liveFiles(root, (file, name) => /\.sbit$/i.test(name), { maxDepth: 4 }));

  const timingFiles =
    root && existsSync(root) ? liveFiles(root, (file, name) => /\.rtr$/i.test(name) || /timing.*\.(txt|rpt)$/i.test(name), { maxDepth: 6 }) : [];
  const timingSummaries = timingFiles.map((path) => ({ path, ...parseTimingText(safeReadText(path)) }));
  const timingValues = timingSummaries.flatMap((t) => t.values);
  const timingMargins = timingSummaries.flatMap((t) => t.margins || []);
  // R1: prefer the structured .rtr parse (per-clock Fmax, per-corner worst slack,
  // failing-endpoint counts, a real met verdict) over scraping WNS/TNS from text.
  // Pick the main report_timing .rtr (not the _exception one, not a bak/ copy).
  const mainRtr =
    timingFiles.find((p) => /\.rtr$/i.test(p) && !/_exception\.rtr$/i.test(p) && !/[\\/]bak[\\/]/i.test(p)) ||
    timingFiles.find((p) => /\.rtr$/i.test(p));
  const rtr = mainRtr ? parseRtr(safeReadText(mainRtr)) : null;
  const checkTimingFiles = root && existsSync(root)
    ? liveFiles(root, (file, name) => /(?:^|_)check_timing_summary\.db$/i.test(name), { maxDepth: 8 })
    : [];
  const mainCheckTiming =
    checkTimingFiles.find((p) => /[\\/]report_timing[\\/]report_db[\\/]check_timing_summary\.db$/i.test(p)) ||
    checkTimingFiles.find((p) => /[\\/]synthesize[\\/]report_db[\\/]synthesize_check_timing_summary\.db$/i.test(p)) ||
    checkTimingFiles[0] ||
    null;
  const constraintCoverage = parseTimingConstraintCoverage({
    log: allLog,
    checkTimingText: mainCheckTiming ? safeReadText(mainCheckTiming) : "",
    checkTimingFile: mainCheckTiming,
  });
  // F3: only definite no-clock evidence can downgrade an otherwise-green timing
  // verdict. A generic mention of create_clock or Timing-4086/4087 is not enough.
  const needsClockConstraint =
    Number(constraintCoverage.clockPinsWithoutClock.count) > 0 ||
    constraintCoverage.clockPinsWithoutClock.explicitWarnings.length > 0;
  const timingNote = !rtr
    ? undefined
    : needsClockConstraint
      ? "时钟未真正约束（PDS 报需 create_clock，按标称默认频率分析）：met 不代表满足目标频率；加 create_clock 后再看。"
      : !rtr.met && rtr.failingPaths.length
        ? `时序未收敛：${rtr.failingEndpoints} 个端点失败；最差路径 ${rtr.failingPaths[0].startpoint} → ${rtr.failingPaths[0].endpoint} 差 ${Math.abs(rtr.failingPaths[0].slack)}ns（${rtr.failingPaths[0].logicLevels} 级逻辑）。放宽 create_clock 周期，或缩短该路径组合逻辑/加流水级。`
        : undefined;
  const utilizationFiles =
    root && existsSync(root) ? liveFiles(root, (file, name) => /\.(prr|prt)$/i.test(name) || /util/i.test(name), { maxDepth: 4 }) : [];
  // R2: structured report_power (.ppr) — total/static/dynamic, per-rail and
  // per-module breakdown, plus a confidence flag so a default-activity estimate
  // is not mistaken for a trustworthy number.
  const pprFiles = root && existsSync(root) ? liveFiles(root, (file, name) => /\.ppr$/i.test(name), { maxDepth: 6 }) : [];
  const mainPpr = pprFiles.find((p) => !/[\\/]bak[\\/]/i.test(p)) || pprFiles[0] || null;
  const power = mainPpr ? parsePower(safeReadText(mainPpr)) : null;

  const util = parseUtilization(allLog);
  const highUtil = util ? highUtilization(util) : [];
  const sbit = unique(bitstreams).find((p) => existsSync(p)) || unique(bitstreams)[0] || null;
  const timing = rtr
    ? {
        met: rtr.met,
        worst: rtr.worstSetupSlack,
        worstSetupSlack: rtr.worstSetupSlack,
        worstHoldSlack: rtr.worstHoldSlack,
        failingEndpoints: rtr.failingEndpoints,
        failingPaths: rtr.failingPaths,
        clocksConstrained: rtr.clocksConstrained,
        clocks: rtr.clocks,
        performance: rtr.performance,
        checks: rtr.checks,
        clockPinsWithoutClock: constraintCoverage.clockPinsWithoutClock,
        portsWithoutIoDelay: constraintCoverage.portsWithoutIoDelay,
        designSummary: rtr.designSummary,
        rtrFile: mainRtr,
        note: timingNote,
        files: timingSummaries,
      }
    : {
        met: timingValues.length ? timingValues.every((n) => n >= 0) : null,
        worst: timingMargins.length ? Math.min(...timingMargins) : timingValues.length ? Math.min(...timingValues) : null,
        clockPinsWithoutClock: constraintCoverage.clockPinsWithoutClock,
        portsWithoutIoDelay: constraintCoverage.portsWithoutIoDelay,
        files: timingSummaries,
      };
  const health = makePdsReportHealth({
    parsedLog,
    timing,
    needsClockConstraint,
    portsWithoutIoDelay: constraintCoverage.portsWithoutIoDelay,
    sbit,
    highUtilization: highUtil,
  });

  return {
    ok: parsedLog.errors.length === 0,
    phase: "pds_reports",
    health,
    hint: health.verdict === "pass" ? undefined : health.hint,
    project: projectInfo
      ? {
          pdsPath: projectInfo.pdsPath,
          part: projectInfo.part,
          topSource: projectInfo.topSource,
        }
      : null,
    top: top || projectInfo?.topSource || null,
    // Dedupe: collectPdsReports concatenates several log files (build.log can be
    // listed twice + flow.log + per-stage run.logs), so the same E:/W: line
    // recurs. Unique by exact line — distinct messages (different file/line) stay.
    errors: unique(parsedLog.errors),
    errorsDetailed: unique(parsedLog.errors).map(parsePdsError).filter(Boolean),
    warnings: unique(parsedLog.warnings),
    cautions: unique(parsedLog.cautions || []),
    timing,
    // Pango writes the usage table into the build log, so parse it from the
    // collected log text; utilizationFiles is kept as a pointer list.
    utilization: util,
    // Additive (brief 003): resource classes near full (>=90%), the usual driver
    // of P&R difficulty / timing pressure. [] when no util table or none are hot.
    highUtilization: highUtil,
    power: power ? { ...power, pprFile: mainPpr } : null,
    reports: {
      logs: unique(logs.map((l) => l.path)),
      scannedLogs: unique(logs.map((l) => l.path)),
      timing: timingFiles,
      checkTiming: checkTimingFiles,
      utilization: utilizationFiles,
    },
    artifacts: {
      sbit,
    },
  };
}

export function moveBuildDirsAside(projectDir) {
  const moved = [];
  const existing = BUILD_DIRS.map((d) => join(projectDir, d)).filter((p) => existsSync(p));
  if (!existing.length) return moved;
  const backupRoot = join(projectDir, `_pds_build_bak_${nowStamp()}`);
  mkdirSync(backupRoot, { recursive: true });
  for (const p of existing) {
    const dst = join(backupRoot, basename(p));
    renameSync(p, dst);
    moved.push({ from: p, to: dst });
  }
  return moved;
}

export function sbitHasEncryptionMarker(sbitPath) {
  if (!sbitPath || !existsSync(sbitPath)) return false;
  const buf = readFileSync(sbitPath);
  const head = buf.subarray(0, Math.min(buf.length, 65536)).toString("latin1");
  return /effsoftecrypt/i.test(head);
}

export function resolvePdsLogBitstream(bitstreamFromLog, projectDir) {
  if (!bitstreamFromLog) return null;
  return isAbsolute(bitstreamFromLog) ? bitstreamFromLog : resolve(projectDir, bitstreamFromLog);
}
