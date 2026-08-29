// ModelSim/Questa toolchain — install resolution + bin-tool location.
// Knows where vlib/vlog/vcom/vsim and the utility exes live, derived from a
// single MODELSIM_HOME (the install root that contains win64/ + modelsim.ini).
// Mirrors pango-pds/install.mjs: config/env override, then a sane default.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONFIG, toolEnv } from "../../core/config.mjs";

// No baked-in install path — the home comes from config (modelsimHome) or env
// (PANGO_MCP_MODELSIM_HOME / MODELSIM_HOME / MODEL_TECH). Unset -> null, and the
// install degrades to "unconfigured" (tools null) with a clear env hint, instead
// of pointing at one machine's personal directory.
const DEFAULT_MODELSIM_HOME = null;

// Platform bin dir under the install root. This box is Windows/win64; Linux
// installs keep the same exe names under linux_x86_64 (handled for symmetry).
function platformBinDir(home) {
  if (!home) return null;
  return process.platform === "win32" ? join(home, "win64") : join(home, "linux_x86_64");
}

// MODEL_TECH (set by ModelSim itself) points at the bin dir, not the root — so
// if that is what we're handed, climb one level to the install home.
function homeFromAny(p) {
  if (!p) return null;
  const b = basename(String(p)).toLowerCase();
  return b === "win64" || b === "linux_x86_64" ? dirname(p) : p;
}

function resolveModelsimHome() {
  const env = toolEnv();
  const candidate =
    CONFIG.modelsimHome ||
    env.PANGO_MCP_MODELSIM_HOME ||
    env.MODELSIM_HOME ||
    homeFromAny(env.MODEL_TECH) ||
    DEFAULT_MODELSIM_HOME;
  return candidate;
}

function buildInstall() {
  const home = resolveModelsimHome();
  const binDir = platformBinDir(home);
  // Unconfigured (no home) -> all tool paths null. Callers guard null before
  // existsSync so current Node releases do not emit invalid-argument warnings.
  const exe = (name) => (binDir ? join(binDir, process.platform === "win32" ? `${name}.exe` : name) : null);
  // UVM include dir for the precompiled `mtiUvm` library. modelsim.ini maps
  // mtiUvm -> uvm-1.1d by default, so prefer 1.1d's headers to match the lib.
  const uvmIncDir = home
    ? ["uvm-1.1d", "uvm-1.2", "uvm-1.1c"].map((v) => join(home, "verilog_src", v, "src")).find((d) => existsSync(d)) || null
    : null;
  return {
    id: "modelsim",
    home,
    binDir,
    ini: home ? join(home, "modelsim.ini") : null,
    uvmIncDir,
    uvmLib: "mtiUvm",
    tools: {
      vlib: exe("vlib"),
      vlog: exe("vlog"),
      vcom: exe("vcom"),
      vsim: exe("vsim"),
      vopt: exe("vopt"),
      vmap: exe("vmap"),
      vdir: exe("vdir"),
      vcover: exe("vcover"),
      wlf2vcd: exe("wlf2vcd"),
      vcd2wlf: exe("vcd2wlf"),
      vgencomp: exe("vgencomp"),
      vmake: exe("vmake"),
      sccom: exe("sccom"),
    },
  };
}

export const MODELSIM = buildInstall();

// Path to a named ModelSim bin exe (no .exe suffix needed in the name).
export function msimTool(name) {
  const base = String(name).replace(/\.exe$/i, "");
  if (MODELSIM.tools[base]) return MODELSIM.tools[base];
  return MODELSIM.binDir ? join(MODELSIM.binDir, process.platform === "win32" ? `${base}.exe` : base) : null;
}

// Source-file language partition. Verilog/SystemVerilog → vlog; VHDL → vcom.
// .vp/.svp are Pango's IEEE-1735 ENCRYPTED Verilog/SystemVerilog (e.g. PCIe/ADC
// IP sim models); .vhp is encrypted VHDL. ModelSim decrypts them natively (the
// envelope carries a Mentor key block), so they compile like their plain peers.
export const VERILOG_EXT = /\.(v|sv|vh|svh|vp|svp|verilog)$/i;
export const VHDL_EXT = /\.(vhd|vhdl|vhp)$/i;
export const HDL_EXT = /\.(v|sv|vh|svh|vp|svp|verilog|vhd|vhdl|vhp)$/i;

// fpga_msim_exe allowlist: library/coverage/waveform/util tools that take
// arbitrary args. The compile/sim drivers (vlog/vcom/vsim) have dedicated tools
// (fpga_msim_compile / fpga_msim_sim / fpga_msim_do) and are intentionally
// excluded here — but any bin exe may still be probed read-only with -help.
export const MSIM_EXE_ALLOWLIST = new Set([
  "vlib",
  "vmap",
  "vdir",
  "vcover",
  "wlf2vcd",
  "vcd2wlf",
  "vgencomp",
  "vmake",
  "vopt",
  "sccom",
]);

export function detectModelsimTools() {
  const out = {};
  for (const [name, path] of Object.entries(MODELSIM.tools)) {
    out[name] = path && existsSync(path) ? path : null;
  }
  return out;
}

export function modelsimEnvHints(tools = detectModelsimTools()) {
  const hints = [];
  for (const name of ["vlib", "vlog", "vsim"]) {
    if (!tools[name]) {
      hints.push(`未找到 ${name}（ModelSim）。设 PANGO_MCP_MODELSIM_HOME 或 config.modelsimHome 指向安装根目录（含 win64/）。当前推断 home=${MODELSIM.home}`);
    }
  }
  if (!tools.vcom) hints.push("未找到 vcom：VHDL 编译不可用（Verilog/SV 仍可用 vlog）。");
  return hints;
}
