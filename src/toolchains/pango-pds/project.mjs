// Pango PDS toolchain — .pds project parsing (S-expr + XML formats) and
// minimal / LED-blink project generation with .fdc constraints.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { cleanToken, readText, xmlAttr } from "../../core/exec.mjs";

const inputRef = (projectDir, path, extra = {}) => ({
  path,
  absPath: resolve(projectDir, path.replace(/\//g, "\\")),
  ...extra,
});

function uniqueInputRefs(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item.absPath || item.path || "").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function splitIncludeDirs(values, projectDir) {
  return uniqueInputRefs(
    values
      .flatMap((value) => String(value || "").split(/[;\r\n]+/))
      .map((value) => value.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
      .map((path) => inputRef(projectDir, path))
  ).map((item) => item.absPath);
}

export function parseXmlPdsProject(text, pdsPath) {
  const projectDir = dirname(resolve(pdsPath));
  const partTag = /<part\b[^>]*>/i.exec(text)?.[0] || "";
  const optionTags = [...text.matchAll(/<option\b[^>]*>/gi)].map((match) => match[0]);
  const topModule = optionTags.find((tag) => /^top_module$/i.test(xmlAttr(tag, "name") || ""));
  const topModuleName = topModule ? xmlAttr(topModule, "value") : null;
  const files = [];
  const ipFiles = [];
  for (const match of text.matchAll(/<item\b[^>]*>/gi)) {
    const tag = match[0];
    const type = xmlAttr(tag, "type");
    const file = xmlAttr(tag, "file");
    if (!file) continue;
    if (/^IP$/i.test(type || "")) {
      ipFiles.push(inputRef(projectDir, file, { type: "ip", library: xmlAttr(tag, "library") }));
      continue;
    }
    if (!/^FILE$/i.test(type || "")) continue;
    const fmt = xmlAttr(tag, "format");
    files.push(inputRef(projectDir, file, {
      format: fmt,
      library: xmlAttr(tag, "library"),
      isTop: !!(topModuleName && basename(file).replace(/\.(sv|v|vhd|vhdl)$/i, "") === topModuleName),
    }));
  }
  const sources = files.filter((f) => /^(verilog|vhdl|systemverilog)$/i.test(f.format || "") || /\.(v|sv|vhd|vhdl)$/i.test(f.path));
  const constraints = files.filter((f) => /^fdc$/i.test(f.format || "") || /\.fdc$/i.test(f.path));
  // auxFiles = everything else the .pds references (e.g. .fic for ILA insertion).
  // Filter to PROJECT-INPUT files (under projectDir, not the build outputs PDS
  // also writes here — outputs live under prj_tasks/ and are regenerated).
  const usedAbs = new Set([...sources, ...constraints].map((f) => f.absPath));
  const auxFiles = files.filter(
    (f) => !usedAbs.has(f.absPath) && !/^prj_tasks[\\/]/i.test(f.path) && !/\.(pcf|adf|sbit|smsk|bgr|cmr|prt|rtr|rur|ror|plr|vm|snr|netlist|cgs|dmr|db|log)$/i.test(f.path)
  );
  const projectTag = /<project\b[^>]*>/i.exec(text)?.[0] || "";
  const includeDirs = splitIncludeDirs(
    optionTags
      .filter((tag) => /include.*(?:path|dir)|(?:path|dir).*include/i.test(xmlAttr(tag, "name") || ""))
      .map((tag) => xmlAttr(tag, "value")),
    projectDir
  );
  const uniqueIps = uniqueInputRefs(ipFiles);
  return {
    pdsPath: resolve(pdsPath),
    projectDir,
    flowName: xmlAttr(projectTag, "name"),
    pdsFileVersion: xmlAttr(projectTag, "project_version"),
    part: partTag
      ? {
          family: xmlAttr(partTag, "family"),
          device: xmlAttr(partTag, "device"),
          speedgrade: xmlAttr(partTag, "speedgrade"),
          package: xmlAttr(partTag, "package"),
        }
      : null,
    topModule: topModuleName,
    topSource: sources.find((f) => f.isTop)?.path || sources[0]?.path || null,
    sources,
    constraints,
    ipFiles: uniqueIps,
    includeDirs,
    auxFiles,
    projectInputs: [...sources, ...constraints, ...uniqueIps, ...auxFiles],
    parenBalanced: true,
    format: "xml",
  };
}

export function parsePdsProject(pdsPath) {
  const text = readText(pdsPath);
  if (/^\s*<\?xml\b|^\s*<project\b/i.test(text)) return parseXmlPdsProject(text, pdsPath);
  const projectDir = dirname(resolve(pdsPath));
  const flow = /\(_flow\s+([^\s()"]+|"[^"]+")\s+"?([^"\s()]+)"?/i.exec(text);
  const partMatch =
    /\(_part\s*\(_family\s+([^)]+)\)\s*\(_device\s+([^)]+)\)\s*\(_speedgrade\s+([^)]+)\)\s*\(_package\s+([^)]+)\)\s*\)/i.exec(
      text
    );
  const files = [];
  const starts = [...text.matchAll(/\(_file\s+"([^"]+)"/gi)].map((m) => ({ index: m.index, path: m[1] }));
  for (let i = 0; i < starts.length; i += 1) {
    const cur = starts[i];
    const next = starts[i + 1]?.index ?? Math.min(text.length, cur.index + 800);
    const block = text.slice(cur.index, next);
    const fmt = /\(_format\s+([^)]+)\)/i.exec(block);
    const topMarker = /\+\s+"([^"]+)"/i.exec(block)?.[1] || null;
    files.push({
      path: cur.path,
      absPath: resolve(projectDir, cur.path.replace(/\//g, "\\")),
      format: fmt ? cleanToken(fmt[1]) : null,
      topModule: topMarker,
      isTop: !!topMarker,
    });
  }
  const sources = files.filter((f) => /^(verilog|vhdl|systemverilog)$/i.test(f.format || "") || /\.(v|sv|vhd|vhdl)$/i.test(f.path));
  const constraints = files.filter((f) => /^fdc$/i.test(f.format || "") || /\.fdc$/i.test(f.path));
  const fileIps = files.filter((f) => /^idf$/i.test(f.format || "") || /\.idf$/i.test(f.path));
  const explicitIps = [...text.matchAll(/\(_ip\s+"([^"]+)"/gi)].map((match) => inputRef(projectDir, match[1], { type: "ip", library: null }));
  const ipFiles = uniqueInputRefs([...fileIps.map((f) => ({ ...f, type: "ip" })), ...explicitIps]);
  const includeDirs = splitIncludeDirs(
    [...text.matchAll(/\(_option\s+([^\s()]+)\s+\(_string\s+("[^"]*"|[^\s()]+)/gi)]
      .filter((match) => /include.*(?:path|dir)|(?:path|dir).*include/i.test(match[1]))
      .map((match) => cleanToken(match[2])),
    projectDir
  );
  const usedInputs = new Set([...sources, ...constraints, ...ipFiles].map((item) => item.absPath.toLowerCase()));
  const auxFiles = files.filter((f) => !usedInputs.has(f.absPath.toLowerCase()));
  return {
    pdsPath: resolve(pdsPath),
    projectDir,
    flowName: flow ? cleanToken(flow[1]) : null,
    pdsFileVersion: flow ? cleanToken(flow[2]) : null,
    part: partMatch
      ? {
          family: cleanToken(partMatch[1]),
          device: cleanToken(partMatch[2]),
          speedgrade: cleanToken(partMatch[3]),
          package: cleanToken(partMatch[4]),
        }
      : null,
    topModule: sources.find((f) => f.isTop)?.topModule || null,
    topSource: sources.find((f) => f.isTop)?.path || null,
    sources,
    constraints,
    ipFiles,
    includeDirs,
    auxFiles,
    projectInputs: [...sources, ...constraints, ...ipFiles, ...auxFiles],
    parenBalanced: (text.match(/\(/g) || []).length === (text.match(/\)/g) || []).length,
    format: "sexpr",
  };
}

export function pdsTimespec() {
  return new Date().toISOString().slice(0, 19);
}

export function sanitizeProjectFileName(name) {
  return String(name || "demo").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "demo";
}

export function ensureEmptyOrForce(dir, force) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir).filter((name) => name !== "." && name !== "..");
  if (entries.length && !force) throw new Error(`目标目录非空，需 force:true 才覆盖: ${dir}`);
  if (force) rmSync(dir, { recursive: true, force: true });
}

// Device-agnostic invariant (ARCHITECTURE §10): this tool assumes NO device. The
// part — family/device/speedgrade/package — is the target board's physical
// identity and must be supplied in full by the caller (user / Target Profile).
// The tool never defaults or guesses any field: a guessed package/speedgrade
// silently mismatches the real board and the build fails downstream. Supply the
// whole part, or get an error naming what's missing.
const REQUIRED_PART_FIELDS = ["family", "device", "speedgrade", "package"];
function assertCompletePart(part) {
  const missing = REQUIRED_PART_FIELDS.filter((f) => !part?.[f]);
  if (missing.length) {
    throw new Error(
      `target part 不完整，缺 ${missing.join("/")}。family/device/speedgrade/package 是目标板的物理标识，` +
        `必须由用户/Target Profile 完整提供——工具不内置默认、不替你猜(猜错封装/速度等级会与真实器件错配，构建失败)。`
    );
  }
}

// Render FDC pin constraints from a Target-Profile `pins` map (F-fdc): the board
// supplies real pin LOCs so the tool generates constraints instead of the agent
// hand-writing them. pins = { "<port>": { loc, dir?, iostd?, vccio?, drive?, freqMhz? } }.
// loc is required per pin; dir defaults to INPUT. Empty/absent → minimal comment.
// A pin carrying `freqMhz` (the clock line's frequency — board physical info from
// the Target Profile, never tool-defaulted/guessed) also emits a create_clock so
// PDS timing analysis targets the real frequency instead of a nominal default.
export function renderFdcFromPins(pins) {
  const entries = Object.entries(pins || {}).filter(([, p]) => p && p.loc);
  if (!entries.length) return null;
  const lines = entries.map(([port, p]) =>
    fdcIo(port, p.loc, (p.dir || "INPUT").toUpperCase(), {
      ...(p.vccio ? { vccio: String(p.vccio) } : {}),
      ...(p.iostd ? { standard: p.iostd } : {}),
      ...(p.drive ? { drive: String(p.drive) } : {}),
    })
  );
  const clockLines = entries
    .filter(([, p]) => Number(p.freqMhz) > 0)
    .map(([port, p]) => `create_clock -name ${port} -period ${Number((1000 / Number(p.freqMhz)).toFixed(3))} [get_ports ${port}]`);
  const clockBlock = clockLines.length
    ? `\n# Clock constraints from the board Target Profile (pin freqMhz) so timing targets the real frequency.\n${clockLines.join("\n")}\n`
    : "";
  return `# Pin constraints generated from the board Target Profile (config boards[].pins).\n${lines.join("\n")}\n${clockBlock}`;
}

export function selectProfilePins(pins, pinNames) {
  if (pinNames == null) return pins;
  if (!Array.isArray(pinNames) || pinNames.length === 0) throw new Error("pinNames 必须是非空端口名数组");
  if (!pins || typeof pins !== "object") throw new Error("pinNames 需要 board Target Profile 提供 pins");
  const names = [...new Set(pinNames.map((name) => String(name).trim()).filter(Boolean))];
  const missing = names.filter((name) => !Object.hasOwn(pins, name));
  if (missing.length) throw new Error(`pinNames 不在 Target Profile pins 中: ${missing.join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, pins[name]]));
}

export function createMinimalPdsProject({ projectDir, name = "fab_demo", top = "top", part, pins = null, pinNames = null, force = false }) {
  assertCompletePart(part);
  const target = resolve(projectDir);
  ensureEmptyOrForce(target, force);
  mkdirSync(join(target, "rtl"), { recursive: true });
  mkdirSync(join(target, "constraints"), { recursive: true });

  const selected = {
    family: part.family,
    device: part.device,
    speedgrade: part.speedgrade,
    package: part.package,
  };
  const fileName = sanitizeProjectFileName(name);
  const ts = pdsTimespec();
  const topRel = `rtl/${top}.v`;
  const fdcRel = `constraints/${top}.fdc`;
  const pdsPath = join(target, `${fileName}.pds`);
  const sourcePath = join(target, "rtl", `${top}.v`);
  const fdcPath = join(target, "constraints", `${top}.fdc`);

  writeFileSync(
    sourcePath,
    `module ${top}();\n  (* keep = "true" *) wire fpga_mcp_keep = 1'b1;\nendmodule\n`,
    "utf8"
  );
  const selectedPins = selectProfilePins(pins, pinNames);
  writeFileSync(fdcPath, renderFdcFromPins(selectedPins) || "# Minimal constraint file generated by fpga_pds_create_project.\n", "utf8");
  writeFileSync(
    pdsPath,
    // NOTE: the flow identifier MUST stay "fab_demo" — pds_shell validates it and
    // rejects other values with "E: Flow-0131: The flow identifier is wrong",
    // failing project analysis before compile. It is NOT the display name; do not
    // tie it to `name`.
    `(_flow fab_demo "2022.2-rc2"
    (_comment "Generated by fpga_pds_create_project")
    (_version "1.0.9")
    (_status "initial")
    (_project (_option prj_work_dir (_string ".")) (_option prj_impl_dir (_string ".")))
    (_task tsk_setup
        (_widget wgt_select_arch (_input (_part (_family ${selected.family})(_device ${selected.device})(_speedgrade ${selected.speedgrade})(_package ${selected.package}))))
        (_widget wgt_my_design_src (_input (_file "${topRel}" + "${top}" (_format verilog)(_timespec "${ts}"))))
        (_widget wgt_import_logic_con_file (_input (_file "${fdcRel}" (_format fdc)(_timespec "${ts}")))))
    (_task tsk_compile       (_command cmd_compile       (_gci_state (_integer 0))))
    (_task tsk_synthesis     (_command cmd_synthesize    (_gci_state (_integer 0))(_option selected_syn_tool_opt (_integer 2))))
    (_task tsk_devmap        (_command cmd_devmap        (_gci_state (_integer 0))))
    (_task tsk_pnr           (_command cmd_pnr           (_gci_state (_integer 0))(_option fix_hold_violation (_switch ON))))
    (_task tsk_gen_bitstream (_command cmd_gen_bitstream (_gci_state (_integer 0)))))
`,
    "utf8"
  );
  const info = parsePdsProject(pdsPath);
  return { pdsPath, sourcePath, fdcPath, projectDir: target, info, pinNames: selectedPins ? Object.keys(selectedPins) : [] };
}

export function fdcIo(port, loc, direction, { vccio = "3.3", standard = "LVCMOS33", drive = "8" } = {}) {
  const driveLine = direction.toUpperCase() === "OUTPUT" ? `define_attribute {p:${port}} {PAP_IO_DRIVE} {${drive}}\ndefine_attribute {p:${port}} {PAP_IO_SLEW} {FAST}\n` : "";
  return `define_attribute {p:${port}} {PAP_IO_DIRECTION} {${direction}}\ndefine_attribute {p:${port}} {PAP_IO_LOC} {${loc}}\ndefine_attribute {p:${port}} {PAP_IO_VCCIO} {${vccio}}\ndefine_attribute {p:${port}} {PAP_IO_STANDARD} {${standard}}\ndefine_attribute {p:${port}} {PAP_IO_NONE} {TRUE}\n${driveLine}`;
}

export function createBlinkPdsProject({
  projectDir,
  name = "fab_blink",
  top = "top",
  clkPin,
  ledPins,
  part,
  vccio = "3.3",
  ioStandard = "LVCMOS33",
  counterBit = 24,
  clkFreqMhz = 50,
  force = false,
}) {
  if (!clkPin) throw new Error("clkPin 不能为空");
  if (!Array.isArray(ledPins) || !ledPins.length) throw new Error("ledPins 不能为空");
  const created = createMinimalPdsProject({
    projectDir,
    name,
    top,
    force,
    part,
  });
  const width = ledPins.length;
  writeFileSync(
    created.sourcePath,
    `module ${top}(input clk, output wire [${width - 1}:0] led);\n  reg [31:0] counter = 32'd0;\n  always @(posedge clk) begin\n    counter <= counter + 32'd1;\n  end\n  assign led = counter[${counterBit + width - 1}:${counterBit}];\nendmodule\n`,
    "utf8"
  );
  const ledConstraints = ledPins
    .map((pin, i) => fdcIo(`led[${i}]`, pin, "OUTPUT", { vccio, standard: ioStandard }))
    .join("\n");
  // Real clock constraint: without create_clock PDS analyzes against a nominal
  // ~1 MHz default and timing.met is vacuous. clkFreqMhz is the board
  // oscillator the caller targets; period = 1000/freq ns.
  const clkPeriodNs = Number((1000 / clkFreqMhz).toFixed(3));
  writeFileSync(
    created.fdcPath,
    `# LED blink constraints generated by fpga_pds_create_blink_project.\n${fdcIo("clk", clkPin, "Input", { vccio, standard: ioStandard })}\n# Clock constraint so timing analysis targets the real frequency.\ncreate_clock -name clk -period ${clkPeriodNs} [get_ports clk]\n\n${ledConstraints}`,
    "utf8"
  );
  return { ...created, info: parsePdsProject(created.pdsPath), clkPin, ledPins, ioStandard, vccio, counterBit, clkFreqMhz, clkPeriodNs };
}
