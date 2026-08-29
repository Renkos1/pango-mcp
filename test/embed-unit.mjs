// Deterministic unit test for the vector math behind the semantic layer.
// No API calls — verifies cosine + top-K ranking with hand-built vectors.
import { cosine, topKByCosine } from "../src/core/vectorstore.mjs";
import { embedConfig, isEmbedConfigured } from "../src/core/embed.mjs";

let fail = false;
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// cosine basics
if (!approx(cosine([1, 0], [1, 0]), 1)) (console.error("✗ cosine identical != 1"), (fail = true));
if (!approx(cosine([1, 0], [0, 1]), 0)) (console.error("✗ cosine orthogonal != 0"), (fail = true));
if (!approx(cosine([1, 1], [2, 2]), 1)) (console.error("✗ cosine colinear != 1"), (fail = true));
if (cosine([0, 0], [1, 1]) !== 0) (console.error("✗ cosine zero-vector != 0"), (fail = true));

// top-K ranks by similarity to the query
const items = [
  { id: "a", vec: [1, 0, 0] },
  { id: "b", vec: [0.9, 0.1, 0] },
  { id: "c", vec: [0, 1, 0] },
  { id: "d", vec: [0, 0, 1] },
];
const ranked = topKByCosine([1, 0, 0], items, 2);
if (ranked.length !== 2 || ranked[0].id !== "a" || ranked[1].id !== "b") {
  console.error("✗ topKByCosine 排序/截断错误", ranked);
  fail = true;
}
if (!(ranked[0].score >= ranked[1].score)) (console.error("✗ topK 分数未降序"), (fail = true));

// embed config must be absent-or-complete (no half-configured provider)
const cfg = embedConfig();
if (cfg && (!cfg.baseUrl || !cfg.model || !cfg.apiKey)) (console.error("✗ embedConfig 半配置", cfg), (fail = true));
if (isEmbedConfigured() !== !!cfg) (console.error("✗ isEmbedConfigured 与 embedConfig 不一致"), (fail = true));
console.log(`embed configured: ${isEmbedConfigured()}${cfg ? ` (model ${cfg.model})` : ""}`);

console.log(fail ? "EMBED-UNIT: FAIL" : "EMBED-UNIT: PASS（cosine/topK 向量数学 + 配置完整性）");
process.exit(fail ? 1 : 0);
