// ModelSim knowledge retrieval: the command reference (from docs/cmd_help/*.txt)
// plus the manual-PDF registry (docs/pdfdocs/*.pdf). The corpus is built offline
// by build-knowledge/build-commands.mjs into ./knowledge/commands.index.json and
// committed. Retrieval is zero-cost keyword scoring (core/knowledge); manual PDF
// paths are resolved against the live install so the corpus stays portable.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { toolError, toolResult } from "../../core/exec.mjs";
import { loadJson, scoreText, search, tokenize } from "../../core/knowledge.mjs";
import { MODELSIM } from "./install.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KN = resolve(HERE, "knowledge");

// Parse a ModelSim cmd_help .txt — a sequence of Tcl-list entries
// `cmd {description} {arguments}` — into [{command, description, arguments}].
// Brace groups are balanced (descriptions/args may span lines and nest braces,
// e.g. `run`'s usage); leading #-comment lines and blank lines are skipped.
export function parseCmdHelp(text) {
  const s = String(text || "");
  const n = s.length;
  const out = [];
  let i = 0;
  const isWs = (c) => c === " " || c === "\t" || c === "\r" || c === "\n";
  const skipWs = () => { while (i < n && isWs(s[i])) i++; };
  const skipCommentsAndWs = () => {
    for (;;) {
      skipWs();
      if (i < n && s[i] === "#") { while (i < n && s[i] !== "\n") i++; continue; }
      break;
    }
  };
  const readBrace = () => {
    let depth = 0;
    const start = i;
    for (; i < n; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") { depth--; if (depth === 0) { const inner = s.slice(start + 1, i); i++; return inner; } }
    }
    return s.slice(start + 1); // unbalanced: take the rest
  };
  const norm = (x) => x.trim().replace(/\s+/g, " ");
  while (i < n) {
    skipCommentsAndWs();
    if (i >= n) break;
    if (s[i] === "{") { readBrace(); continue; } // stray group, no command word
    let w = "";
    while (i < n && !isWs(s[i])) { w += s[i]; i++; }
    if (!w) break;
    skipWs();
    let description = "";
    let args = "";
    if (i < n && s[i] === "{") description = readBrace();
    skipWs();
    if (i < n && s[i] === "{") args = readBrace();
    out.push({ command: w, description: norm(description), arguments: norm(args) });
  }
  return out;
}

// Resolve a manual's absolute PDF path against the live install (the corpus
// stores only the filename so it survives install relocation / modelsimHome).
function manualPath(file) {
  return join(MODELSIM.home, "docs", "pdfdocs", file);
}

export function register(server) {
  server.registerTool(
    "fpga_msim_doc_search",
    {
      title: "ModelSim 文档/命令检索",
      description:
        "检索 ModelSim 命令参考(来自 docs/cmd_help/*.txt 的结构化语料：command/description/arguments)+ 手册 PDF 注册表(docs/pdfdocs/*.pdf，返回路径供宿主直接 Read)。command=精确命令(vsim/vlog/coverage/run/examine/force/vcd...)返回 description+arguments；query=关键词召回；kind=all/command/manual；不传 query 返回汇总(命令数+手册清单)。纯关键词、零额外成本。命令的完整 syntax 用 fpga_msim_exe <tool> -help 拿。",
      inputSchema: {
        command: z.string().optional().describe("精确命令名，如 vsim/vlog/coverage/run/examine/force/vcd"),
        query: z.string().optional().describe("关键词召回，如 'coverage save'/'force signal'/'dump vcd'/'breakpoint'"),
        kind: z.enum(["all", "command", "manual"]).optional().describe("检索范围，默认 all"),
        limit: z.number().optional().describe("query 返回上限，默认 10"),
      },
    },
    async ({ command, query, kind = "all", limit = 10 }) => {
      const corpus = loadJson(join(KN, "commands.index.json"));
      if (!corpus) return toolError("ModelSim 命令语料未构建。该语料派生自 Siemens 产品文档，按 EULA 不随包分发，需用你自己的授权安装生成一次：\n  pnpm knowledge:build:msim\n（读取 <modelsimHome>/docs/cmd_help；产物只落本机，已被 .gitignore 排除。）");
      if (command) {
        const rec = corpus.commands.find((c) => c.command.toLowerCase() === String(command).toLowerCase());
        if (!rec) {
          const suggestions = search(corpus.commands, command, { fields: ["command", "description"], limit });
          return toolResult({ ok: false, phase: "msim_doc_search", note: `未找到精确命令 ${command}`, suggestions });
        }
        return toolResult({ ok: true, phase: "msim_doc_search", command: rec });
      }
      if (!query) {
        return toolResult({
          ok: true,
          phase: "msim_doc_search",
          commandCount: corpus.commands.length,
          manualCount: corpus.manuals.length,
          manuals: corpus.manuals.map((m) => ({ title: m.title, path: manualPath(m.file), sizeKb: m.sizeKb })),
          source: corpus.source,
        });
      }
      const out = { ok: true, phase: "msim_doc_search", query };
      if (kind === "all" || kind === "command") {
        // Weight the command name heavily so a name query (the common case) wins
        // over common words ("the"/"simulation") that recur in long descriptions.
        const qts = tokenize(query);
        out.commands = corpus.commands
          .map((c) => ({ c, score: scoreText(qts, c.command) * 5 + scoreText(qts, c.description) + scoreText(qts, c.arguments) }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((x) => x.c);
      }
      if (kind === "all" || kind === "manual") {
        out.manuals = search(corpus.manuals, query, { fields: ["title"], limit }).map((m) => ({ title: m.title, path: manualPath(m.file), sizeKb: m.sizeKb }));
      }
      out.hint = "command 给结构化用法；manual 给 PDF 路径(可直接 Read)；命令完整 syntax 用 fpga_msim_exe <tool> -help。";
      return toolResult(out);
    }
  );
}
