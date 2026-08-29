// ModelSim transcript parser. THE reason this exists: vsim/vlog return exit
// code 0 even when a run hits ** Fatal / a testbench $fatal. So, exactly like
// the PDS hook, `ok` is decided by parsing the transcript, not the exit code.
//
// vsim in -c mode echoes the transcript with a leading "# "; vlog/vcom do not.
// Both emit "** Error/Fatal/Warning" lines and a final "Errors: N, Warnings: N".

import { matchRules, splitLines } from "../../core/logparse.mjs";

const ERROR_LINE = /^\s*\*\*\s*(Error|Fatal|Failure)\b/i;
const WARNING_LINE = /^\s*\*\*\s*Warning\b/i;
const SUMMARY = /Errors:\s*(\d+),\s*Warnings:\s*(\d+)/i;

// Known-issue rules (compact diagnostics with fix hints). Kept small and
// high-signal; the long tail is left to the raw log.
export const MSIM_RULES = [
  {
    code: "msim-license",
    severity: "error",
    // Match both flavors: a missing license env yields "Unable to checkout a
    // license" / "Invalid license environment"; a node-lock host mismatch (e.g.
    // the license NIC's MAC changed) yields FlexLM "Invalid host".
    pattern: /Cannot find.*license|license.*(expired|server|checkout|denied)|MGLS_LICENSE|Failure to obtain a license|Invalid license environment|Unable to checkout a license|Invalid host\b/i,
    hint: "ModelSim license 问题：检查 LM_LICENSE_FILE / MGLS_LICENSE_FILE 指向有效 license；node-lock 'Invalid host' 多为 license 网卡 MAC 变动。",
  },
  {
    code: "msim-undefined-module",
    severity: "error",
    pattern: /Module '[^']+' is not defined|instantiation of '[^']+' failed|Cannot find.*\b(module|entity|design unit)\b/i,
    hint: "实例化了未编译/未定义的模块或实体：确认相关源文件已编入同一库且名字大小写匹配。",
  },
  {
    code: "msim-no-design-unit",
    severity: "error",
    pattern: /is not a design unit|Cannot find design unit|Error loading design/i,
    hint: "vsim 的 <lib>.<top> 不存在：确认 top 名与所在库（默认 work），以及编译已成功。",
  },
  {
    code: "msim-syntax",
    severity: "error",
    pattern: /near "[^"]*":\s*(syntax error|expecting)|Syntax error/i,
    hint: "语法错误：定位 ** Error 行的 file(line)，修正源。",
  },
  {
    code: "msim-unresolved",
    severity: "error",
    pattern: /No\s+\w+\s+found|Unresolved reference|undefined (variable|symbol)/i,
    hint: "未解析引用：检查 package/import、库映射与编译顺序。",
  },
  {
    // F13: vsim can't open the work library — typically running vsim from a
    // workdir that lacks the compiled lib (the lib is under ._fpga_msim/work),
    // so it needs `vmap work <path>`. Real: "(vsim-19) Failed to access library
    // 'work' at \"work\"."
    code: "msim-lib-access",
    severity: "error",
    pattern: /Failed to access library\b/i,
    hint: "vsim 找不到库（多为从构建目录外跑、未 vmap）：vmap work <编译输出>/work 或在编译目录跑 vsim。",
  },
  {
    // Gate-level / timing sim can't find the SDF passed via -sdfmin/-sdfmax/-sdftyp.
    // Real: "(vsim-SDF-3196) Failed to find SDF file \"...\"."
    code: "msim-sdf",
    severity: "error",
    pattern: /Failed to find SDF file|\(vsim-SDF-\d+\)/i,
    hint: "门级仿真找不到 SDF：核对 -sdfmin/-sdfmax/-sdftyp 的路径与 region 前缀（/=path）。",
  },
];

// Parse ONE tool's output (a single vlog/vcom/vsim invocation). For a sim that
// has compile + run, parse each phase's own output separately so the per-phase
// "Errors: N" summary is unambiguous.
// Structure a ModelSim "** Error/Fatal/Warning ..." line into
// { severity, file, line, code, message }. Handles the common shapes:
//   ** Error: file(line): (vlog-2730) message
//   ** Error (suppressible): file(line): (vlog-XXXX) message
//   ** Error: (vsim-19) message                 (no file/line)
//   ** Error: file(line): near "x": syntax error (no parenthesized code)
export function parseMsimMessage(line) {
  const m = /^\s*\*\*\s*(Error|Fatal|Failure|Warning)\b(?:\s*\([^)]*\))?\s*:\s*(.*)$/i.exec(String(line));
  if (!m) return null;
  const severity = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  let rest = m[2];
  let file = null;
  let lineNo = null;
  let code = null;
  const fl = /^(.*?)\((\d+)\):\s*(.*)$/.exec(rest); // file(line):
  if (fl) {
    file = fl[1].trim();
    lineNo = Number(fl[2]);
    rest = fl[3];
  }
  const cd = /^\(([A-Za-z]+-\d+)\)\s*(.*)$/.exec(rest); // (vlog-2730)
  if (cd) {
    code = cd[1];
    rest = cd[2];
  }
  return { severity, file, line: lineNo, code, message: rest.trim() };
}

