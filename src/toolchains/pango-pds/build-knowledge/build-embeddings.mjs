// Offline builder: embed the structured corpus (primitives / IP / doc chunks)
// once and cache vectors under knowledge/embeddings/. Opt-in and provider-
// configured — needs PANGO_MCP_EMBED_* (see core/embed.mjs). Re-run after
// knowledge:build or when changing the embedding model. Run:
//   node src/toolchains/pango-pds/build-knowledge/build-embeddings.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embedConfig, embedTexts } from "../../../core/embed.mjs";
import { saveVectors } from "../../../core/vectorstore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KN = resolve(HERE, "..", "knowledge");
const EMB = join(KN, "embeddings");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Build [{id, text}] item lists per corpus from the committed structured data.
function primitiveItems() {
  const index = readJson(join(KN, "primitives.index.json"));
  return index.primitives.map((p) => {
    const rec = readJson(join(KN, "primitives", `${p.name}.json`));
    const ports = rec.ports.map((x) => x.name).join(" ");
    const params = rec.params.map((x) => x.name).join(" ");
    return { id: p.name, text: `${p.name} ${p.category} primitive. ports: ${ports}. params: ${params}` };
  });
}

function ipItems() {
  const index = readJson(join(KN, "ip.index.json"));
  return index.cores.map((c) => {
    const rec = readJson(join(KN, "ip", `${c.slug}.json`));
    const params = rec.params.slice(0, 40).map((x) => x.name).join(" ");
    return { id: c.slug, text: `${c.displayName} ${c.name} IP core. category ${c.category}. top ${c.topModule}. params: ${params}` };
  });
}

function docItems() {
  const index = readJson(join(KN, "docs.index.json"));
  return index.chunks.map((m) => {
    const ch = readJson(join(KN, "doc-chunks", `${m.id}.json`));
    return { id: m.id, text: `${ch.title}\n${ch.text}`.slice(0, 4000) };
  });
}

async function buildCorpus(name, items, model) {
  const r = await embedTexts(items.map((it) => it.text));
  const store = {
    model,
    dim: r.dim,
    builtAt: new Date().toISOString(),
    items: items.map((it, i) => ({ id: it.id, vec: r.vectors[i] })),
  };
  const path = saveVectors(join(EMB, `${name}.vec.json`), store);
  console.log(`  ${name}: ${items.length} items, dim ${r.dim} -> ${path}`);
}

async function main() {
  const cfg = embedConfig();
  if (!cfg) {
    console.error(
      "未配置 embedding provider，跳过语义层（关键词检索仍可用）。\n" +
        "需要时在 pango-mcp.env 配置：PANGO_MCP_EMBED_BASE_URL / PANGO_MCP_EMBED_MODEL / PANGO_MCP_EMBED_API_KEY。\n" +
        "例：DashScope -> BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1, MODEL=text-embedding-v3, API_KEY=$DASHSCOPE_API_KEY"
    );
    process.exit(2);
  }
  if (!existsSync(join(KN, "primitives.index.json"))) {
    console.error("语料未构建；先运行 knowledge:build。");
    process.exit(1);
  }
  console.log(`embedding corpus with model ${cfg.model} (batch ${cfg.batch})...`);
  await buildCorpus("primitives", primitiveItems(), cfg.model);
  await buildCorpus("ip", ipItems(), cfg.model);
  await buildCorpus("docs", docItems(), cfg.model);
  console.log("done. semantic layer ready (auto-used by fpga_*_lookup / fpga_doc_search).");
}

main().catch((err) => {
  console.error(`embedding 构建失败: ${err.message}`);
  process.exit(1);
});
