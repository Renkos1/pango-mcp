#!/usr/bin/env node
// pango-mcp — engine-agnostic MCP capability layer for FPGA toolchains (bootstrap).
//
// The host agent owns general file editing. This server owns FPGA-specific
// actions, organized by toolchain/backend:
//   core/        backend-agnostic shared infra (exec, config, vcd, ...)
//   toolchains/pango-pds   Pango PDS: project/build/reports/scan/flash
//   toolchains/sim         simulation engines (current backend: iverilog)
// A future toolchain (e.g. Vivado) is added as toolchains/<vendor>/ without
// touching existing code. `fpga_env` is the one cross-cutting meta tool and is
// assembled here from each toolchain's probes.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONFIG_SOURCE, ENV_FILE_SOURCE } from "./core/config.mjs";
import { toolError, toolResult } from "./core/exec.mjs";
import { LocalExecutor, getExecutor, getHost, listHosts } from "./core/executor.mjs";
import { registerCapabilities } from "./core/capabilities.mjs";
import { CODE_VERSION, versionLine } from "./core/version.mjs";
import { serverInstanceSnapshot, siblingServerHint } from "./core/server-instances.mjs";
import { installStdioLifecycle, reapOrphanedServerInstances } from "./core/lifecycle.mjs";
import { installToolTrace } from "./core/trace.mjs";
import { registerVaultTool } from "./core/vault-tool.mjs";
import {
  DEFAULT_CDT_PORT,
  DEFAULT_CDT_PORT_2025,
  DEFAULT_CDT_STARTUP_TIMEOUT_MS,
  DEFAULT_FLASH_SCAN_RETRIES,
  DEFAULT_FLASH_SCAN_RETRY_DELAY_MS,
  DEFAULT_SCAN_MAX_DEVICES,
  IDCODE_ALIASES,
  PDS_INSTALLS,
  envHints,
  listBoards,
  getBoard,
} from "./toolchains/pango-pds/install.mjs";
import { register as registerPangoPds } from "./toolchains/pango-pds/index.mjs";
import { preflightPdsLicense } from "./toolchains/pango-pds/license.mjs";
import { register as registerSim } from "./toolchains/sim/index.mjs";
import { register as registerModelsim } from "./toolchains/modelsim/index.mjs";
import { MODELSIM, detectModelsimTools, modelsimEnvHints } from "./toolchains/modelsim/install.mjs";

const server = new McpServer({ name: "pango-mcp", version: CODE_VERSION.version || "0.0.0" });
// V4 A-trace: opt-in tool-call audit log (enable via PANGO_MCP_TRACE=1). Must wrap
// registerTool before any tool is registered so every fpga_* call is traced.
installToolTrace(server);
registerVaultTool(server, toolResult, toolError);

// Unified env probe — SAME flow for local (LocalExecutor) and remote
// (SshExecutor); no device-specific code path (a bug in one executor's
// which/exists then surfaces uniformly, instead of only remotely). PDS layout
// is derived from each install's shell path: given the root .../bin/pds_shell.exe,
// cdt_js.exe / cdt_cfg.exe sit beside it on every machine.
const PROBE_TOOLS = ["iverilog", "vvp", "verilator", "gcc", "node", "pnpm"];

async function probeEnv(executor, pdsList, { license = null } = {}) {
  const sep = executor.os === "windows" ? "\\" : "/";
  const tools = {};
  for (const c of PROBE_TOOLS) tools[c] = await executor.which(c);
  const pds = {};
  for (const inst of pdsList) {
    const shell = inst.shell || null;
    const binDir = shell ? String(shell).replace(/[\\/][^\\/]*$/, "") : null;
    const cdtJs = inst.cdtJs || (binDir ? `${binDir}${sep}cdt_js.exe` : null);
    const cdtCfg = inst.cdtCfg || (binDir ? `${binDir}${sep}cdt_cfg.exe` : null);
    const shellExists = !!shell && await executor.exists(shell);
    const licenseState = license?.state || "unknown";
    const available = !shellExists ? false : licenseState === "valid" ? true : licenseState === "unknown" ? null : false;
    pds[inst.label] = {
      pds_shell: shellExists ? shell : null,
      cdt_js: cdtJs && await executor.exists(cdtJs) ? cdtJs : null,
      cdt_cfg: cdtCfg && await executor.exists(cdtCfg) ? cdtCfg : null,
      installed: shellExists,
      available,
      availability: !shellExists ? "tool_missing" : licenseState === "valid" ? "available" : `license_${licenseState}`,
      license: license ? {
        state: license.state,
        usable: license.usable,
        validation: license.validation,
        expiresOn: license.expiresOn,
        daysRemaining: license.daysRemaining,
        hostCheck: license.hostCheck,
      } : null,
    };
  }
  return { tools, pds };
}

