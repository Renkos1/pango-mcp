// Net-name discovery for ILA tapping.
//
// THE PROBLEM (see docs/ILA-FINDINGS.md): post-synthesis
// flattened net names ≠ RTL names. A reg that drives an LED is renamed
// (tx -> nt_led[0]); a clock port becomes the INBUF output (clk -> nt_clk); a
// purely-internal net survives clean (tx_int). The .fic inserter taps NETS, so an
// agent that guesses RTL names fails — the only authority is the synthesis netlist.
//
// THE MECHANISM (validated locally, board-independent):
//   pds_shell -file <tcl>:  open_project -> compile -> run_ads
//   then read prj_tasks/syn_1/synthesize/<top>_syn.vm  (plaintext, deterministic)
// run_ads is the ADS-project synth command (`synthesize` is the Synplify path and
// errors "synthesis tool does not match"). Synthesis-only is seconds, no board.
//
// This module is the single source of net truth: fpga_ila_list_nets exposes it and
// fpga_ila_build calls it to resolve desired (RTL) names -> real nets before
// writing the .fic. The mapped VM explains RTL renames; cdt_ins ins_list_nets is
// the final authority for flattened names. The .fic writer (ila.mjs) stays the
// authoring primitive.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { findFiles, safeReadText, unique } from "../../core/exec.mjs";
import { parsePdsProject } from "./project.mjs";
import { pdsDiagnostics } from "./diagnostics.mjs";
import { cdtTool } from "./install.mjs";
import { parsePdsLog } from "./reports.mjs";
import { ProjectInputStageError, stageProjectInputs } from "./staging.mjs";

// A Verilog escaped id is `\name ` (leading backslash, ends at whitespace). Our
// regexes exclude the trailing space; just drop the leading backslash.
const stripEsc = (id) => String(id).replace(/^\\/, "");
// A net token is tappable only if it is not a constant literal / empty.
const isRealNet = (tok) => !!tok && tok !== "" && !/^\d+'[bBhHdDoO]/.test(tok) && !/^['"]/.test(tok);

// Parse a mapped-Verilog (.vm) netlist into per-module facts. Pure + deterministic.
// Per module: ports, nets (wire decls), instances [{type,inst}], dffs [{inst,net}]
// (GTP_DFF .Q), clocks (nets on any .CLK), portNets [{a,b}] (INBUF/OUTBUF wiring).
export function parseVm(text) {
  const src = String(text || "");
  const modules = [];
  const moduleRe = /\bmodule\s+(\\?\S+)\s*\(([\s\S]*?)\)\s*;([\s\S]*?)\bendmodule/g;
  let m;
  while ((m = moduleRe.exec(src))) {
    const name = stripEsc(m[1]);
    const body = m[3];

    const ports = [];
    const portRe = /\b(input|output|inout)\s+(?:\[(\d+):(\d+)\]\s*)?(\\?[^\s,()]+)/g;
    for (let p; (p = portRe.exec(m[2])); ) {
      ports.push({ dir: p[1], name: stripEsc(p[4]), msb: p[2] != null ? +p[2] : null, lsb: p[3] != null ? +p[3] : null });
    }

    const nets = [];
    const wireRe = /\bwire\s+(?:\[(\d+):(\d+)\]\s*)?(\\?[^\s;]+)\s*;/g;
    for (let w; (w = wireRe.exec(body)); ) {
      nets.push({ name: stripEsc(w[3]), msb: w[1] != null ? +w[1] : null, lsb: w[2] != null ? +w[2] : null });
    }

    // Instance headers: [attr] TYPE [#(params, one nesting level)] INSTNAME (
    const instances = [];
    const instRe = /(?:\(\*[\s\S]*?\*\)\s*)?\b([A-Za-z]\w*)\s+(?:#\((?:[^()]|\([^()]*\))*\)\s*)?(\\?[^\s()]+)\s*\(/g;
    for (let i; (i = instRe.exec(body)); ) instances.push({ type: i[1], inst: stripEsc(i[2]) });

    // GTP_DFF instance -> its .Q net (instance name is the token just before "( .Q (").
    const dffs = [];
    const dffRe = /(\\?[^\s()]+)\s*\(\s*\.Q\s*\(\s*([^)\s]*)\s*\)/g;
    for (let d; (d = dffRe.exec(body)); ) if (isRealNet(d[2])) dffs.push({ inst: stripEsc(d[1]), net: d[2] });

    const clocks = [];
    const clkRe = /\.CLK\s*\(\s*([^)\s]+)\s*\)/g;
    for (let c; (c = clkRe.exec(body)); ) if (isRealNet(c[1]) && !clocks.includes(c[1])) clocks.push(c[1]);

    // INBUF: .O(net) .I(port) ; OUTBUF: .O(port) .I(net). Record the pair; the
    // resolver matches whichever side equals a desired port name.
    const portNets = [];
    const bufRe = /GTP_(?:INBUF|OUTBUF|IBUF|OBUF)\b[\s\S]*?\.O\s*\(\s*([^)\s]+)\s*\)[\s\S]*?\.I\s*\(\s*([^)\s]+)\s*\)/g;
    for (let b; (b = bufRe.exec(body)); ) portNets.push({ a: b[1], b: b[2] });

    modules.push({ name, ports, nets, instances, dffs, clocks, portNets });
  }

  // Top = the module that no other module instantiates as a TYPE.
  const moduleNames = new Set(modules.map((mod) => mod.name));
  const instantiated = new Set();
  for (const mod of modules) for (const inst of mod.instances) if (moduleNames.has(inst.type)) instantiated.add(inst.type);
  const top = modules.find((mod) => !instantiated.has(mod.name)) || modules[modules.length - 1] || null;
  return { modules, topModule: top ? top.name : null };
}

