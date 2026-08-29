// Pango PDS license preflight.
//
// This is intentionally metadata-only and side-effect free: it never invokes a
// compiler, touches a project, or exposes license signatures/host identifiers.
// It detects definite local failures (unset/missing/expired/read error) before a
// long PDS run. Node-lock ownership, floating-server specs, and unrecognized
// formats are not guessed: anything that cannot be proven statically is left
// for the real runtime checkout instead of being false-blocked.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG, resolveEnvValue } from "../../core/config.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_STATES = new Set(["unset", "missing", "expired", "error"]);

function parseExpiry(value) {
  const raw = String(value || "").trim();
  if (!raw) return { recognized: false, permanent: false, expiresOn: null, expiresAt: null };
  if (/^(?:permanent|never|none)$/i.test(raw)) return { recognized: true, permanent: true, expiresOn: null, expiresAt: null };

  let year;
  let month;
  let day;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = Number(match[3]);
  } else {
    match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw);
    if (match) {
      const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
      year = Number(match[3]);
      month = months.indexOf(match[2].toLowerCase()) + 1;
      day = Number(match[1]);
    }
  }
  if (!year || !month || !day) return { recognized: false, permanent: false, expiresOn: raw, expiresAt: null };
  const expiresAt = new Date(year, month - 1, day, 23, 59, 59, 999);
  if (Number.isNaN(expiresAt.getTime())) return { recognized: false, permanent: false, expiresOn: raw, expiresAt: null };
  return {
    recognized: true,
    permanent: false,
    expiresOn: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    expiresAt,
  };
}

const braceField = (block, name) => new RegExp(`-${name}\\s+\\{([^}]*)\\}`, "i").exec(block)?.[1]?.trim() || null;

export function parsePdsLicenseText(text, { now = new Date() } = {}) {
  const source = String(text || "");
  const features = [];

  for (const match of source.matchAll(/(?:^|\r?\n)\s*feature\b([\s\S]*?)(?=(?:\r?\n)\s*feature\b|$)/gi)) {
    const block = match[1];
    const featureName = braceField(block, "feat_name");
    if (!featureName) continue;
    const expiry = parseExpiry(braceField(block, "expire_date"));
    const hostBound = !!braceField(block, "host_id");
    features.push({
      name: featureName,
      expiresOn: expiry.expiresOn,
      expiresAt: expiry.expiresAt,
      expiryRecognized: expiry.recognized,
      permanent: expiry.permanent,
      hostBound,
    });
  }

  // Also accept conventional FlexNet FEATURE/INCREMENT lines. Skip the custom
  // Pango "feature -feat_name {...}" form already handled above.
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*(?:FEATURE|INCREMENT)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(line);
    if (!match || /^-feat_name$/i.test(match[1])) continue;
    const expiry = parseExpiry(match[4]);
    features.push({
      name: match[1],
      expiresOn: expiry.expiresOn,
      expiresAt: expiry.expiresAt,
      expiryRecognized: expiry.recognized,
      permanent: expiry.permanent,
      hostBound: false,
    });
  }

  const nowMs = new Date(now).getTime();
  const timeValid = features.filter((feature) => feature.permanent || (feature.expiresAt && feature.expiresAt.getTime() >= nowMs));
  const expiredFeatures = features.filter((feature) => feature.expiresAt && feature.expiresAt.getTime() < nowMs);
  let state = "unknown";
  if (timeValid.length) state = "valid";
  else if (features.length && expiredFeatures.length === features.length) state = "expired";

  const datedUsable = timeValid.filter((feature) => feature.expiresAt).sort((a, b) => b.expiresAt - a.expiresAt);
  const active = datedUsable[0] || timeValid[0] || features[0] || null;
  const daysRemaining = active?.expiresAt ? Math.ceil((active.expiresAt.getTime() - nowMs) / DAY_MS) : null;
  const hostCheck = features.some((feature) => feature.hostBound) ? "unverified" : "not_applicable";

  return {
    state,
    usable: state === "valid" ? true : INVALID_STATES.has(state) ? false : null,
    blocking: INVALID_STATES.has(state),
    validation: "metadata",
    featureCount: features.length,
    features: features.map((feature) => ({
      name: feature.name,
      expiresOn: feature.expiresOn,
      permanent: feature.permanent,
      hostBound: feature.hostBound,
    })),
    expiresOn: active?.expiresOn || null,
    daysRemaining,
    hostCheck,
  };
}