export function parseModelsimLog(text) {
  const errors = [];
  const warnings = [];
  let summary = null;
  for (const raw of splitLines(text)) {
    const line = raw.replace(/^#\s?/, "");
    if (ERROR_LINE.test(line)) errors.push(line.trim());
    else if (WARNING_LINE.test(line)) warnings.push(line.trim());
    const m = SUMMARY.exec(line);
    if (m) summary = { errors: Number(m[1]), warnings: Number(m[2]) };
  }
  const s = String(text || "");
  let diagnostics = matchRules(s, MSIM_RULES);
  // Defect-2 mutual exclusion: a corrupt/missing license makes vsim abort the
  // load, so the transcript shows the license error AND a downstream "Error
  // loading design" / "is not a design unit" — but the unit actually exists and
  // compiled fine. License is the root cause; drop the no-design-unit FALSE
  // positive when a license diagnostic is present so the AI fixes the license,
  // not a non-existent design-unit problem.
  if (diagnostics.some((d) => d.code === "msim-license")) {
    diagnostics = diagnostics.filter((d) => d.code !== "msim-no-design-unit");
  }
  return {
    summary,
    errors,
    errorsDetailed: errors.map(parseMsimMessage).filter(Boolean),
    warnings,
    errorCount: errors.length,
    warningCount: warnings.length,
    finished: /\$finish\b|End time:/i.test(s),
    fatal: /\*\*\s*(Fatal|Failure)\b/i.test(s),
    diagnostics,
  };
}

// ModelSim coverage-type label → stable key.
const COV_TYPES = {
  branches: "branch", branch: "branch",
  statements: "statement", statement: "statement",
  conditions: "condition", condition: "condition",
  toggles: "toggle", toggle: "toggle",
  expressions: "expression", expression: "expression",
  fsms: "fsm", fsm: "fsm", states: "fsm",
};

// Parse a ModelSim "coverage report -summary" (inline, has a Weight column) or
// "vcover report" (per-instance, no Weight column) table into structured
// per-type {bins,hits,misses,pct} plus the overall total. The coverage % is
// always the trailing NN.NN%, so the optional Weight column is tolerated.
// Returns null when no coverage table is present (don't fabricate one).
export function parseCoverageReport(text) {
  const metrics = {};
  let total = null;
  for (const raw of splitLines(text)) {
    const line = raw.replace(/^#\s?/, "").trim();
    const t = /Total\s+coverage[^:]*:\s*([\d.]+)\s*%/i.exec(line);
    if (t) { total = Number(t[1]); continue; }
    const m = /^([A-Za-z][A-Za-z ]*?)\s+(\d+)\s+(\d+)\s+(\d+)(?:\s+\d+)?\s+([\d.]+)\s*%$/.exec(line);
    if (!m) continue;
    const key = COV_TYPES[m[1].trim().toLowerCase()];
    if (!key) continue;
    metrics[key] = { bins: Number(m[2]), hits: Number(m[3]), misses: Number(m[4]), pct: Number(m[5]) };
  }
  if (total === null && !Object.keys(metrics).length) return null;
  return { total, metrics };
}

// Per-instance coverage from a `vcover report -details` (or `coverage report
// -details`): each "=== Instance: X" / "=== Design Unit: Y" block lists per-type
// rows like "Branches <bins> <hits> <misses> <pct>%". This locates WHICH module
// is under-covered (the actionable bit) instead of only the overall %.
export function parseCoverageByInstance(text) {
  const instances = [];
  let cur = null;
  for (const raw of splitLines(text)) {
    const inst = /^===\s*Instance:\s*(.+?)\s*$/.exec(raw);
    if (inst) {
      cur = { instance: inst[1].trim(), designUnit: null, types: {} };
      instances.push(cur);
      continue;
    }
    if (!cur) continue;
    const du = /^===\s*Design Unit:\s*(.+?)\s*$/.exec(raw);
    if (du) {
      cur.designUnit = du[1].trim();
      continue;
    }
    const row = /^\s*([A-Za-z]+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%/.exec(raw);
    if (row) {
      const key = COV_TYPES[row[1].toLowerCase()];
      if (key) cur.types[key] = { bins: Number(row[2]), hits: Number(row[3]), misses: Number(row[4]), pct: Number(row[5]) };
    }
  }
  return instances;
}

// Extract the actionable "uncovered" entries from a `vcover report -details`
// (or `coverage report -details`): the specific Count-0 source lines / branch
// arms / untoggled nodes that need a test — one level deeper than the per-type
// %. ModelSim flags zero counts in the Count column as `***0***`; a toggle node
// is uncovered only when NEITHER transition fired. Returns one
// { instance, type, item, count:0 } per miss, where:
//   instance = enclosing "=== Instance: X" (falls back to the nearest Design
//              Unit, then null, when the report has no instance header)
//   type     = COV_TYPES key from the "<Type> Details" section banner
//   item     = the report's own locator (trailing source label, else "line N";
//              for toggle, the node/bus name copied verbatim)
// No -details section -> [] (don't fabricate).
export function parseCoverageDetails(text) {
  const out = [];
  let curInstance = null;
  let curDesignUnit = null;
  let curType = null;
  let inDetails = false;
  for (const raw of splitLines(text)) {
    const inst = /^===\s*Instance:\s*(.+?)\s*$/.exec(raw);
    if (inst) { curInstance = inst[1].trim(); curDesignUnit = null; inDetails = false; continue; }
    const du = /^===\s*Design Unit:\s*(.+?)\s*$/.exec(raw);
    if (du) { curDesignUnit = du[1].trim(); inDetails = false; continue; }
    const banner = /={3,}\s*([A-Za-z][A-Za-z ]*?)\s+Details={3,}/.exec(raw);
    if (banner) { curType = COV_TYPES[banner[1].trim().toLowerCase()] || null; inDetails = true; continue; }
    // A "<Type> Coverage:" summary header ends the previous details block. The
    // detail sub-header reads "<Type> Coverage for instance ..." (no colon), so
    // the trailing-colon anchor distinguishes them.
    if (/^[A-Za-z][A-Za-z ]*Coverage:\s*$/.test(raw)) { inDetails = false; continue; }
    if (!inDetails || !curType) continue;
    const instance = curInstance ?? curDesignUnit ?? null;
    if (curType === "toggle") {
      // <node> <1H->0L> <0L->1H> <coverage%> — uncovered iff both counts are 0.
      const t = /^\s*(\S+)\s+(\d+)\s+(\d+)\s+[\d.]+\s*$/.exec(raw);
      if (t && Number(t[2]) === 0 && Number(t[3]) === 0) {
        out.push({ instance, type: curType, item: t[1], count: 0 });
      }
      continue;
    }
    // Count-column detail (branch/statement/condition/expression/fsm): a row
    // whose Count cell is the `***0***` zero marker. Locator = trailing source
    // label if present, else "line <N>" from the leading Line column.
    const z = /^(.*?)\*\*\*0\*\*\*\s*(.*?)\s*$/.exec(raw);
    if (z) {
      const source = z[2].trim();
      const lead = /^\s*(\d+)/.exec(z[1]);
      const item = source || (lead ? `line ${lead[1]}` : "(unknown)");
      out.push({ instance, type: curType, item, count: 0 });
    }
  }
  return out;
}

// Parse a UVM run's "UVM Report Summary" counts. A failing UVM test prints
// "UVM_ERROR :  N" / "UVM_FATAL :  N" yet ModelSim still reports "Errors: 0", so
// these counts must feed the ok decision. Only the summary lines (UVM_X : N)
// are counted — inline messages ("UVM_ERROR file(line) @ t: ...") are ignored.
// Returns null when no UVM summary is present.
export function parseUvmReport(text) {
  const counts = {};
  for (const raw of splitLines(text)) {
    const line = raw.replace(/^#\s?/, "").trim();
    const m = /^UVM_(INFO|WARNING|ERROR|FATAL)\s*:\s*(\d+)$/.exec(line);
    if (m) counts[m[1].toLowerCase()] = Number(m[2]);
  }
  if (!Object.keys(counts).length) return null;
  return { info: counts.info ?? 0, warning: counts.warning ?? 0, error: counts.error ?? 0, fatal: counts.fatal ?? 0 };
}

// ok decision for a transcript, exit code ONLY as a tiebreaker when the log
// carries no signal at all. Prefer the explicit "Errors: N" summary; fall back
// to counted ** Error/Fatal lines.
export function judgeModelsimOk(parsed, { exitCode, timedOut } = {}) {
  if (timedOut) return false;
  if (parsed.fatal) return false;
  if (parsed.summary) return parsed.summary.errors === 0;
  if (parsed.errorCount > 0) return false;
  // No parseable signal: trust the exit code as a last resort.
  return exitCode === undefined || exitCode === 0;
}

// Compact, high-signal lines for the summary payload (token economy).
export function modelsimKeyLines(text, max = 14) {
  return splitLines(text)
    .map((l) => l.replace(/^#\s?/, "").trim())
    .filter((l) => /\$finish|\$stop|\*\*\s*(Note|Error|Fatal|Failure|Warning)|Errors:\s*\d+|Top level modules|^-- (Compiling|Loading)|^UVM_(ERROR|FATAL)\b/i.test(l))
    .slice(0, max);
}
