// Pango PDS build-log hook: turn a multi-MB pds_shell log into compact,
// actionable findings. Known-issue rules carry a `doc` pointer the N3 knowledge
// layer resolves to a manual/skill section.

import { splitLines } from "../../core/logparse.mjs";
import { safeReadText } from "../../core/exec.mjs";

// Error signature -> diagnosis/fix. `doc` is a stable knowledge pointer.
export const PDS_KNOWN_ISSUES = [
  {
    code: "place_0084_nonclock_io",
    severity: "error",
    pattern: /Place-0084/i,
    hint: "时钟进入非时钟能力 IO，P&R 失败且不出 bitstream。把时钟经 PLL(GTP_GPLL) CLKIN1→CLKOUT0 再驱动全局时钟。",
    doc: "pds-project-and-flow#place-0084-pll",
  },
  {
    code: "inserter_0005_stale_fic",
    severity: "error",
    pattern: /Inserter-0005/i,
    hint: ".fic 网名在 flatten 后找不到，会卡住 dev_map（pds_shell 仍退 0）。更新 .fic 网名或清空 wgt_my_fic_src。",
    doc: "debug-ila#fic-stale-net",
  },
  {
    // Real: "E: Inserter-0021: Net '<n>' which connected to Debug Core 0 Trigger
    // Port 0 Channel 0 cannot be found ..." — the .fic named a net that doesn't
    // exist post-flatten (seen twice in practice: 'u_cnt/q[0]' then 'q[0]').
    code: "inserter_0021_net_not_found",
    severity: "error",
    pattern: /Inserter-0021/i,
    hint: ".fic 抓取/时钟网名在 post-synth flatten 后不存在。改用综合后真实存在的网名：被抓信号用其 flatten 层次名（综合可能改名/优化掉裸内部信号——确认它没被优化）；时钟用显式全局缓冲输出（如 GTP_CLKBUFG 的 clk_g），别用裸端口名。先跑一次综合查真实网名再写 .fic。",
    doc: "debug-ila#inserter-net-name",
  },
  {
    // Pango's real signature is "E: Verilog-NNNN: ... is referenced to undefined
    // module." — match the phrasing, NOT a bare "Verilog-\d+:" (which also tags
    // benign I:/W: Verilog info lines as if they were this error).
    code: "verilog_undefined_module",
    severity: "error",
    pattern: /referenced to undefined module|undefined module/i,
    hint: "前端报未定义模块：两种修法——①该模块的源/IP 未加入 .pds 源列表，在 wgt_my_design_src 增加 (_file \"<rel>\" (_format verilog)...)；②是残留或拼错的例化，删掉或改正该例化。",
    doc: "pds-project-and-flow#add-source",
  },
  {
    code: "encrypted_sbit",
    severity: "error",
    // Matched against the FULL log: the marker is injected synthetically by the
    // caller (not emitted by pds_shell as an "E:" line), so it must bypass the
    // error-line scoping in pdsDiagnostics().
    fullText: true,
    pattern: /effsoftecrypt/i,
    hint: "sbit 头部含透明加密标记，烧录会是乱码。必须用 pds_shell(非 GUI) 从 shell 重新构建。",
    doc: "pds-flow#encryption-caveat",
  },
  {
    // The canonical failure code is Flow-0183. Do NOT match a bare "not/fail" —
    // the benign "The license will invalid in 28 days. In order not to affect
    // your usage ..." warning contains both "license" and "not" on one line.
    code: "flow_0183_license",
    severity: "error",
    pattern: /Flow-0183|license[^\r\n]*(checkout failed|check ?out fail|cannot (get|checkout)|can not (get|checkout)|not available|unavailable|expired)|无法获取.*许可|许可.*(失败|过期|无效)/i,
    hint: "PDS license 未就绪。设置 PANGO_LICENSE_FILE 指向有效 license。",
    doc: "pds-project-and-flow#license",
  },
  {
    // 综合/前端：Pango's real signature is "E: Verilog-NNNN: ... Syntax error
    // near <token>." (+ a following "E: Parsing ERROR."). Match the "Syntax
    // error" phrasing tied to a Verilog code — NOT a bare "Verilog-\d+:" (which
    // also tags benign I: analyzing-module / W: lines), and distinct from
    // verilog_undefined_module above (that one keys on "undefined module").
    code: "verilog_syntax_error",
    severity: "error",
    pattern: /Verilog-\d+:[^\r\n]*Syntax error|Syntax error near/i,
    hint: "前端 Verilog 语法错误（编译在综合前就停）。看 E: 行里的 (line number: N) 定位到 rtl 源那一行修语法——常见是漏分号、漏 end/endmodule、或例化端口写错。",
    doc: "pds-project-and-flow#verilog-syntax",
  },
  {
    // 约束/FDC：constraint reader could not apply a line. Real signatures:
    // "E: ConstraintEditor-0046: ... Failed to import constraint \"...\"." and
    // "E: CommandTiming-0057: ... command 'create_clock' is aborted." Match those
    // precise phrasings, not a bare "constraint" keyword (which appears in many
    // benign I:/W: lines like the constraint-check summary).
    code: "fdc_constraint_import_failed",
    severity: "error",
    pattern: /Failed to import constraint|Nothing matched for '[^']*', command '[^']*' is aborted/i,
    hint: "FDC 约束导入失败：约束引用了设计里不存在的对象（如 get_ports 指向不存在的端口名），整条约束被丢弃。核对 .fdc 里该行的端口/网名与 RTL 顶层端口一致，再重跑。",
    doc: "pds-project-and-flow#fdc-import",
  },
  {
    // 约束/IO：a constrained IO is missing the mandatory LOC/VCCIO/IOSTANDARD
    // trio. Real: "E: ConstraintEditor-0040: IO 'p:X' lacks attribute
    // PAP_IO_VCCIO, please specify both { LOC VCCIO IOSTANDARD } ...". Key on the
    // unquoted PAP_IO_(VCCIO|STANDARD|LOC) / the "please specify both" phrase —
    // NOT on bare "lacks attribute", which the benign "W: ... lacks attribute
    // 'PAP_IO_DRIVE', it's better to set" warning also contains.
    code: "fdc_io_attr_missing",
    severity: "error",
    pattern: /lacks attribute PAP_IO_(?:VCCIO|STANDARD|LOC)\b|please specify both \{ ?LOC VCCIO IOSTANDARD ?\}/i,
    hint: "该 IO 缺少必填属性三件套 LOC/VCCIO/IOSTANDARD。在 .fdc 里为这个端口补齐 define_attribute {p:<port>} {PAP_IO_LOC/PAP_IO_VCCIO/PAP_IO_STANDARD} {...}（DRIVE/SLEW 是可选项，缺了只告警不报错）。",
    doc: "pds-project-and-flow#io-loc-vccio-standard",
  },
  {
    // DRC/布局：a PAP_IO_LOC names a pad that does not exist on this package, so
    // placement is impossible. Real: "E: ConstraintEditor-0086: ... Package pin
    // 'ZZ999' is invalid to be placed at." Match the precise placement-validity
    // phrasing, not a bare "pin"/"LOC".
    code: "pin_loc_invalid",
    severity: "error",
    pattern: /Package pin '[^']*' is invalid to be placed at/i,
    hint: "PAP_IO_LOC 指定的封装引脚在当前 device/package 上不存在（或与所选封装不匹配）。核对 .fdc 的引脚号对得上工程选的 device/package 引脚表，改成真实存在的 pad。",
    doc: "pds-project-and-flow#pin-loc-invalid",
  },
];

