// Governed Markdown knowledge vault for verified FPGA design assets.
//
// Source entries are one-file-per-asset Markdown with a deliberately small
// YAML subset: every frontmatter value is JSON-compatible YAML flow syntax.
// This keeps the vault valid for Obsidian/humans without adding a runtime YAML
// dependency. Only objective tool results may reach writeVerifiedCandidate().

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

import { CONFIG, PACKAGE_DIR, toolEnv } from "./config.mjs";
import { appendTraceEvent, getTraceContext } from "./trace.mjs";
import { CODE_VERSION } from "./version.mjs";

export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const KNOWLEDGE_TIERS = Object.freeze(["candidate", "trusted", "golden"]);
export const KNOWLEDGE_STATUSES = Object.freeze(["active", "recalled"]);

// Default vault location. NOT relative to the package: `../..` is the enclosing
// monorepo here, but for anyone who installs the package standalone it is the
// grandparent of their checkout, so the server would silently mkdir+write vault
// entries outside their repo. Home-scoped, same as tracePath().
const DEFAULT_VAULT_DIR = join(homedir(), ".pango-mcp", "knowledge-vault");
const FRONTMATTER_ORDER = [
  "schema-version",
  "id",
  "title",
  "tier",
  "status",
  "domain",
  "kind",
  "intent",
  "summary",
  "tags",
  "retrieval",
  "verified-on",
  "toolchain-version",
  "provenance",
  "rationale",
  "recall",
  "created-at",
  "updated-at",
];

const REQUIRED_FIELDS = new Set(FRONTMATTER_ORDER);

export function defaultVaultDir() {
  return resolve(toolEnv().PANGO_MCP_KNOWLEDGE_VAULT || CONFIG.knowledgeVaultPath || DEFAULT_VAULT_DIR);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value).trim()).filter(Boolean))];
}

function slugify(value) {
  const slug = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || "entry";
}

function valueToYaml(value) {
  const out = JSON.stringify(value);
  return out === undefined ? "null" : out;
}

function yamlToValue(raw) {
  const text = raw.trim();
  if (!text) return "";
  try {
    return JSON.parse(text);
  } catch {
    // Human edits such as `tier: golden` remain accepted. Structured values
    // must stay in JSON-compatible flow syntax so parsing stays deterministic.
    return text.replace(/^['"]|['"]$/g, "");
  }
}

export function serializeEntry(data, body = "") {
  const keys = [
    ...FRONTMATTER_ORDER.filter((key) => Object.hasOwn(data, key)),
    ...Object.keys(data).filter((key) => !REQUIRED_FIELDS.has(key)).sort(),
  ];
  const frontmatter = keys.map((key) => `${key}: ${valueToYaml(data[key])}`).join("\n");
  const normalizedBody = String(body || "").trim();
  return `---\n${frontmatter}\n---\n${normalizedBody ? `\n${normalizedBody}\n` : ""}`;
}

export function parseEntryMarkdown(markdown) {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("knowledge entry is missing YAML frontmatter");
  const data = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const field = /^([^:]+):\s*(.*)$/.exec(line);
    if (!field) throw new Error(`unsupported frontmatter line: ${rawLine}`);
    data[field[1].trim()] = yamlToValue(field[2]);
  }
  return { data, body: text.slice(match[0].length).replace(/^\r?\n/, "") };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => !isNonEmptyString(item))) errors.push(`${path} must be an array of non-empty strings`);
}

