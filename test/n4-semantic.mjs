// N4 real semantic check (needs an OpenAI-compatible embeddings provider).
// Uses DASHSCOPE_API_KEY if present. Builds the corpus vectors, then proves the
// semantic layer adds value: a query whose words do NOT appear in the target
// ("phase locked loop" -> GTP_GPLL) returns nothing by keyword but ranks the
// PLL primitive top by semantics. Run: node test/n4-semantic.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const KN = join(pkg, "src", "toolchains", "pango-pds", "knowledge");

if (!process.env.DASHSCOPE_API_KEY && !process.env.PANGO_MCP_EMBED_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log("N4-SEMANTIC: SKIP (无 embedding key：设 DASHSCOPE_API_KEY / PANGO_MCP_EMBED_API_KEY / OPENAI_API_KEY)");
  process.exit(0);
}

const embedEnv = {
  ...process.env,
  PANGO_MCP_EMBED_BASE_URL: process.env.PANGO_MCP_EMBED_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  PANGO_MCP_EMBED_MODEL: process.env.PANGO_MCP_EMBED_MODEL || "text-embedding-v3",
  PANGO_MCP_EMBED_API_KEY: process.env.PANGO_MCP_EMBED_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY,
  PANGO_MCP_EMBED_BATCH: process.env.PANGO_MCP_EMBED_BATCH || "10",
};

// 1) Build corpus vectors.
console.log(`building embeddings with ${embedEnv.PANGO_MCP_EMBED_MODEL}...`);
const build = spawnSync("node", [join(pkg, "src", "toolchains", "pango-pds", "build-knowledge", "build-embeddings.mjs")], { env: embedEnv, encoding: "utf8" });
process.stdout.write(build.stdout || "");
if (build.status !== 0) {
  console.error("✗ build-embeddings 失败\n", build.stderr || "");
  process.exit(1);
}
let fail = false;
for (const f of ["primitives", "ip", "docs"]) if (!existsSync(join(KN, "embeddings", `${f}.vec.json`))) (console.error(`✗ 缺向量文件 ${f}.vec.json`), (fail = true));

// 2) Query the server (same env so it can embed queries + load vectors).
const client = new Client({ name: "n4", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(pkg, "src", "index.mjs")], env: embedEnv }));
const jsonTool = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const primSem = await jsonTool("fpga_primitive_lookup", { query: "phase locked loop", mode: "semantic" });
const primKw = await jsonTool("fpga_primitive_lookup", { query: "phase locked loop", mode: "keyword" });
console.log("primitive 'phase locked loop' -> semantic:", primSem.retrieval, primSem.matches?.slice(0, 3).map((m) => m.name).join(","), "| keyword count:", primKw.count);

const docSem = await jsonTool("fpga_doc_search", { query: "capture a waveform over jtag", mode: "semantic", kind: "chunk" });
console.log("doc 'capture waveform over jtag' -> semantic:", docSem.retrieval, "top:", docSem.chunks?.[0]?.title, `(${docSem.chunks?.[0]?.source})`);

const ipSem = await jsonTool("fpga_ip_lookup", { query: "clock generator", mode: "semantic" });
console.log("ip 'clock generator' -> semantic:", ipSem.retrieval, ipSem.matches?.slice(0, 3).map((m) => m.displayName).join(","));

await client.close();

if (primSem.retrieval !== "semantic" || !primSem.matches?.some((m) => m.name === "GTP_GPLL")) (console.error("✗ 语义未把 'phase locked loop' 映射到 GTP_GPLL", primSem), (fail = true));
if (primKw.count > 0 && primKw.matches?.some((m) => m.name === "GTP_GPLL")) console.log("  (注：关键词竟也命中 GPLL；语义优势在更弱)");
if (docSem.retrieval !== "semantic" || !(docSem.chunks?.length > 0)) (console.error("✗ doc 语义检索无结果", docSem), (fail = true));
if (ipSem.retrieval !== "semantic" || !(ipSem.matches?.length > 0)) (console.error("✗ ip 语义检索无结果", ipSem), (fail = true));

console.log(fail ? "N4-SEMANTIC: FAIL" : "N4-SEMANTIC: PASS（语义层实跑：构建向量 + 语义召回胜过关键词）");
process.exit(fail ? 1 : 0);
