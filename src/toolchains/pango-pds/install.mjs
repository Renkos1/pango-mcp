// Pango PDS toolchain — install resolution + device/JTAG constants.
// Knows where pds_shell / cdt_js / cdt_cfg live, which CDT port each PDS
// version defaults to, and the IDCODE aliases used by device-safety guards.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { CONFIG, toolEnv } from "../../core/config.mjs";
import { positiveInt } from "../../core/exec.mjs";

// Version slots only — NO baked-in install path. The path comes from config
// (pdsInstalls[].shell) or env (PANGO_MCP_PDS_2022 / PANGO_MCP_PDS_2025 / _BIN /
// _HOME). A hardcoded shell here would SHADOW that env (item.shell short-circuits
// the `||` chain), so a general user's config would be silently ignored — keep
// shell:null and let resolution flow to config/env, with a clear "configure it"
// error when truly unset.
const DEFAULT_PDS_INSTALLS = [
  { id: "2022.2", label: "PDS 2022.2 (SP4.2)", shell: null },
  { id: "2025.2", label: "PDS 2025.2 (SP1 · 省略 pdsVersion 时的默认)", shell: null },
];

function normalizePdsInstalls() {
  const configured = Array.isArray(CONFIG.pdsInstalls) && CONFIG.pdsInstalls.length ? CONFIG.pdsInstalls : DEFAULT_PDS_INSTALLS;
  const env = toolEnv();
  const envBin = (version) => env[`PANGO_MCP_PDS_${version}_BIN`] || env[`PDS_${version}_BIN`];
  const envShell = (version) => env[`PANGO_MCP_PDS_${version}`] || env[`PDS_${version}_SHELL`];
  const shellFromHome = (home) => (home ? join(home, "bin", "pds_shell.exe") : null);
  const installs = configured.map((item, index) => {
    const defaultInstall = DEFAULT_PDS_INSTALLS[index] || {};
    const versionKey = defaultInstall.id?.startsWith("2025") || item.id?.includes("2025") ? "2025" : "2022";
    const binDir = item.binDir || envBin(versionKey);
    const shell =
      item.shell ||
      envShell(versionKey) ||
      (binDir ? join(binDir, "pds_shell.exe") : null) ||
      shellFromHome(versionKey === "2025" ? env.PDS_2025_HOME || env.PANGO_MCP_PDS_2025_HOME : env.PDS_2022_HOME || env.PANGO_MCP_PDS_2022_HOME) ||
      defaultInstall.shell;
    return {
      id: item.id || defaultInstall.id || `pds-${index + 1}`,
      label: item.label || item.id || defaultInstall.label || `PDS ${index + 1}`,
      shell,
      binDir: binDir || (shell ? dirname(shell) : null),
      cdtJs: item.cdtJs,
      cdtCfg: item.cdtCfg,
    };
  });
  const pds2022 = envShell("2022");
  if (pds2022) {
    const target = installs.find((p) => p.id.includes("2022")) || installs[0];
    Object.assign(target, { shell: pds2022, binDir: dirname(pds2022) });
  }
  const pds2025 = envShell("2025");
  if (pds2025) {
    const target = installs.find((p) => p.id.includes("2025")) || installs[1] || installs[0];
    Object.assign(target, { shell: pds2025, binDir: dirname(pds2025) });
  }
  return installs;
}

export const PDS_INSTALLS = normalizePdsInstalls();

// The install root that holds bin/, doc/, ip/, arch/. The shipped knowledge
// corpora store vendor paths RELATIVE to this root (never absolute — an
// absolute path baked at build time points at the machine that built it), so
// both the offline builders and the lookup tools join against this at runtime.
// null when no PDS is configured; callers surface the relative path plus a hint.
export function pdsHome({ pdsVersion } = {}) {
  const homeOf = (i) => (i?.binDir ? dirname(i.binDir) : i?.shell ? dirname(dirname(i.shell)) : null);
  // Honour the default-version choice (choosePdsInstall), NOT array order —
  // iterating PDS_INSTALLS would pick 2022.2 first and resolve corpus paths
  // against an install the corpus was not built from.
  const preferred = homeOf(choosePdsInstall({ pdsVersion }));
  if (preferred) return preferred;
  for (const install of PDS_INSTALLS) {
    const home = homeOf(install);
    if (home) return home;
  }
  return null;
}

// Absolute vendor path -> install-root-relative, forward slashes. Used by the
// offline corpus builders so what they commit is machine-independent.
export function toVendorRel(absPath) {
  if (!absPath) return absPath;
  const home = pdsHome();
  const posix = String(absPath).split("\\").join("/");
  if (!home || !isAbsolute(absPath)) return posix;
  const rel = relative(home, absPath);
  // Outside the install root (unusual) — keep absolute rather than emit ../..
  return rel.startsWith("..") ? posix : rel.split("\\").join("/");
}

