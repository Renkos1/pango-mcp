// Offline builder: parse the PDS IP catalog (ip/**/index.xml, ~65 cores) into a
// structured corpus under knowledge/ip/. Each core: header (name/version/
// category/top_module), supported devices/families, params, and the path to its
// own datasheet PDF. Run once at build time:
//   node src/toolchains/pango-pds/build-knowledge/build-ip.mjs [ipRoot]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVendorPath, toVendorRel } from "./pds-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "knowledge", "ip");
const IP_ROOT = resolveVendorPath({
  explicit: process.argv[2],
  envKey: "PANGO_MCP_IP_ROOT",
  sub: ["ip"],
  what: "PDS IP 目录",
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (name === "index.xml") out.push(p);
  }
  return out;
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
};

function parseParams(xml) {
  const params = [];
  for (const m of xml.matchAll(/<param>([\s\S]*?)<\/param>/gi)) {
    const blk = m[1];
    const name = tag(blk, "name");
    if (!name) continue;
    const items = [...blk.matchAll(/<item>([^<]*)<\/item>/gi)].map((x) => x[1].trim());
    params.push({ name, type: tag(blk, "type") || null, default: tag(blk, "default"), ...(items.length ? { items } : {}) });
  }
  return params;
}

function sanitize(s, i) {
  return (String(s || "ip").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_|_$/g, "") || "ip") + `_${i}`;
}

function main() {
  if (!existsSync(IP_ROOT)) {
    console.error(`IP 根目录不存在: ${IP_ROOT}\n用 argv[2] 或 PANGO_MCP_IP_ROOT 指定。`);
    process.exit(1);
  }
  const files = walk(IP_ROOT);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const catalog = [];
  files.forEach((file, i) => {
    const xml = readFileSync(file, "utf8");
    const header = /<header>([\s\S]*?)<\/header>/i.exec(xml)?.[1] || "";
    const ipDir = dirname(file);
    const datasheetRel = tag(header, "datasheet");
    const datasheet = datasheetRel ? resolve(ipDir, datasheetRel.replace(/\\/g, "/")) : null;
    const devices = [...new Set([...xml.matchAll(/<device\s+name="([^"]+)"/gi)].map((m) => m[1]))];
    const families = [...new Set([...xml.matchAll(/<family\s+name="([^"]+)"/gi)].map((m) => m[1]))];
    const params = parseParams(xml);
    const slug = sanitize(tag(header, "display_name") || tag(header, "top_module") || tag(header, "id"), i);
    const record = {
      slug,
      name: tag(header, "name"),
      displayName: tag(header, "display_name"),
      topModule: tag(header, "top_module"),
      version: tag(header, "version"),
      vendor: tag(header, "vendor"),
      category: tag(header, "category"),
      id: tag(header, "id"),
      dir: relative(IP_ROOT, ipDir).replace(/\\/g, "/"),
      datasheet: datasheet && existsSync(datasheet) ? toVendorRel(datasheet) : datasheetRel,
      families,
      devices,
      params,
    };
    writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(record, null, 2), "utf8");
    catalog.push({
      slug,
      name: record.name,
      displayName: record.displayName,
      category: record.category,
      version: record.version,
      topModule: record.topModule,
      paramCount: params.length,
      hasDatasheet: !!(datasheet && existsSync(datasheet)),
    });
  });

  const index = {
    generatedAt: new Date().toISOString(),
    source: toVendorRel(IP_ROOT),
    count: catalog.length,
    cores: catalog.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName))),
  };
  writeFileSync(resolve(OUT_DIR, "..", "ip.index.json"), JSON.stringify(index, null, 2), "utf8");
  console.log(`ip cores: ${catalog.length} -> ${OUT_DIR}`);
  console.log("with datasheet:", catalog.filter((c) => c.hasDatasheet).length);
}

main();
