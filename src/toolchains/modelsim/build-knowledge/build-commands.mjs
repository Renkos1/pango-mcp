// Offline builder: parse ModelSim docs/cmd_help/*.txt into a structured command
// corpus and register docs/pdfdocs/*.pdf manuals, writing the committed corpus
// ../knowledge/commands.index.json. Run once per install:
//   node src/toolchains/modelsim/build-knowledge/build-commands.mjs
// The command entries are install-independent text; manuals store only the
// filename (paths are resolved against the live install at query time).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODELSIM } from "../install.mjs";
import { parseCmdHelp } from "../knowledge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "knowledge");
const docsDir = join(MODELSIM.home, "docs");
const cmdHelpDir = join(docsDir, "cmd_help");
const pdfDir = join(docsDir, "pdfdocs");

// cmd_help files in increasing richness; later/richer descriptions win on merge.
const EDITION = {
  "cmd_help.txt": "tcl",
  "core_cmd_help.txt": "core",
  "pe_cmd_help.txt": "pe",
  "ee_cmd_help.txt": "ee",
};

const merged = new Map(); // command -> { command, description, arguments, editions[] }
for (const file of Object.keys(EDITION)) {
  const p = join(cmdHelpDir, file);
  if (!existsSync(p)) continue;
  for (const e of parseCmdHelp(readFileSync(p, "utf8"))) {
    const prev = merged.get(e.command);
    if (!prev) {
      merged.set(e.command, { ...e, editions: [EDITION[file]] });
    } else {
      if (e.description.length > prev.description.length) prev.description = e.description;
      if (!prev.arguments && e.arguments) prev.arguments = e.arguments;
      if (!prev.editions.includes(EDITION[file])) prev.editions.push(EDITION[file]);
    }
  }
}
const commands = [...merged.values()].sort((a, b) => a.command.localeCompare(b.command));

const manuals = existsSync(pdfDir)
  ? readdirSync(pdfDir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((f) => ({ title: basename(f, ".pdf"), file: f, sizeKb: Math.round(statSync(join(pdfDir, f)).size / 1024) }))
  : [];

mkdirSync(OUT_DIR, { recursive: true });
const index = {
  source: { home: MODELSIM.home, cmdHelpDir, pdfDir },
  builtAt: new Date().toISOString(),
  commandCount: commands.length,
  manualCount: manuals.length,
  commands,
  manuals,
};
writeFileSync(join(OUT_DIR, "commands.index.json"), JSON.stringify(index, null, 2));
console.log(`MSIM knowledge: ${commands.length} commands, ${manuals.length} manuals -> ${join(OUT_DIR, "commands.index.json")}`);
