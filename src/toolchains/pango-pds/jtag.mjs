import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

function clampPositiveInt(value, fallback, { min = 1, max = 32 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForTcpPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpPortOpen(host, port, 500)) return true;
    await sleep(250);
  }
  return false;
}

export function normalizeIdcode(idcode, aliases = {}) {
  const alias = aliases[String(idcode || "").toUpperCase()] || idcode;
  const match = /0x[0-9a-f]+/i.exec(String(alias || ""));
  return match ? match[0].toLowerCase() : null;
}

export function idcodeMatches(actual, expected, aliases = {}) {
  const a = normalizeIdcode(actual, aliases);
  const e = normalizeIdcode(expected, aliases);
  if (!a || !e) return false;
  try {
    return (BigInt(a) & 0x0fffffffn) === (BigInt(e) & 0x0fffffffn);
  } catch {
    return a === e;
  }
}

export function parseScanLog(log) {
  const devices = [];
  for (const match of String(log || "").matchAll(/IDCODE\((\d+)\):[^\r\n]*(0x)?([0-9a-f]{8,})/gi)) {
    devices.push({ index: Number(match[1]), idcode: `0x${match[3].toLowerCase()}` });
  }
  for (const match of String(log || "").matchAll(/ID value is:\s*(0x[0-9a-f]+)/gi)) {
    if (!devices.find((d) => d.idcode === match[1].toLowerCase())) {
      devices.push({ index: devices.length, idcode: match[1].toLowerCase() });
    }
  }
  return devices.sort((a, b) => a.index - b.index);
}

export function diagnoseCdtLog(log, { timedOut = false, devices } = {}) {
  const text = String(log || "");
  const rules = [
    {
      code: "cdt_no_cable",
      severity: "error",
      pattern: /No cable was found in system/i,
      hint: "PDS 未发现 JTAG cable；检查 USB/驱动/供电，修好后重试 scan。",
    },
    {
      code: "cdt_version_mismatch",
      severity: "error",
      pattern: /version.*(mismatch|not match)|mismatch.*version/i,
      hint: "cdt_cfg 与已监听的 cdt_js 版本不一致；2025.2 默认用 65425，避免复用 2022.2 的 65420 server。",
    },
    {
      code: "cdt_invalid_device_index",
      severity: "warning",
      pattern: /invalid device index/i,
      hint: "scan 读取了不存在的 JTAG device_index；单 FPGA 板保持 maxDevices=1，多器件链再显式调大。",
    },
    {
      code: "cdt_dirty_error_state",
      severity: "warning",
      pattern: /Public-4023: Error has occurred, please run command clean/i,
      hint: "cdt_cfg 会话已有错误状态；避免无效 device_index 探测，必要时重启 cdt_js 后重试。",
    },
  ];
  const issues = rules.filter((rule) => rule.pattern.test(text)).map(({ code, severity, hint }) => ({ code, severity, hint }));
  if (timedOut) {
    issues.unshift({
      code: "cdt_scan_transient_timeout",
      severity: "warning",
      hint: "cdt_cfg scan 超时；这可能是 cdt_js/cable 的瞬态状态，flash 前置 scan 会短重试。",
    });
  }
  if (Array.isArray(devices) && devices.length === 0 && !issues.some((issue) => issue.code === "cdt_no_cable")) {
    issues.push({
      code: "cdt_scan_no_devices",
      severity: "warning",
      hint: "scan 未解析到 IDCODE；若 cable/供电正常，短重试或重启 cdt_js 可能恢复。",
    });
  }
  return issues;
}

