// Offline builder: parse the Logos2 primitive library (gtp_lib.v, 153 modules)
// into a structured, LLM-friendly corpus committed under knowledge/primitives/.
// Run once at build time (not on the hot path):
//   node src/toolchains/pango-pds/build-knowledge/build-primitives.mjs [gtp_lib.v]
// Source path can be overridden by argv[2] or PANGO_MCP_GTP_LIB.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveVendorPath, toVendorRel } from "./pds-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "knowledge", "primitives");
const SRC = resolveVendorPath({
  explicit: process.argv[2],
  envKey: "PANGO_MCP_GTP_LIB",
  sub: ["arch", "vendor", "pango", "logos2", "common", "lib", "gtp_lib.v"],
  what: "Logos2 原语库 gtp_lib.v",
});

// Ordered category rules (specific before generic).
const CATEGORIES = [
  ["clock_pll", /GPLL|FPLL|PPLL|DLL|CLKBUF|CLKPD|CFGCLK|IOCLK|OSC/i],
  ["ff_latch", /^GTP_DFF|^GTP_DLATCH/i],
  ["lut", /^GTP_LUT|MUX2LUT/i],
  ["mem", /RAM|ROM|FIFO|DRM|KEYRAM/i],
  ["serdes_ddr", /DDR|SERDES|HSST|IDELAY|IODELAY|ISERDES|OSERDES/i],
  ["mipi", /MIPI/i],
  ["pcie", /PCIE/i],
  ["analog", /ADC|SENSOR|APM|DDC|RES_CAL/i],
  ["io_buffer", /BUF|VREF|HPIO/i],
  ["config_misc", /JTAG|GRS|START|UDID|EFUSE|SCANCHAIN|RES_CAL|INV|ONE|ZERO|HOLDDELAY/i],
];

function categorize(name) {
  for (const [cat, re] of CATEGORIES) if (re.test(name)) return cat;
  return "other";
}

// Return {inner, end} for the balanced parens starting at the '(' at openIdx.
function balanced(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

function parseParams(inner) {
  const params = [];
  for (const line of inner.split(/\r?\n/)) {
    const m = /parameter\b\s*(real|integer|signed)?\s*(\[[^\]]+\])?\s*([A-Za-z_]\w*)\s*=\s*(.+?)\s*,?\s*$/.exec(line);
    if (m) params.push({ name: m[3], type: m[1] || (m[2] ? `bitvec${m[2]}` : "string/int"), default: m[4].trim() });
  }
  return params;
}

function parsePorts(inner) {
  const ports = [];
  for (const line of inner.split(/\r?\n/)) {
    const m = /\b(input|output|inout)\b\s*(?:reg|wire)?\s*(\[[^\]]+\])?\s*([A-Za-z_]\w*)\s*,?\s*$/.exec(line);
    if (!m) continue;
    const range = m[2] || null;
    let width = 1;
    if (range) {
      const r = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(range);
      width = r ? Math.abs(Number(r[1]) - Number(r[2])) + 1 : range;
    }
    ports.push({ name: m[3], dir: m[1], width, ...(range ? { range } : {}) });
  }
  return ports;
}

function instTemplate(name, params, ports) {
  const paramLine = params.length ? `\n#(\n${params.map((p) => `    .${p.name}(${p.default})`).join(",\n")}\n)` : "";
  const portLine = ports.map((p) => `    .${p.name}(${p.name})`).join(",\n");
  return `${name}${paramLine} u_${name.toLowerCase()} (\n${portLine}\n);`;
}

function main() {
  if (!existsSync(SRC)) {
    console.error(`gtp_lib.v 不存在: ${SRC}\n用 argv[2] 或 PANGO_MCP_GTP_LIB 指定路径。`);
    process.exit(1);
  }
  const text = readFileSync(SRC, "utf8");
  const blocks = [...text.matchAll(/^module\s+([A-Za-z_]\w*)([\s\S]*?)^endmodule/gm)];
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const primitives = [];
  const byCategory = {};
  for (const b of blocks) {
    const name = b[1];
    const body = b[2];
    let params = [];
    let portsInner = body;
    const hashIdx = body.indexOf("#(");
    if (hashIdx >= 0) {
      const pBlk = balanced(body, hashIdx + 1);
      if (pBlk) {
        params = parseParams(pBlk.inner);
        portsInner = body.slice(pBlk.end + 1);
      }
    }
    const portOpen = portsInner.indexOf("(");
    let ports = [];
    if (portOpen >= 0) {
      const portBlk = balanced(portsInner, portOpen);
      if (portBlk) ports = parsePorts(portBlk.inner);
    }
    const category = categorize(name);
    const record = { name, category, params, ports, instTemplate: instTemplate(name, params, ports) };
    writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(record, null, 2), "utf8");
    primitives.push({ name, category, portCount: ports.length, paramCount: params.length });
    (byCategory[category] ||= []).push(name);
  }

  const index = {
    generatedAt: new Date().toISOString(),
    source: toVendorRel(SRC),
    device: "Logos2",
    count: primitives.length,
    categories: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.sort()])),
    primitives: primitives.sort((a, b) => a.name.localeCompare(b.name)),
  };
  writeFileSync(resolve(OUT_DIR, "..", "primitives.index.json"), JSON.stringify(index, null, 2), "utf8");
  console.log(`primitives: ${primitives.length} modules -> ${OUT_DIR}`);
  console.log("by category:", Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])));
}

main();
