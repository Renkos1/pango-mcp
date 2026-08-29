// ModelSim/Questa toolchain — MCP tool registration.
// Headless HDL simulation under full MCP control, mirroring the PDS philosophy:
//   - never trust the exit code; judge ok by parsing the transcript;
//   - compact summary by default + detail:"full" escape hatch + input-hash cache;
//   - a small set of curated tools (sim/compile) plus two guarded generic
//     dispatchers (msim_do for any vsim Tcl, msim_exe for any bin util) so the
//     long tail (coverage, UVM, force/examine, WLF↔VCD) is reachable without a
//     tool per feature.
// VCD output is produced via a do-file so the existing fpga_assert tool judges
// ModelSim waveforms unchanged. VHDL (vcom) is the real edge over fpga_sim.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { run, safeReadText, spawnDetached, toTclPath, toolError, toolResult } from "../../core/exec.mjs";
import { attachLog, capList } from "../../core/logparse.mjs";
import { hashFiles, hashParts, loadCachedSummary, runStoreDir, writeRunLog, writeRunSummary } from "../../core/runstore.mjs";
import {
  HDL_EXT,
  MODELSIM,
  MSIM_EXE_ALLOWLIST,
  VERILOG_EXT,
  VHDL_EXT,
  msimTool,
} from "./install.mjs";
import { judgeModelsimOk, modelsimKeyLines, parseCoverageByInstance, parseCoverageReport, parseModelsimLog, parseUvmReport } from "./logparse.mjs";
import { register as registerKnowledge } from "./knowledge.mjs";
import { getExecutor, getHost } from "../../core/executor.mjs";
import { renderVcdToFiles } from "../../core/waveform.mjs";
import { parseVcd } from "../../core/vcd.mjs";
import { evaluateAssertions } from "../../core/assert.mjs";

const BUILD_SUBDIR = "._fpga_msim";

// fpga_msim_do confirm gate. Pure simulation is non-destructive and runs freely,
// but a do/Tcl script can also reach the host: `exec` spawns host programs, the
// `file delete|rename|copy|mkdir` subcommands mutate the filesystem, and `open`
// in write/append mode creates/overwrites files. Those need an explicit
// confirm:true, mirroring fpga_cdt's detectMutatingCdt guard. `sh`/`system` are
// intentionally NOT matched (too broad — collides with signal names like
// `examine sh`); the access mode must be a whitespace-separated token so signal
// paths ending in w/a (e.g. /dut/wa) don't false-positive.
const SUSPICIOUS_DO = [
  { re: /\bexec\b/i, label: (m) => m[0].toLowerCase() },
  { re: /\bfile\s+(delete|rename|copy|mkdir)\b/i, label: (m) => m[0].toLowerCase().replace(/\s+/g, " ") },
  { re: /\bopen\b[^\n]*?\s([waWA]\+?|[rR]\+)(\s|$|\])/, label: () => "open(write)" },
  // Everything above matches a literal. Tcl does not have to write one: `eval`,
  // `subst`, `source` and `uplevel` run text assembled at run time, so a script
  // using them can reach `exec` or `file delete` without those words appearing.
  // Unlike fpga_cdt's commands[], a .do file is free-form by design, so this
  // flags rather than rejects and the operator decides.
  { re: /\b(eval|subst|source|uplevel)\b/i, label: (m) => m[0].toLowerCase() },
];

// Substitution only rewrites what runs when it lands in COMMAND position:
// `[format ex%s ec] ...` and `$cmd ...` become a different command, while the
// `[open ...]` in `set fh [open "in.txt" r]` is an argument and cannot rename
// `set`. Flagging every `[` would make the gate fire on ordinary Tcl and train
// the operator to pass confirm:true reflexively, which is worse than not asking.
function substitutedCommandName(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    for (const segment of line.split(";")) {
      const first = segment.trim().split(/\s+/)[0] || "";
      if (first.startsWith("[") || first.includes("$")) return first.startsWith("[") ? "[]-command" : "$-command";
    }
  }
  return null;
}

// Return the distinct suspicious tokens found in a do/Tcl body (empty => safe).
export function detectSuspiciousDo(text) {
  const s = String(text || "");
  const found = new Set();
  for (const { re, label } of SUSPICIOUS_DO) {
    const m = re.exec(s);
    if (m) found.add(label(m));
  }
  const substituted = substitutedCommandName(s);
  if (substituted) found.add(substituted);
  return [...found];
}

// Resolve the source list to absolute paths and split by language. Empty
// `sources` => auto-detect HDL files in workdir (excluding dotfiles / our build
// dir), matching fpga_sim's convenience.
function resolveSources(workdir, sources) {
  let names = sources && sources.length ? sources : readdirSync(workdir).filter((f) => HDL_EXT.test(f) && !f.startsWith(".") && !f.startsWith("_"));
  const abs = names.map((n) => (isAbsolute(n) ? n : resolve(workdir, n)));
  const missing = abs.filter((p) => !existsSync(p));
  if (missing.length) return { error: `源文件不存在: ${missing.join(", ")}` };
  return {
    all: abs,
    verilog: abs.filter((p) => VERILOG_EXT.test(p)),
    vhdl: abs.filter((p) => VHDL_EXT.test(p)),
    hasSv: abs.some((p) => /\.(sv|svh|svp)$/i.test(p)),
  };
}

// vlib + vcom(VHDL) + vlog(Verilog/SV) into a fresh `lib` under buildDir.
// Returns the concatenated compile transcript, its parse, and a compileOk flag.
// VHDL is compiled before Verilog (common mixed-language ordering); designs
// needing finer interleaving use fpga_msim_do.
async function compileSources({ buildDir, lib, verilog, vhdl, hasSv, vlogArgs = [], vcomArgs = [], coverage = false, fileList = null, libDirs = [], timeoutSec }) {
  rmSync(join(buildDir, lib), { recursive: true, force: true });
  const steps = [];
  // Coverage instrumentation at compile (branch/condition/statement/toggle).
  const coverArgs = coverage ? ["-cover", "bcst"] : [];
  // IP support: -F reads a vlog filelist with paths resolved RELATIVE TO THE
  // FILELIST (Pango ships these for PCIe/DDR/etc.); -y + libext let vlog
  // auto-resolve only the vendor primitives a design actually instantiates.
  const fileListArgs = fileList ? ["-F", fileList] : [];
  const libArgs = libDirs.length ? [...libDirs.flatMap((d) => ["-y", d]), "+libext+.v+.sv+.vp+.svp"] : [];
  const vlibRes = await run(msimTool("vlib"), [lib], { cwd: buildDir, timeoutSec });
  steps.push({ tool: "vlib", code: vlibRes.code, log: (vlibRes.stdout + vlibRes.stderr).trim() });

  if (vhdl.length) {
    const res = await run(msimTool("vcom"), ["-quiet", "-work", lib, ...coverArgs, ...vcomArgs, ...vhdl], { cwd: buildDir, timeoutSec });
    steps.push({ tool: "vcom", code: res.code, log: (res.stdout + res.stderr).trim() });
  }
  // Run vlog when there are Verilog/SV sources OR a filelist/lib search to honor
  // (encrypted .vp/.svp IP and library dirs both come through vlog).
  if (verilog.length || fileList || libDirs.length) {
    const args = ["-quiet", "-work", lib, ...coverArgs, ...(hasSv || fileList || libDirs.length ? ["-sv"] : []), ...libArgs, ...fileListArgs, ...vlogArgs, ...verilog];
    const res = await run(msimTool("vlog"), args, { cwd: buildDir, timeoutSec });
    steps.push({ tool: "vlog", code: res.code, log: (res.stdout + res.stderr).trim() });
  }

  const log = steps.map((s) => `$ ${s.tool}\n${s.log}`).join("\n\n");
  // Parse each compile step's own transcript so the per-step "Errors: N"
  // summary is unambiguous, then aggregate.
  let errorCount = 0;
  let warningCount = 0;
  const diagnostics = [];
  const errors = [];
  const errorsDetailed = [];
  for (const s of steps) {
    if (s.tool === "vlib") continue;
    const p = parseModelsimLog(s.log);
    errorCount += p.summary ? p.summary.errors : p.errorCount;
    warningCount += p.summary ? p.summary.warnings : p.warningCount;
    errors.push(...p.errors);
    errorsDetailed.push(...(p.errorsDetailed || []));
    diagnostics.push(...p.diagnostics);
  }
  return { log, steps, ok: errorCount === 0, errorCount, warningCount, errors, errorsDetailed, diagnostics };
}