// Inverse: a stored corpus path -> something the host agent can actually open.
// null when no PDS is configured, so callers can fall back to the relative path
// plus a "configure PDS" hint instead of handing out a path that cannot resolve.
export function fromVendorRel(relPath) {
  if (!relPath) return null;
  if (isAbsolute(relPath)) return relPath;
  const home = pdsHome();
  return home ? join(home, relPath) : null;
}

// Build-output directories moved aside by backupOldBuildDirs so a fresh run is
// never read against stale artifacts. PDS 2025.2 nests all outputs under
// prj_tasks/<run>/ (pnr_1, syn_1, ...); PDS 2022.2 used the flat top-level dirs
// below. Listing both keeps the backup correct across versions. (Set
// backupOldBuildDirs:false to keep prj_tasks for faster incremental rebuilds.)
export const BUILD_DIRS = [
  "prj_tasks",
  "compile",
  "synthesize",
  "device_map",
  "place_route",
  "report_timing",
  "report_power",
  "generate_bitstream",
  "constraint_check",
];

export const IDCODE_ALIASES = {
  PG2L100H: "0x00602899",
  PG2L200H: "0x00603899",
  GW: "0x00602899",
  TG: "0x00603899",
  ...(CONFIG.idcodeAliases || {}),
};

// Reverse-lookup the friendly device alias for a scanned IDCODE, ignoring the
// top 4 silicon-revision bits (same masking as the flash IDCODE guard). When
// several aliases share an id (PG2L200H/TG), prefer the device-part name (PG*).
export function aliasForIdcode(idcode) {
  const m = /0x[0-9a-f]+/i.exec(String(idcode || ""));
  if (!m) return null;
  let target;
  try {
    target = BigInt(m[0].toLowerCase()) & 0x0fffffffn;
  } catch {
    return null;
  }
  const hits = Object.entries(IDCODE_ALIASES)
    .filter(([, v]) => {
      try {
        return (BigInt(String(v).toLowerCase()) & 0x0fffffffn) === target;
      } catch {
        return false;
      }
    })
    .map(([k]) => k);
  if (!hits.length) return null;
  return hits.find((k) => /^PG/i.test(k)) || hits[0];
}

export const DEFAULT_CDT_PORT = Number(toolEnv().PANGO_MCP_CDT_PORT || CONFIG.cdtPort || 65420);
export const DEFAULT_CDT_PORT_2025 = Number(toolEnv().PANGO_MCP_CDT_PORT_2025 || CONFIG.cdtPort2025 || 65425);
export const DEFAULT_SCAN_MAX_DEVICES = positiveInt(toolEnv().PANGO_MCP_SCAN_MAX_DEVICES || CONFIG.scanMaxDevices, 1, { min: 1, max: 32 });
export const DEFAULT_CDT_STARTUP_TIMEOUT_MS = positiveInt(toolEnv().PANGO_MCP_CDT_STARTUP_TIMEOUT_MS || CONFIG.cdtStartupTimeoutMs, 10000, {
  min: 1000,
  max: 60000,
});
export const DEFAULT_FLASH_SCAN_RETRIES = positiveInt(toolEnv().PANGO_MCP_FLASH_SCAN_RETRIES || CONFIG.flashScanRetries, 1, { min: 0, max: 5 });
export const DEFAULT_FLASH_SCAN_RETRY_DELAY_MS = positiveInt(toolEnv().PANGO_MCP_FLASH_SCAN_RETRY_DELAY_MS || CONFIG.flashScanRetryDelayMs, 1500, {
  min: 0,
  max: 30000,
});

// Default PDS install when the caller doesn't pin a version. Env-level "prefer
// the newer suite" choice (NOT a device assumption); override per call via pdsVersion.
const DEFAULT_PDS_ID = "2025.2";

export function choosePdsInstall({ pdsVersion } = {}) {
  if (pdsVersion) {
    const wanted = String(pdsVersion).toLowerCase();
    const matched = PDS_INSTALLS.find((p) => p.id.toLowerCase().includes(wanted) || p.label.toLowerCase().includes(wanted));
    if (matched) return matched;
  }
  // No pdsVersion given: use the default install. NOT device-keyed — device
  // specifics come from the project/user, never a baked-in device→version map.
  // (Was a dead device branch matching PG2L200H/TG/FBB that returned the same as
  // the fallback — debug-period leftover, removed.)
  return PDS_INSTALLS.find((p) => p.id === DEFAULT_PDS_ID) || PDS_INSTALLS[0];
}