function splitLicenseValue(value, platform = process.platform) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.includes(";")) return raw.split(";").map((item) => item.trim()).filter(Boolean);
  if (platform !== "win32" && raw.includes(":")) return raw.split(":").map((item) => item.trim()).filter(Boolean);
  return [raw];
}

export function inspectPdsLicenseValue(
  value,
  {
    now = new Date(),
    platform = process.platform,
    fileExists = existsSync,
    readFile = (path) => readFileSync(path, "utf8"),
  } = {}
) {
  const specs = splitLicenseValue(value, platform);
  if (!specs.length) {
    return { state: "unset", usable: false, blocking: true, validation: "metadata", entries: [], expiresOn: null, daysRemaining: null, hostCheck: "unknown" };
  }

  const entries = specs.map((spec) => {
    if (/^\d+@[^\\/]+$/.test(spec)) {
      return { spec, kind: "server", exists: null, state: "unknown", usable: null, blocking: false, validation: "runtime_required", expiresOn: null, daysRemaining: null, hostCheck: "unknown" };
    }
    const path = resolve(spec);
    if (!fileExists(path)) return { spec, path, kind: "file", exists: false, state: "missing", usable: false, blocking: true, validation: "metadata", expiresOn: null, daysRemaining: null, hostCheck: "unknown" };
    try {
      return { spec, path, kind: "file", exists: true, ...parsePdsLicenseText(readFile(path), { now }) };
    } catch (err) {
      return { spec, path, kind: "file", exists: true, state: "error", usable: false, blocking: true, validation: "metadata", error: err.message, expiresOn: null, daysRemaining: null, hostCheck: "unknown" };
    }
  });

  const valid = entries.find((entry) => entry.state === "valid");
  const unknown = entries.find((entry) => entry.state === "unknown");
  const selected = valid || unknown || entries.find((entry) => entry.state === "expired") || entries.find((entry) => entry.state === "missing") || entries[0];
  return {
    state: selected.state,
    usable: selected.state === "valid" ? true : INVALID_STATES.has(selected.state) ? false : null,
    blocking: INVALID_STATES.has(selected.state),
    validation: selected.validation,
    entries,
    expiresOn: selected.expiresOn || null,
    daysRemaining: selected.daysRemaining ?? null,
    hostCheck: selected.hostCheck || "unknown",
  };
}

function stateHint(license) {
  switch (license.state) {
    case "unset": return "PANGO_LICENSE_FILE 未设置";
    case "missing": return "PANGO_LICENSE_FILE 指向的文件不存在";
    case "expired": return `PDS license 已过期${license.expiresOn ? `（到期 ${license.expiresOn}）` : ""}`;
    case "error": return "PDS license 文件读取/解析失败";
    case "unknown": return "PDS license 无法静态验证（可能是 floating server 或未知格式），需运行时 checkout";
    default: return license.expiresOn ? `PDS license 元数据有效至 ${license.expiresOn}` : "PDS license 元数据有效";
  }
}

export function preflightPdsLicense({ resolution, ...inspectOptions } = {}) {
  const resolved = resolution || resolveEnvValue("PANGO_LICENSE_FILE", {
    fallbackValue: CONFIG.pdsLicenseFile,
    fallbackSource: "config.pdsLicenseFile",
  });
  const inspected = inspectPdsLicenseValue(resolved.value, inspectOptions);
  const conflictHint = resolved.conflict
    ? `PANGO_LICENSE_FILE 来源冲突：实际使用 ${resolved.source}，优先级为 process_env > env_file > config_env > config.pdsLicenseFile；被遮蔽来源: ${resolved.shadowed.join(", ") || "none"}。`
    : "";
  return {
    ...inspected,
    source: resolved.source,
    sourcePath: resolved.sourcePath,
    conflict: resolved.conflict,
    candidates: resolved.candidates,
    shadowed: resolved.shadowed,
    hint: `${conflictHint}${stateHint(inspected)}`,
  };
}
