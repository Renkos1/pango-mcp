// Pure parsing/classification for the bare Python JTAG CLI. Hardware access
// stays in cli.py; this module makes its preflight result deterministic and
// unit-testable before the MCP result is assembled.

export const D2XX_INVENTORY_MARKER = "JTAG_D2XX_JSON:";
export const FLA_FRAMING_MARKER = "FLA_FRAMING_JSON:";

export function extractFlaFraming(out) {
  let parsed = null;
  for (const line of String(out || "").split(/\r?\n/)) {
    const at = line.indexOf(FLA_FRAMING_MARKER);
    if (at < 0) continue;
    try {
      parsed = JSON.parse(line.slice(at + FLA_FRAMING_MARKER.length).trim());
    } catch {
      // A truncated record must not hide the human-readable capture summary.
    }
  }
  return parsed;
}

export function extractD2xxInventory(out) {
  let parsed = null;
  for (const line of String(out || "").split(/\r?\n/)) {
    const at = line.indexOf(D2XX_INVENTORY_MARKER);
    if (at < 0) continue;
    try {
      parsed = JSON.parse(line.slice(at + D2XX_INVENTORY_MARKER.length).trim());
    } catch {
      // Preserve legacy fallback classification when a partial line is emitted.
    }
  }
  return parsed;
}

export function stripD2xxInventoryRecord(out) {
  return String(out || "")
    .split(/\r?\n/)
    .filter((line) => !line.includes(D2XX_INVENTORY_MARKER))
    .join("\n")
    .trim();
}

export function stripFlaFramingRecord(out) {
  return String(out || "")
    .split(/\r?\n/)
    .filter((line) => !line.includes(FLA_FRAMING_MARKER))
    .join("\n")
    .trim();
}

export function parseBareJtagIdcodes(out) {
  return [...String(out || "").matchAll(/channel\s+(\d+):\s*IDCODE\s*=\s*(0x[0-9A-Fa-f]{8})/g)]
    .map((match) => ({ channel: Number(match[1]), idcode: match[2] }))
    .filter((item) => isValidIdcode(item.idcode));
}

// cli.py has historical argparse placement rules: scan owns a subcommand-level
// --channel, flash owns a subcommand-level --tck-hz, while capture/poll use the
// global options. Keep that grammar in one place so MCP handlers cannot emit an
// accepted safety scan followed by a malformed mutating command.
export function buildBareJtagCliArgs(command, { channel, tckHz, subArgs = [] } = {}) {
  const args = [];
  if (command === "scan") {
    if (tckHz != null) args.push("--tck-hz", String(tckHz));
    args.push(command, ...subArgs);
    if (channel != null) args.push("--channel", String(channel));
    return args;
  }
  if (command === "flash") {
    if (channel != null) args.push("--channel", String(channel));
    args.push(command, ...subArgs);
    if (tckHz != null) args.push("--tck-hz", String(tckHz));
    return args;
  }
  if (["capture", "poll"].includes(command)) {
    if (channel != null) args.push("--channel", String(channel));
    if (tckHz != null) args.push("--tck-hz", String(tckHz));
    args.push(command, ...subArgs);
    return args;
  }
  throw new Error(`unsupported bare JTAG command: ${command}`);
}

export function parseBareJtagCaptureSummary(out) {
  const text = String(out || "");
  const idcode = /IDCODE\s*=\s*(0x[0-9A-Fa-f]{8})/i.exec(text)?.[1] || null;
  const framing = extractFlaFraming(text);
  const stats = /(\d+)\s+samples\s+x\s+(\d+)\s+bit,\s*(\d+)\s+distinct/i.exec(text);
  // Framing inference can intentionally fail closed before a sample summary is
  // emitted. Preserve its machine record so the MCP result still exposes the
  // candidate scores and the explicit paddingBits recovery path.
  if (!stats) return framing ? { idcode, framing } : null;
  const stepsText = /inter-sample step\(s\):\s*\[([^\]]*)\]/i.exec(text)?.[1] || "";
  const steps = [...stepsText.matchAll(/-?\d+/g)].map((match) => Number(match[0]));
  return {
    idcode,
    sampleCount: Number(stats[1]),
    width: Number(stats[2]),
    distinct: Number(stats[3]),
    steps,
    monotonic: /inter-sample step\(s\):[^\n]*\(monotonic\)/i.test(text),
    ...(framing ? { framing } : {}),
  };
}