export function validateEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return ["entry must be an object"];
  for (const key of REQUIRED_FIELDS) if (!Object.hasOwn(entry, key)) errors.push(`missing required field: ${key}`);
  if (entry["schema-version"] !== KNOWLEDGE_SCHEMA_VERSION) errors.push(`schema-version must be ${KNOWLEDGE_SCHEMA_VERSION}`);
  for (const key of ["id", "title", "domain", "kind", "intent", "summary", "rationale", "created-at", "updated-at"]) {
    if (!isNonEmptyString(entry[key])) errors.push(`${key} must be a non-empty string`);
  }
  if (isNonEmptyString(entry.id) && !/^[a-z0-9][a-z0-9-]{2,127}$/.test(entry.id)) errors.push("id must be a lowercase slug");
  if (!KNOWLEDGE_TIERS.includes(entry.tier)) errors.push(`tier must be one of: ${KNOWLEDGE_TIERS.join(", ")}`);
  if (!KNOWLEDGE_STATUSES.includes(entry.status)) errors.push(`status must be one of: ${KNOWLEDGE_STATUSES.join(", ")}`);
  validateStringArray(entry.tags, "tags", errors);

  const retrieval = entry.retrieval;
  if (!retrieval || typeof retrieval !== "object" || Array.isArray(retrieval)) errors.push("retrieval must be an object");
  else {
    validateStringArray(retrieval.aliases, "retrieval.aliases", errors);
    validateStringArray(retrieval.keywords, "retrieval.keywords", errors);
    validateStringArray(retrieval.targets, "retrieval.targets", errors);
  }

  if (!Array.isArray(entry["verified-on"]) || entry["verified-on"].length === 0) errors.push("verified-on must contain at least one evidence record");
  else {
    entry["verified-on"].forEach((evidence, index) => {
      if (!evidence || typeof evidence !== "object") errors.push(`verified-on[${index}] must be an object`);
      else for (const key of ["id", "at", "mode", "method", "tool"]) if (!isNonEmptyString(evidence[key])) errors.push(`verified-on[${index}].${key} must be a non-empty string`);
    });
  }

  if (!entry["toolchain-version"] || typeof entry["toolchain-version"] !== "object" || Array.isArray(entry["toolchain-version"])) {
    errors.push("toolchain-version must be an object");
  }
  if (!entry.provenance || typeof entry.provenance !== "object" || Array.isArray(entry.provenance)) errors.push("provenance must be an object");
  const recall = entry.recall;
  if (!recall || typeof recall !== "object" || Array.isArray(recall)) errors.push("recall must be an object");
  else if (!KNOWLEDGE_STATUSES.includes(recall.state)) errors.push(`recall.state must be one of: ${KNOWLEDGE_STATUSES.join(", ")}`);
  return errors;
}

function ensureVault(vaultDir) {
  const root = resolve(vaultDir || defaultVaultDir());
  const entriesDir = join(root, "entries");
  mkdirSync(entriesDir, { recursive: true });
  return { root, entriesDir };
}

function entryRevision(markdown) {
  return sha256(markdown);
}

function entryBody(entry) {
  const evidence = entry["verified-on"]
    .map((item) => `- ${item.at} — ${item.mode}/${item.method} via \`${item.tool}\` (evidence \`${item.id}\`)`)
    .join("\n");
  return [
    `# ${entry.title}`,
    "",
    "## Intent",
    "",
    entry.intent,
    "",
    "## Summary",
    "",
    entry.summary,
    "",
    "## Rationale",
    "",
    entry.rationale,
    "",
    "## Verification evidence",
    "",
    evidence,
  ].join("\n");
}

function candidateIdentity(metadata) {
  const logicalKey = metadata.key || ["fpga", "design-verification", metadata.projectPath || "", metadata.title].join(":");
  return `${slugify(metadata.title)}-${sha256(logicalKey).slice(0, 12)}`;
}

function normalizeToolchainVersion(version = CODE_VERSION) {
  if (version.server || version.git) return { ...version };
  return {
    server: version.version || null,
    git: version.gitFull || version.git || null,
    dirty: version.dirty ?? null,
    node: version.node || process.version,
  };
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") throw new Error("knowledge metadata is required");
  for (const key of ["title", "intent", "rationale"]) if (!isNonEmptyString(metadata[key])) throw new Error(`knowledge.${key} must be a non-empty string`);
  return {
    ...metadata,
    summary: isNonEmptyString(metadata.summary) ? metadata.summary : metadata.intent,
    tags: uniqueStrings(metadata.tags),
    aliases: uniqueStrings(metadata.aliases),
    targets: uniqueStrings(metadata.targets),
    sourcePaths: uniqueStrings(metadata.sourcePaths),
  };
}

