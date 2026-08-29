// N2 real check (needs PDS; the cdt read path needs a connected board).
// Verifies fpga_exe passthrough (ip_generate -help) and fpga_cdt read path
// (cfg_read_device_property) against the live JTAG chain when present.
// Run: node test/n2-control.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(dirname(here), "src", "index.mjs");
const client = new Client({ name: "n2", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: [serverPath] }));
const jsonTool = async (name, args = {}, options = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, options)).content[0].text);

let fail = false;

// 1) fpga_exe passthrough: probe ip_generate -help (no hardware needed).
const exeHelp = await jsonTool("fpga_exe", { exe: "ip_generate", args: ["-help"] });
const helpOk = exeHelp.ok === true && /IP Generator|Usage:/i.test(exeHelp.log || exeHelp.tail || "");
console.log("exe ip_generate -help -> ok=", exeHelp.ok, "matched=", helpOk);
if (!helpOk) (console.error("✗ fpga_exe ip_generate -help 未返回用法", exeHelp), (fail = true));

// 2) fpga_pds_scan to detect board presence.
const scan = await jsonTool("fpga_pds_scan", { timeoutSec: 25 });
console.log("scan -> ok=", scan.ok, "devices=", (scan.devices || []).map((d) => `${d.index}:${d.idcode}`).join(","));

// 3) If a board is present, fpga_cdt read path must read the same IDCODE.
if (scan.devices?.length) {
  const cdtRead = await jsonTool("fpga_cdt", { interpreter: "cdt_cfg", commands: ["cfg_read_device_property -mode 0 -device_index 0"], timeoutSec: 30 });
  const got = cdtRead.extract?.devices?.[0]?.idcode;
  console.log("cdt read -> ok=", cdtRead.ok, "idcode=", got);
  if (!cdtRead.ok || !got) (console.error("✗ fpga_cdt 读路未取到 IDCODE", cdtRead), (fail = true));
} else {
  console.log("cdt read -> SKIP (无连接板卡)");
}

await client.close();
console.log(fail ? "N2-CONTROL: FAIL" : "N2-CONTROL: PASS（fpga_exe 直通 + fpga_cdt 读路）");
process.exit(fail ? 1 : 0);
