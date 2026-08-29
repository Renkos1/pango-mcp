// Backend-agnostic knowledge retrieval helpers over the shipped corpus
// (structured JSON + markdown chunks committed under each toolchain's
// knowledge/). Deterministic keyword/substring scoring — no embedding model,
// no recurring cost. A semantic layer can be added later as an enhancement.

import { readFileSync } from "node:fs";

export function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function tokenize(s) {
  return String(s || "").toLowerCase().match(/[a-z0-9_]+/g) || [];
}

// Count substring occurrences of each query token across the text.
export function scoreText(queryTokens, text) {
  const t = String(text || "").toLowerCase();
  let score = 0;
  for (const q of queryTokens) {
    if (!q) continue;
    const parts = t.split(q).length - 1;
    if (parts > 0) score += parts;
  }
  return score;
}

// Rank items by query against the given fields; returns the top-K items.
export function search(items, query, { fields = ["name"], limit = 10 } = {}) {
  const qts = tokenize(query);
  if (!qts.length) return items.slice(0, limit);
  return items
    .map((it) => ({ it, score: fields.reduce((s, f) => s + scoreText(qts, it[f]), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.it);
}