export function tcpPortOpen(host, port, timeoutMs = 800) {
  return new Promise((resolveOpen) => {
    const socket = new Socket();
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

function scanRecoveryHint(result) {
  if (result.devices?.length) return undefined;
  const issueCodes = new Set((result.diagnostics?.knownIssues || []).map((issue) => issue.code));
  if (issueCodes.has("cdt_version_mismatch")) return "检测到 cdt 版本/端口不匹配；2025.2 请使用默认 65425，必要时结束旧 cdt_js 后重试。";
  if (issueCodes.has("cdt_no_cable")) return "未发现 JTAG cable；检查 USB cable、驱动、板卡供电后重试。";
  if (issueCodes.has("cdt_scan_transient_timeout") || issueCodes.has("cdt_scan_no_devices")) {
    return "scan 疑似 CDT/cable 瞬态失败；可用 retryOnTransient:true 重试一次，仍失败则重启 cdt_js 或重新插拔 cable。";
  }
  return "未解析到 IDCODE；确认 PDS 版本、端口、JTAG cable、板卡供电和 maxDevices 后重试。";
}

export async function ensureCdtServer(ctx, install, port) {
  const cdtJs = ctx.cdtTool(install, "cdt_js.exe");
  if (!existsSync(cdtJs)) throw new Error(`未找到 cdt_js.exe: ${cdtJs}`);
  if (await tcpPortOpen("127.0.0.1", port, 800)) return { started: false, path: cdtJs, port };
  const child = spawn(cdtJs, ["-port", String(port)], {
    detached: true,
    env: ctx.toolEnv(),
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const ready = await waitForTcpPort("127.0.0.1", port, ctx.cdtStartupTimeoutMs || 10000);
  if (!ready) throw new Error(`cdt_js 启动后端口未就绪: port=${port}, pid=${child.pid}`);
  return { started: true, path: cdtJs, port, pid: child.pid };
}

// Decode raw cdt console output. Remote Windows cdt_* prints localized errors in
// GBK (cp936); the SSH stream's default utf-8 toString() mojibakes them, so the
// caller hands us raw bytes here. Prefer utf-8 (covers ASCII + UTF-8 consoles);
// fall back to GBK only when the bytes aren't valid utf-8. A string in (the local
// path, already decoded) passes straight through — never double-decode.
export function decodeCdtLog(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  const bytes = raw instanceof Uint8Array ? raw : Buffer.from(raw);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gbk").decode(bytes);
  }
}

// OS-level / cdt failure signatures that must force ok:false. The old check only
// matched cdt's own "E:" code, so an OS-level failure (a missing exe whose error is
// the GBK "系统找不到指定的文件。") slipped through as ok:true. Run this on DECODED
// text. Returns a short hint when a failure is detected, else null. Judge by error
// signature only — never by an empty device list (read commands legitimately have none).
const CDT_FAIL_SIGNATURES = [
  { re: /系统找不到|找不到指定|无法找到/, hint: "远端报“系统找不到指定的文件/路径”：核对 cdt_dbg/cdt_cfg/cdt_js 可执行路径与远程 PDS 安装目录。" },
  { re: /cannot find|no such file|not recognized/i, hint: "remote reported a missing file/command; check the cdt exe path and PDS install on the host." },
  { re: /^\s*E:/im, hint: "cdt_* 返回错误码(E:)；读 log/extract 定位失败命令。" },
  { re: /No devices were detected/i, hint: "未检测到器件：检查 cable/供电，必要时重启 cdt_js。" },
  { re: /fail(ed|ure).{0,40}cable|open.{0,20}cable|cable.{0,20}(fail|not)/i, hint: "JTAG cable 打开失败；检查 USB cable/驱动/cdt_js 监听端口。" },
];
export function cdtFailureSignature(log) {
  const text = String(log || "");
  for (const sig of CDT_FAIL_SIGNATURES) if (sig.re.test(text)) return sig.hint;
  return null;
}

// Run a Tcl script through a cdt_js-backed interpreter (cdt_cfg.exe for cfg_*,
// cdt_dbg.exe for dbg_*). Both connect to a resident cdt_js server.
export async function runCdtScript(ctx, install, exeName, script, { port = 65420, timeoutSec = 30 } = {}) {
  const exe = ctx.cdtTool(install, exeName);
  if (!existsSync(exe)) throw new Error(`未找到 ${exeName}: ${exe}`);
  const server = await ensureCdtServer(ctx, install, port);
  const tmp = mkdtempSync(join(tmpdir(), "fpga-cdt-"));
  const scriptPath = join(tmp, "run.tcl");
  try {
    writeFileSync(scriptPath, `${script}\ncatch {exit}\n`, "utf8");
    const res = await ctx.run(exe, ["-file", scriptPath], { timeoutSec });
    return { ...res, cdtServer: server };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function runCdtCfg(ctx, install, script, { port = 65420, timeoutSec = 30 } = {}) {
  return runCdtScript(ctx, install, "cdt_cfg.exe", script, { port, timeoutSec });
}

// Run cdt_cfg for pure offline file generation (cfg_gen_sfc / cfg_gen_multi_file /
// cfg_gen_chain_file). These transform .sbit→.sfc and need NO cdt_js server, JTAG
// cable, or attached device — so we skip ensureCdtServer entirely (device-free).
// Mirrors runCdtScript's temp-script lifecycle otherwise.
export async function runCdtGen(ctx, install, script, { timeoutSec = 120 } = {}) {
  const exe = ctx.cdtTool(install, "cdt_cfg.exe");
  if (!existsSync(exe)) throw new Error(`未找到 cdt_cfg.exe: ${exe}`);
  const tmp = mkdtempSync(join(tmpdir(), "fpga-gen-"));
  const scriptPath = join(tmp, "gen.tcl");
  try {
    writeFileSync(scriptPath, `${script}\ncatch {exit}\n`, "utf8");
    return await ctx.run(exe, ["-file", scriptPath], { timeoutSec });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The JTAG scan-chain Tcl, shared by the local and remote scan paths so the
// device-reading logic never diverges (cfg_connect targets 127.0.0.1 = the
// loopback on whichever host cdt_cfg runs on).
export function buildScanScript(scanPort, scanLimit) {
  return `
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port ${Number(scanPort)}
cfg_scan_chain
for {set i 0} {$i < ${Number(scanLimit)}} {incr i} {
  if {[catch {cfg_read_device_property -mode 0 -device_index $i} id]} {
    puts "NO_DEVICE($i): $id"
    break
  } else {
    puts "IDCODE($i): $id"
  }
}
cfg_disconnect
cfg_close`;
}

async function scanJtagOnce(ctx, { pdsVersion, port, timeoutSec = 30, maxDevices = ctx.defaultScanMaxDevices || 1 } = {}) {
  const install = ctx.choosePdsInstall({ pdsVersion });
  const scanPort = port ?? ctx.defaultPortForInstall(install);
  const scanLimit = clampPositiveInt(maxDevices, ctx.defaultScanMaxDevices || 1, { min: 1, max: 32 });
  if (!existsSync(install.shell)) throw new Error(`PDS 安装不可用: ${install.shell}`);
  const script = buildScanScript(scanPort, scanLimit);
  const res = await runCdtCfg(ctx, install, script, { port: scanPort, timeoutSec });
  const log = (res.stdout + res.stderr).trim();
  const devices = parseScanLog(log);
  const parsedLog = ctx.parsePdsLog(log);
  const result = {
    ok: res.code === 0 && devices.length > 0,
    phase: "pds_scan",
    pds: { id: install.id, label: install.label },
    port: scanPort,
    exitCode: res.code,
    timedOut: res.timedOut,
    cdtServer: res.cdtServer,
    maxDevices: scanLimit,
    devices,
    log,
    diagnostics: {
      pdsErrors: parsedLog.errors,
      pdsWarnings: parsedLog.warnings,
      knownIssues: diagnoseCdtLog(log, { timedOut: res.timedOut, devices }),
    },
  };
  result.hint = scanRecoveryHint(result);
  return result;
}

export async function scanJtag(ctx, { retryOnTransient = false, retryDelayMs = 1500, ...args } = {}) {
  const attempts = [];
  const first = await scanJtagOnce(ctx, args);
  attempts.push({
    attempt: 1,
    ok: first.ok,
    timedOut: first.timedOut,
    devices: first.devices,
    diagnostics: first.diagnostics,
    cdtServer: first.cdtServer,
  });
  if (first.ok || !retryOnTransient) return { ...first, attempts };

  const issueCodes = new Set((first.diagnostics?.knownIssues || []).map((issue) => issue.code));
  const retryable = first.timedOut || issueCodes.has("cdt_scan_transient_timeout") || issueCodes.has("cdt_scan_no_devices");
  if (!retryable) return { ...first, attempts };

  if (retryDelayMs > 0) await sleep(retryDelayMs);
  const second = await scanJtagOnce(ctx, args);
  attempts.push({
    attempt: 2,
    ok: second.ok,
    timedOut: second.timedOut,
    devices: second.devices,
    diagnostics: second.diagnostics,
    cdtServer: second.cdtServer,
  });
  return { ...second, attempts, retried: true, firstAttempt: first };
}

// Shared remote cdt_cfg orchestration. cmd's console/job semantics over Windows
// SSH break the cdt_js↔cdt_cfg pair (cdt_js dies with the session, or its console
// swallows cdt_cfg's stdout). A single PowerShell session fixes both:
// Start-Process keeps cdt_js alive for the session, while `& cdt_cfg | Out-String`
// captures cdt_cfg's full output to a file we read back. Optional `files` are
// staged into the remote temp dir first (e.g. a .sbit); `makeTcl(rdir, sep)`
// builds the Tcl knowing where they landed. Returns { log, timedOut }.
export async function runCdtRemote(executor, install, { makeTcl, files = [], exeName = "cdt_cfg.exe", port = 65425, timeoutSec = 60, serverWaitSec = 5 }) {
  const win = executor.os === "windows";
  const sep = win ? "\\" : "/";
  const rdir = await executor.mkdtemp("cdtremote-");
  const tmp = mkdtempSync(join(tmpdir(), "fpga-cdt-"));
  try {
    for (const f of files) await executor.putFile(f.localPath, `${rdir}${sep}${f.remoteName}`);
    const tcl = `${makeTcl(rdir, sep)}\ncatch {exit}\n`;
    writeFileSync(join(tmp, "run.tcl"), tcl, "utf8");
    let raw; // raw bytes (Buffer) or string -> decodeCdtLog handles both
    let timedOut = false;
    if (win) {
      const outTxt = `${rdir}\\out.txt`;
      const ps =
        `$ErrorActionPreference='Continue'\r\n` +
        `$bin='${install.binDir}'\r\n` +
        `$p = Start-Process -FilePath "$bin\\cdt_js.exe" -ArgumentList '-port','${Number(port)}' -WorkingDirectory $bin -PassThru -WindowStyle Hidden\r\n` +
        `Start-Sleep -Seconds ${serverWaitSec}\r\n` +
        `$out = & "$bin\\${exeName}" -file '${rdir}\\run.tcl' 2>&1 | Out-String\r\n` +
        `Set-Content -LiteralPath '${outTxt}' -Value $out\r\n` +
        `try { Stop-Process -Id $p.Id -Force } catch {}\r\n`;
      writeFileSync(join(tmp, "run.ps1"), ps, "utf8");
      await executor.putFile(join(tmp, "run.tcl"), `${rdir}\\run.tcl`);
      await executor.putFile(join(tmp, "run.ps1"), `${rdir}\\run.ps1`);
      const runRes = await executor.exec(`powershell -NoProfile -ExecutionPolicy Bypass -File ${rdir}\\run.ps1`, { timeoutSec });
      timedOut = runRes.timedOut;
      // Fetch out.txt as raw bytes (SFTP) so a GBK(cp936) Windows-console error
      // ("系统找不到指定的文件。") decodes correctly instead of mojibaking through
      // the SSH stream's utf-8 default. Fall back to `type` if the pull fails.
      const localOut = join(tmp, "out.txt");
      try {
        await executor.getFile(outTxt, localOut);
        if (existsSync(localOut)) raw = readFileSync(localOut);
      } catch {}
      if (raw == null) {
        const t = await executor.exec(`cmd /c type ${outTxt}`, { timeoutSec: 15 });
        raw = `${t.stdout || ""}${t.stderr || ""}`;
      }
    } else {
      const exeBase = exeName.replace(/\.exe$/i, "");
      await executor.putFile(join(tmp, "run.tcl"), `${rdir}/run.tcl`);
      const res = await executor.exec(
        `cd '${install.binDir}' && ./cdt_js -port ${Number(port)} & sleep ${serverWaitSec}; ./${exeBase} -file '${rdir}/run.tcl' 2>&1; kill %1 2>/dev/null`,
        { timeoutSec }
      );
      timedOut = res.timedOut;
      raw = `${res.stdout || ""}${res.stderr || ""}`;
    }
    return { log: decodeCdtLog(raw).trim(), timedOut };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    try {
      await executor.exec(win ? "cmd /c taskkill /f /im cdt_js.exe >NUL 2>&1" : "pkill -f cdt_js", { timeoutSec: 15 });
    } catch {}
    try {
      await executor.exec(win ? `cmd /c rmdir /s /q "${rdir}"` : `rm -rf '${rdir}'`, { timeoutSec: 15 });
    } catch {}
  }
}

// Remote JTAG scan: same buildScanScript/parseScanLog/diagnoseCdtLog as local —
// only the orchestration (runCdtRemote) is remote.
export async function scanJtagRemote(executor, install, { port = 65425, timeoutSec = 30, maxDevices = 1, serverWaitSec = 5 } = {}) {
  const scanPort = Number(port);
  const scanLimit = clampPositiveInt(maxDevices, 1, { min: 1, max: 32 });
  const { log, timedOut } = await runCdtRemote(executor, install, {
    makeTcl: () => buildScanScript(scanPort, scanLimit),
    port: scanPort,
    timeoutSec,
    serverWaitSec,
  });
  const devices = parseScanLog(log);
  const result = {
    ok: devices.length > 0 && !/^\s*E:/im.test(log),
    phase: "pds_scan",
    scope: "remote",
    port: scanPort,
    timedOut,
    maxDevices: scanLimit,
    devices,
    log,
    diagnostics: { knownIssues: diagnoseCdtLog(log, { devices }) },
  };
  result.hint = scanRecoveryHint(result);
  return result;
}

// Remote SRAM flash: stage the (local) .sbit to the remote, then cfg_assign_file
// + cfg_program via runCdtRemote. Caller must have already scan-verified the
// IDCODE (same guard as local flash). ok requires "The done bit is 1".
export async function flashSramRemote(executor, install, { sbit, deviceIndex = 0, port = 65425, timeoutSec = 120, serverWaitSec = 5 } = {}) {
  const dev = Number(deviceIndex);
  const { log, timedOut } = await runCdtRemote(executor, install, {
    files: [{ localPath: sbit, remoteName: "design.sbit" }],
    makeTcl: (rdir, sep) =>
      [
        "cfg_set_tcl_break -flag true",
        `cfg_connect -ip 127.0.0.1 -port ${Number(port)}`,
        "cfg_scan_chain",
        `cfg_assign_file -file ${`${rdir}${sep}design.sbit`.replace(/\\/g, "/")} -device_index ${dev}`,
        `cfg_program -device_index ${dev}`,
        "cfg_disconnect",
        "cfg_close",
      ].join("\n"),
    port: Number(port),
    timeoutSec,
    serverWaitSec,
  });
  const ok = /done bit is\s+1/i.test(log) && !/^\s*E:/im.test(log);
  return {
    ok,
    phase: "flash_sram",
    scope: "remote",
    timedOut,
    artifacts: { sbit },
    log,
    hint: ok ? undefined : "未看到 done bit is 1，或 cdt_cfg 返回 E:。",
  };
}

// Remote SPI flash: stage the (local) .sbit, generate the .sfc on the remote, and
// run the jtag→SPI program/verify chain via runCdtRemote. Caller must have
// scan-verified the IDCODE. ok requires a verify success line.
export async function flashSpiRemote(executor, install, { sbit, flashPart, deviceIndex = 0, port = 65425, timeoutSec = 300, serverWaitSec = 5 } = {}) {
  const dev = Number(deviceIndex);
  const fwd = (p) => String(p).replace(/\\/g, "/");
  const { log, timedOut } = await runCdtRemote(executor, install, {
    files: [{ localPath: sbit, remoteName: "design.sbit" }],
    makeTcl: (rdir, sep) => {
      const rsbit = fwd(`${rdir}${sep}design.sbit`);
      const rsfc = fwd(`${rdir}${sep}design.sfc`);
      return [
        "cfg_set_tcl_break -flag true",
        `cfg_connect -ip 127.0.0.1 -port ${Number(port)}`,
        "cfg_scan_chain",
        "cfg_set_cable_property -index 0 -freq 5Mhz",
        `cfg_gen_sfc -sbit ${rsbit} -sfc ${rsfc} -device_name ${flashPart}`,
        `cfg_jtag_flash_scan_device -device_index ${dev}`,
        `cfg_jtag_flash_assign_file -file ${rsfc} -device_index ${dev}`,
        `cfg_jtag_flash_erase -device_index ${dev}`,
        `cfg_jtag_flash_program -device_index ${dev}`,
        `cfg_jtag_flash_verify -device_index ${dev}`,
        "cfg_disconnect",
        "cfg_close",
      ].join("\n");
    },
    port: Number(port),
    timeoutSec,
    serverWaitSec,
  });
  const ok = /verify.*(success|pass|ok)|success/i.test(log) && !/^\s*E:/im.test(log);
  return { ok, phase: "flash_spi", scope: "remote", timedOut, artifacts: { sbit }, flashPart, log, hint: ok ? undefined : "未看到 verify success，或 cdt_cfg 返回 E:。" };
}