// Execution-device layer (ROADMAP 方向1): probe a remote host's FPGA tools over
// SSH via the same probeEnv as local. Read-only (which/exists) — no file staging.
async function remoteEnv(hostId) {
  const cfg = getHost(hostId);
  const exec = getExecutor(hostId);
  try {
    const pdsList = Object.entries(cfg.pds || {}).map(([label, shell]) => ({ label, shell }));
    const { tools, pds } = await probeEnv(exec, pdsList);
    const hints = [];
    for (const t of ["iverilog", "vvp"]) if (!tools[t]) hints.push(`远端 PATH 未找到 ${t}`);
    if (!pdsList.length) hints.push(`host '${hostId}' 未配置 PDS 路径（pango-mcp.config.json: hosts.${hostId}.pds）`);
    // Remote ModelSim: probe vsim/vlog/vcom under the per-host modelsim.home.
    let modelsim = null;
    if (cfg.modelsim?.home) {
      const sep = exec.os === "windows" ? "\\" : "/";
      const binDir = `${cfg.modelsim.home}${sep}win64`;
      const msimProbe = {};
      for (const t of ["vsim", "vlog", "vcom"]) {
        const p = `${binDir}${sep}${t}.exe`;
        msimProbe[t] = (await exec.exists(p)) ? p : null;
      }
      modelsim = { home: cfg.modelsim.home, binDir, tools: msimProbe };
      if (!msimProbe.vsim) hints.push(`远端 ModelSim 未找到 vsim（hosts.${hostId}.modelsim.home=${cfg.modelsim.home}）`);
    }
    return toolResult({
      ok: true,
      phase: "env",
      scope: "remote",
      host: hostId,
      executor: exec.label,
      remoteOs: exec.os,
      tools,
      pds,
      modelsim,
      hints,
      note: "远程探测（execution-device layer，经 SSH 的同一套 probeEnv）。ModelSim 远程：fpga_msim_sim 传 host 即在该设备 stage+build+sim、拉回 VCD/coverage。",
    });
  } catch (err) {
    return toolError(`远程 fpga_env 失败（host=${hostId}）: ${err.message}`, { host: hostId, hosts: listHosts() });
  } finally {
    await exec.close();
  }
}

