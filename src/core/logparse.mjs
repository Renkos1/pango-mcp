// Backend-agnostic log-extraction framework. The point is token economy:
// tools return compact, extracted findings by default and persist the full log
// to disk; the agent opts into the full text only when it needs it.
//
// Toolchain-specific extractors (PDS build hook, etc.) live with their
// toolchain and reuse these primitives + the known-issue rule matcher.

export function splitLines(text) {
  return String(text || "").split(/\r?\n/);
}

export function lastLines(text, n = 40) {
  const lines = splitLines(text);
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

// Attach a log to a result object under a token budget. Small logs are returned
// in full (so cheap flows like sim still carry their log); large logs are
// replaced by a tail + an on-disk path unless detail === "full".
export function attachLog(obj, text, { detail = "summary", logPath = null, tailCount = 40, fullThreshold = 8192 } = {}) {
  const s = String(text || "");
  const lines = splitLines(s);
  obj.logLines = lines.length;
  obj.logBytes = Buffer.byteLength(s, "utf8");
  if (logPath) obj.logPath = logPath;
  if (detail === "full" || obj.logBytes <= fullThreshold) {
    obj.log = s;
    obj.truncated = false;
  } else {
    obj.truncated = true;
    obj.tail = lines.slice(Math.max(0, lines.length - tailCount)).join("\n");
  }
  return obj;
}

// Cap a list and report how many were dropped, so big error/warning lists never
// blow up a return payload.
export function capList(items, max = 50) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length <= max) return { items: arr, count: arr.length, truncated: false };
  return { items: arr.slice(0, max), count: arr.length, truncated: true };
}

// Generic known-issue rule matcher. A rule is
//   { code, severity, pattern: RegExp, hint, doc? }
// and matched rules return as compact diagnostics entries (optionally carrying a
// `doc` pointer the knowledge layer can resolve to a manual section).
export function matchRules(text, rules = []) {
  const s = String(text || "");
  return rules
    .filter((r) => r.pattern.test(s))
    .map(({ code, severity, hint, doc }) => ({ code, severity, hint, ...(doc ? { doc } : {}) }));
}

// Furthest milestone reached, given ordered stage markers
//   [{ stage, pattern: RegExp }]
export function detectStage(text, markers = []) {
  const s = String(text || "");
  let reached = null;
  for (const m of markers) if (m.pattern.test(s)) reached = m.stage;
  return reached;
}
