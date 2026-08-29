// Pango PDS knowledge retrieval tools over the committed corpus under
// ./knowledge/ (built offline by build-knowledge/*). Compact returns: a name
// lookup gives one primitive's ports/params/instTemplate; a query gives top
// matches; no args gives the category summary.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { toolError, toolResult } from "../../core/exec.mjs";
import { loadJson, scoreText, search, tokenize } from "../../core/knowledge.mjs";
import { fromVendorRel } from "./install.mjs";
import { embedQuery, isEmbedConfigured } from "../../core/embed.mjs";
import { loadVectors, topKByCosine } from "../../core/vectorstore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KN = resolve(HERE, "knowledge");

// The corpus stores vendor paths relative to the PDS install root so it is the
// same bytes on every machine. The host agent needs something it can actually
// Read, so join against the configured install here — and say so plainly when
// no PDS is configured, rather than handing back a path that silently fails.
const PDF_HINT_UNRESOLVED = "PDF 路径相对 PDS 安装根；未配置 PDS 安装(PANGO_MCP_PDS_2025 或 config.pdsInstalls[].shell)，无法给出绝对路径。";
function withAbsPath(doc) {
  const abs = fromVendorRel(doc.path);
  return abs ? { ...doc, path: abs } : { ...doc, path: doc.path, pathRelativeToPdsHome: true };
}

// Hybrid ranking: semantic (cosine over the opt-in embedded corpus) when a
// provider + vectors are available and the query embeds with the same model;
// otherwise zero-cost keyword scoring. Semantic is purely additive — any gap
// (no key, vectors not built, model mismatch, embed failure) falls back to
// keyword so results are never worse than before.
async function rankQuery(corpusName, items, query, { fields, idField, limit = 10, mode = "auto" }) {
  const keyword = (note) => ({ items: search(items, query, { fields, limit }), retrieval: "keyword", note });
  if (mode === "keyword") return keyword();
  if (!isEmbedConfigured()) return keyword(mode === "semantic" ? "未配置 embedding provider，已回退关键词" : undefined);
  const store = loadVectors(join(KN, "embeddings", `${corpusName}.vec.json`));
  if (!store) return keyword(mode === "semantic" ? "语义向量未构建(运行 knowledge:embed)，已回退关键词" : undefined);
  const q = await embedQuery(query);
  if (!q || q.model !== store.model) return keyword(mode === "semantic" ? "查询嵌入不可用或与语料模型不匹配，已回退关键词" : undefined);
  const ranked = topKByCosine(q.vec, store.items, limit);
  const byId = new Map(items.map((it) => [String(it[idField]), it]));
  const out = ranked.map((r) => byId.get(String(r.id))).filter(Boolean);
  return { items: out, retrieval: "semantic", model: store.model };
}