function normalizeExpectedIdcode(value, aliases = {}) {
  const alias = aliases[String(value || "").toUpperCase()] || value;
  return /0x[0-9a-f]+/i.exec(String(alias || ""))?.[0]?.toLowerCase() || null;
}

export function evaluateBareFlashGate({ confirm, expectIdcode, aliases = {} }) {
  if (!confirm) {
    return {
      ok: false,
      phase: "confirm",
      hint: "裸机 JTAG SRAM 烧录需要显式 confirm:true；执行前会先只读 scan 并校验 expectIdcode。",
    };
  }
  const expected = normalizeExpectedIdcode(expectIdcode, aliases);
  if (!expected) {
    return {
      ok: false,
      phase: "input",
      hint: `expectIdcode 无法识别: ${expectIdcode}`,
    };
  }
  return { ok: true, expected };
}

function isValidIdcode(value) {
  const normalized = String(value || "").toLowerCase();
  return /^0x[0-9a-f]{8}$/.test(normalized) && !["0x00000000", "0xffffffff"].includes(normalized);
}

const ISSUE = {
  dll_unavailable: {
    code: "jtag_d2xx_dll_unavailable",
    hint: "D2XX DLL 无法加载；核对 cable 驱动位数与 PANGO_MCP_FTD2XX/PDS 安装路径。",
  },
  no_ftdi_devices: {
    code: "jtag_no_ftdi_devices",
    hint: "D2XX 未枚举到 FTDI cable；检查 USB 连接、板卡/下载器供电和 Windows 设备状态后重试。",
  },
  channels_open_elsewhere: {
    code: "jtag_channels_open_elsewhere",
    hint: "D2XX 报告 FT2232 通道已被其他句柄打开，无法仅凭状态确定 owner。先检查 cdt_js，再关闭占用 COM/serial/JTAG 的程序；仍全部占用时只重启或重插这根 cable。",
  },
  channel_open_failed: {
    code: "jtag_channel_open_failed",
    hint: "FTDI 已出现但通道打开失败。检查 cdt_js 与其他 COM/serial/JTAG 使用者；若无可见 owner，重启或重插这根 cable 后再扫，不要假定一定是 cdt_js。",
  },
  jtag_no_valid_idcode: {
    code: "jtag_no_valid_idcode",
    hint: "D2XX 通道可用但未读到有效 IDCODE；确认 JTAG 通道选择、板卡供电、线缆方向和 TCK 后重试。",
  },
};

export function analyzeJtagCliOutput({ out, exitCode, idcodes = [] }) {
  const inventory = extractD2xxInventory(out);
  const validIdcodes = idcodes.filter((item) => isValidIdcode(item?.idcode));
  let state;

  if (validIdcodes.length || exitCode === 0) {
    state = "ok";
  } else if (inventory?.state && inventory.state !== "available") {
    state = inventory.state;
  } else if (/Could not find module|WinError\s*193|ftd2xx\.dll.*(?:not found|load)/i.test(String(out || ""))) {
    state = "dll_unavailable";
  } else if (/FT_STATUS\s+3\b|FT_DEVICE_NOT_OPENED/i.test(String(out || ""))) {
    state = "channel_open_failed";
  } else if (!inventory && /FT_STATUS\s+2\b|FT_DEVICE_NOT_FOUND/i.test(String(out || ""))) {
    state = "no_ftdi_devices";
  } else {
    state = "jtag_no_valid_idcode";
  }

  const cable = {
    ...(inventory || {}),
    inventoryAvailable: !!inventory,
    state,
  };
  const template = ISSUE[state];
  const knownIssues = template ? [{ ...template, severity: "warning" }] : [];
  return {
    cable,
    diagnostics: { knownIssues },
    hint: template?.hint,
  };
}
