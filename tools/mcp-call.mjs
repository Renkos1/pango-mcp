// Independent acceptance driver: spawn the real MCP server over stdio, call ONE
// tool with JSON args from argv, print the full raw JSON response. No assertions
// here on purpose — the verifier reads the raw output and cross-checks itself.
//
//   node tools/mcp-call.mjs <toolName> '<jsonArgs>'
//   node tools/mcp-call.mjs --list           # list tool names + input schemas
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const serverPath = join(pkg, "src", "index.mjs");

const client = new Client({ name: "verify", version: "0.0.0" });
// Pass our env through to the server child (the SDK's default stdio env is a
// filtered safe-set and would drop test overrides like PANGO_MCP_EMBED_MODEL).
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: { ...process.env } }));

const arg = process.argv[2];
if (arg === "--list") {
  const tools = await client.listTools();
  for (const t of tools.tools) {
    console.log(`\n### ${t.name}`);
    console.log("schema:", JSON.stringify(t.inputSchema));
  }
  await client.close();
  process.exit(0);
}

const name = arg;
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
// PDS builds are minutes-level; the SDK client default request timeout is 60s.
// Raise it (and reset-on-progress) so long pds_shell runs are not aborted
// client-side. FPGA_VERIFY_TIMEOUT can force a SHORT timeout to prove that
// server progress notifications reset it (build must still complete).
const callTimeout = Number(process.env.FPGA_VERIFY_TIMEOUT) || 1800000;
const res = await client.callTool({ name, arguments: args }, undefined, {
  timeout: callTimeout,
  resetTimeoutOnProgress: true,
  maxTotalTimeout: 1800000,
  onprogress: (p) => console.error(`[progress] ${p.progress} ${p.message || ""}`),
});
const out = { isError: !!res.isError, content: res.content };
// Tool responses are JSON text inside content[0].text; surface both the parsed
// object (pretty) and the isError flag so guard/negative cases are visible.
let parsed = null;
try {
  parsed = JSON.parse(res.content[0].text);
} catch {}
console.log("=== isError:", !!res.isError, "===");
if (parsed) console.log(JSON.stringify(parsed, null, 2));
else console.log(JSON.stringify(out, null, 2));
await client.close();
process.exit(0);