// choosePdsInstall always returns an entry, but with shell/binDir null when
// nothing is configured — so every caller that goes straight to `.binDir` used
// to hand `join()` a null and die with `The "path" argument must be of type
// string`. The README promises the opposite: an unset path fails naming the knob
// it needs. This is that failure.
export function requirePdsInstall({ pdsVersion } = {}) {
  const install = choosePdsInstall({ pdsVersion });
  if (install?.binDir) return install;
  const known = PDS_INSTALLS.map((p) => p.id).join(" / ");
  throw new Error(
    `未配置 PDS 安装${pdsVersion ? `（请求版本 ${pdsVersion}）` : ""}：设 PANGO_MCP_PDS_2025 指向 <PDS>\\bin\\pds_shell.exe` +
    `（或 PANGO_MCP_PDS_2022 / PANGO_MCP_PDS_2025_BIN），或在 pango-mcp.config.json 里配 pdsInstalls。` +
    `已知版本 id: ${known}。用 fpga_env 看本机识别到什么。`
  );
}

export function defaultPortForInstall(install) {
  if (String(install?.id || "").includes("2025")) return DEFAULT_CDT_PORT_2025;
  return DEFAULT_CDT_PORT;
}

export function cdtTool(install, exeName) {
  if (exeName === "cdt_js.exe" && install.cdtJs) return install.cdtJs;
  if (exeName === "cdt_cfg.exe" && install.cdtCfg) return install.cdtCfg;
  return join(install.binDir, exeName);
}

export function detectPdsTools() {
  const pds = {};
  for (const install of PDS_INSTALLS) {
    pds[install.label] = {
      pds_shell: install.shell && existsSync(install.shell) ? install.shell : null,
      cdt_js: install.binDir && existsSync(cdtTool(install, "cdt_js.exe")) ? cdtTool(install, "cdt_js.exe") : null,
      cdt_cfg: install.binDir && existsSync(cdtTool(install, "cdt_cfg.exe")) ? cdtTool(install, "cdt_cfg.exe") : null,
    };
  }
  return pds;
}

export function envHints(tools, pds, license = null) {
  const missing = [];
  for (const name of ["iverilog", "vvp"]) if (!tools[name]) missing.push(`PATH 中未找到 ${name}`);
  for (const [label, paths] of Object.entries(pds)) {
    if (!paths.pds_shell) missing.push(`${label}: 未找到 pds_shell.exe，可设置 PANGO_MCP_PDS_2022/PANGO_MCP_PDS_2025 或 pdsInstalls[].shell`);
    if (!paths.cdt_js || !paths.cdt_cfg) missing.push(`${label}: 未找到 cdt_js/cdt_cfg，可设置 pdsInstalls[].binDir/cdtJs/cdtCfg`);
  }
  if (license) {
    if (license.state !== "valid" || license.conflict) missing.push(license.hint);
  } else if (!toolEnv().PANGO_LICENSE_FILE) {
    missing.push("PANGO_LICENSE_FILE 未设置；PDS compile 可能报 Flow-0183");
  }
  return missing;
}

// ── Board / Target Profiles (ARCHITECTURE §10) ──────────────────────────────
// Physical target info — family/device/package/speedgrade, pins, clockFreqMhz,
// flashPart, host — lives in config under `boards`, supplied by the USER per
// board (never device-defaulted/guessed). A task picks one via board:<name>; the
// tool pulls a complete target from it. Discover configured boards via fpga_env.
export function listBoards() {
  return Object.keys(CONFIG.boards || {});
}

// Resolve a board profile by name; throws a guiding error if absent (the agent
// must then ask the user / add it — physical info is user-supplied, not guessed).
export function getBoard(name) {
  const b = (CONFIG.boards || {})[name];
  if (!b) {
    const have = listBoards();
    throw new Error(
      `board '${name}' 未在配置(pango-mcp.config.json 的 boards)。` +
        (have.length ? `已配置: ${have.join(", ")}。` : "尚无任何 board 配置。") +
        `在 config 增加该板 profile(family/device/package/speedgrade/pins/...)，或改传完整显式 part——物理信息须来自用户/Target Profile，工具不替你猜。`
    );
  }
  return b;
}

// Build a complete part {family,device,package,speedgrade} from an optional board
// profile + explicit overrides. Explicit fields win over the profile. Returns
// { part, pins } so callers can also generate constraints from the board pins.
export function resolveTargetPart({ board, family, device, package: pkg, speedgrade } = {}) {
  const b = board ? getBoard(board) : null;
  const part = {
    family: family ?? b?.family,
    device: device ?? b?.device,
    package: pkg ?? b?.package,
    speedgrade: speedgrade ?? b?.speedgrade,
  };
  return { part, pins: b?.pins || null, board: b };
}
