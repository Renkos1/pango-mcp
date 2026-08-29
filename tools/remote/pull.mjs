// Pull a remote file to a local path from a configured remote host.
//   node tools/remote/pull.mjs <remotePath> <localPath> [hostId]
// Host id comes from argv or PANGO_MCP_HOST — no baked-in default. A default
// host id here would be a specific machine on the author's LAN, and a
// mistyped call would silently target it.
import { getExecutor } from "../../src/core/executor.mjs";

const [remotePath, localPath, hostArg] = process.argv.slice(2);
const host = hostArg || process.env.PANGO_MCP_HOST;
if (!host) throw new Error("host id required: pass it as the third argument or set PANGO_MCP_HOST");
const ex = getExecutor(host);
await ex._get(remotePath, localPath);
console.log(`pulled ${host}:${remotePath} -> ${localPath}`);
await ex.close();
process.exit(0);
