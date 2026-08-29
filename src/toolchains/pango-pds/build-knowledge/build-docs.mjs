// Offline builder: a doc layer for "completely mastering PDS", cost-controlled.
//  (1) Registry of every PDS manual (doc/*.pdf, mapped to its tool) + each IP's
//      datasheet, so an agent finds the exact PDF path and reads it on demand
//      (host agents read PDFs natively — no embedding model, no recurring cost).
//  (2) Searchable extracted-text chunks from the distilled skill references
//      (the high-value Tcl/flow/ILA knowledge), shipped with the corpus.
// Run once at build time:
//   node src/toolchains/pango-pds/build-knowledge/build-docs.mjs [docRoot]

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromVendorRel, resolveVendorPath, toVendorRel } from "./pds-root.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KN = resolve(HERE, "..", "knowledge");
const CHUNK_DIR = join(KN, "doc-chunks");
// Package-local: the skill is shipped with the server, so a clean clone can
// regenerate the chunk corpus without any path outside the package.
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..", "..");
const SKILL_DIR = join(PACKAGE_ROOT, "skills", "pds-flow");
const DOC_ROOT = resolveVendorPath({
  explicit: process.argv[2],
  envKey: "PANGO_MCP_DOC_ROOT",
  sub: ["doc"],
  what: "PDS 手册目录",
});

// UG number -> the tool/exe the manual drives (so "how do I drive X" finds it).
const UG_TOOL = {
  "990001": "pds (quick start)",
  "990002": "pds",
  "990003": "simulation",
  "990004": "tcl (cdt_cfg/cdt_dbg/pds_shell)",
  "990101": "ads language",
  "990102": "ads synthesis",
  "990201": "block editor",
  "990202": "design workspace (dw)",
  "990203": "ip_compiler / ip_generate",
  "990205": "ip_compiler (developer)",
  "990301": "ppc (power calculator)",
  "990302": "ppp (power planner)",
  "990303": "ssn analyzer",
  "990304": "ssn estimator",
  "990401": "cdt_cfg (fabric configuration)",
  "990402": "cdt_dbg (fabric debugger)",
  "990403": "cdt_ins (fabric inserter)",
  "990404": "cdt_bts (bitstream tool)",
  "990405": "rf_analyzer",
  "061003": "public programmable module",
  "070010": "gtp (titan3 serdes)",
};

function titleFromPdf(file) {
  const m = /^UG(\d+)_(.+)\.pdf$/i.exec(file);
  if (!m) return { title: file.replace(/\.pdf$/i, ""), ug: null };
  return { title: m[2].replace(/_/g, " "), ug: m[1] };
}

function kb(path) {
  try {
    return Math.round(statSync(path).size / 1024);
  } catch {
    return null;
  }
}

function buildRegistry() {
  const docs = [];
  if (existsSync(DOC_ROOT)) {
    for (const file of readdirSync(DOC_ROOT).filter((f) => /\.pdf$/i.test(f))) {
      const { title, ug } = titleFromPdf(file);
      const path = join(DOC_ROOT, file);
      docs.push({ kind: "manual", title, ug, tool: (ug && UG_TOOL[ug]) || null, path: toVendorRel(path), sizeKb: kb(path) });
    }
  }
  // IP datasheets from the IP catalog, if built.
  const ipIndex = existsSync(join(KN, "ip.index.json")) ? JSON.parse(readFileSync(join(KN, "ip.index.json"), "utf8")) : null;
  if (ipIndex) {
    for (const c of ipIndex.cores.filter((x) => x.hasDatasheet)) {
      const rec = JSON.parse(readFileSync(join(KN, "ip", `${c.slug}.json`), "utf8"));
      // rec.datasheet is stored install-root-relative; resolve to stat it.
      const abs = fromVendorRel(rec.datasheet);
      if (abs && existsSync(abs)) {
        docs.push({ kind: "ip_datasheet", title: `${c.displayName} IP — ${basename(abs)}`, ipSlug: c.slug, tool: "ip core", path: rec.datasheet, sizeKb: kb(abs) });
      }
    }
  }
  return docs;
}

// Split a markdown file into heading-delimited chunks.
function chunkMarkdown(text, source) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let title = source;
  let buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) chunks.push({ source, title, text: body });
    buf = [];
  };
  for (const line of lines) {
    const h = /^#{1,3}\s+(.*)$/.exec(line);
    if (h) {
      flush();
      title = h[1].trim();
    }
    buf.push(line);
  }
  flush();
  return chunks;
}

function buildChunks() {
  rmSync(CHUNK_DIR, { recursive: true, force: true });
  mkdirSync(CHUNK_DIR, { recursive: true });
  const sources = [
    ["SKILL.md", join(SKILL_DIR, "SKILL.md")],
    ["cdt-tcl-commands.md", join(SKILL_DIR, "reference", "cdt-tcl-commands.md")],
    ["pds-project-and-flow.md", join(SKILL_DIR, "reference", "pds-project-and-flow.md")],
    ["debug-ila.md", join(SKILL_DIR, "reference", "debug-ila.md")],
  ];
  const meta = [];
  let n = 0;
  for (const [name, path] of sources) {
    if (!existsSync(path)) continue;
    for (const ch of chunkMarkdown(readFileSync(path, "utf8"), name)) {
      const id = `chunk_${String(n).padStart(3, "0")}`;
      writeFileSync(join(CHUNK_DIR, `${id}.json`), JSON.stringify({ id, ...ch }, null, 2), "utf8");
      meta.push({ id, source: name, title: ch.title, chars: ch.text.length });
      n += 1;
    }
  }
  return meta;
}

function main() {
  mkdirSync(KN, { recursive: true });
  const docs = buildRegistry();
  const chunks = buildChunks();
  writeFileSync(
    join(KN, "docs.index.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), docRoot: toVendorRel(DOC_ROOT), manualCount: docs.filter((d) => d.kind === "manual").length, datasheetCount: docs.filter((d) => d.kind === "ip_datasheet").length, chunkCount: chunks.length, docs, chunks }, null, 2),
    "utf8"
  );
  console.log(`docs: ${docs.length} (manuals + datasheets), chunks: ${chunks.length} -> ${KN}`);
}

main();