server.registerTool(
  "fpga_env",
  {
    title: "FPGA 环境探测",
    description:
      "报告 FPGA 工作流可用工具：iverilog/vvp、verilator、gcc、node/pnpm，以及 PDS/cdt 路径、本地 PDS license 可用性/配置来源和本机 MCP server 实例归属。默认探本机；传 host 则经 SSH 探该远程执行设备（execution-device layer，与本机同一套探测逻辑）。",
    inputSchema: {
      host: z.string().optional().describe("远程执行设备 id（pango-mcp.config.json 的 hosts 之一）；省略=本机"),
    },
  },
  async ({ host } = {}) => {
    if (host) return remoteEnv(host);
    const license = preflightPdsLicense();
    const serverInstances = serverInstanceSnapshot();
    const { tools, pds } = await probeEnv(
      LocalExecutor,
      PDS_INSTALLS.map((p) => ({ label: p.label, shell: p.shell, cdtJs: p.cdtJs, cdtCfg: p.cdtCfg })),
      { license }
    );
    const modelsimTools = detectModelsimTools();
    return toolResult({
      ok: true,
      phase: "env",
      scope: "local",
      serverVersion: CODE_VERSION,
      serverInstances,
      tools,
      pds,
      license,
      modelsim: { home: MODELSIM.home, binDir: MODELSIM.binDir, tools: modelsimTools },
      config: {
        envFilePath: ENV_FILE_SOURCE.path,
        envFileError: ENV_FILE_SOURCE.error,
        jsonPath: CONFIG_SOURCE.path,
        jsonError: CONFIG_SOURCE.error,
        cdtPort: DEFAULT_CDT_PORT,
        cdtPort2025: DEFAULT_CDT_PORT_2025,
        scanMaxDevices: DEFAULT_SCAN_MAX_DEVICES,
        cdtStartupTimeoutMs: DEFAULT_CDT_STARTUP_TIMEOUT_MS,
        flashScanRetries: DEFAULT_FLASH_SCAN_RETRIES,
        flashScanRetryDelayMs: DEFAULT_FLASH_SCAN_RETRY_DELAY_MS,
      },
      idcodeAliases: IDCODE_ALIASES,
      hosts: listHosts().map((id) => {
        const h = getHost(id) || {};
        return { id, host: h.host || null, os: h.os || null, pds: Object.keys(h.pds || {}), modelsim: !!h.modelsim?.home };
      }),
      // Configured board / Target Profiles (ARCHITECTURE §10). The agent picks one
      // per task via board:<name>; physical info is user-supplied here, never guessed.
      boards: listBoards().map((name) => {
        const b = getBoard(name);
        return { name, device: b.device || null, package: b.package || null, host: b.host || null, hasPins: !!b.pins };
      }),
      hints: [...envHints(tools, pds, license), ...modelsimEnvHints(modelsimTools), siblingServerHint(serverInstances)].filter(Boolean),
      note: "仿真走 iverilog/vvp 或 ModelSim(vlog/vcom/vsim)；PDS 走 pds_shell；JTAG 走 cdt_js+cdt_cfg。烧录工具强制 confirm + IDCODE 校验。省略 pdsVersion 时用默认 PDS 安装(当前 2025.2)，多安装并存时显式传 pdsVersion。远程执行设备见 hosts，各工具传 host:<id> 即在该设备上跑。路径参数一律用正斜杠 /（Windows 路径也用 /），避免反斜杠在 JSON 里被转义出错。目标板物理信息(器件/封装/引脚等)配在 config 的 boards，建工程/构建时传 board:<name> 选用一套完整 target；未配置则向用户询问，工具绝不默认/猜器件。",
    });
  }
);

server.registerTool(
  "fpga_server_cleanup",
  {
    title: "MCP server 实例审计与孤儿清理",
    description:
      "审计本机 pango-mcp stdio server 的 PID、父进程、年龄与私有内存；只把父进程已消失或父 PID 已复用的实例列为 orphan_candidate。默认只读；confirm:true 才终止经二次身份复核的孤儿。仍由客户端持有的实例永不跨任务强杀。",
    inputSchema: {
      confirm: z.boolean().optional().describe("省略/false=只读审计；true=仅清理经二次复核的 orphan_candidate"),
      pids: z.array(z.number().int().positive()).max(64).optional().describe("可选候选 PID 白名单；未列入或不是 pango-mcp 孤儿的进程不会终止"),
      minAgeSec: z.number().int().min(0).max(86400).optional().describe("孤儿最小存活秒数，默认 60；避免父进程退出瞬间竞态"),
    },
  },
  async ({ confirm = false, pids, minAgeSec = 60 } = {}) => {
    const result = await reapOrphanedServerInstances({ confirm, pids, minAgeSec });
    return toolResult({
      ...result,
      phase: "server_lifecycle",
      hint: result.ok ? undefined : "server 实例盘点或孤儿终止未完整成功；查看 failures，且不要改用跨任务强杀。",
      note: confirm
        ? "只处理父进程缺失/PID 已复用且身份二次匹配的孤儿；client_owned 与当前 server 始终跳过。"
        : "当前为只读审计；确认 candidates 后才可传 confirm:true。client_owned 只表示原客户端父进程仍存活，不等同残留，也不证明当前有工具调用。",
    });
  }
);

registerPangoPds(server);
registerSim(server);
registerModelsim(server);
registerCapabilities(server, toolResult);

const transport = new StdioServerTransport();
await server.connect(transport);
installStdioLifecycle({ server });
console.error(
  `[pango-mcp] MCP server ready (stdio) — ${versionLine()}. Use the MCP tools/list request (or \`node tools/mcp-call.mjs --list\`) for the authoritative tool set; fpga_capabilities returns the tiered catalog + howto recipes (+ serverVersion for staleness checks).`
);