function buildDir(workdir) {
  const dir = join(workdir, BUILD_SUBDIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// vsim -c do-script: optional VCD capture, optional user pre-run commands, the
// run command, then a forced quit so -c never hangs.
function buildRunDo({ vcd, vcdResolved, doBeforeRun, runArg, coverage, coverageUcdb, coverageDetails }) {
  const lines = [];
  if (vcd) {
    lines.push(`vcd file {${toTclPath(vcdResolved)}}`);
    lines.push("vcd add -r /*");
  }
  if (doBeforeRun) lines.push(doBeforeRun);
  lines.push(`run ${runArg}`);
  // Coverage commands must run AFTER the run; vsim is started with -onfinish
  // stop so a testbench $finish returns here instead of exiting the simulator.
  if (coverage) {
    lines.push("coverage report -summary");
    if (coverageDetails) lines.push(`coverage report -details -file {${toTclPath(coverageDetails)}}`);
    lines.push(`coverage save {${toTclPath(coverageUcdb)}}`);
  }
  lines.push("quit -f");
  return lines.join("\n");
}

function compileSummary({ phase, ok, comp, parsed, install, lib, languages, sources, durationMs, detail, logPath, command, cached = false, extra = {} }) {
  const errs = capList(parsed.errors, 40);
  const result = {
    ok,
    phase,
    source: "modelsim",
    cached,
    modelsimVersion: install.id,
    command,
    lib,
    languages,
    sourceCount: sources.length,
    durationMs,
    errorCount: parsed.errorCount,
    errors: errs.items,
    errorsDetailed: parsed.errorsDetailed && parsed.errorsDetailed.length ? parsed.errorsDetailed.slice(0, 40) : undefined,
    errorsTruncated: errs.truncated,
    warningCount: parsed.warningCount ?? null,
    diagnostics: { knownIssues: parsed.diagnostics || [] },
    ...extra,
  };
  if (comp) {
    result.exitCode = comp.code;
    result.timedOut = comp.timedOut;
  }
  result.keyLines = modelsimKeyLines(extra.__rawLog ?? "");
  delete result.__rawLog;
  return result;
}

// Resolve the ModelSim install for a remote host from its config (Windows).
function remoteMsimInstall(host) {
  const cfg = getHost(host);
  if (!cfg) throw new Error(`未知 host '${host}'`);
  const home = cfg.modelsim?.home;
  if (!home) throw new Error(`host '${host}' 未配置 ModelSim（pango-mcp.config.json: hosts.${host}.modelsim.home）`);
  const sep = (cfg.os || "windows") === "windows" ? "\\" : "/";
  const binDir = `${home}${sep}win64`;
  return { home, binDir, sep, license: cfg.modelsim?.license || null, tool: (name) => `${binDir}${sep}${String(name).replace(/\.exe$/i, "")}.exe` };
}

// Remote run-phase do-file: relative artifact names (cwd = staged remote dir).
function buildRemoteRunDo({ vcd, doBeforeRun, runArg, coverage }) {
  const lines = [];
  if (vcd) {
    lines.push("vcd file {sim.vcd}");
    lines.push("vcd add -r /*");
  }
  if (doBeforeRun) lines.push(doBeforeRun);
  lines.push(`run ${runArg}`);
  if (coverage) {
    lines.push("coverage report -summary");
    lines.push("coverage save {coverage.ucdb}");
  }
  lines.push("quit -f");
  return lines.join("\n");
}

const winQ = (s) => `"${String(s).replace(/"/g, '""')}"`;

// VCD full name ("tb.u.q [7:0]") -> ModelSim wave path ("/tb/u/q").
function vcdToWavePath(full) {
  return `/${String(full).replace(/\s+\[[^\]]+\]$/, "").replace(/\./g, "/")}`;
}

// Build the GUI `add wave` do-script. Activates ModelSim wave-window UX: signals
// auto-grouped by hierarchy scope (or explicit `groups`), bus radix (default
// hex), name/value column widths, then zoom-to-fit. No `quit` — the GUI stays.
// Falls back to `add wave -r /*` when no VCD is available to enumerate signals.
export function buildViewDo(vcd, { groups = null, signals = null, radix = "hex" } = {}) {
  const lines = ["configure wave -namecolwidth 240", "configure wave -valuecolwidth 110", "configure wave -timelineunits ns"];
  // Dedup: ModelSim bit-blasts buses into per-bit VCD vars (q [7]..q [0]) that
  // all strip to the same wave path; one `add wave /scope/q` shows the bus.
  const grp = (name, paths) => {
    const uniq = [...new Set(paths)];
    if (uniq.length) lines.push(`add wave -group {${String(name).replace(/[{}]/g, "")}} -radix ${radix} ${uniq.join(" ")}`);
  };
  if (groups && groups.length) {
    for (const g of groups) grp(g.name, (g.signals || []).map((s) => (String(s).startsWith("/") ? s : vcdToWavePath(s))));
  } else if (signals && signals.length && vcd) {
    const paths = signals.map((name) => {
      const s = vcd.signals.find((x) => x.full === name || x.ref === name || x.full.endsWith(`.${name}`));
      return s ? vcdToWavePath(s.full) : (String(name).startsWith("/") ? name : vcdToWavePath(name));
    });
    grp("signals", paths);
  } else if (vcd && vcd.signals.length) {
    const byScope = new Map();
    for (const s of vcd.signals) {
      const stripped = s.full.replace(/\s+\[[^\]]+\]$/, "");
      const i = stripped.lastIndexOf(".");
      const scope = i >= 0 ? stripped.slice(0, i) : "(top)";
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(`/${stripped.replace(/\./g, "/")}`);
    }
    for (const [scope, paths] of byScope) grp(scope, paths);
  } else {
    lines.push("add wave -r /*");
  }
  lines.push("wave zoom full");
  return `${lines.join("\n")}\n`;
}

// Remote fpga_msim_sim / fpga_msim_compile: stage sources to a remote temp dir,
// run the whole vlib→[vcom]→[vlog](→vsim for sim) sequence as ONE chained cmd
// (so cwd persists for the `work` lib), pull artifacts (VCD/ucdb) to a local
// mirror, judge ok from the same transcript parser. mode="sim"|"compile".
// fileList/libDirs here are REMOTE-side paths (the host's PDS install), passed
// straight to vlog -F/-y — not staged. Input-hash cached per host+options.
async function runMsimRemote({ mode, host, exec, workdir, src, top, lib, fileList, libDirs = [], vcd, coverage, uvm, uvmTest, wave = false, waveSignals, waveOpen = false, assertions, runArg, doBeforeRun, vlogArgs = [], vcomArgs = [], vsimArgs = [], detail, timeoutSec, started, cache = true }) {
  const inst = remoteMsimInstall(host);
  const sep = inst.sep;
  const isSim = mode === "sim";
  const localBdir = buildDir(workdir);

  const cacheKey = hashParts([
    host, "remote", mode, hashFiles(src.all), top || "", lib, runArg || "",
    JSON.stringify({ vcd, coverage, uvm, uvmTest: uvmTest || "", wave, waveSignals: waveSignals || null, assertions: assertions || null, fileList: fileList || "", libDirs, doBeforeRun: doBeforeRun || "", vlogArgs, vcomArgs, vsimArgs }),
    inst.home,
  ]);
  const cacheDir = runStoreDir(workdir, cacheKey);
  const mirror = join(localBdir, "remote", String(host), cacheKey.slice(0, 16));
  if (cache) {
    const prev = loadCachedSummary(cacheDir);
    const artifactsOk = !prev?.artifacts?.vcd || existsSync(prev.artifacts.vcd);
    if (prev && prev.ok && artifactsOk) {
      const hit = { ...prev, cached: true, hint: "命中远程缓存(输入未变)；cache:false 重跑。" };
      if (detail === "full" && prev.logPath && existsSync(prev.logPath)) attachLog(hit, safeReadText(prev.logPath), { detail: "full", logPath: prev.logPath });
      return toolResult(hit);
    }
  }

  const rdir = await exec.mkdtemp("fpgamsim-");
  for (const abs of src.all) await exec.putFile(abs, `${rdir}${sep}${basename(abs)}`);
  if (isSim) {
    const doLocal = join(localBdir, "run.remote.do");
    writeFileSync(doLocal, buildRemoteRunDo({ vcd, doBeforeRun, runArg, coverage }), "utf8");
    await exec.putFile(doLocal, `${rdir}${sep}run.do`);
  }

  const verilog = src.verilog.map((p) => basename(p));
  const vhdl = src.vhdl.map((p) => basename(p));
  const coverArgs = coverage ? ["-cover", "bcst"] : [];
  const uvmVlog = uvm ? ["-sv", `+incdir+${inst.home}${sep}verilog_src${sep}uvm-1.1d${sep}src`, "-L", "mtiUvm"] : [];
  const fileListArgs = fileList ? ["-F", fileList] : [];
  const libArgs = libDirs.length ? [...libDirs.flatMap((d) => ["-y", d]), "+libext+.v+.sv+.vp+.svp"] : [];
  const needSv = src.hasSv || uvm || !!fileList || libDirs.length;

  const seg = (toolName, args) => [winQ(inst.tool(toolName)), ...args].join(" ");
  const segs = [`cd /d ${winQ(rdir)}`, seg("vlib", [lib])];
  if (vhdl.length) segs.push(seg("vcom", ["-quiet", "-work", lib, ...coverArgs, ...vcomArgs, ...vhdl]));
  if (verilog.length || fileList || libDirs.length) {
    segs.push(seg("vlog", ["-quiet", "-work", lib, ...coverArgs, ...(needSv ? ["-sv"] : []), ...uvmVlog, ...libArgs, ...fileListArgs, ...vlogArgs, ...verilog]));
  }
  if (isSim) {
    const userVopt = vsimArgs.some((a) => /^-voptargs/i.test(String(a)));
    const voptParts = [...(vcd ? ["+acc"] : []), ...(coverage ? ["+cover=bcst"] : [])];
    const voptArgs = voptParts.length && !userVopt ? [`-voptargs=${voptParts.join(" ")}`] : [];
    const covRun = coverage ? ["-coverage", "-onfinish", "stop"] : [];
    const uvmRun = uvm ? ["-L", "mtiUvm", ...(uvmTest ? [`+UVM_TESTNAME=${uvmTest}`] : [])] : [];
    segs.push(seg("vsim", ["-c", "-do", "run.do", ...covRun, ...uvmRun, ...voptArgs, ...vsimArgs, `${lib}.${top}`]));
  }
  const lic = inst.license ? `set MGLS_LICENSE_FILE=${inst.license}&&set LM_LICENSE_FILE=${inst.license}&&` : "";
  const chain = `cmd /c "${lic}${segs.join(" && ")}"`;

  const res = await exec.exec(chain, { timeoutSec });
  const log = (res.stdout + res.stderr).trim();
  const parsed = parseModelsimLog(log);
  const coverageData = isSim && coverage ? parseCoverageReport(log) : null;
  const uvmData = isSim && uvm ? parseUvmReport(log) : null;
  const ok = judgeModelsimOk(parsed, { exitCode: res.code, timedOut: res.timedOut }) && (!uvmData || (uvmData.error === 0 && uvmData.fatal === 0));

  // Pull just the artifacts (not the whole remote work lib) into a local mirror.
  rmSync(mirror, { recursive: true, force: true });
  mkdirSync(mirror, { recursive: true });
  let vcdLocal = null;
  let ucdbLocal = null;
  if (isSim && vcd) { try { await exec.getFile(`${rdir}${sep}sim.vcd`, join(mirror, "sim.vcd")); vcdLocal = join(mirror, "sim.vcd"); } catch {} }
  if (isSim && coverage) { try { await exec.getFile(`${rdir}${sep}coverage.ucdb`, join(mirror, "coverage.ucdb")); ucdbLocal = join(mirror, "coverage.ucdb"); } catch {} }
  // Turnkey waveform: render the VCD pulled back from the host.
  let waveSvg = null;
  let waveHtml = null;
  let waveInfo = null;
  if (isSim && wave && vcdLocal) {
    try {
      const w = await renderVcdToFiles(vcdLocal, { signals: waveSignals, open: waveOpen, title: `${top} waveform @${host}` });
      waveSvg = w.svgPath;
      waveHtml = w.htmlPath;
      waveInfo = { svgPath: w.svgPath, htmlPath: w.htmlPath, signalCount: w.signalCount, truncated: w.truncated };
    } catch {}
  }

  // Composite assertions (declarative spec) on the pulled-back transcript/VCD.
  let assertData = null;
  if (isSim && assertions?.length) {
    const vcdForAssert = vcdLocal ? parseVcd(vcdLocal) : null;
    const ares = evaluateAssertions({ log, vcd: vcdForAssert, assertions });
    const af = ares.filter((r) => !r.ok).length;
    assertData = { passed: ares.length - af, failed: af, results: ares };
  }
  const okFinal = ok && (!assertData || assertData.failed === 0);

  const languages = [src.verilog.length ? (src.hasSv ? "sv" : "verilog") : null, src.vhdl.length ? "vhdl" : null].filter(Boolean);
  const logPath = writeRunLog(cacheDir, "build.log", log);
  const result = {
    ok: okFinal,
    phase: isSim ? "msim_sim" : "msim_compile",
    source: "modelsim",
    scope: "remote",
    cached: false,
    host,
    remoteHome: inst.home,
    lib,
    languages,
    ...(isSim ? { top } : {}),
    sourceCount: src.all.length,
    durationMs: Date.now() - started,
    exitCode: res.code,
    timedOut: res.timedOut,
    errorCount: parsed.errorCount,
    errors: capList(parsed.errors, 40).items,
    warningCount: parsed.warningCount ?? null,
    diagnostics: { knownIssues: parsed.diagnostics || [] },
    ...(isSim ? { run: { summary: parsed.summary, finished: parsed.finished, fatal: parsed.fatal }, coverage: coverageData, uvm: uvmData, assert: assertData || undefined, wave: waveInfo || undefined } : {}),
    artifacts: isSim ? { vcd: vcdLocal, coverageUcdb: ucdbLocal, waveSvg, waveHtml, remoteDir: rdir, mirror } : { remoteDir: rdir },
    keyLines: modelsimKeyLines(log),
    hint: okFinal
      ? undefined
      : assertData && assertData.failed
        ? `${assertData.failed} 条断言失败：读 assert.results。`
        : uvmData && (uvmData.error || uvmData.fatal)
          ? `UVM 测试失败：UVM_ERROR=${uvmData.error}/UVM_FATAL=${uvmData.fatal}；读 keyLines。`
          : "远程 transcript 含 ** Error/Fatal 或 Errors:>0；读 errors/diagnostics。",
  };
  attachLog(result, log, { detail, logPath });
  if (okFinal) {
    const copy = { ...result };
    delete copy.log;
    delete copy.tail;
    copy.truncated = result.truncated;
    writeRunSummary(cacheDir, copy);
  }
  return toolResult(result);
}

// Open the local ModelSim GUI waveform viewer on a VCD (auto vcd2wlf) or WLF,
// with hierarchy grouping / bus radix / zoom-fit. Shared by fpga_msim_view and
// fpga_msim_sim's view:true. GUI is always local (remote VCDs are pulled first);
// returns a plain object (caller wraps in toolResult/toolError).
async function launchView({ vcdPath = null, wlfPath = null, signals = null, groups = null, radix = "hex", launch = true, timeoutSec = 120 }) {
  if (!existsSync(msimTool("vsim"))) return { ok: false, error: `未找到本机 ModelSim(vsim)：${MODELSIM.binDir}` };
  let wlf = wlfPath || null;
  let vcdParsed = null;
  if (!wlf) {
    if (!vcdPath || !isAbsolute(vcdPath) || !existsSync(vcdPath)) return { ok: false, error: "需 vcdPath 或 wlfPath（绝对路径）" };
    if (statSync(vcdPath).size === 0) return { ok: false, error: `VCD 为空: ${vcdPath}` };
    try { vcdParsed = parseVcd(vcdPath); } catch {}
    wlf = `${vcdPath.replace(/\.vcd$/i, "")}.wlf`;
    const conv = await run(msimTool("vcd2wlf"), [vcdPath, wlf], { timeoutSec });
    if (conv.code !== 0 || !existsSync(wlf)) return { ok: false, error: `vcd2wlf 转换失败: ${(conv.stdout + conv.stderr).trim().slice(-200)}` };
  } else if (!isAbsolute(wlf) || !existsSync(wlf)) {
    return { ok: false, error: `wlfPath 不存在或非绝对路径: ${wlf}` };
  }
  const viewDo = buildViewDo(vcdParsed, { groups, signals, radix });
  const groupCount = (viewDo.match(/add wave -group/g) || []).length;
  const doFile = join(dirname(wlf), "._view.do");
  writeFileSync(doFile, viewDo, "utf8"); // no quit — GUI stays open
  const args = ["-gui", "-view", wlf, "-do", doFile];
  if (!launch) return { ok: true, launched: false, wlf, groups: groupCount, radix, doScript: viewDo, command: { exe: msimTool("vsim"), args } };
  const pid = spawnDetached(msimTool("vsim"), args, { cwd: dirname(wlf) });
  return { ok: true, launched: true, pid, wlf, groups: groupCount, radix, command: { exe: msimTool("vsim"), args } };
}

export function register(server) {
  // ---- fpga_msim_sim : compile (vlog/vcom) + headless vsim run -------------
  server.registerTool(
    "fpga_msim_sim",
    {
      title: "ModelSim 仿真 (vlib+vlog/vcom+vsim -c)",
      description:
        "用 ModelSim 头less 编译(Verilog/SV→vlog，VHDL→vcom)并运行(vsim -c -do)一个设计(含 testbench)。不信退出码：以 transcript 的 ** Error/Fatal 与 'Errors: N' 判定 ok（$fatal 时 vsim 仍退 0）。可出 VCD 供 fpga_assert 判定；可选 coverage 返回结构化覆盖率(分支/语句/条件/翻转 %)。默认紧凑摘要 + detail:'full' + 按输入 hash 缓存。VHDL 是相对 fpga_sim(iverilog) 的增量能力。",
      inputSchema: {
        workdir: z.string().describe("工作目录绝对路径(HDL 源所在；编译产物隔离在 ._fpga_msim/)"),
        top: z.string().describe("顶层模块/实体名(通常是零端口 testbench)"),
        sources: z.array(z.string()).optional().describe("相对 workdir 或绝对的源文件；省略=workdir 下所有 .v/.sv/.vhd(排除 . 与 _ 前缀)"),
        lib: z.string().optional().describe("工作库名，默认 work"),
        host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts，需配 hosts.<id>.modelsim.home；省略=本机）。远程时源文件推到该设备编译+仿真，产物(VCD/coverage ucdb)拉回本地镜像供 fpga_assert。"),
        fileList: z.string().optional().describe("vlog 文件清单(.f)路径(相对 workdir 或绝对)，经 -F 读入(清单内相对路径相对清单所在目录解析)。用于含 IP 的仿真：直接喂 PDS 生成的/随 PDS 的 IP 仿真清单(如 PCIe filelist_pciegen*_gtp.f)。加密 IP(.vp/.svp，IEEE-1735 含 Mentor key)由 vlog 原生解密，无需走 PDS 仿真渠道。"),
        libDirs: z.array(z.string()).optional().describe("vlog 库搜索目录(相对 workdir 或绝对)，经 -y +libext 让 vlog 按需自动解析设计实例化到的厂商原语仿真模型(如 Pango arch/.../verilog/fm_lib/simulation 或 gtp_lib 所在目录)，无需手列每个 GTP_*.v。"),
        vcd: z.boolean().optional().describe("是否生成 VCD(经 do-file: vcd file + vcd add -r /*)，默认 false。开启时自动加 -voptargs=+acc 保留信号可见性(否则 vopt 优化掉信号，VCD 为空)。"),
        coverage: z.boolean().optional().describe("是否收集代码覆盖率(分支/条件/语句/翻转)，默认 false。开启=编译加 -cover bcst + vsim -coverage -onfinish stop + 自动 +cover；run 后 coverage report/save，返回结构化 coverage{total,metrics{branch/statement/condition/toggle:{bins,hits,misses,pct}}} + artifacts.coverageUcdb。"),
        wave: z.boolean().optional().describe("仿真后把 VCD 渲染成波形图(SVG+HTML)，默认 false。**自动启用 VCD**(含 +acc 保信号)；产出见 artifacts.waveSvg/waveHtml。一步出图给用户看，免再调 fpga_wave。"),
        waveSignals: z.array(z.string()).optional().describe("wave 只画这些信号(省略=全部，上限 40)"),
        waveOpen: z.boolean().optional().describe("wave 出图后用默认浏览器弹给用户看(本机)，默认 false"),
        assertions: z
          .array(
            z.object({
              name: z.string().optional(),
              type: z.enum(["log_contains", "log_not_contains", "log_regex", "log_not_regex", "vcd_final_eq", "vcd_at_eq", "vcd_never_eq"]),
              pattern: z.string().optional(),
              flags: z.string().optional(),
              signal: z.string().optional(),
              value: z.union([z.string(), z.number(), z.boolean()]).optional(),
              time: z.number().optional(),
            })
          )
          .optional()
          .describe("一步内做声明式断言(同 fpga_assert)：log_*/vcd_*。**任一 vcd_* 自动启用 VCD**；断言失败则整体 ok=false(断言即规格)。结果在 assert{passed,failed,results}。免再单独调 fpga_assert。"),
        uvm: z.boolean().optional().describe("是否按 UVM 测试编译/运行，默认 false。开启=用预编译 mtiUvm 库(无需 gcc/DPI)：编译加 -sv +incdir+<uvm src> -L mtiUvm，vsim 加 -L mtiUvm；解析 UVM Report Summary，**UVM_ERROR/UVM_FATAL>0 即 ok=false**(ModelSim 退出码/Errors 仍可能为 0，反幻觉)。返回 uvm{info,warning,error,fatal}。"),
        uvmTest: z.string().optional().describe("UVM 测试名，传给 +UVM_TESTNAME=<名>(顶层需 run_test())。省略则由 TB 的 run_test(\"...\") 决定。"),
        vcdPath: z.string().optional().describe("VCD 输出路径(相对 workdir 或绝对)；vcd=true 时默认 ._fpga_msim/sim.vcd"),
        runArg: z.string().optional().describe("vsim run 参数，默认 '-all'(可为 '1us' 等定长)"),
        doBeforeRun: z.string().optional().describe("run 前注入的额外 Tcl(如 force/add wave/coverage 配置)"),
        vlogArgs: z.array(z.string()).optional().describe("追加给 vlog 的参数，如 +define+X、-timescale 1ns/1ps"),
        vcomArgs: z.array(z.string()).optional().describe("追加给 vcom 的参数，如 -2008"),
        vsimArgs: z.array(z.string()).optional().describe("追加给 vsim 的参数，如 -gG=1、+UVM_TESTNAME=..."),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary(省 token)；full 含完整 transcript"),
        cache: z.boolean().optional().describe("源文件+选项未变时复用上次摘要，默认 true；false 强制重跑"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ workdir, top, sources, lib = "work", host, fileList, libDirs = [], vcd = false, coverage = false, uvm = false, uvmTest, wave = false, waveSignals, waveOpen = false, assertions, vcdPath, runArg = "-all", doBeforeRun, vlogArgs = [], vcomArgs = [], vsimArgs = [], detail = "summary", cache = true, timeoutSec = 120 }) => {
      if (!isAbsolute(workdir) || !existsSync(workdir)) return toolError(`workdir 不存在或非绝对路径: ${workdir}`);
      const src = resolveSources(workdir, sources);
      if (src.error) return toolError(src.error);
      if (!src.all.length && !fileList && !(libDirs || []).length) return toolError(`workdir 无 HDL 源文件: ${workdir}（含 IP 时也可用 fileList/libDirs）`);
      if (wave) vcd = true; // waveform needs the VCD (and +acc) — auto-enable
      if (assertions?.some((a) => String(a.type).startsWith("vcd_"))) vcd = true; // VCD assertions need a VCD
      const started = Date.now();

      // Remote execution device: stage sources + run on the host, pull artifacts.
      // fileList/libDirs are REMOTE-side paths (the host's PDS install), passed
      // through to the remote vlog -F/-y (not staged from local).
      let exec;
      try {
        exec = getExecutor(host);
      } catch (e) {
        return toolError(e.message);
      }
      if (exec.isRemote) {
        try {
          return await runMsimRemote({ mode: "sim", host, exec, workdir, src, top, lib, fileList, libDirs, vcd, coverage, uvm, uvmTest, wave, waveSignals, waveOpen, assertions, runArg, doBeforeRun, vlogArgs, vcomArgs, vsimArgs, detail, timeoutSec, started, cache });
        } catch (e) {
          return toolError(`远程 ModelSim 执行失败 (host=${host}): ${e.message}`);
        } finally {
          await exec.close();
        }
      }

      // ---- local ----
      const fileListAbs = fileList ? (isAbsolute(fileList) ? fileList : resolve(workdir, fileList)) : null;
      if (fileListAbs && !existsSync(fileListAbs)) return toolError(`fileList 不存在: ${fileListAbs}`);
      const libDirsAbs = (libDirs || []).map((d) => (isAbsolute(d) ? d : resolve(workdir, d)));
      if (!existsSync(msimTool("vsim")) || !existsSync(msimTool("vlib"))) return toolError(`未找到 ModelSim(vsim/vlib)：${MODELSIM.binDir}。设 PANGO_MCP_MODELSIM_HOME 或 config.modelsimHome。`);
      if (uvm && !MODELSIM.uvmIncDir) return toolError(`未找到 UVM include(verilog_src/uvm-*/src)：该 ModelSim 安装可能不含 UVM。home=${MODELSIM.home}`);
      if (src.verilog.length && !existsSync(msimTool("vlog"))) return toolError("未找到 vlog，无法编译 Verilog/SV");
      if (src.vhdl.length && !existsSync(msimTool("vcom"))) return toolError("未找到 vcom，无法编译 VHDL");

      const bdir = buildDir(workdir);
      const vcdResolved = vcd ? (vcdPath ? (isAbsolute(vcdPath) ? vcdPath : resolve(workdir, vcdPath)) : join(bdir, "sim.vcd")) : null;
      const languages = [src.verilog.length ? (src.hasSv ? "sv" : "verilog") : null, src.vhdl.length ? "vhdl" : null].filter(Boolean);

      const cacheKey = hashParts([
        hashFiles(src.all),
        top,
        lib,
        runArg,
        JSON.stringify({ vcd, coverage, uvm, uvmTest: uvmTest || "", wave, waveSignals: waveSignals || null, assertions: assertions || null, fileList: fileListAbs || "", libDirs: libDirsAbs, doBeforeRun: doBeforeRun || "", vlogArgs, vcomArgs, vsimArgs }),
        MODELSIM.home,
      ]);
      const cacheDir = runStoreDir(workdir, cacheKey);
      if (cache) {
        const prev = loadCachedSummary(cacheDir);
        const vcdStillThere = !prev?.artifacts?.vcd || existsSync(prev.artifacts.vcd);
        if (prev && prev.ok && vcdStillThere) {
          const hit = { ...prev, cached: true, hint: "命中仿真缓存(输入未变)，跳过重跑；需重跑用 cache:false。" };
          if (detail === "full" && prev.logPath && existsSync(prev.logPath)) attachLog(hit, safeReadText(prev.logPath), { detail: "full", logPath: prev.logPath });
          return toolResult(hit);
        }
      }

      // UVM: compile the TB against the precompiled mtiUvm library (no gcc/DPI).
      const uvmVlogArgs = uvm ? ["-sv", `+incdir+${MODELSIM.uvmIncDir}`, "-L", MODELSIM.uvmLib] : [];
      const compiled = await compileSources({ buildDir: bdir, lib, verilog: src.verilog, vhdl: src.vhdl, hasSv: src.hasSv, vlogArgs: [...uvmVlogArgs, ...vlogArgs], vcomArgs, coverage, fileList: fileListAbs, libDirs: libDirsAbs, timeoutSec });
      if (!compiled.ok) {
        const log = compiled.log;
        const logPath = writeRunLog(cacheDir, "build.log", log);
        const result = compileSummary({
          phase: "msim_compile",
          ok: false,
          parsed: { errorCount: compiled.errorCount, errors: compiled.errors, warningCount: compiled.warningCount, errorsDetailed: compiled.errorsDetailed, diagnostics: compiled.diagnostics },
          install: MODELSIM,
          lib,
          languages,
          sources: src.all,
          durationMs: Date.now() - started,
          detail,
          logPath,
          command: { phase: "compile", steps: compiled.steps.map((s) => s.tool) },
          extra: { artifacts: { lib: join(bdir, lib), vcd: null }, hint: "编译未通过，未运行 vsim；读 errors/diagnostics 修源。", __rawLog: log },
        });
        attachLog(result, log, { detail, logPath });
        return toolResult(result);
      }

      // Run phase. ModelSim's default vopt flow optimizes signals away, so VCD
      // dumping needs -voptargs=+acc and coverage needs +cover; inject them
      // unless the caller set their own -voptargs. Coverage also needs
      // -coverage + -onfinish stop (so $finish returns to the do-file for
      // coverage report/save instead of exiting the simulator).
      const coverageUcdb = coverage ? join(bdir, "coverage.ucdb") : null;
      const coverageDetails = coverage ? join(bdir, "coverage.details.rpt") : null;
      const doScript = buildRunDo({ vcd, vcdResolved, doBeforeRun, runArg, coverage, coverageUcdb, coverageDetails });
      writeFileSync(join(bdir, "run.do"), doScript, "utf8");
      const userVopt = vsimArgs.some((a) => /^-voptargs/i.test(String(a)));
      const voptParts = [...(vcd ? ["+acc"] : []), ...(coverage ? ["+cover=bcst"] : [])];
      const voptArgs = voptParts.length && !userVopt ? [`-voptargs=${voptParts.join(" ")}`] : [];
      const covArgs = coverage ? ["-coverage", "-onfinish", "stop"] : [];
      const uvmRunArgs = uvm ? ["-L", MODELSIM.uvmLib, ...(uvmTest ? [`+UVM_TESTNAME=${uvmTest}`] : [])] : [];
      const vsimArgsFinal = ["-c", "-do", "run.do", ...covArgs, ...uvmRunArgs, ...voptArgs, ...vsimArgs, `${lib}.${top}`];
      const command = { exe: msimTool("vsim"), args: vsimArgsFinal, cwd: bdir };
      const sim = await run(msimTool("vsim"), vsimArgsFinal, { cwd: bdir, timeoutSec });
      const simLog = (sim.stdout + sim.stderr).trim();
      const parsed = parseModelsimLog(simLog);
      let coverageData = coverage ? parseCoverageReport(simLog) : null;
      if (coverageData && coverageDetails && existsSync(coverageDetails)) {
        // Per-instance gaps: which modules are under-covered (the actionable bit).
        const insts = parseCoverageByInstance(safeReadText(coverageDetails));
        coverageData = { ...coverageData, gaps: insts.filter((i) => Object.values(i.types).some((t) => t.misses > 0)).slice(0, 30) };
      }
      const uvmData = uvm ? parseUvmReport(simLog) : null;
      // ModelSim "Errors: 0" doesn't see UVM_ERROR/UVM_FATAL — fold them into ok.
      const ok = judgeModelsimOk(parsed, { exitCode: sim.code, timedOut: sim.timedOut }) && (!uvmData || (uvmData.error === 0 && uvmData.fatal === 0));

      const fullLog = `${compiled.log}\n\n$ vsim ${vsimArgsFinal.join(" ")}\n${simLog}`;
      const logPath = writeRunLog(cacheDir, "build.log", fullLog);
      // Composite assertions (declarative spec): a failed assertion makes the
      // run ok=false even when the transcript is clean.
      let assertData = null;
      if (assertions?.length) {
        const vcdForAssert = vcd && existsSync(vcdResolved) ? parseVcd(vcdResolved) : null;
        const ares = evaluateAssertions({ log: fullLog, vcd: vcdForAssert, assertions });
        const af = ares.filter((r) => !r.ok).length;
        assertData = { passed: ares.length - af, failed: af, results: ares };
      }
      const okFinal = ok && (!assertData || assertData.failed === 0);
      const result = compileSummary({
        phase: "msim_sim",
        ok: okFinal,
        comp: sim,
        parsed,
        install: MODELSIM,
        lib,
        languages,
        sources: src.all,
        durationMs: Date.now() - started,
        detail,
        logPath,
        command,
        extra: {
          top,
          run: { summary: parsed.summary, finished: parsed.finished, fatal: parsed.fatal },
          coverage: coverageData,
          uvm: uvmData,
          assert: assertData || undefined,
          artifacts: {
            lib: join(bdir, lib),
            vcd: vcd && existsSync(vcdResolved) ? vcdResolved : null,
            coverageUcdb: coverage && coverageUcdb && existsSync(coverageUcdb) ? coverageUcdb : null,
            transcript: join(bdir, "transcript"),
          },
          hint: okFinal
            ? undefined
            : assertData && assertData.failed
              ? `${assertData.failed} 条断言失败：读 assert.results 看 detail(信号/期望/实际)。`
              : uvmData && (uvmData.error || uvmData.fatal)
                ? `UVM 测试失败：UVM_ERROR=${uvmData.error}/UVM_FATAL=${uvmData.fatal}(ModelSim Errors 可能仍为 0)；读 keyLines 定位 uvm_error/uvm_fatal 行。`
                : "vsim 退出码可能为 0 但 transcript 含 ** Error/Fatal 或 Errors:>0；读 run.summary/errors/diagnostics 修 RTL/TB。",
          __rawLog: fullLog,
        },
      });
      attachLog(result, fullLog, { detail, logPath });

      // Turnkey waveform: render the just-produced VCD to SVG/HTML in one call.
      if (wave && result.artifacts?.vcd && existsSync(result.artifacts.vcd)) {
        try {
          const w = await renderVcdToFiles(result.artifacts.vcd, { signals: waveSignals, open: waveOpen, title: `${top} waveform` });
          result.artifacts.waveSvg = w.svgPath;
          result.artifacts.waveHtml = w.htmlPath;
          result.artifacts.waveOpened = w.opened;
          result.wave = { svgPath: w.svgPath, htmlPath: w.htmlPath, signalCount: w.signalCount, truncated: w.truncated };
        } catch {}
      }

      // Cache only successful runs (re-validated above); persist a summary copy
      // without the inlined log (detail:full reattaches from logPath).
      if (okFinal) {
        const cacheCopy = { ...result };
        delete cacheCopy.log;
        delete cacheCopy.tail;
        cacheCopy.truncated = result.truncated;
        writeRunSummary(cacheDir, cacheCopy);
      }
      return toolResult(result);
    }
  );

  // ---- fpga_msim_compile : compile only (syntax/elaboration check) ----------
  server.registerTool(
    "fpga_msim_compile",
    {
      title: "ModelSim 仅编译 (vlog/vcom)",
      description:
        "只编译(不运行 vsim)：Verilog/SV→vlog、VHDL→vcom，做语法/早期检查。加密 IP(.vp/.svp，IEEE-1735)由 vlog 原生解密。ok 由 'Errors: N' 与 ** Error 判定，不信退出码。紧凑摘要 + detail:'full' + 缓存。",
      inputSchema: {
        workdir: z.string().describe("工作目录绝对路径"),
        sources: z.array(z.string()).optional().describe("相对/绝对源文件(含加密 .vp/.svp)；省略=workdir 下所有 HDL"),
        lib: z.string().optional().describe("工作库名，默认 work"),
        host: z.string().optional().describe("远程执行设备 id（hosts.<id>.modelsim.home；省略=本机）。远程时源推到该设备编译；fileList/libDirs 为该设备侧路径。"),
        fileList: z.string().optional().describe("vlog 文件清单(.f)，经 -F 读入(清单内相对路径相对清单目录)。喂 PDS 的 IP 仿真清单(如 PCIe filelist_pciegen*_gtp.f)。"),
        libDirs: z.array(z.string()).optional().describe("vlog 库搜索目录，经 -y +libext 自动解析实例化到的厂商原语仿真模型。"),
        vlogArgs: z.array(z.string()).optional().describe("追加给 vlog 的参数"),
        vcomArgs: z.array(z.string()).optional().describe("追加给 vcom 的参数，如 -2008"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary"),
        cache: z.boolean().optional().describe("默认 true；false 强制重编"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ workdir, sources, lib = "work", host, fileList, libDirs = [], vlogArgs = [], vcomArgs = [], detail = "summary", cache = true, timeoutSec = 120 }) => {
      if (!isAbsolute(workdir) || !existsSync(workdir)) return toolError(`workdir 不存在或非绝对路径: ${workdir}`);
      const src = resolveSources(workdir, sources);
      if (src.error) return toolError(src.error);
      if (!src.all.length && !fileList && !(libDirs || []).length) return toolError(`workdir 无 HDL 源文件: ${workdir}（含 IP 时也可用 fileList/libDirs）`);

      // Remote compile: stage + remote vlib/vcom/vlog (no vsim), no artifact pull.
      let exec;
      try {
        exec = getExecutor(host);
      } catch (e) {
        return toolError(e.message);
      }
      if (exec.isRemote) {
        try {
          return await runMsimRemote({ mode: "compile", host, exec, workdir, src, top: null, lib, fileList, libDirs, vlogArgs, vcomArgs, detail, timeoutSec, started: Date.now(), cache });
        } catch (e) {
          return toolError(`远程 ModelSim 编译失败 (host=${host}): ${e.message}`);
        } finally {
          await exec.close();
        }
      }

      // ---- local ----
      if (!existsSync(msimTool("vlib"))) return toolError(`未找到 ModelSim(vlib)：${MODELSIM.binDir}`);
      const fileListAbs = fileList ? (isAbsolute(fileList) ? fileList : resolve(workdir, fileList)) : null;
      if (fileListAbs && !existsSync(fileListAbs)) return toolError(`fileList 不存在: ${fileListAbs}`);
      const libDirsAbs = (libDirs || []).map((d) => (isAbsolute(d) ? d : resolve(workdir, d)));

      const bdir = buildDir(workdir);
      const languages = [src.verilog.length ? (src.hasSv ? "sv" : "verilog") : null, src.vhdl.length ? "vhdl" : null].filter(Boolean);
      const cacheKey = hashParts([hashFiles(src.all), lib, "compile", JSON.stringify({ vlogArgs, vcomArgs, fileList: fileListAbs || "", libDirs: libDirsAbs }), MODELSIM.home]);
      const cacheDir = runStoreDir(workdir, cacheKey);
      if (cache) {
        const prev = loadCachedSummary(cacheDir);
        if (prev && prev.ok) {
          const hit = { ...prev, cached: true, hint: "命中编译缓存；cache:false 重编。" };
          if (detail === "full" && prev.logPath && existsSync(prev.logPath)) attachLog(hit, safeReadText(prev.logPath), { detail: "full", logPath: prev.logPath });
          return toolResult(hit);
        }
      }

      const started = Date.now();
      const compiled = await compileSources({ buildDir: bdir, lib, verilog: src.verilog, vhdl: src.vhdl, hasSv: src.hasSv, vlogArgs, vcomArgs, fileList: fileListAbs, libDirs: libDirsAbs, timeoutSec });
      const logPath = writeRunLog(cacheDir, "build.log", compiled.log);
      const result = compileSummary({
        phase: "msim_compile",
        ok: compiled.ok,
        parsed: { errorCount: compiled.errorCount, errors: compiled.errors, warningCount: compiled.warningCount, errorsDetailed: compiled.errorsDetailed, diagnostics: compiled.diagnostics },
        install: MODELSIM,
        lib,
        languages,
        sources: src.all,
        durationMs: Date.now() - started,
        detail,
        logPath,
        command: { phase: "compile", steps: compiled.steps.map((s) => s.tool) },
        extra: { artifacts: { lib: join(bdir, lib) }, hint: compiled.ok ? undefined : "编译未通过；读 errors/diagnostics。", __rawLog: compiled.log },
      });
      attachLog(result, compiled.log, { detail, logPath });
      if (compiled.ok) {
        const cacheCopy = { ...result };
        delete cacheCopy.log;
        delete cacheCopy.tail;
        writeRunSummary(cacheDir, cacheCopy);
      }
      return toolResult(result);
    }
  );

  // ---- fpga_msim_do : guarded generic vsim -c Tcl passthrough ---------------
  server.registerTool(
    "fpga_msim_do",
    {
      title: "ModelSim 通用 do 脚本直通 (vsim -c)",
      description:
        "对 vsim -c 跑任意 do/Tcl，覆盖长尾：coverage(coverage save/report)、force/examine、add wave、UVM(+UVM_TESTNAME)、WLF 分析、自定义 run 控制等。强制 headless(-c)+末尾自动 quit -f(防挂)。纯仿真脚本自由跑；含可触达宿主的命令(Tcl exec / file delete|rename|copy|mkdir / open 写)需 confirm:true(仿 fpga_cdt 写器件护栏)。可给 top 让工具 vsim <lib>.<top>，或在脚本内自行 vsim/vlog/vcom。",
      inputSchema: {
        workdir: z.string().describe("工作目录绝对路径(cwd；通常含已编译的库或先用 fpga_msim_compile)"),
        commands: z.array(z.string()).optional().describe("do 命令(每行一条)；与 doScript 二选一"),
        doScript: z.string().optional().describe("完整 do/Tcl 脚本(与 commands 二选一)"),
        top: z.string().optional().describe("可选：给定则 vsim <lib>.<top>；省略则脚本需自行 vsim"),
        lib: z.string().optional().describe("库名，默认 work(仅 top 给定时用)"),
        host: z.string().optional().describe("远程执行设备 id（hosts.<id>.modelsim.home；省略=本机）。远程时把 workdir 顶层源文件浅推到该设备临时目录后跑 vsim -do（do 宜自包含/引用已 stage 的文件）。"),
        vsimArgs: z.array(z.string()).optional().describe("追加给 vsim 的参数，如 -coverage、-gG=1、+UVM_TESTNAME=test"),
        confirm: z.boolean().optional().describe("脚本含可触达宿主的命令(exec/文件写)时必须 true；纯仿真脚本无需"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 300"),
      },
    },
    async ({ workdir, commands, doScript, top, lib = "work", host, vsimArgs = [], confirm, detail = "summary", timeoutSec = 300 }) => {
      if (!isAbsolute(workdir) || !existsSync(workdir)) return toolError(`workdir 不存在或非绝对路径: ${workdir}`);
      let body = doScript ?? (Array.isArray(commands) ? commands.join("\n") : "");
      if (!body.trim()) return toolError("需要提供 commands[] 或 doScript");
      // Policy gate (install-independent): a do-script reaching the host needs
      // confirm. Applies equally to local and remote.
      const suspicious = detectSuspiciousDo(body);
      if (suspicious.length && !confirm) {
        return toolResult({
          ok: false,
          phase: "confirm",
          source: "modelsim",
          suspicious,
          hint: "do 脚本含可触达宿主的命令(exec/文件写)；确认无害后带 confirm:true 重发。纯仿真(run/force/examine/coverage)无需 confirm。",
        });
      }
      if (!/\bquit\b/.test(body)) body += "\nquit -f"; // never hang in -c

      // Remote: shallow-stage workdir top-level files, run vsim -c -do there.
      let exec;
      try {
        exec = getExecutor(host);
      } catch (e) {
        return toolError(e.message);
      }
      if (exec.isRemote) {
        let inst;
        try {
          inst = remoteMsimInstall(host);
        } catch (e) {
          return toolError(e.message);
        }
        try {
          const sep = inst.sep;
          const rdir = await exec.mkdtemp("fpgamsim-do-");
          for (const name of readdirSync(workdir)) {
            if (name.startsWith(".") || name.startsWith("_")) continue;
            const abs = join(workdir, name);
            try { if (statSync(abs).isFile()) await exec.putFile(abs, `${rdir}${sep}${name}`); } catch {}
          }
          const doLocal = join(buildDir(workdir), "msim_do.remote.do");
          writeFileSync(doLocal, body, "utf8");
          await exec.putFile(doLocal, `${rdir}${sep}msim_do.do`);
          const seg = (t, a) => [winQ(inst.tool(t)), ...a].join(" ");
          const lic = inst.license ? `set MGLS_LICENSE_FILE=${inst.license}&&set LM_LICENSE_FILE=${inst.license}&&` : "";
          const vsimSeg = seg("vsim", ["-c", "-do", "msim_do.do", ...vsimArgs, ...(top ? [`${lib}.${top}`] : [])]);
          const res = await exec.exec(`cmd /c "${lic}cd /d ${winQ(rdir)} && ${vsimSeg}"`, { timeoutSec });
          const log = (res.stdout + res.stderr).trim();
          const parsed = parseModelsimLog(log);
          const ok = judgeModelsimOk(parsed, { exitCode: res.code, timedOut: res.timedOut });
          const out = {
            ok, phase: "msim_do", source: "modelsim", scope: "remote", host,
            top: top || null, lib, exitCode: res.code, timedOut: res.timedOut,
            run: { summary: parsed.summary, finished: parsed.finished, fatal: parsed.fatal },
            errorCount: parsed.errorCount, errors: capList(parsed.errors, 40).items,
            diagnostics: { knownIssues: parsed.diagnostics }, keyLines: modelsimKeyLines(log),
            hint: ok ? undefined : "远程 transcript 含 ** Error/Fatal 或 Errors:>0；读 run/errors/diagnostics。",
          };
          return toolResult(attachLog(out, log, { detail }));
        } catch (e) {
          return toolError(`远程 do 执行失败 (host=${host}): ${e.message}`);
        } finally {
          await exec.close();
        }
      }

      // ---- local ----
      if (!existsSync(msimTool("vsim"))) return toolError(`未找到 vsim：${MODELSIM.binDir}`);
      // Run vsim from the isolated build dir (where fpga_msim_compile/sim put the
      // `work` lib) — same cwd as those tools — so `vsim <lib>.<top>` chains off a
      // prior compile via the default lib mapping. (Was cwd=workdir, which looked
      // for ./work and failed with vsim-19 after a separate compile.) Self-contained
      // do-scripts should reference source files by absolute path.
      const bdir = buildDir(workdir);
      const doPath = join(bdir, "msim_do.do");
      writeFileSync(doPath, body, "utf8");
      const args = ["-c", "-do", doPath, ...vsimArgs, ...(top ? [`${lib}.${top}`] : [])];
      try {
        const res = await run(msimTool("vsim"), args, { cwd: bdir, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        const parsed = parseModelsimLog(log);
        const ok = judgeModelsimOk(parsed, { exitCode: res.code, timedOut: res.timedOut });
        const out = {
          ok,
          phase: "msim_do",
          source: "modelsim",
          top: top || null,
          lib,
          exitCode: res.code,
          timedOut: res.timedOut,
          run: { summary: parsed.summary, finished: parsed.finished, fatal: parsed.fatal },
          errorCount: parsed.errorCount,
          errors: capList(parsed.errors, 40).items,
          diagnostics: { knownIssues: parsed.diagnostics },
          keyLines: modelsimKeyLines(log),
          hint: ok ? undefined : "transcript 含 ** Error/Fatal 或 Errors:>0；读 run/errors/diagnostics。",
        };
        return toolResult(attachLog(out, log, { detail }));
      } catch (err) {
        return toolError(`vsim do 执行失败: ${err.message}`);
      }
    }
  );

  // ---- fpga_msim_exe : guarded generic bin-tool passthrough ----------------
  server.registerTool(
    "fpga_msim_exe",
    {
      title: "ModelSim bin 工具直通 (受护栏)",
      description:
        "在 ModelSim bin 目录跑库/覆盖率/波形/工具类 exe(vlib/vmap/vdir/vcover/wlf2vcd/vcd2wlf/vgencomp/vmake/vopt/sccom)并回提取后的输出。任意 bin exe 都可用 -help/-version 探测。编译/仿真(vlog/vcom/vsim)有专用工具(fpga_msim_compile/sim/do)，不在此列。",
      inputSchema: {
        exe: z.string().describe("bin 下的 exe 名(可省略 .exe)，如 vcover / wlf2vcd / vdir"),
        args: z.array(z.string()).optional().describe("命令行参数；用 ['-help'] 探测用法"),
        cwd: z.string().optional().describe("工作目录绝对路径，默认 bin 目录(本机)"),
        host: z.string().optional().describe("远程执行设备 id（hosts.<id>.modelsim.home；省略=本机）。远程时在该设备 bin 目录跑该 exe。"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 120"),
      },
    },
    async ({ exe, args = [], cwd, host, detail = "summary", timeoutSec = 120 }) => {
      const base = String(exe).replace(/\.exe$/i, "");
      const helpOnly = args.length > 0 && args.every((a) => /^-{1,2}(h|help|version|v)$/i.test(String(a)));
      if (!MSIM_EXE_ALLOWLIST.has(base) && !helpOnly) {
        return toolResult({
          ok: false,
          phase: "blocked",
          source: "modelsim",
          exe: base,
          allowlist: [...MSIM_EXE_ALLOWLIST],
          hint: `exe '${base}' 不在允许列表；仅允许 -help/-version 探测，或改用 fpga_msim_compile/sim/do。`,
        });
      }
      // Remote: run the same exe on the host's ModelSim install.
      let rexec;
      try {
        rexec = getExecutor(host);
      } catch (e) {
        return toolError(e.message);
      }
      if (rexec.isRemote) {
        let inst;
        try {
          inst = remoteMsimInstall(host);
        } catch (e) {
          return toolError(e.message);
        }
        try {
          const rExePath = inst.tool(base);
          const res = await rexec.run(rExePath, args, { timeoutSec });
          const log = (res.stdout + res.stderr).trim();
          const out = { ok: res.code === 0, phase: "msim_exe", source: "modelsim", scope: "remote", host, exe: base, exePath: rExePath, args, helpOnly, exitCode: res.code, timedOut: res.timedOut };
          return toolResult(attachLog(out, log, { detail }));
        } catch (e) {
          return toolError(`远程 exe 执行失败 (host=${host}): ${e.message}`);
        } finally {
          await rexec.close();
        }
      }
      const exePath = msimTool(base);
      if (!existsSync(exePath)) return toolError(`未找到 exe: ${exePath}`, { binDir: MODELSIM.binDir });
      if (cwd && (!isAbsolute(cwd) || !existsSync(cwd))) return toolError(`cwd 不存在或非绝对路径: ${cwd}`);
      try {
        const res = await run(exePath, args, { cwd: cwd || MODELSIM.binDir, timeoutSec });
        const log = (res.stdout + res.stderr).trim();
        const out = { ok: res.code === 0, phase: "msim_exe", exe: base, exePath, args, helpOnly, exitCode: res.code, timedOut: res.timedOut };
        return toolResult(attachLog(out, log, { detail }));
      } catch (err) {
        return toolError(`exe 执行失败: ${err.message}`);
      }
    }
  );

  // ---- fpga_msim_view : open the ModelSim GUI waveform viewer (local) -------
  server.registerTool(
    "fpga_msim_view",
    {
      title: "打开 ModelSim 波形 GUI (本机交互查看)",
      description:
        "在本机打开 ModelSim 图形界面查看波形(交互式缩放/测量/层级展开)——给用户做深度查看的渠道。输入 VCD(自动 vcd2wlf 转 WLF)或 WLF；signals 可预选 add wave，省略则 add wave -r /*。GUI 进程脱离 MCP 独立运行(detached)，工具立即返回。注：开的是**本机** GUI（远程仿真的 VCD 已拉回本地，直接对本地路径用此工具）；要静态图像/弹浏览器用 fpga_wave。launch:false 只做转换+给出命令不真正弹窗。",
      inputSchema: {
        vcdPath: z.string().optional().describe("VCD 绝对路径(自动 vcd2wlf 转 WLF 再 view；与 wlfPath 二选一)"),
        wlfPath: z.string().optional().describe("WLF 绝对路径(直接 view)"),
        signals: z.array(z.string()).optional().describe("只看这些信号(名或 /路径)；省略=按层级自动分组全加"),
        groups: z.array(z.object({ name: z.string(), signals: z.array(z.string()) })).optional().describe("显式信号分组 [{name,signals[]}]，每组一个 add wave -group；省略 signals/groups 时按 VCD 层级 scope 自动分组"),
        radix: z.enum(["hex", "dec", "unsigned", "bin", "symbolic"]).optional().describe("总线显示进制，默认 hex"),
        launch: z.boolean().optional().describe("是否真正弹出 GUI，默认 true；false=只转换+返回命令/do(用于脚本/测试)"),
        timeoutSec: z.number().optional().describe("vcd2wlf 转换超时秒数，默认 120"),
      },
    },
    async ({ vcdPath, wlfPath, signals, groups, radix = "hex", launch = true, timeoutSec = 120 }) => {
      // Shared GUI-view logic lives in launchView (also used by fpga_msim_sim's
      // view path); this tool just wraps it as a toolResult/toolError.
      const r = await launchView({ vcdPath, wlfPath, signals, groups, radix, launch, timeoutSec });
      if (!r.ok) return toolError(r.error);
      const hint = r.launched
        ? `已脱离 MCP 打开本机 ModelSim GUI(按层级分组 ${r.groups} 组、总线 ${r.radix}、zoom full)；窗口交给用户交互。静态图像用 fpga_wave。`
        : "launch:false——已转好 WLF + 分组/进制/zoom 的 view do；置 launch:true(默认)即弹出 GUI。";
      return toolResult({ ok: true, phase: "view", source: "modelsim-gui", launched: r.launched, pid: r.pid, wlf: r.wlf, groups: r.groups, radix: r.radix, command: r.command, doScript: r.doScript, hint });
    }
  );

  // ---- fpga_msim_doc_search : command reference + manual registry ----------
  registerKnowledge(server);
}
