// Tiny on-disk vector store: precomputed corpus vectors + cosine top-K. No
// external vector DB service — the corpora are small (hundreds of items) so a
// plain JSON file + in-process cosine is enough and has zero infra cost.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// items: [{ id, vec }]. Returns [{ id, score }] sorted desc, top-k.
export function topKByCosine(queryVec, items, k = 10) {
  return items
    .map((it) => ({ id: it.id, score: cosine(queryVec, it.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// store: { model, dim, builtAt, items:[{id, vec}] }
export function saveVectors(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), "utf8");
  return path;
}

export function loadVectors(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
