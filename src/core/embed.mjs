// OpenAI-compatible embeddings client for the optional semantic retrieval
// layer. Cost-controlled by design: the corpus is embedded once at build time
// (knowledge:embed) and cached to disk; at query time only the single query is
// embedded (with an in-memory cache). If no provider is configured, every entry
// point returns null so callers fall back to zero-cost keyword retrieval.
//
// Config (env or pango-mcp.env), all PANGO_MCP_EMBED_* with OPENAI_* fallback:
//   PANGO_MCP_EMBED_BASE_URL  e.g. https://dashscope.aliyuncs.com/compatible-mode/v1
//   PANGO_MCP_EMBED_MODEL     e.g. text-embedding-v3 / text-embedding-3-small
//   PANGO_MCP_EMBED_API_KEY   provider key (falls back to OPENAI_API_KEY)
//   PANGO_MCP_EMBED_BATCH     inputs per request, default 10
//   PANGO_MCP_EMBED_DIM       optional requested dimension

import { toolEnv } from "./config.mjs";

export function embedConfig() {
  const env = toolEnv();
  const baseUrl = (env.PANGO_MCP_EMBED_BASE_URL || env.OPENAI_BASE_URL || "").replace(/\/+$/, "");
  const model = env.PANGO_MCP_EMBED_MODEL || "";
  const apiKey = env.PANGO_MCP_EMBED_API_KEY || env.OPENAI_API_KEY || "";
  if (!baseUrl || !model || !apiKey) return null;
  const batch = Math.max(1, Number(env.PANGO_MCP_EMBED_BATCH) || 10);
  const dim = env.PANGO_MCP_EMBED_DIM ? Number(env.PANGO_MCP_EMBED_DIM) : undefined;
  return { baseUrl, model, apiKey, batch, dim };
}

export function isEmbedConfigured() {
  return !!embedConfig();
}

async function embedBatch(cfg, inputs, { timeoutMs = 30000 } = {}) {
  const body = { model: cfg.model, input: inputs, encoding_format: "float" };
  if (cfg.dim) body.dimensions = cfg.dim;
  const res = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const data = json.data || [];
  const vecs = new Array(inputs.length);
  data.forEach((d, i) => {
    vecs[typeof d.index === "number" ? d.index : i] = d.embedding;
  });
  if (vecs.some((v) => !Array.isArray(v))) throw new Error("embeddings response missing vectors");
  return vecs;
}

// Embed an array of texts. Returns { model, dim, vectors } or null if unconfigured.
export async function embedTexts(texts, opts = {}) {
  const cfg = embedConfig();
  if (!cfg) return null;
  const vectors = [];
  for (let i = 0; i < texts.length; i += cfg.batch) {
    const chunk = texts.slice(i, i + cfg.batch);
    vectors.push(...(await embedBatch(cfg, chunk, opts)));
  }
  return { model: cfg.model, dim: vectors[0]?.length || cfg.dim || 0, vectors };
}

const queryCache = new Map();

// Embed a single query string, cached in-memory per (model, text).
// Returns { model, vec } or null if unconfigured. Never throws: on failure
// returns null so the caller falls back to keyword retrieval.
export async function embedQuery(text, opts = {}) {
  const cfg = embedConfig();
  if (!cfg) return null;
  const key = `${cfg.model}::${text}`;
  if (queryCache.has(key)) return queryCache.get(key);
  let out = null;
  try {
    const r = await embedTexts([text], opts);
    if (r?.vectors?.[0]) out = { model: cfg.model, vec: r.vectors[0] };
  } catch {
    out = null;
  }
  if (out) {
    queryCache.set(key, out);
    if (queryCache.size > 256) queryCache.delete(queryCache.keys().next().value);
  }
  return out;
}