// Warnings that are known-benign and should not alarm the agent.
export const BENIGN_WARNINGS = [
  /IPSpecCheck[\s\S]{0,80}?fifo[\s\S]{0,80}?WR_ADDR_WIDTH/i,
  // License-expiry nag — not a build problem.
  /license will (invalid|expire)/i,
  // Registers PDS optimizes away (expected for counters whose upper bits are
  // unused, e.g. blink's counter[..] dangling and cleaned).
  /is dangling and will be cleaned/i,
  // Ports with no external input/output delay -> treated as combinational. This
  // is distinct from a missing create_clock and must not downgrade clock timing.
  /is not constrained, it is treated as combinational/i,
];

// Ordered build-stage milestones; the furthest match = how far the flow got.
export const PDS_STAGE_MARKERS = [
  { stage: "compile", pattern: /Analyzing module|Elaborating module|Compiling/i },
  { stage: "synthesize", pattern: /Synthesiz|ADS synth|Running synthesis/i },
  { stage: "device_map", pattern: /Device\s*Map|dev_map|Mapping done|Mapping/i },
  { stage: "place", pattern: /Placement done|Placing/i },
  { stage: "route", pattern: /Routing done|Routing/i },
  { stage: "bitstream", pattern: /The bitstream file is/i },
];

