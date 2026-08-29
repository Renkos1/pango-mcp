// Push a local file or directory to a configured remote host.
//   node tools/remote/push.mjs <localPath> <remotePath> [hostId]
// Host id comes from argv or PANGO_MCP_HOST — no baked-in default. A default
// host id here would be a specific machine on the author's LAN, and a
// mistyped call would silently target it.
import { statSync } from "node:fs";
import { getExecutor } from "../../src/core/executor.mjs";

const [localPath, remotePath, hostArg] = process.argv.slice(2);
const host = hostArg || process.env.PANGO_MCP_HOST;
if (!host) throw new Error("host id required: pass it as the third argument or set PANGO_MCP_HOST");
const ex = getExecutor(host);
if (statSync(localPath).isDirectory()) {
  const n = await ex.putDir(localPath, remotePath);
  console.log(`pushed dir (${n} files) -> ${host}:${remotePath}`);
} else {
  await ex.putFile(localPath, remotePath);
  console.log(`pushed -> ${host}:${remotePath}`);
}
await ex.close();
process.exit(0);
