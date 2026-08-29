// test/static-gate.mjs — P0 静态可读性 gate (R0.5)。无 LLM、确定性、可进 CI。
// 对 MCP 工具面做 4 类静态检查；任一失败 → 非零退出。详见 docs/briefs/001-p0-static-gate.md。
//
// 用法:
//   node test/static-gate.mjs            # 真 gate：对当前代码必须 PASS（含 KNOWN_GAPS 豁免）
//   node test/static-gate.mjs --selftest # 元测试：对“坏 fixture”跑同一批检测器，证明断言真能变红
//
// 检查项:
//   1. listTools 每工具 description 非空；每个 inputSchema.properties 字段 description 非空。
//   2. 源里 `toolResult({ ok:false, ... })` 调用点邻域应带 `hint`（agent 自纠的可执行指引）。
//      —— 仅 scope 到 `toolResult(...)` 这一 brief 明确点名的“agent 收到的结构化结果”构造：
//      裸 `{ ok:false }` 对象字面量（assert.mjs 的逐断言 detail、modelsim 转换 helper 的内部返回）、
//      以及 `toolError(text)`（其 text 本身即报错指引）不在此 scope 内。
//   3. 引用真实性：源里引用的 `docs/<X>.md`（仓库根 docs/ 设计文档）须真实存在；
//      description/hint/catalog 文本里出现的 `fpga_*` 工具名须在 listTools 结果里。
//   4. CAPABILITY_CATALOG 与实际工具注册表须双向一致且无重复（catalog = registered）。
//
// 红线: 本任务只新增本文件（+package.json 一个脚本）。gate 抓到的源缺陷一律走 KNOWN_GAPS 豁免 +
//       reports/001.md DEBT 记账，绝不擅自改源（源不在本任务 Scope）。

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { CAPABILITY_CATALOG } from "../src/core/capabilities.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here); // packages/pango-mcp
const srcDir = join(pkgRoot, "src");
// 包内 docs：独立仓库 checkout 下该门必须仍然可跑（原先指向仓库根 docs/，抽取后必挂）。
const docsDir = join(pkgRoot, "docs");
const serverPath = join(srcDir, "index.mjs");

// ── KNOWN_GAPS：gate 对当前代码必须整体 PASS。下列为步骤 1/2 抓出的“真实源缺陷”，
//    逐条豁免（源不在本任务 Scope，交总控按 reports/001.md DEBT 排后续修复）。
//    步骤 3/4 当前无缺陷，故无豁免。

// 步骤 1：缺 .describe() 的工具入参（key = `tool.prop`，对行号漂移稳定）。
//   006 已补全 ila_build/ila_flow 的 10 个入参描述并撤豁免 → 此 gate 现强制所有入参有 description。
const KNOWN_GAPS_DESC = new Set([]);

// 步骤 2：`toolResult({ ok:false })` 调用点缺 `hint`（key = `relfile:line`）。
// 这些点多已用 `note`+`suggestions`/原始日志传达指引，只是未走 `hint` 约定 —— 轻度 DEBT。
// Keyed by CONTENT signature ("<relFile> :: <whitespace-collapsed toolResult span>"),
// NOT absolute line — line-based waivers shifted 4× this session (F-gate-brittle).
// Each is a deliberate ok:false whose guidance reaches the agent via
// note/suggestions/attached-log rather than a `hint` key. See reports/001.md DEBT.
const KNOWN_GAPS_HINT = new Set([
  'src/toolchains/modelsim/knowledge.mjs :: toolResult({ ok: false, phase: "msim_doc_search", note: `未找到精确命令 ${command}`, suggestions })',
  'src/toolchains/pango-pds/knowledge.mjs :: toolResult({ ok: false, phase: "primitive_lookup", note: `未找到精确原语 ${name}`, suggestions })',
  'src/toolchains/pango-pds/knowledge.mjs :: toolResult({ ok: false, phase: "primitive_lookup", note: `未知分类 ${category}`, categories: Object.keys(index.categories) })',
  'src/toolchains/pango-pds/knowledge.mjs :: toolResult({ ok: false, phase: "ip_lookup", note: `未找到核 ${slug}`, suggestions })',
  'src/toolchains/sim/index.mjs :: toolResult(attachLog({ ok: false, phase: "compile", source: "iverilog", exitCode: comp.code, artifacts }, (comp.stdout + comp.stderr).trim(), { detail }))',
  // ila_flow `fail()` now carries a literal hint — debt retired.
]);