export function pdsDiagnostics(log) {
  const text = String(log || "");
  // Error-severity rules fire only on lines pds_shell itself marked as errors
  // (E:), consistent with parsePdsLog's error definition. This stops benign
  // I:/W: lines that merely contain a trigger word from raising a false "error"
  // diagnosis on an otherwise-successful build. Rules flagged fullText (the
  // synthetic effsoftecrypt marker) still scan the whole text.
  const errorLines = splitLines(text)
    .filter((l) => /^\s*E:/i.test(l))
    .join("\n");
  const out = [];
  for (const rule of PDS_KNOWN_ISSUES) {
    const scope = rule.fullText ? text : errorLines;
    if (rule.pattern.test(scope)) {
      out.push({ code: rule.code, severity: rule.severity, hint: rule.hint, ...(rule.doc ? { doc: rule.doc } : {}) });
    }
  }
  return out;
}

// Classify warnings into benign vs real, keeping only a few samples.
export function summarizeWarnings(warnings = [], { samples = 8 } = {}) {
  const benign = [];
  const real = [];
  for (const w of warnings) {
    if (BENIGN_WARNINGS.some((re) => re.test(w))) benign.push(w);
    else real.push(w);
  }
  return {
    count: warnings.length,
    benignCount: benign.length,
    realCount: real.length,
    samples: real.slice(0, samples),
    // Deprioritized, not hidden: keep a few benign samples inspectable so a real
    // missing-constraint warning (e.g. an unconstrained output that mattered) is
    // never fully masked by classification.
    benignSamples: benign.slice(0, samples),
  };
}

// Best-effort "Device Utilization Summary" parse (FF/LUT/DRM/PLL/IO/DSP ...).
// pds_shell prints this in the build LOG (not in a prj_tasks report file) as a
// pipe-delimited table:
//   | FF                    | 29       | 319600        | 1            |
//   | + LUT as Logic        | 29       |               |              |   (sub-row: skipped, no totals)
// We parse the LAST such block (post-place = authoritative) and keep rows that
// carry both Used and Available counts. Falls back to a legacy "Name used/total
// (pct%)" form for older/other report shapes.
export function parseUtilization(text) {
  const s = String(text || "");
  // Use the FIRST summary block (the post-map flat table: FF/LUT/Distributed
  // RAM/.../GPLL/PPLL against device totals) — it's the most agent-readable.
  // Later blocks nest FF/LUT under CLMA/CLMS grids and read as 0 at top level.
  let region = s;
  const start = s.toLowerCase().indexOf("device utilization summary");
  if (start >= 0) {
    region = s.slice(start);
    const next = region.toLowerCase().indexOf("device utilization summary", 1);
    if (next > 0) region = region.slice(0, next);
  }
  const out = {};
  for (const m of region.matchAll(/^\s*\|\s*\+?\s*([A-Za-z][A-Za-z0-9_()/ .+-]*?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)?/gm)) {
    const name = m[1].trim().replace(/\s+/g, " ");
    out[name] = { used: Number(m[2]), total: Number(m[3]), pct: m[4] !== undefined ? Number(m[4]) : null };
  }
  if (Object.keys(out).length) return out;
  for (const m of s.matchAll(/^\s*([A-Za-z][A-Za-z0-9_\/ .-]*?)\s+(\d+)\s*\/\s*(\d+)\s*(?:\(?\s*([\d.]+)\s*%)?/gm)) {
    const name = m[1].trim();
    if (!/^(LUT|FF|Register|Flip|DRM|BRAM|DSP|GPLL|PLL|IO|MULT|ALU|APM|Slice|Carry|Latch)/i.test(name)) continue;
    out[name] = { used: Number(m[2]), total: Number(m[3]), pct: m[4] !== undefined ? Number(m[4]) : null };
  }
  return Object.keys(out).length ? out : null;
}

// Flag resource classes whose occupancy >= threshold — a lightweight, actionable
// hint about which resource is near-full (the usual driver of P&R difficulty and
// timing pressure). Operates on parseUtilization()'s output. When pct is null
// (table omitted the Utilization(%) value), it's derived from used/total*100.
// Rows without a usable total are skipped; result is sorted by occupancy desc.
export function highUtilization(util, threshold = 90) {
  const out = [];
  for (const [name, r] of Object.entries(util || {})) {
    if (!r || !Number.isFinite(r.total) || r.total <= 0) continue;
    const pct = r.pct == null ? (r.used / r.total) * 100 : r.pct;
    if (Number.isFinite(pct) && pct >= threshold) out.push({ name, used: r.used, total: r.total, pct });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

export function parseUtilizationFromFiles(paths = []) {
  for (const p of paths) {
    const util = parseUtilization(safeReadText(p));
    if (util) return { util, file: p };
  }
  return { util: null, file: null };
}
