// Run a PowerShell snippet on a configured remote host and print output.
//   node tools/remote/ps.mjs <hostId> '<powershell>'
//   PANGO_MCP_HOST=<hostId> node tools/remote/ps.mjs '<powershell>'
// Host id comes from argv or PANGO_MCP_HOST — no baked-in default. A default
// host id here would be a specific machine on the author's LAN, and a
// mistyped call would silently target it.
import { getExecutor } from "../../src/core/executor.mjs";

const args = process.argv.slice(2);
const host = args.length > 1 ? args[0] : process.env.PANGO_MCP_HOST;
const ps = args.length > 1 ? args[1] : args[0];
if (!host) throw new Error("host id required: pass it as the first argument or set PANGO_MCP_HOST (see pango-mcp.config.example.json hosts{})");
const ex = getExecutor(host);
const b64 = Buffer.from(ps, "utf16le").toString("base64");
const r = await ex.exec(`powershell -NoProfile -EncodedCommand ${b64}`, { timeoutSec: 90 });
console.log(r.stdout.replace(/\r/g, ""));
if (r.stderr && r.stderr.trim() && !/CLIXML/.test(r.stderr)) console.error("[stderr] " + r.stderr.slice(0, 300));
await ex.close();
process.exit(0);