function snippet(text, qts, span = 240) {
  const lower = String(text).toLowerCase();
  let pos = -1;
  for (const q of qts) {
    const i = lower.indexOf(q);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return text.slice(0, span);
  const start = Math.max(0, pos - 60);
  return (start > 0 ? "…" : "") + text.slice(start, start + span) + (start + span < text.length ? "…" : "");
}

export function register(server) {
  server.registerTool(
    "fpga_primitive_lookup",
    {
      title: "Logos2 原语查询",
      description:
        "查 Logos2 原语库(gtp_lib.v, 153 个 GTP_* 原语)：name=精确查端口/参数/最小例化模板；category=列某类(clock_pll/ff_latch/lut/mem/io_buffer/serdes_ddr/mipi/pcie/analog/config_misc)；query=关键词召回；都不传=返回分类汇总。结构化、省 token。",
      inputSchema: {
        name: z.string().optional().describe("精确原语名，如 GTP_GPLL / GTP_LUT4 / GTP_DFF_RE"),
        category: z.string().optional().describe("按类列出，如 clock_pll / mem / io_buffer"),
        query: z.string().optional().describe("关键词/语义召回，如 'pll' / 'phase locked loop' / 'fifo'"),
        mode: z.enum(["auto", "keyword", "semantic"]).optional().describe("检索方式，默认 auto(有 embedding 则语义，否则关键词)"),
        limit: z.number().optional().describe("query/建议返回上限，默认 10"),
      },
    },
    async ({ name, category, query, mode = "auto", limit = 10 }) => {
      const index = loadJson(join(KN, "primitives.index.json"));
      if (!index) return toolError("原语索引未构建；先运行 build-knowledge/build-primitives.mjs");
      if (name) {
        const recPath = join(KN, "primitives", `${String(name).toUpperCase()}.json`);
        const rec = existsSync(recPath) ? loadJson(recPath) : null;
        if (!rec) {
          const suggestions = search(index.primitives, name, { fields: ["name", "category"], limit });
          return toolResult({ ok: false, phase: "primitive_lookup", note: `未找到精确原语 ${name}`, suggestions });
        }
        return toolResult({ ok: true, phase: "primitive_lookup", primitive: rec });
      }
      if (category) {
        const names = index.categories[category];
        if (!names) {
          return toolResult({ ok: false, phase: "primitive_lookup", note: `未知分类 ${category}`, categories: Object.keys(index.categories) });
        }
        return toolResult({ ok: true, phase: "primitive_lookup", category, count: names.length, names });
      }
      if (query) {
        const { items: matches, retrieval, note } = await rankQuery("primitives", index.primitives, query, { fields: ["name", "category"], idField: "name", limit, mode });
        return toolResult({ ok: true, phase: "primitive_lookup", query, retrieval, note, count: matches.length, matches });
      }
      return toolResult({
        ok: true,
        phase: "primitive_lookup",
        device: index.device,
        count: index.count,
        categories: Object.fromEntries(Object.entries(index.categories).map(([k, v]) => [k, v.length])),
        source: index.source,
      });
    }
  );

  server.registerTool(
    "fpga_ip_lookup",
    {
      title: "PDS IP 核查询",
      description:
        "查 PDS IP 目录(~65 核：PLL/RAM/DRM/FIFO/APM/DDR/Debug 等)：slug=精确返回该核 header/支持器件/参数(含 enum 选项)/数据手册 PDF 路径；query=关键词召回；category=按类(子串匹配，如 'PLL'/'Memory'/'DDR')；都不传=返回核清单汇总。每个核自带 datasheet PDF。",
      inputSchema: {
        slug: z.string().optional().describe("精确核 slug(来自 query/summary 结果)"),
        query: z.string().optional().describe("关键词/语义召回，如 'pll'/'fifo'/'clock divider'/'reset'"),
        category: z.string().optional().describe("分类子串过滤，如 'PLL'/'Memory'/'DDR'/'Debug'"),
        mode: z.enum(["auto", "keyword", "semantic"]).optional().describe("检索方式，默认 auto"),
        limit: z.number().optional().describe("query 返回上限，默认 10"),
        maxParams: z.number().optional().describe("slug 返回的参数上限(控 token)，默认 60"),
      },
    },
    async ({ slug, query, category, mode = "auto", limit = 10, maxParams = 60 }) => {
      const index = loadJson(join(KN, "ip.index.json"));
      if (!index) return toolError("IP 索引未构建；先运行 build-knowledge/build-ip.mjs");
      if (slug) {
        const recPath = join(KN, "ip", `${slug}.json`);
        const rec = existsSync(recPath) ? loadJson(recPath) : null;
        if (!rec) {
          const suggestions = search(index.cores, slug, { fields: ["slug", "displayName", "name"], limit });
          return toolResult({ ok: false, phase: "ip_lookup", note: `未找到核 ${slug}`, suggestions });
        }
        const params = Array.isArray(rec.params) ? rec.params : [];
        const trimmed = params.length > maxParams;
        // datasheet is stored install-root-relative; hand back an openable path.
        const datasheet = fromVendorRel(rec.datasheet) || rec.datasheet;
        return toolResult({
          ok: true,
          phase: "ip_lookup",
          core: { ...rec, datasheet, params: params.slice(0, maxParams), paramCount: params.length, paramsTruncated: trimmed || undefined },
          hint: trimmed ? `参数过多(${params.length})，已截断到 ${maxParams}；完整配置见 datasheet 或 maxParams 调大。` : undefined,
        });
      }
      if (category) {
        const cores = index.cores.filter((c) => String(c.category || "").toLowerCase().includes(category.toLowerCase()));
        return toolResult({ ok: true, phase: "ip_lookup", category, count: cores.length, cores });
      }
      if (query) {
        const { items: matches, retrieval, note } = await rankQuery("ip", index.cores, query, { fields: ["name", "displayName", "category", "topModule", "slug"], idField: "slug", limit, mode });
        return toolResult({ ok: true, phase: "ip_lookup", query, retrieval, note, count: matches.length, matches });
      }
      return toolResult({ ok: true, phase: "ip_lookup", count: index.count, source: index.source, cores: index.cores });
    }
  );

  server.registerTool(
    "fpga_doc_search",
    {
      title: "PDS 文档检索",
      description:
        "检索 PDS 文档层：(1)已抽取的蒸馏文本 chunk(Tcl/编译流程/扫链烧录/ILA 调试，直接可用)；(2)21 份 PDS 手册 + 62 份 IP 数据手册注册表(返回 PDF 路径，宿主 agent 可直接 Read 该 PDF)。query 关键词召回；kind 限定 all/chunk/manual/datasheet；不传 query 返回手册清单。无 embedding、零额外成本。",
      inputSchema: {
        query: z.string().optional().describe("关键词/语义，如 'cfg_program'/'capture waveform over jtag'/'Place-0084'/'timing'"),
        kind: z.enum(["all", "chunk", "manual", "datasheet"]).optional().describe("检索范围，默认 all"),
        mode: z.enum(["auto", "keyword", "semantic"]).optional().describe("chunk 检索方式，默认 auto"),
        limit: z.number().optional().describe("每类返回上限，默认 8"),
      },
    },
    async ({ query, kind = "all", mode = "auto", limit = 8 }) => {
      const index = loadJson(join(KN, "docs.index.json"));
      if (!index) return toolError("doc 索引未构建；先运行 build-knowledge/build-docs.mjs");
      if (!query) {
        const manuals = index.docs.filter((d) => d.kind === "manual").map((d) => withAbsPath({ title: d.title, tool: d.tool, ug: d.ug, path: d.path }));
        return toolResult({
          ok: true,
          phase: "doc_search",
          manualCount: index.manualCount,
          datasheetCount: index.datasheetCount,
          chunkCount: index.chunkCount,
          manuals,
          hint: manuals.some((m) => m.pathRelativeToPdsHome) ? PDF_HINT_UNRESOLVED : undefined,
        });
      }
      const qts = tokenize(query);
      const out = {};
      if (kind === "all" || kind === "chunk") {
        let semantic = null;
        if (mode !== "keyword") {
          if (!isEmbedConfigured()) {
            // Consistent with primitive/ip rankQuery: explicit semantic requests
            // get a fallback note (auto stays quiet).
            if (mode === "semantic") out.note = "未配置 embedding provider，chunk 已回退关键词";
          } else {
            const store = loadVectors(join(KN, "embeddings", "docs.vec.json"));
            const q = store ? await embedQuery(query) : null;
            if (store && q && q.model === store.model) {
              // Over-fetch then re-rank with deprecation penalty so MCP-superseded
              // chunks (e.g. raw cdt_ins how-to vs the fpga_ila_* tools) sink to
              // the bottom even when their vector is a close match.
              const overK = Math.max(limit * 3, 12);
              const ranked = topKByCosine(q.vec, store.items, overK)
                .map((r) => {
                  const ch = loadJson(join(KN, "doc-chunks", `${r.id}.json`));
                  if (!ch) return null;
                  const dep = !!ch.deprecated;
                  return { rawScore: r.score, score: r.score * (dep ? 0.3 : 1), id: r.id, source: ch.source, title: ch.title, deprecated: dep || undefined, snippet: snippet(ch.text, qts) };
                })
                .filter(Boolean)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
              semantic = ranked.map((r) => ({ score: Number(r.score.toFixed(4)), id: r.id, source: r.source, title: r.title, deprecated: r.deprecated, snippet: r.snippet }));
            } else if (mode === "semantic") {
              out.note = "语义不可用(未构建向量或模型不匹配)，chunk 已回退关键词";
            }
          }
        }
        if (semantic) {
          out.chunks = semantic;
          out.retrieval = "semantic";
        } else {
          const scored = [];
          for (const m of index.chunks) {
            const ch = loadJson(join(KN, "doc-chunks", `${m.id}.json`));
            if (!ch) continue;
            const raw = scoreText(qts, ch.title) * 3 + scoreText(qts, ch.text);
            const dep = !!ch.deprecated;
            const score = raw * (dep ? 0.3 : 1);
            if (score > 0) scored.push({ score, id: m.id, source: ch.source, title: ch.title, deprecated: dep || undefined, snippet: snippet(ch.text, qts) });
          }
          out.chunks = scored.sort((a, b) => b.score - a.score).slice(0, limit);
          out.retrieval = "keyword";
        }
      }
      if (kind === "all" || kind === "manual" || kind === "datasheet") {
        const wantKind = kind === "datasheet" ? "ip_datasheet" : "manual";
        const pool = index.docs.filter((d) => (kind === "all" ? true : d.kind === wantKind)).map((d) => ({ ...d, _hay: `${d.title} ${d.tool || ""} ${d.ipSlug || ""} ${d.ug || ""}` }));
        out.docs = search(pool, query, { fields: ["_hay"], limit }).map((d) =>
          withAbsPath({ kind: d.kind, title: d.title, tool: d.tool, ug: d.ug, path: d.path, sizeKb: d.sizeKb })
        );
      }
      const unresolved = (out.docs || []).some((d) => d.pathRelativeToPdsHome);
      return toolResult({
        ok: true,
        phase: "doc_search",
        query,
        ...out,
        hint: `manual/datasheet 给 PDF 路径(可直接 Read)；chunk 为已抽取文本，直接可用。${unresolved ? ` ${PDF_HINT_UNRESOLVED}` : ""}`,
      });
    }
  );
}