function normalizeEvidence(verification) {
  const evidence = {
    at: verification.at || new Date().toISOString(),
    mode: verification.mode,
    method: verification.method,
    tool: verification.tool,
    target: verification.target ?? null,
    artifacts: verification.artifacts || {},
    ...(verification.assertions ? { assertions: verification.assertions } : {}),
    ...(verification.stages ? { stages: verification.stages } : {}),
  };
  evidence.id = `evidence-${sha256(JSON.stringify(evidence)).slice(0, 12)}`;
  return { id: evidence.id, ...evidence };
}

export function getVaultEntry({ vaultDir = defaultVaultDir(), id }) {
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(String(id || ""))) return null;
  const path = join(resolve(vaultDir), "entries", `${id}.md`);
  if (!existsSync(path)) return null;
  const markdown = readFileSync(path, "utf8");
  const parsed = parseEntryMarkdown(markdown);
  return { ...parsed, id: parsed.data.id, path, revision: entryRevision(markdown), errors: validateEntry(parsed.data) };
}

export function writeVerifiedCandidate({
  vaultDir = defaultVaultDir(),
  metadata: rawMetadata,
  verification,
  toolchainVersion = CODE_VERSION,
  traceContext = getTraceContext(),
} = {}) {
  const metadata = normalizeMetadata(rawMetadata);
  if (!verification || !isNonEmptyString(verification.mode) || !isNonEmptyString(verification.method) || !isNonEmptyString(verification.tool)) {
    throw new Error("objective verification evidence is incomplete");
  }
  const { entriesDir } = ensureVault(vaultDir);
  const id = candidateIdentity(metadata);
  const path = join(entriesDir, `${id}.md`);
  const evidence = normalizeEvidence(verification);
  const now = evidence.at;
  const sessionId = traceContext?.sessionId || null;
  const assetsGitSha = traceContext?.header?.assets?.gitSha || normalizeToolchainVersion(toolchainVersion).git || null;
  const existing = getVaultEntry({ vaultDir, id });

  if (existing && (existing.data.tier !== "candidate" || existing.data.status !== "active" || existing.data.recall?.state !== "active")) {
    return { id, path, skipped: true, reason: existing.data.tier !== "candidate" ? "tier-protected" : "entry-recalled", tier: existing.data.tier };
  }

  let entry;
  let body;
  let created = false;
  let updated = false;
  if (!existing) {
    created = true;
    entry = {
      "schema-version": KNOWLEDGE_SCHEMA_VERSION,
      id,
      title: metadata.title,
      tier: "candidate",
      status: "active",
      domain: "fpga",
      kind: "design-verification",
      intent: metadata.intent,
      summary: metadata.summary,
      tags: metadata.tags,
      retrieval: { aliases: metadata.aliases, keywords: uniqueStrings([...metadata.tags, ...metadata.aliases]), targets: metadata.targets },
      "verified-on": [evidence],
      "toolchain-version": normalizeToolchainVersion(toolchainVersion),
      provenance: {
        capture: "automatic",
        projectPath: metadata.projectPath || null,
        sourcePaths: metadata.sourcePaths,
        sessions: sessionId ? [sessionId] : [],
        assetsGitSha,
      },
      rationale: metadata.rationale,
      recall: { state: "active", reason: null, "replaced-by": null },
      "created-at": now,
      "updated-at": now,
    };
    body = entryBody(entry);
  } else {
    entry = { ...existing.data };
    const evidenceList = [...entry["verified-on"]];
    if (!evidenceList.some((item) => item.id === evidence.id)) {
      evidenceList.push(evidence);
      updated = true;
    }
    entry["verified-on"] = evidenceList;
    entry["updated-at"] = now;
    entry["toolchain-version"] = normalizeToolchainVersion(toolchainVersion);
    entry.tags = uniqueStrings([...entry.tags, ...metadata.tags]);
    entry.retrieval = {
      aliases: uniqueStrings([...(entry.retrieval?.aliases || []), ...metadata.aliases]),
      keywords: uniqueStrings([...(entry.retrieval?.keywords || []), ...metadata.tags, ...metadata.aliases]),
      targets: uniqueStrings([...(entry.retrieval?.targets || []), ...metadata.targets]),
    };
    entry.provenance = {
      ...entry.provenance,
      sourcePaths: uniqueStrings([...(entry.provenance?.sourcePaths || []), ...metadata.sourcePaths]),
      sessions: uniqueStrings([...(entry.provenance?.sessions || []), ...(sessionId ? [sessionId] : [])]),
      assetsGitSha,
    };
    body = existing.body;
  }

  const errors = validateEntry(entry);
  if (errors.length) throw new Error(`candidate schema validation failed: ${errors.join("; ")}`);
  const markdown = serializeEntry(entry, body);
  writeFileSync(path, markdown, "utf8");
  const revision = entryRevision(markdown);
  appendTraceEvent("asset_write", { entryId: id, revision, tier: "candidate", operation: created ? "created" : updated ? "updated" : "unchanged" });
  return { id, path, revision, tier: "candidate", ...(created ? { created: true } : {}), ...(!created ? { updated: true } : {}) };
}