// ── 工具：遍历 src 下所有 .mjs。
function walkMjs(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkMjs(p));
    else if (ent.name.endsWith(".mjs")) out.push(p);
  }
  return out;
}
function rel(p) {
  return relative(pkgRoot, p).split("\\").join("/");
}

// ── 检测器（纯函数，便于 --selftest 喂坏 fixture）。

// 步骤 1：返回违规 key 列表（`tool` 或 `tool.prop`）。
function detectEmptyDescriptions(tools) {
  const bad = [];
  for (const t of tools) {
    if (!t.description || !String(t.description).trim()) bad.push(t.name);
    const props = (t.inputSchema && t.inputSchema.properties) || {};
    for (const [k, v] of Object.entries(props)) {
      if (!v || !v.description || !String(v.description).trim()) bad.push(`${t.name}.${k}`);
    }
  }
  return bad;
}

// 步骤 4：目录必须完整覆盖注册表，也不能引用不存在的工具或跨 tier 重复。
function catalogToolNames(catalog) {
  const names = [];
  for (const tier of Object.values(catalog.tiers || {})) {
    for (const entry of tier) if (entry && entry.tool) names.push(entry.tool);
  }
  return names;
}
function detectCatalogDangling(catalog, registered) {
  return [...new Set(catalogToolNames(catalog))].filter((n) => !registered.has(n));
}
function detectCatalogMissing(catalog, registered) {
  const catalogued = new Set(catalogToolNames(catalog));
  return [...registered].filter((n) => !catalogued.has(n));
}
function detectCatalogDuplicates(catalog) {
  const seen = new Set();
  const duplicates = new Set();
  for (const name of catalogToolNames(catalog)) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates];
}