// Expand a width-decl to its bit members (or [name] if scalar).
function members(decl) {
  if (decl.msb == null || decl.lsb == null) return [decl.name];
  const hi = Math.max(decl.msb, decl.lsb);
  const lo = Math.min(decl.msb, decl.lsb);
  const out = [];
  for (let i = lo; i <= hi; i += 1) out.push(`${decl.name}[${i}]`);
  return out;
}

const topOf = (parsed) => (parsed?.modules || []).find((m) => m.name === parsed.topModule) || parsed?.modules?.[0] || null;

// Fabric Inserter is the final authority for names accepted by a .fic. Keep the
// exact spelling it prints (older releases can put a space before a bus index),
// but compare through a normalized spelling so callers may use `bus[0]` on all
// supported releases.
const comparableNetName = (name) => String(name || "").trim().replace(/\s+\[/g, "[");
const netLeaf = (name) => comparableNetName(name).split("/").at(-1) || "";
const bitName = (name) => /^(.*)\[(\d+)\]$/.exec(comparableNetName(name));

function inserterEntries(parsed) {
  if (!Array.isArray(parsed?.inserterNets)) return null;
  return parsed.inserterNets
    .map((item, index) => (typeof item === "string" ? { index, name: item, sourceComponent: null } : item))
    .filter((item) => item && String(item.name || "").trim());
}

function exactInserterEntry(parsed, name) {
  const wanted = comparableNetName(name);
  return inserterEntries(parsed)?.find((item) => comparableNetName(item.name) === wanted) || null;
}

function inserterBusGroups(parsed, name) {
  const entries = inserterEntries(parsed);
  if (!entries) return [];
  const wanted = comparableNetName(name);
  const groups = new Map();
  for (const entry of entries) {
    const match = bitName(entry.name);
    if (!match) continue;
    const base = match[1];
    if (!groups.has(base)) groups.set(base, { base, bits: [] });
    groups.get(base).bits.push({ index: Number(match[2]), name: entry.name });
  }
  let matches;
  if (wanted.includes("/")) {
    matches = [...groups.values()].filter((group) => group.base === wanted);
  } else if (groups.has(wanted)) {
    // A top-level bus is an exact path and wins over same-leaf hierarchical buses.
    matches = [groups.get(wanted)];
  } else {
    matches = [...groups.values()].filter((group) => netLeaf(group.base) === wanted);
  }
  return matches.map((group) => ({
    base: group.base,
    bits: group.bits.sort((a, b) => a.index - b.index).map((bit) => bit.name),
  }));
}

// Parse cdt_ins `ins_list_nets` output. A row is columnar:
//   <index> : <flattened net name> <source component>
// Names can contain one space before `[N]` on older PDS versions, so only a run
// of 2+ spaces terminates the name column.
export function parseInserterNetList(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s*:\s+(.+?)\s{2,}(\S.*?)\s*$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const name = match[2].trim();
    const sourceComponent = match[3].trim();
    const key = `${index}\0${name}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push({ index, name, sourceComponent });
  }
  return out;
}

// Compact, agent-facing digest of what can be tapped.
export function summarizeNetlist(parsed) {
  const top = topOf(parsed);
  if (!top) return { topModule: null, clocks: [], tappable: [], registers: [], submodules: [] };
  return {
    topModule: top.name,
    clocks: top.clocks,
    tappable: top.nets.map((n) => ({
      net: n.name,
      width: n.msb != null ? Math.abs(n.msb - n.lsb) + 1 : 1,
      bus: n.msb != null ? `[${n.msb}:${n.lsb}]` : null,
    })),
    registers: top.dffs.map((d) => ({ inst: d.inst, net: d.net })),
    submodules: top.instances.filter((i) => parsed.modules.some((mod) => mod.name === i.type)).map((i) => ({ inst: i.inst, module: i.type })),
  };
}

// Expand any desired name that uniquely identifies a multi-bit Inserter bus into
// its authoritative flattened scalar members (LSB first). When no Inserter list
// is attached, retain the legacy top-level VM expansion for parser-only callers.
// Names already carrying an explicit `[i]`, and scalar/unknown names, pass
// through unchanged; a same-leaf bus in multiple instances stays ambiguous.
// Returns { names, expansions:[{ name, bits }] } — expansions drive a user-facing
// note so the channel-count change is visible, not silent.
export function expandBuses(parsed, names) {
  const top = topOf(parsed);
  const busDecl = (base) =>
    top?.nets.find((n) => n.name === base && n.msb != null && n.lsb != null && Math.abs(n.msb - n.lsb) >= 1) || null;
  const out = [];
  const expansions = [];
  for (const raw of names || []) {
    const name = String(raw).trim();
    if (/\[\d+\]$/.test(name)) { out.push(name); continue; } // explicit bit
    if (inserterEntries(parsed)) {
      // An exact scalar wins. Otherwise only expand when the requested bus maps
      // to one flattened hierarchy. Two instances exposing the same leaf bus
      // stay unexpanded so resolveSignal can report an actionable ambiguity.
      if (exactInserterEntry(parsed, name)) { out.push(name); continue; }
      const groups = inserterBusGroups(parsed, name);
      if (groups.length === 1) {
        const bits = groups[0].bits;
        out.push(...bits);
        expansions.push({ name, bits, flattenedBase: groups[0].base, verified: true });
      } else {
        out.push(name);
      }
      continue;
    }
    const decl = busDecl(name);
    if (decl) {
      const bits = members(decl); // LSB-first, e.g. rx_data[0..7]
      out.push(...bits);
      expansions.push({ name, bits });
    } else {
      out.push(name);
    }
  }
  return { names: out, expansions };
}

function legacyResolveSignal(parsed, name) {
  const top = topOf(parsed);
  if (!top) return { name, net: null, status: "pruned", verified: false, note: "无顶层模块" };
  const bare = String(name).trim();

  for (const n of top.nets) {
    if (n.name === bare || members(n).includes(bare)) return { name, net: bare, status: "exact", verified: false };
  }
  for (const d of top.dffs) {
    if (stripEsc(d.inst) === bare) {
      return { name, net: d.net, status: d.net === bare ? "exact" : "renamed", verified: false, note: `寄存器 ${bare} 的输出网为 ${d.net}` };
    }
  }
  for (const pn of top.portNets) {
    if (pn.a === bare && isRealNet(pn.b)) return { name, net: pn.b, status: "renamed", verified: false, note: `端口 ${bare} 的内部网为 ${pn.b}` };
    if (pn.b === bare && isRealNet(pn.a)) return { name, net: pn.a, status: "renamed", verified: false, note: `端口 ${bare} 的内部网为 ${pn.a}` };
  }
  for (const mod of parsed.modules) {
    if (mod.name === top.name) continue;
    const hit = mod.nets.some((n) => n.name === bare || members(n).includes(bare)) || mod.dffs.some((d) => stripEsc(d.inst) === bare);
    if (hit) {
      const inst = top.instances.find((i) => i.type === mod.name)?.inst;
      return {
        name,
        net: `${inst ? inst + "/" : mod.name + "/"}${bare}`,
        status: "hierarchical",
        verified: false,
        note: `在子模块 ${mod.name} 内；该名称尚未经 Fabric Inserter 验证`,
      };
    }
  }
  return {
    name,
    net: null,
    status: "pruned",
    verified: false,
    note: "综合后找不到该网——可能被优化掉(无可观测消费者)或名字不同。保留它:给信号加 (* syn_preserve = 1 *) / (* keep = 1 *)，或让它驱动一个输出/被寄存，再重跑。",
  };
}

function moduleInstancePaths(parsed) {
  const modules = new Map((parsed.modules || []).map((mod) => [mod.name, mod]));
  const paths = new Map();
  const add = (moduleName, path) => {
    if (!paths.has(moduleName)) paths.set(moduleName, []);
    if (!paths.get(moduleName).includes(path)) paths.get(moduleName).push(path);
  };
  const walk = (moduleName, prefix, ancestry, depth) => {
    if (depth > 64) return;
    const mod = modules.get(moduleName);
    if (!mod) return;
    for (const inst of mod.instances || []) {
      if (!modules.has(inst.type)) continue;
      const path = prefix ? `${prefix}/${inst.inst}` : inst.inst;
      add(inst.type, path);
      if (!ancestry.includes(inst.type)) walk(inst.type, path, [...ancestry, inst.type], depth + 1);
    }
  };
  if (parsed.topModule) {
    add(parsed.topModule, "");
    walk(parsed.topModule, "", [parsed.topModule], 0);
  }
  return paths;
}

function vmResolutionCandidates(parsed, bare) {
  const paths = moduleInstancePaths(parsed);
  const candidates = [];
  let known = false;
  for (const mod of parsed.modules || []) {
    const locals = new Set();
    for (const net of mod.nets || []) {
      if (net.name === bare || members(net).includes(bare)) {
        known = true;
        locals.add(bare);
      }
    }
    for (const dff of mod.dffs || []) {
      if (stripEsc(dff.inst) === bare) {
        known = true;
        locals.add(dff.net);
      }
    }
    for (const pn of mod.portNets || []) {
      if (pn.a === bare && isRealNet(pn.b)) { known = true; locals.add(pn.b); }
      if (pn.b === bare && isRealNet(pn.a)) { known = true; locals.add(pn.a); }
    }
    if ((mod.ports || []).some((port) => port.name === bare)) known = true;
    for (const prefix of paths.get(mod.name) || []) {
      for (const local of locals) candidates.push(prefix ? `${prefix}/${local}` : local);
    }
  }
  return { known, candidates: unique(candidates) };
}

const usableResolution = (result) =>
  !!result?.verified && !!result?.net && ["exact", "renamed", "hierarchical"].includes(result.status);

// Resolve a desired (usually RTL) signal name to a net proven to exist in the
// Fabric Inserter's flattened database. Without `parsed.inserterNets`, the
// legacy VM heuristic is retained for parser callers but marked verified:false;
// fpga_ila_build never accepts such a result.
// status: exact | renamed | hierarchical | bus | ambiguous | unverified | pruned.
export function resolveSignal(parsed, name) {
  const bare = String(name).trim();
  const entries = inserterEntries(parsed);
  if (!entries) return legacyResolveSignal(parsed, name);

  const exact = exactInserterEntry(parsed, bare);
  if (exact) return { name, net: exact.name, status: "exact", verified: true, sourceComponent: exact.sourceComponent };

  const busGroups = inserterBusGroups(parsed, bare);
  const leafMatches = bare.includes("/")
    ? []
    : entries.filter((entry) => netLeaf(entry.name) === comparableNetName(bare));
  if (leafMatches.length === 1 && busGroups.length === 0) {
    const hit = leafMatches[0];
    return {
      name,
      net: hit.name,
      status: comparableNetName(hit.name).includes("/") ? "hierarchical" : "renamed",
      verified: true,
      sourceComponent: hit.sourceComponent,
      note: `Fabric Inserter 唯一匹配: ${hit.name}`,
    };
  }
  if (leafMatches.length || busGroups.length) {
    const candidates = unique([...leafMatches.map((entry) => entry.name), ...busGroups.map((group) => group.base)]);
    if (leafMatches.length === 0 && busGroups.length === 1) {
      return {
        name,
        net: null,
        status: "bus",
        verified: false,
        candidates: busGroups[0].bits,
        note: `该名称是 ${busGroups[0].bits.length} 位总线；先展开为 Inserter 标量网`,
      };
    }
    return {
      name,
      net: null,
      status: "ambiguous",
      verified: false,
      candidates,
      note: `Fabric Inserter 中有多个同名候选；请传完整层级名: ${candidates.join(", ")}`,
    };
  }

  // For an explicit hierarchy, absence from the authority is definitive. Do
  // not fall back to its leaf and accidentally select another instance.
  if (bare.includes("/")) {
    return {
      name,
      net: null,
      status: "unverified",
      verified: false,
      note: `完整层级名不在 Fabric Inserter flattened net list 中: ${bare}`,
    };
  }

  // VM facts still help translate RTL register/port names, but every resulting
  // candidate must round-trip through the Inserter authority before it is usable.
  const vm = vmResolutionCandidates(parsed, bare);
  const verifiedCandidates = unique(
    vm.candidates.map((candidate) => exactInserterEntry(parsed, candidate)?.name).filter(Boolean)
  );
  if (verifiedCandidates.length === 1) {
    const net = verifiedCandidates[0];
    return {
      name,
      net,
      status: comparableNetName(net).includes("/") ? "hierarchical" : comparableNetName(net) === comparableNetName(bare) ? "exact" : "renamed",
      verified: true,
      note: `RTL 名经 mapped VM 映射，并由 Fabric Inserter 验证为 ${net}`,
    };
  }
  if (verifiedCandidates.length > 1) {
    return {
      name,
      net: null,
      status: "ambiguous",
      verified: false,
      candidates: verifiedCandidates,
      note: `多个实例都包含该 RTL 名；请传完整层级名: ${verifiedCandidates.join(", ")}`,
    };
  }
  if (vm.known) {
    return {
      name,
      net: null,
      status: "unverified",
      verified: false,
      candidates: vm.candidates,
      note: "mapped VM 中存在该 RTL 名，但 Fabric Inserter 未暴露对应标量网；不会把猜测名称写入 FIC。",
    };
  }
  return {
    name,
    net: null,
    status: "pruned",
    verified: false,
    note: "综合/Inserter 后找不到该网——可能被优化掉(无可观测消费者)。保留它:给信号加 (* syn_preserve = 1 *) / (* keep = 1 *)，或让它驱动一个输出/被寄存，再重跑。",
  };
}

// Final, exact membership gate used immediately before writing/registering a
// FIC. This intentionally does not resolve aliases: only already-resolved names
// that cdt_ins listed are accepted.
export function validateInserterNets(parsed, names) {
  const authority = inserterEntries(parsed);
  if (!authority) {
    return { ok: false, verified: [], missing: [...(names || [])], reason: "Fabric Inserter 网名清单不可用" };
  }
  const verified = [];
  const missing = [];
  for (const name of names || []) {
    const hit = exactInserterEntry(parsed, name);
    if (hit) verified.push(hit.name);
    else missing.push(name);
  }
  return { ok: missing.length === 0, verified, missing, availableCount: authority.length };
}

export { usableResolution };

// Run compile and ADS synthesis in separate pds_shell processes. Some PDS
// releases terminate the Tcl interpreter from a failed compile despite catch,
// so putting run_ads in the same script masks the real error as a missing file.
const phaseTcl = (pdsFwd, command, marker) =>
  [
    `puts "==FPGA_NL_${marker}_BEGIN=="`,
    `puts "open: [catch {open_project {${pdsFwd}}} phase_error] :: $phase_error"`,
    `puts "${command}: [catch {${command}} phase_error] :: $phase_error"`,
    `puts "==FPGA_NL_${marker}_END=="`,
  ].join("\n");

const outputRel = (root, path) => relative(root, path).replace(/\\/g, "/");
const artifactScore = (path) => {
  const rel = String(path).replace(/\\/g, "/");
  let score = /\.vm$/i.test(rel) ? 100 : 10;
  if (/\/synthesize\//i.test(rel)) score += 50;
  if (/_syn\.vm$/i.test(rel)) score += 30;
  if (/\/compile\//i.test(rel)) score -= 20;
  return score;
};

// PDS layouts vary by release: current task-based projects use
// prj_tasks/<run>/synthesize, while older flows use top-level compile/synthesize.
// Track both mapped Verilog and ADF artifacts; mapped Verilog is preferred for
// net-name parsing, while an ADF-only result is diagnosed distinctly.
export function findNetlistArtifacts(workDir) {
  const candidates = findFiles(
    workDir,
    (path, name) => {
      if (!/\.(?:vm|adf)$/i.test(name)) return false;
      const rel = outputRel(workDir, path);
      return /(^|\/)(?:prj_tasks|compile|synthesize)(?:\/|$)/i.test(rel);
    },
    { maxDepth: 8 }
  ).sort((a, b) => artifactScore(b) - artifactScore(a));
  return {
    candidates,
    vmPath: candidates.find((path) => /\.vm$/i.test(path)) || null,
    adfPath: candidates.find((path) => /\.adf$/i.test(path)) || null,
  };
}

const sanitize = (name) => String(name || "").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
const tailLog = (s, count = 60) => String(s).split(/\r?\n/).slice(-count).join("\n");
const formatOf = (item) => {
  const format = String(item.format || "").toLowerCase();
  if (["verilog", "systemverilog", "vhdl"].includes(format)) return format;
  if (/\.sv$/i.test(item.path || item.stagedPath)) return "systemverilog";
  if (/\.vhd(?:l)?$/i.test(item.path || item.stagedPath)) return "vhdl";
  return "verilog";
};

function collectPhaseLog(work, phase, processOutput) {
  const stageDir = phase === "compile" ? "compile" : "synthesize";
  const stageLogs = findFiles(
    work,
    (path, name) => name.toLowerCase() === "run.log" && new RegExp(`(?:^|[\\\\/])${stageDir}(?:[\\\\/]|$)`, "i").test(path),
    { maxDepth: 8 }
  );
  const rootLogs = [join(work, "flow.log"), join(work, "run.log")].filter((path) => existsSync(path));
  return [processOutput, ...rootLogs.map(safeReadText), ...stageLogs.map(safeReadText)].filter(Boolean).join("\n");
}

function failedPhase(result, log) {
  const parsed = parsePdsLog(log);
  return !!(
    result?.timedOut ||
    Number(result?.code || 0) !== 0 ||
    parsed.errors.length ||
    /(?:^|\n)(?:open|compile|run_ads):\s*[1-9]\d*\s*::|Run process\s+"[^"]+"\s+failed|Program Error Out|Executing\s*:\s*open_project[^\r\n]*failed/i.test(log)
  );
}

function phaseFailure(stage, result, log, work, fallback) {
  const parsed = parsePdsLog(log);
  const errors = unique(parsed.errors);
  const errorsDetailed = parsePdsLog(errors.join("\n")).errorsDetailed;
  const diagnostics = unique(
    String(log || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^E:|^(?:open|compile|run_ads):\s*[1-9]\d*\s*::|Run process\s+"[^"]+"\s+failed|Program Error Out|Public-4023/i.test(line))
  ).slice(-30);
  const headline = errors[0] || diagnostics[0] || fallback;
  return {
    ok: false,
    stage,
    error: `${stage} 失败: ${headline}`,
    errors,
    errorsDetailed,
    diagnostics,
    knownIssues: pdsDiagnostics(log),
    exitCode: Number(result?.code || 0),
    timedOut: !!result?.timedOut,
    log: tailLog(log),
    work,
  };
}

const tclBrace = (value) => `{${String(value).replace(/\\/g, "/").replace(/([{}])/g, "\\$1")}}`;
const markerStatus = (log, marker) => {
  const match = new RegExp(`==PANGO_MCP_INS_${marker}_STATUS==(\\d+)`).exec(log);
  return match ? Number(match[1]) : null;
};

// Ask the actual Fabric Inserter to enumerate the flattened names it accepts.
// `-netlist` alone does not populate the Tcl net DB on every PDS release, so the
// script deliberately creates a temporary project and calls ins_set_file.
export async function listInserterNets({ adfPath, install, part = {}, run, workDir, timeoutSec = 240 }) {
  if (!adfPath || !existsSync(adfPath)) {
    return {
      ok: false,
      stage: "inserter_nets",
      error: "综合网表未产出 Fabric Inserter 所需的 .adf 数据库",
      errors: [],
      diagnostics: ["需要 synthesize 阶段的 .adf，不能从模块名猜 flattened Inserter 网名"],
    };
  }
  const resolvedInstall = { ...install, binDir: install?.binDir || dirname(install?.shell || "") };
  const exe = cdtTool(resolvedInstall, "cdt_ins.exe");
  if (!exe || !existsSync(exe)) {
    return {
      ok: false,
      stage: "inserter_nets",
      error: `未找到 Fabric Inserter: ${exe || "cdt_ins.exe"}`,
      errors: [],
      diagnostics: ["请配置与 pds_shell 同一安装目录的 cdt_ins.exe"],
    };
  }

  const root = workDir || dirname(adfPath);
  const scriptPath = join(root, "fpga_nl_inserter.tcl");
  const probePath = join(root, "fpga_nl_inserter_probe");
  const script = [
    'puts "==PANGO_MCP_INS_BEGIN=="',
    `set new_status [catch {ins_new ${tclBrace(probePath)}} new_error]`,
    'puts "==PANGO_MCP_INS_NEW_STATUS==$new_status"',
    'puts "==PANGO_MCP_INS_NEW_ERROR==$new_error"',
    "if {$new_status == 0} {",
    `  set input_status [catch {ins_set_file -input ${tclBrace(adfPath)}} input_error]`,
    '  puts "==PANGO_MCP_INS_INPUT_STATUS==$input_status"',
    '  puts "==PANGO_MCP_INS_INPUT_ERROR==$input_error"',
    "  if {$input_status == 0} {",
    "    set list_status [catch {ins_list_nets} list_error]",
    '    puts "==PANGO_MCP_INS_LIST_STATUS==$list_status"',
    '    puts "==PANGO_MCP_INS_LIST_ERROR==$list_error"',
    "  }",
    "}",
    'puts "==PANGO_MCP_INS_END=="',
    "catch {exit}",
  ].join("\n");
  writeFileSync(scriptPath, script, "utf8");

  const args = [];
  if (part.device) args.push("-device", String(part.device));
  if (part.package) args.push("-package", String(part.package));
  if (part.speedgrade) args.push("-speedgrade", String(part.speedgrade));
  // cdt_ins forwards this argument through Tcl; a Windows backslash would be
  // consumed as an escape (notably `\f` in `\fpga...`).
  args.push("-file", scriptPath.replace(/\\/g, "/"));
  let result;
  try {
    result = await run(exe, args, { cwd: root, timeoutSec });
  } catch (err) {
    return phaseFailure("inserter_nets", { code: 1 }, String(err?.message || err), root, "cdt_ins 调用异常");
  }
  const log = `${result.stdout || ""}\n${result.stderr || ""}`;
  const entries = parseInserterNetList(log);
  const statusByStage = {
    new: markerStatus(log, "NEW"),
    input: markerStatus(log, "INPUT"),
    list: markerStatus(log, "LIST"),
  };
  const statuses = Object.values(statusByStage);
  const markersComplete = statuses.every((status) => status != null) && /==PANGO_MCP_INS_END==/.test(log);
  const errors = unique(
    String(log)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^E:|invalid command name|Executing\s*:.*failed|Net list is empty/i.test(line))
  );
  if (result.timedOut || Number(result.code || 0) !== 0 || !markersComplete || statuses.some((status) => status !== 0) || errors.length || !entries.length) {
    const headline = errors[0] || (result.timedOut
      ? "cdt_ins 超时"
      : !markersComplete
        ? "cdt_ins 脚本未完整执行"
        : !entries.length
          ? "Fabric Inserter 未返回任何可抽头网"
          : "cdt_ins 命令失败");
    return {
      ok: false,
      stage: "inserter_nets",
      error: `Fabric Inserter 网名枚举失败: ${headline}`,
      errors,
      diagnostics: unique(String(log).split(/\r?\n/).filter((line) => /==PANGO_MCP_INS_.*(?:STATUS|ERROR)==|^E:|failed|Net list is empty/i.test(line))).slice(-30),
      exitCode: Number(result.code || 0),
      timedOut: !!result.timedOut,
      statusByStage,
      log: tailLog(log),
      exe,
      adfPath,
    };
  }
  return { ok: true, entries, count: entries.length, exe, adfPath, statusByStage, log: tailLog(log, 20) };
}

function readParseableArtifact(path) {
  let bytes = readFileSync(path);
  if (/\.adf$/i.test(path) && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      bytes = gunzipSync(bytes);
    } catch {}
  }
  const text = bytes.toString("utf8");
  return /\bmodule\s+\\?\S+[\s\S]*?\bendmodule\b/.test(text) ? text : null;
}

// Discover real post-synth net names for a project. Synthesizes a sidecar copy of
// the project INPUTS (fresh plaintext .pds + copied sources/constraints) via
// pds_shell -file: immune to output encryption, never disturbs the real build dir.
// Same RTL + part + ADS tool => same flattening as the real build.
//   run     : core exec.run(file,args,{cwd,timeoutSec})
//   install : choosePdsInstall result (uses install.shell)
export async function discoverNets({ pdsPath, install, run, timeoutSec = 240 }) {
  let info;
  try {
    info = parsePdsProject(pdsPath);
  } catch (err) {
    return { ok: false, stage: "project_parse", error: `工程解析失败: ${err.message}`, errors: [], diagnostics: [err.message] };
  }
  if (!info.part?.device) return { ok: false, stage: "project_parse", error: "无法从工程解析器件(part)", errors: [], diagnostics: ["工程 part.device 为空"] };
  if (!info.sources?.length) return { ok: false, stage: "project_parse", error: "工程无 RTL 源(sources)", errors: [], diagnostics: ["工程输入清单中没有 RTL source"] };

  const work = mkdtempSync(join(tmpdir(), "fpga-nl-"));
  let staged;
  try {
    staged = stageProjectInputs({ projectInfo: info, workDir: work });
  } catch (err) {
    const details = err instanceof ProjectInputStageError ? err.details : {};
    return {
      ok: false,
      stage: "staging",
      error: `工程输入 staging 失败: ${err.message}`,
      errors: [],
      diagnostics: [err.message],
      staging: details,
      work,
    };
  }
  if (!staged.sources.length) return { ok: false, stage: "staging", error: "工程 RTL staging 后为空", errors: [], work };

  const topModule = info.topModule || basename(info.topSource || staged.sources[0].stagedPath).replace(/\.[^.]+$/, "");
  const ts = new Date().toISOString().slice(0, 19);
  // Exact widget keywords (a suffix like wgt_my_design_src_0 crashes the analyzer).
  // Multiple sources/constraints go as repeated (_file ...) inside one widget input.
  const fileItems = staged.sources
    .map((item, i) => {
      const isTop = item.isTop || (info.topSource ? item.path === info.topSource : i === 0);
      return `(_file "${item.stagedPath}"${isTop ? ` + "${topModule}"` : ""} (_format ${formatOf(item)})(_timespec "${ts}"))`;
    })
    .join("");
  const conItems = staged.constraints.map((item) => `(_file "${item.stagedPath}" (_format fdc)(_timespec "${ts}"))`).join("");
  const ipItems = staged.ipFiles
    .map((ip) => {
      const sources = ip.sourceItems.map((source) => `(_ip_source_item "${source.stagedPath}" (_timespec "${ts}"))`).join("");
      return `(_ip "${ip.stagedPath}" (_timespec "${ts}")${sources})`;
    })
    .join("");
  const setupWidgets = [
    `        (_widget wgt_my_design_src (_input ${fileItems}))`,
    ipItems ? `        (_widget wgt_my_ips_src (_input ${ipItems}))` : null,
    conItems ? `        (_widget wgt_import_logic_con_file (_input ${conItems}))` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const pds = `(_flow fab_demo "2022.2-rc2"
    (_comment "pango-mcp net-name discovery sidecar")
    (_version "1.0.9")
    (_status "initial")
    (_project (_option prj_work_dir (_string ".")) (_option prj_impl_dir (_string ".")))
    (_task tsk_setup
        (_widget wgt_select_arch (_input (_part (_family ${info.part.family})(_device ${info.part.device})(_speedgrade ${info.part.speedgrade})(_package ${info.part.package}))))
${setupWidgets})
    (_task tsk_compile       (_command cmd_compile       (_gci_state (_integer 0))))
    (_task tsk_synthesis     (_command cmd_synthesize    (_gci_state (_integer 0))(_option selected_syn_tool_opt (_integer 2))))
    (_task tsk_devmap        (_command cmd_devmap        (_gci_state (_integer 0))))
    (_task tsk_pnr           (_command cmd_pnr           (_gci_state (_integer 0))(_option fix_hold_violation (_switch ON))))
    (_task tsk_gen_bitstream (_command cmd_gen_bitstream (_gci_state (_integer 0)))))
`;
  const pdsCopy = join(work, `${sanitize(basename(pdsPath).replace(/\.pds$/i, "")) || "fab_demo"}.pds`);
  writeFileSync(pdsCopy, pds, "utf8");
  const pdsFwd = pdsCopy.replace(/\\/g, "/");

  const compileTcl = join(work, "fpga_nl_compile.tcl");
  writeFileSync(compileTcl, phaseTcl(pdsFwd, "compile", "COMPILE"), "utf8");
  let compileResult;
  try {
    compileResult = await run(install.shell, ["-file", compileTcl], { cwd: work, timeoutSec });
  } catch (err) {
    return phaseFailure("compile", { code: 1 }, String(err?.message || err), work, "pds_shell 调用异常");
  }
  const compileOut = `${compileResult.stdout || ""}\n${compileResult.stderr || ""}`;
  const compileLog = collectPhaseLog(work, "compile", compileOut);
  if (failedPhase(compileResult, compileLog)) return phaseFailure("compile", compileResult, compileLog, work, "compile 未成功完成");

  const adsTcl = join(work, "fpga_nl_run_ads.tcl");
  writeFileSync(adsTcl, phaseTcl(pdsFwd, "run_ads", "RUN_ADS"), "utf8");
  let adsResult;
  try {
    adsResult = await run(install.shell, ["-file", adsTcl], { cwd: work, timeoutSec });
  } catch (err) {
    return phaseFailure("run_ads", { code: 1 }, String(err?.message || err), work, "pds_shell 调用异常");
  }
  const adsOut = `${adsResult.stdout || ""}\n${adsResult.stderr || ""}`;
  const adsLog = collectPhaseLog(work, "run_ads", adsOut);
  if (failedPhase(adsResult, adsLog)) return phaseFailure("run_ads", adsResult, adsLog, work, "run_ads 未成功完成");

  const artifacts = findNetlistArtifacts(work);
  const netlistPath = artifacts.vmPath || artifacts.adfPath;
  if (!netlistPath || !existsSync(netlistPath)) {
    return {
      ok: false,
      stage: "netlist",
      error: "ADS 综合完成，但未在 PDS 合法输出目录找到可解析的 .vm/.adf 网表",
      errors: [],
      diagnostics: unique(String(adsLog).split(/\r?\n/).filter((line) => /^E:|Run process/i.test(line))).slice(-30),
      log: tailLog(adsLog),
      artifacts,
      work,
    };
  }
  const artifactHead = readFileSync(netlistPath).subarray(0, 512).toString("utf8");
  if (/effsoftecrypt/i.test(artifactHead)) {
    return { ok: false, stage: "netlist_parse", error: "综合网表被加密(effsoftecrypt) — 旁路失败", errors: [], netlistPath, artifacts, work };
  }
  const netlistText = readParseableArtifact(netlistPath);
  if (!netlistText) {
    return {
      ok: false,
      stage: "netlist_parse",
      error: `PDS 仅产出不可直接解析的 ${netlistPath.toLowerCase().endsWith(".adf") ? "ADF 数据库" : "网表"}；未找到 mapped-Verilog .vm`,
      errors: [],
      diagnostics: [`发现网表产物: ${netlistPath}`],
      artifacts,
      netlistPath,
      work,
    };
  }
  const parsed = parseVm(netlistText);
  if (!parsed.modules.length) {
    return { ok: false, stage: "netlist_parse", error: `网表中未解析到 Verilog module: ${netlistPath}`, errors: [], netlistPath, artifacts, work };
  }
  const inserter = await listInserterNets({
    adfPath: artifacts.adfPath,
    install,
    part: info.part,
    run,
    workDir: work,
    timeoutSec,
  });
  if (!inserter.ok) {
    return {
      ...inserter,
      netlistPath,
      artifacts: artifacts.candidates,
      work,
    };
  }
  parsed.inserterNets = inserter.entries;
  const summary = summarizeNetlist(parsed);
  return {
    ok: true,
    parsed,
    summary: { ...summary, inserterNetCount: inserter.count },
    inserterNets: inserter.entries,
    inserterExe: inserter.exe,
    netlistPath,
    netlistFormat: netlistPath.toLowerCase().endsWith(".vm") ? "vm" : "adf",
    vmPath: artifacts.vmPath,
    adfPath: artifacts.adfPath,
    artifacts: artifacts.candidates,
    work,
    part: info.part,
    topModule: parsed.topModule,
    staged: {
      sources: staged.sources.map((item) => item.stagedPath),
      constraints: staged.constraints.map((item) => item.stagedPath),
      ips: staged.ipFiles.map((item) => item.stagedPath),
      includes: staged.includeFiles.map((item) => item.path),
    },
  };
}