export function listVaultEntries({ vaultDir = defaultVaultDir() } = {}) {
  const entriesDir = join(resolve(vaultDir), "entries");
  if (!existsSync(entriesDir)) return [];
  const entries = [];
  for (const name of readdirSync(entriesDir)) {
    if (!name.endsWith(".md")) continue;
    const path = join(entriesDir, name);
    try {
      const markdown = readFileSync(path, "utf8");
      const parsed = parseEntryMarkdown(markdown);
      entries.push({ ...parsed, id: parsed.data.id, path, revision: entryRevision(markdown), errors: validateEntry(parsed.data) });
    } catch (error) {
      entries.push({ id: name.slice(0, -3), path, data: null, body: "", revision: null, errors: [error.message] });
    }
  }
  return entries;
}

function searchScore(query, entry) {
  const text = [
    entry.title,
    entry.intent,
    entry.summary,
    ...(entry.tags || []),
    ...(entry.retrieval?.aliases || []),
    ...(entry.retrieval?.keywords || []),
    ...(entry.retrieval?.targets || []),
  ]
    .join(" ")
    .toLowerCase();
  const tokens = String(query || "").toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
  if (!tokens.length) return 1;
  return tokens.reduce((score, token) => score + (text.includes(token) ? 1 + text.split(token).length - 2 : 0), 0);
}