// 步骤 3a：源文本里引用的 docs/<X>.md（仓库根设计文档），返回不存在的悬挂引用。
//   只认 .md（cmd_help/pdfdocs 等是 ModelSim 安装相对目录，非仓库根设计文档，自然排除）。
const DOC_REF_RE = /docs\/[A-Za-z0-9_./\-一-鿿]+\.md/g;
function detectDocDangling(textByFile, docsRootDir) {
  const dangling = [];
  for (const [file, text] of textByFile) {
    for (const m of text.matchAll(DOC_REF_RE)) {
      const ref = m[0]; // e.g. docs/ILA-FINDINGS.md
      const abs = join(docsRootDir, ref.replace(/^docs\//, ""));
      if (!existsSync(abs)) dangling.push(`${file}: ${ref}`);
    }
  }
  return dangling;
}

// 步骤 3b：corpus 文本里出现的 fpga_* 工具名，返回未注册的悬挂引用。
//   只认“极大标识符”：前面不接 ._字母数字（排除 ._fpga_msim、__fpga_vcd_wrapper）。
//   再排除项目自有非工具命名空间（不是缺陷豁免，是词法事实）：
//     - 以 `_` 结尾 = 前缀/族标记（fpga_ila_*、fpga_s1_…），非单个工具名
//     - `fpga_mcp_*` = demo 工程名 / keep 线标识
//     - `fpga_vcd_wrapper` = 生成的 Verilog 包装模块
const TOOL_REF_RE = /(?<![._A-Za-z0-9])fpga_[a-z0-9_]+/g;
const NON_TOOL_EXACT = new Set(["fpga_vcd_wrapper"]);
function isToolRef(tok) {
  if (tok.endsWith("_")) return false;
  if (tok.startsWith("fpga_mcp_")) return false;
  if (NON_TOOL_EXACT.has(tok)) return false;
  return true;
}
function detectToolRefDangling(corpusText, registered) {
  const dangling = new Set();
  for (const m of corpusText.matchAll(TOOL_REF_RE)) {
    const tok = m[0];
    if (isToolRef(tok) && !registered.has(tok)) dangling.add(tok);
  }
  return [...dangling];
}

// 步骤 2：扫 `toolResult( ... )` 括号配平区间；含 ok:false 但区间内无 hint 的，记 `relfile:line`。
function detectMissingHint(srcText, relFile) {
  const hits = [];
  const re = /toolResult\s*\(/g;
  let m;
  while ((m = re.exec(srcText))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < srcText.length && depth > 0) {
      const c = srcText[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    const span = srcText.slice(m.index, i);
    if (/ok:\s*false/.test(span) && !/hint/i.test(span)) {
      // Key by CONTENT (whitespace-collapsed span), NOT absolute line — line
      // numbers shift whenever code above changes (F-gate-brittle bit this 4×).
      // The span text is stable across such shifts.
      const sig = span.replace(/\s+/g, " ").trim();
      hits.push(`${relFile} :: ${sig}`);
    }
  }
  return hits;
}

// ── --selftest：对坏 fixture 跑同一批检测器，每个必须变红（证明断言真能失败）。
function selftest() {
  const fails = [];
  const must = (name, cond) => {
    if (!cond) fails.push(name);
  };

  // 1: 空工具描述 + 空入参描述都应被抓。
  const d1 = detectEmptyDescriptions([
    { name: "bad_tool", description: "  ", inputSchema: { properties: {} } },
    { name: "ok_tool", description: "fine", inputSchema: { properties: { p: { description: "" } } } },
  ]);
  must("step1/empty-tool-desc", d1.includes("bad_tool"));
  must("step1/empty-prop-desc", d1.includes("ok_tool.p"));
  // 正例：齐全的不该被抓。
  must("step1/clean-noflag", detectEmptyDescriptions([{ name: "t", description: "x", inputSchema: { properties: { p: { description: "y" } } } }]).length === 0);

  // 2: ok:false 无 hint 应抓；有 hint 不该抓。
  must("step2/missing-hint", detectMissingHint('return toolResult({ ok: false, phase: "x" });', "f.mjs").length === 1);
  must("step2/has-hint-noflag", detectMissingHint('return toolResult({ ok: false, hint: "do y" });', "f.mjs").length === 0);
  must("step2/ok-true-noflag", detectMissingHint('return toolResult({ ok: true, x: 1 });', "f.mjs").length === 0);

  // 3a: 悬挂 docs/*.md 应抓；真实的不该抓。
  must("step3a/dangling-doc", detectDocDangling([["f.mjs", "见 docs/NOPE-NOT-REAL.md"]], docsDir).length === 1);
  // 3b: 未注册 fpga_* 应抓；前缀/命名空间/已注册不该抓。
  const reg = new Set(["fpga_env", "fpga_cdt"]);
  must("step3b/dangling-tool", detectToolRefDangling("用 fpga_does_not_exist 跑", reg).includes("fpga_does_not_exist"));
  must("step3b/registered-noflag", detectToolRefDangling("先 fpga_env 再 fpga_cdt", reg).length === 0);
  must("step3b/prefix-noflag", detectToolRefDangling("族 fpga_ila_* 与 ._fpga_msim 与 fpga_mcp_demo 与 fpga_vcd_wrapper", reg).length === 0);

  // 4: catalog 悬挂、漏项和重复都应抓。
  must("step4/dangling-catalog", detectCatalogDangling({ tiers: { t: [{ tool: "fpga_ghost" }] } }, new Set(["fpga_env"])).includes("fpga_ghost"));
  must("step4/registered-noflag", detectCatalogDangling({ tiers: { t: [{ tool: "fpga_env" }] } }, new Set(["fpga_env"])).length === 0);
  must("step4/missing-catalog", detectCatalogMissing({ tiers: { t: [{ tool: "fpga_env" }] } }, new Set(["fpga_env", "fpga_sim"])).includes("fpga_sim"));
  must("step4/duplicate-catalog", detectCatalogDuplicates({ tiers: { a: [{ tool: "fpga_env" }], b: [{ tool: "fpga_env" }] } }).includes("fpga_env"));
  must("step4/exact-noflag", detectCatalogMissing({ tiers: { t: [{ tool: "fpga_env" }] } }, new Set(["fpga_env"])).length === 0);

  if (fails.length) {
    console.error("SELFTEST FAILED — 这些检测器没能在坏 fixture 上变红:");
    for (const f of fails) console.error("  - " + f);
    process.exit(1);
  }
  console.log("SELFTEST PASS — 4 类检测器在坏 fixture 上均正确变红，正例不误报。");
  process.exit(0);
}

// ── 真 gate。
async function gate() {
  const client = new Client({ name: "static-gate", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: { ...process.env } }));
  const { tools } = await client.listTools();
  await client.close();

  const registered = new Set(tools.map((t) => t.name));
  const srcFiles = walkMjs(srcDir);
  const textByFile = srcFiles.map((p) => [rel(p), readFileSync(p, "utf8")]);

  const failures = [];
  const staleWaivers = [];

  // 步骤 1
  const emptyDesc = detectEmptyDescriptions(tools);
  for (const k of emptyDesc) if (!KNOWN_GAPS_DESC.has(k)) failures.push(`[step1] 缺 description: ${k}`);
  for (const k of KNOWN_GAPS_DESC) if (!emptyDesc.includes(k)) staleWaivers.push(`[step1] KNOWN_GAPS_DESC 已不存在: ${k}`);

  // 步骤 4
  for (const n of detectCatalogDangling(CAPABILITY_CATALOG, registered)) failures.push(`[step4] CAPABILITY_CATALOG 引用未注册工具: ${n}`);
  for (const n of detectCatalogMissing(CAPABILITY_CATALOG, registered)) failures.push(`[step4] CAPABILITY_CATALOG 漏掉已注册工具: ${n}`);
  for (const n of detectCatalogDuplicates(CAPABILITY_CATALOG)) failures.push(`[step4] CAPABILITY_CATALOG 重复列出工具: ${n}`);

  // 步骤 3a：docs/*.md 引用真实性
  for (const d of detectDocDangling(textByFile, docsDir)) failures.push(`[step3a] 悬挂 docs 引用: ${d}`);

  // 步骤 3b：corpus = 工具/入参 description + CAPABILITY_CATALOG + 源里 hint 字面量
  const hintLiterals = [];
  for (const [, text] of textByFile) {
    for (const m of text.matchAll(/\bhints?\s*:\s*(`[^`]*`|"[^"]*"|'[^']*')/g)) hintLiterals.push(m[1]);
  }
  const descText = tools
    .map((t) => `${t.description || ""} ${Object.values((t.inputSchema && t.inputSchema.properties) || {}).map((p) => (p && p.description) || "").join(" ")}`)
    .join("\n");
  const corpus = [descText, JSON.stringify(CAPABILITY_CATALOG), hintLiterals.join("\n")].join("\n");
  for (const tok of detectToolRefDangling(corpus, registered)) failures.push(`[step3b] 悬挂 fpga_* 工具引用: ${tok}`);

  // 步骤 2
  const missingHint = [];
  for (const [relFile, text] of textByFile) missingHint.push(...detectMissingHint(text, relFile));
  for (const k of missingHint) if (!KNOWN_GAPS_HINT.has(k)) failures.push(`[step2] toolResult ok:false 无 hint: ${k}`);
  for (const k of KNOWN_GAPS_HINT) if (!missingHint.includes(k)) staleWaivers.push(`[step2] KNOWN_GAPS_HINT 已不存在: ${k}`);

  // 报告
  for (const w of staleWaivers) console.warn("WARN " + w); // 陈旧豁免：非致命（缺陷可能已被修），仅提示清理
  if (failures.length) {
    console.error(`STATIC GATE FAILED — ${failures.length} 项:`);
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log(
    `STATIC GATE PASS — ${tools.length} 工具；` +
      `step1 豁免 ${KNOWN_GAPS_DESC.size}、step2 豁免 ${KNOWN_GAPS_HINT.size}（见 reports/001.md DEBT），其余全绿。`
  );
  process.exit(0);
}

if (process.argv.includes("--selftest")) selftest();
else gate();
