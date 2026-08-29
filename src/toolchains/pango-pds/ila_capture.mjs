// High-level ILA orchestration — bakes the multi-step GUI-debugger flow into two
// operations so callers don't re-derive it: `ilaOpen` (bring the debugger up and
// detect cores) and `ilaCapture` (set trigger + run + export + pull + parse +
// group + summarize + render the interactive viewer), each minimizing remote
// round-trips (the whole dbg_fla_* sequence runs in ONE console call).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driveConsole } from "./console.mjs";
import { detectMutatingCdt } from "./device-gate.mjs";
import { launchDebugger, searchJtagAndOpenCable, dumpDbgTree } from "./gui.mjs";
import { parseVcd, groupSignals, summarizeCapture } from "./vcd.mjs";
import { renderViewerHtml } from "./waveform_viewer.mjs";

// Parse the GUI debugger's UIA-tree dump for the detected device + FLA cores.
// dumpDbgTree can list a core twice (it appears in >1 UIA subtree) and names pick
// up a trailing tcl quote / CR — dedup + strip both.
export function parseCoresAndDevice(treeOut) {
  const cores = [];
  const seen = new Set();
  for (const m of String(treeOut || "").matchAll(/CORE:(\d+)\s+(\S+)/g)) {
    const name = m[2].replace(/['"\r\s]+$/, "");
    const key = `${m[1]}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cores.push({ index: Number(m[1]), name });
  }
  const device = (/IDCODE[^\n]*0x[0-9a-fA-F]+|DEV:0[^\n]*/.exec(treeOut || "")?.[0] || null)?.replace(/['"\r\s]+$/, "") || null;
  return { cores, device };
}

// Launch the GUI debugger on a project, scan, open the cable, and detect cores.
export async function ilaOpen(executor, { binDir, projectDir, user = "Administrator" } = {}) {
  const launch = await launchDebugger(executor, { binDir, projectDir, user });
  if (/LAUNCH_NO_WINDOW|S1_FATAL/.test(launch.out || "")) return { ok: false, stage: "launch", detail: launch.out };
  const scan = await searchJtagAndOpenCable(executor, { user });
  // Poll the UIA tree: a freshly launched / just-scanned GUI populates the Device
  // tree (DEV:/CORE:) ASYNCHRONOUSLY — a single early dump reads nothing even
  // though the device+core ARE present (verified live: the dump did contain
  // "DEV:0 ..." + "CORE:0 MyFLA0", just not at the instant of one early read).
  // Retry until they appear instead of failing on the race.
  let cores = [];
  let device = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tree = await dumpDbgTree(executor, { user, maxDepth: 9 });
    ({ cores, device } = parseCoresAndDevice(tree.out));
    if (cores.length) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  const hint = cores.length
    ? undefined
    : "GUI 调试器 UIA 树轮询后仍无 DEV:/CORE:。常见因(按概率)：① host 上无活动交互 session-1 桌面（RDP 登录该用户，qwinsta 应显示 Active 会话）② 扫描结果浮窗未关、挡住主窗 ③ 才轮到 sbit 未真仪表化。headless scan/flash 正常 ≠ GUI 可驱动；确认 session-1 活动后重试。";
  return { ok: true, alreadyRunning: /ALREADY_RUNNING/.test(launch.out || ""), cores, device, scan: (scan.out || "").trim(), hint };
}

// Build the trigger-setup tcl. Default = immediate (the core's all-don't-care
// trigger fires on `run -async`). value = match the data port against a value.
// trigger.value and trigger.condName are interpolated into the console Tcl
// unquoted, so their shape is the only thing standing between a caller and an
// extra command on that line. The numeric fields go through Number() already;
// these two were the strings left bare. A trigger value is digits in the chosen
// radix plus X for don't-care, and a condition name is a Tcl identifier.
const TRIGGER_VALUE = /^[0-9A-Fa-fXx]{1,64}$/;
const TRIGGER_COND = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function requireShape(value, pattern, label) {
  const v = String(value ?? "");
  if (!pattern.test(v)) throw new Error(`${label} 非法: ${JSON.stringify(v)}；只接受 ${pattern}`);
  return v;
}

function triggerTcl(fla, trigger) {
  if (!trigger || trigger.mode === "immediate" || !trigger.mode) return [];
  if (trigger.mode === "value") {
    // radix: 0 Binary,1 Octal,2 Hex,3 UDec. value as a string in that radix; X = don't care.
    const radix = { bin: 0, binary: 0, oct: 1, hex: 2, dec: 3 }[String(trigger.radix || "hex").toLowerCase()] ?? 2;
    const unit = trigger.unit ?? 0;
    // -func 0~7 = ==,<>,>,>=,<,<=,InRange,OutOfRange. MUST set it or the unit
    // stays 'disabled' and run captures immediately (no value gating).
    const func = trigger.func ?? 0;
    const cond = requireShape(trigger.condName || "TriggerCondition1", TRIGGER_COND, "trigger.condName");
    const v = typeof trigger.value === "number"
      ? trigger.value.toString(radix === 2 ? 16 : radix === 0 ? 2 : 10)
      : requireShape(trigger.value, TRIGGER_VALUE, "trigger.value");
    const unitN = Number(unit);
    const funcN = Number(func);
    if (!Number.isInteger(unitN) || unitN < 0 || unitN > 15) throw new Error(`trigger.unit 非法: ${unit}`);
    if (!Number.isInteger(funcN) || funcN < 0 || funcN > 7) throw new Error(`trigger.func 非法: ${func}`);
    // unit defines the match; the condition must reference the unit AND be
    // ACTIVATED (-active) or run ignores it and captures immediately.
    // The condition must be -add'ed FIRST (that also activates it); -select/-set
    // alone target a non-existent condition while the default all-don't-care
    // condition 0 stays active → the core triggers immediately (capture ignores
    // the value). catch the -add so a re-run (condition already present) doesn't
    // abort the sourced script.
    return [
      `catch {dbg_fla_set_trig_cond -device 0 -fla ${fla} -add ${cond}}`,
      `dbg_fla_set_trig_unit -device 0 -fla ${fla} -unit ${unitN} -func ${funcN} -radix ${radix} -value ${v}`,
      `dbg_fla_set_trig_cond -device 0 -fla ${fla} -select ${cond} -set {TU${unitN}}`,
      `dbg_fla_set_trig_cond -device 0 -fla ${fla} -active ${cond}`,
    ];
  }
  return [];
}

// Configure the on-chip capture buffer at RUN time (no rebuild needed). Without
// it, a slow signal reads "all zeros" in the default 1024-sample window — frame
// the event with capture config instead of shrinking the DUT divider.
//   type "n" (Nsamples): `samples` contiguous samples (<= the built .fic
//     dataDepth — the physical buffer can't be exceeded at runtime).
//   type "w" (Windows): 2^`windows` windows with the trigger at `position` —
//     combine with a value trigger to FRAME a rare/slow event, not widen the buffer.
// Omitted -> the project/.fic default applies. Params per
// `dbg_fla_set_capture -help` (-type W/w/0|N/n/1, -windows, -position, -samples).
export function captureTcl(fla, capture) {
  if (!capture) return [];
  if (/^w/i.test(String(capture.type || "n"))) {
    let cmd = `dbg_fla_set_capture -device 0 -fla ${fla} -type w`;
    if (capture.windows != null) cmd += ` -windows ${Number(capture.windows)}`;
    if (capture.position != null) cmd += ` -position ${Number(capture.position)}`;
    return [cmd];
  }
  const s = Number(capture.samples);
  return [`dbg_fla_set_capture -device 0 -fla ${fla} -type n${s ? ` -samples ${s}` : ""}`];
}

// A capture that ran but shows zero transitions usually means the window was too
// short for a slow signal (the classic "all zeros" trap) — NOT that the DUT is
// wrong. Detect it so the result steers the agent to reconfigure capture, never
// to mutate the design.
export function captureHasTransition(grouped) {
  const changed = (vals) => Array.isArray(vals) && new Set(vals).size > 1;
  if ((grouped?.groups || []).some((g) => changed(g.values))) return true;
  return Object.values(grouped?.scalars || {}).some((s) => changed(s?.values ?? s));
}

// Run a capture and produce: compact AI summary + interactive viewer + raw files.
export async function ilaCapture(
  executor,
  { fla = 0, user = "Administrator", trigger = { mode: "immediate" }, capture = null, waitMs = 1500, outDir, title = "FLA capture", clock = null, signalNames = null, busAlias = {} } = {}
) {
  const id = `${Date.now().toString(36)}`;
  const work = await executor.mkdtemp("ila-cap-");
  const remoteVcd = `${work}\\cap_${id}.vcd`.replace(/\\/g, "/");

  const immediate = !trigger || !trigger.mode || trigger.mode === "immediate";
  // Robust sequence: clear any latched error, set a value trigger if asked, then
  // a BLOCKING run (returns only after the capture completes — no -async timing
  // race, no trig_immd error-latch), then export. The default core trigger fires
  // immediately so blocking run returns fast; a value trigger waits for the match
  // (bounded by the console timeout).
  const lines = [
    "catch {clean}",
    ...captureTcl(fla, capture),
    ...(immediate ? [] : triggerTcl(fla, trigger)),
    `dbg_fla_run -device 0 -fla ${fla}`,
    `dbg_fla_export_wf_data -device 0 -fla ${fla} -format vcd -file ${remoteVcd}`,
  ];
  const timeoutSec = Math.max(60, Math.ceil(waitMs / 1000) + 50);
  const script = lines.join("\n");
  // Belt and braces. Every value above is shape-checked, so nothing should be
  // able to grow a device write here — but this path drives the same console
  // that fpga_ila_console gates, and capture is supposed to be read-only. If a
  // write ever does appear, refuse rather than run it unconfirmed.
  const mutating = detectMutatingCdt(script);
  if (mutating.length) throw new Error(`capture 脚本不应包含写器件命令: ${mutating.join(", ")}`);
  const console = await driveConsole(executor, { tcl: script, user, timeoutSec });

  mkdirSync(outDir, { recursive: true });
  const localVcd = join(outDir, `cap_${id}.vcd`);
  // getFile is the public pull on both executors (Ssh=SFTP, Local=copy) — never
  // the SSH-only `_get`, so a local capture works too.
  await executor.getFile(remoteVcd, localVcd);
  const text = readFileSync(localVcd, "utf8");
  const parsed = parseVcd(text);
  if (!parsed.nSamples) {
    return { ok: false, stage: "capture", hint: "VCD has no samples — core may have no clock (reset) or trigger never fired", consoleTail: (console.delta || "").slice(-500), localVcd };
  }
  const grouped = groupSignals(parsed, { alias: busAlias, names: signalNames });
  const summary = summarizeCapture(parsed, grouped);

  const payload = {
    title,
    meta: { nSamples: parsed.nSamples, channelCount: parsed.signals.length, clock, trigger: trigger.mode || "immediate", timescale: parsed.timescale },
    groups: grouped.groups.map((g) => ({ name: g.name, width: g.width, bitNames: g.bitNames, values: g.values })),
    scalars: grouped.scalars,
  };
  const viewerPath = join(outDir, `cap_${id}.html`);
  const dataPath = join(outDir, `cap_${id}.json`);
  writeFileSync(viewerPath, renderViewerHtml(payload), "utf8");
  writeFileSync(dataPath, JSON.stringify(payload), "utf8");

  const noTransition = !captureHasTransition(grouped);
  return {
    ok: true,
    summary,
    viewerPath,
    dataPath,
    localVcd,
    ...(noTransition
      ? {
          noTransition: true,
          hint:
            "捕获窗口内信号零跳变(疑似采样窗对慢信号太短=经典'全0'陷阱)。勿改 DUT——改抓取配置:" +
            "① trigger:{mode:'value',value,radix} 触发该信号变化点 + capture:{type:'w',position} 把窗口 frame 到事件处;" +
            "② capture:{type:'n',samples} 调大(≤构建时 dataDepth);③ 重建时用更慢采样时钟(clockNet)或更大 dataDepth;" +
            "④ 慢信号正解=storage qualification(待补)。",
        }
      : {}),
  };
}