export function searchVault({ vaultDir = defaultVaultDir(), query = "", tier, status = "active", includeRecalled = false, limit = 10 } = {}) {
  return listVaultEntries({ vaultDir })
    .filter((entry) => entry.data && entry.errors.length === 0)
    .filter((entry) => !tier || entry.data.tier === tier)
    .filter((entry) => (includeRecalled ? (!status || entry.data.status === status) : entry.data.status === "active" && entry.data.recall?.state === "active"))
    .map((entry) => ({ entry, score: searchScore(query, entry.data) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.data["updated-at"]).localeCompare(String(a.entry.data["updated-at"])) || a.entry.id.localeCompare(b.entry.id))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
    .map(({ entry, score }) => ({
      id: entry.id,
      title: entry.data.title,
      tier: entry.data.tier,
      status: entry.data.status,
      domain: entry.data.domain,
      kind: entry.data.kind,
      intent: entry.data.intent,
      summary: entry.data.summary,
      tags: entry.data.tags,
      retrieval: entry.data.retrieval,
      updatedAt: entry.data["updated-at"],
      path: entry.path,
      revision: entry.revision,
      score,
    }));
}

export function isAssertionVerificationResult(result) {
  return !!result && result.ok === true && result.phase === "assert" && Number(result.passed) > 0 && Number(result.failed) === 0;
}

export function isHardwareVerificationResult(result) {
  if (!result || result.ok !== true || result.phase !== "ila_flow" || !Array.isArray(result.stages)) return false;
  return ["flash", "capture"].every((stage) => result.stages.some((item) => item.stage === stage && item.ok === true));
}

function compactStages(stages) {
  return (Array.isArray(stages) ? stages : []).map((stage) => ({ stage: stage.stage, ok: stage.ok, ...(stage.idcode ? { idcode: stage.idcode } : {}), ...(stage.doneBit !== undefined ? { doneBit: stage.doneBit } : {}) }));
}

export function captureVerifiedResult({ vaultDir = defaultVaultDir(), toolName, args = {}, result, toolchainVersion = CODE_VERSION, traceContext = getTraceContext() } = {}) {
  if (!args.knowledge) return null;
  let verification = null;
  if (toolName === "fpga_assert" && isAssertionVerificationResult(result)) {
    verification = {
      at: new Date().toISOString(),
      mode: args.vcdPath ? "simulation-or-capture" : "log",
      method: "assert",
      tool: toolName,
      target: null,
      artifacts: args.vcdPath ? { vcd: args.vcdPath } : {},
      assertions: { passed: result.passed, failed: result.failed, results: result.results || [] },
    };
  } else if (toolName === "fpga_ila_flow" && isHardwareVerificationResult(result)) {
    verification = {
      at: new Date().toISOString(),
      mode: "hardware",
      method: "flash+ila",
      tool: toolName,
      target: { host: args.host || "local", expectIdcode: args.expectIdcode || null },
      artifacts: { sbit: args.sbit || null, viewer: result.viewer || null, data: result.data || null },
      stages: compactStages(result.stages),
    };
  }
  if (!verification) return null;
  return writeVerifiedCandidate({ vaultDir, metadata: args.knowledge, verification, toolchainVersion, traceContext });
}

function collectTraceFiles(root, out, depth = 0) {
  if (depth > 5 || !existsSync(root)) return;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (root.toLowerCase().endsWith(".jsonl")) out.push(root);
    return;
  }
  for (const name of readdirSync(root)) collectTraceFiles(join(root, name), out, depth + 1);
}

export function scanRecallImpact({ entryId, tracePaths = [], traceDir } = {}) {
  if (!isNonEmptyString(entryId)) throw new Error("entryId is required");
  const files = [];
  for (const path of tracePaths || []) collectTraceFiles(resolve(path), files);
  if (traceDir) collectTraceFiles(resolve(traceDir), files);
  const uniqueFiles = [...new Set(files)];
  const headers = new Map();
  const uses = new Map();
  for (const path of uniqueFiles) {
    let lines;
    try {
      lines = readFileSync(path, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row.type === "session_start" && row.sessionId) headers.set(row.sessionId, row);
      if (row.type === "asset_use" && row.entryId === entryId && row.sessionId) {
        if (!uses.has(row.sessionId)) uses.set(row.sessionId, []);
        uses.get(row.sessionId).push({ ...row, tracePath: path });
      }
    }
  }
  return {
    entryId,
    traceFilesScanned: uniqueFiles.length,
    sessions: [...uses.entries()].map(([sessionId, sessionUses]) => ({ sessionId, header: headers.get(sessionId) || null, uses: sessionUses })),
  };
}

export function knowledgeCaptureSchema(z) {
  return z
    .object({
      key: z.string().optional().describe("稳定逻辑 key；同 key 的重复验证追加到同一 candidate"),
      title: z.string().min(1).describe("候选知识条目标题"),
      intent: z.string().min(1).describe("这次验证证明的需求/意图"),
      summary: z.string().optional().describe("可复用的简短结论；省略则取 intent"),
      rationale: z.string().min(1).describe("为何值得沉淀以及关键设计取舍"),
      projectPath: z.string().optional().describe("来源工程路径"),
      sourcePaths: z.array(z.string()).optional().describe("来源 RTL/spec/约束等耐久文件路径"),
      tags: z.array(z.string()).optional().describe("检索标签"),
      aliases: z.array(z.string()).optional().describe("别名/模块名"),
      targets: z.array(z.string()).optional().describe("适用板卡/工具链/环境标签"),
    })
    .describe("可选：仅当客观验证全绿时自动写回 knowledge-vault candidate；调用方不能自报 pass/fail");
}
