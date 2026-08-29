import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureVerifiedResult,
  getVaultEntry,
  isAssertionVerificationResult,
  isHardwareVerificationResult,
  parseEntryMarkdown,
  scanRecallImpact,
  searchVault,
  serializeEntry,
  validateEntry,
  writeVerifiedCandidate,
} from "../src/core/vault.mjs";
import { registerVaultTool } from "../src/core/vault-tool.mjs";
import { register as registerSim } from "../src/toolchains/sim/index.mjs";

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log("ok  ", name);
    pass += 1;
  } catch (error) {
    console.log("FAIL", name, "-", error.message);
    fail += 1;
  }
};

const baseEntry = () => ({
  "schema-version": 1,
  id: "counter-load-a1b2c3d4e5f6",
  title: "Counter synchronous load",
  tier: "candidate",
  status: "active",
  domain: "fpga",
  kind: "design-verification",
  intent: "Prove synchronous load wins over increment.",
  summary: "The counter loads the requested value on the next rising edge.",
  tags: ["counter", "load"],
  retrieval: { aliases: ["counter_ld"], keywords: ["synchronous load"], targets: ["simulation"] },
  "verified-on": [
    {
      id: "evidence-1",
      at: "2026-07-10T00:00:00.000Z",
      mode: "simulation",
      method: "assert",
      tool: "fpga_assert",
      target: null,
      artifacts: { vcd: "D:/work/counter.vcd" },
      assertions: { passed: 2, failed: 0 },
    },
  ],
  "toolchain-version": { server: "0.0.2", git: "0123456789abcdef0123456789abcdef01234567" },
  provenance: {
    capture: "automatic",
    projectPath: "D:/work/counter",
    sourcePaths: ["rtl/counter.v"],
    sessions: ["123e4567-e89b-42d3-a456-426614174000"],
    assetsGitSha: "0123456789abcdef0123456789abcdef01234567",
  },
  rationale: "This behavior is reused by several control blocks.",
  recall: { state: "active", reason: null, "replaced-by": null },
  "created-at": "2026-07-10T00:00:00.000Z",
  "updated-at": "2026-07-10T00:00:00.000Z",
});

const metadata = {
  key: "counter-load",
  title: "Counter synchronous load",
  intent: "Prove synchronous load wins over increment.",
  summary: "The counter loads the requested value on the next rising edge.",
  rationale: "This behavior is reused by several control blocks.",
  projectPath: "D:/work/counter",
  sourcePaths: ["rtl/counter.v", "spec.md"],
  tags: ["counter", "load"],
  aliases: ["counter_ld"],
  targets: ["simulation"],
};

const verification = (at, artifact = "D:/work/counter.vcd") => ({
  at,
  mode: "simulation",
  method: "assert",
  tool: "fpga_assert",
  target: null,
  artifacts: { vcd: artifact },
  assertions: { passed: 2, failed: 0 },
});

const entryCount = (vaultDir) => {
  const entriesDir = join(vaultDir, "entries");
  return existsSync(entriesDir) ? readdirSync(entriesDir, { withFileTypes: true }).filter((item) => item.isFile()).length : 0;
};

await check("frontmatter round-trips JSON-compatible YAML flow values", () => {
  const input = baseEntry();
  const markdown = serializeEntry(input, "# Counter synchronous load\n\nReusable evidence.\n");
  const parsed = parseEntryMarkdown(markdown);
  assert.deepEqual(parsed.data, input);
  assert.match(parsed.body, /Reusable evidence/);
  assert.deepEqual(validateEntry(parsed.data), []);
});

await check("schema validator rejects invalid governance fields", () => {
  const bad = { ...baseEntry(), tier: "platinum", rationale: "" };
  const errors = validateEntry(bad);
  assert.ok(errors.some((error) => error.includes("tier")));
  assert.ok(errors.some((error) => error.includes("rationale")));
});

await check("candidate identity is stable and repeat evidence appends", () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "pango-mcp-vault-"));
  try {
    const options = {
      vaultDir,
      metadata,
      toolchainVersion: { server: "0.0.2", git: "a".repeat(40) },
      traceContext: { sessionId: "session-a", header: { assets: { gitSha: "a".repeat(40) } } },
    };
    const first = writeVerifiedCandidate({ ...options, verification: verification("2026-07-10T00:00:00.000Z") });
    const second = writeVerifiedCandidate({ ...options, verification: verification("2026-07-10T01:00:00.000Z", "D:/work/counter-2.vcd") });
    assert.equal(first.created, true);
    assert.equal(second.updated, true);
    assert.equal(first.id, second.id);
    const entry = getVaultEntry({ vaultDir, id: first.id });
    assert.equal(entry.data["verified-on"].length, 2);
    assert.deepEqual(searchVault({ vaultDir, query: "synchronous counter", tier: "candidate" }).map((item) => item.id), [first.id]);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

await check("automatic capture never rewrites a human-promoted entry", () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "pango-mcp-vault-protect-"));
  try {
    const options = {
      vaultDir,
      metadata,
      toolchainVersion: { server: "0.0.2", git: "b".repeat(40) },
      traceContext: { sessionId: "session-b", header: { assets: { gitSha: "b".repeat(40) } } },
    };
    const first = writeVerifiedCandidate({ ...options, verification: verification("2026-07-10T00:00:00.000Z") });
    const entry = getVaultEntry({ vaultDir, id: first.id });
    entry.data.tier = "trusted";
    writeFileSync(entry.path, serializeEntry(entry.data, entry.body), "utf8");
    const before = readFileSync(entry.path, "utf8");
    const skipped = writeVerifiedCandidate({ ...options, verification: verification("2026-07-10T02:00:00.000Z") });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, "tier-protected");
    assert.equal(readFileSync(entry.path, "utf8"), before);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

await check("verification predicates reject caller-claimed or partial success", () => {
  assert.equal(isAssertionVerificationResult({ ok: true, phase: "assert", passed: 1, failed: 0 }), true);
  assert.equal(isAssertionVerificationResult({ ok: true, phase: "assert", passed: 0, failed: 1 }), false);
  assert.equal(
    isHardwareVerificationResult({
      ok: true,
      phase: "ila_flow",
      stages: [
        { stage: "flash", ok: true },
        { stage: "capture", ok: true },
      ],
    }),
    true
  );
  assert.equal(isHardwareVerificationResult({ ok: true, phase: "ila_flow", stages: [{ stage: "flash", ok: true }] }), false);
});

await check("capture writes only from an objectively green tool result", () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "pango-mcp-vault-gate-"));
  try {
    const common = {
      vaultDir,
      toolName: "fpga_assert",
      args: { vcdPath: "D:/work/counter.vcd", knowledge: metadata },
      toolchainVersion: { server: "0.0.2", git: "c".repeat(40) },
      traceContext: { sessionId: "session-c", header: { assets: { gitSha: "c".repeat(40) } } },
    };
    const red = captureVerifiedResult({ ...common, result: { ok: false, phase: "assert", passed: 1, failed: 1 } });
    assert.equal(red, null);
    assert.equal(entryCount(vaultDir), 0);
    const green = captureVerifiedResult({ ...common, result: { ok: true, phase: "assert", passed: 2, failed: 0 } });
    assert.ok(green.id);
    assert.equal(entryCount(vaultDir), 1);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

await check("recall scan reports sessions that consumed an entry", () => {
  const traceDir = mkdtempSync(join(tmpdir(), "pango-mcp-recall-"));
  try {
    const entryId = "counter-load-a1b2c3d4e5f6";
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const rows = [
      { schemaVersion: 1, type: "session_start", ts: "2026-07-10T00:00:00.000Z", sessionId, assets: { gitSha: "d".repeat(40) } },
      { schemaVersion: 1, type: "asset_use", ts: "2026-07-10T00:01:00.000Z", sessionId, entryId, revision: "rev-1" },
    ];
    writeFileSync(join(traceDir, "one.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    writeFileSync(join(traceDir, "broken.jsonl"), "not-json\n", "utf8");
    const impact = scanRecallImpact({ entryId, traceDir });
    assert.equal(impact.sessions.length, 1);
    assert.equal(impact.sessions[0].sessionId, sessionId);
    assert.equal(impact.sessions[0].uses[0].revision, "rev-1");
  } finally {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

await check("fpga_vault exposes search/get/validate/recall through one tool", async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "pango-mcp-vault-tool-"));
  try {
    const created = writeVerifiedCandidate({
      vaultDir,
      metadata,
      verification: verification("2026-07-10T00:00:00.000Z"),
      toolchainVersion: { server: "0.0.2", git: "e".repeat(40) },
      traceContext: null,
    });
    const fakeServer = {
      registered: null,
      registerTool(name, schema, handler) {
        this.registered = { name, schema, handler };
      },
    };
    const toolResult = (structuredContent) => ({ structuredContent });
    const toolError = (error) => ({ isError: true, structuredContent: { ok: false, error } });
    registerVaultTool(fakeServer, toolResult, toolError);
    assert.equal(fakeServer.registered.name, "fpga_vault");

    const search = await fakeServer.registered.handler({ action: "search", vaultDir, query: "counter" });
    assert.equal(search.structuredContent.ok, true);
    assert.equal(search.structuredContent.entries[0].id, created.id);
    const get = await fakeServer.registered.handler({ action: "get", vaultDir, id: created.id });
    assert.equal(get.structuredContent.entry.id, created.id);
    const validate = await fakeServer.registered.handler({ action: "validate", vaultDir });
    assert.equal(validate.structuredContent.valid, 1);
  } finally {
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

await check("fpga_assert auto-captures green evidence and never captures red", async () => {
  const vaultDir = mkdtempSync(join(tmpdir(), "pango-mcp-vault-assert-"));
  const previousVault = process.env.PANGO_MCP_KNOWLEDGE_VAULT;
  process.env.PANGO_MCP_KNOWLEDGE_VAULT = vaultDir;
  try {
    const fakeServer = {
      handlers: new Map(),
      registerTool(name, _schema, handler) {
        this.handlers.set(name, handler);
      },
    };
    registerSim(fakeServer);
    const assertTool = fakeServer.handlers.get("fpga_assert");
    const green = await assertTool({
      log: "SPEC PASS",
      assertions: [{ name: "spec", type: "log_contains", pattern: "SPEC PASS" }],
      knowledge: metadata,
    });
    assert.equal(green.structuredContent.ok, true);
    assert.ok(green.structuredContent.knowledgeCandidate.id);
    assert.equal(entryCount(vaultDir), 1);

    const red = await assertTool({
      log: "SPEC FAIL",
      assertions: [{ name: "spec", type: "log_contains", pattern: "SPEC PASS" }],
      knowledge: { ...metadata, key: "must-not-exist", title: "Must not exist" },
    });
    assert.equal(red.structuredContent.ok, false);
    assert.equal(red.structuredContent.knowledgeCandidate, undefined);
    assert.equal(entryCount(vaultDir), 1);
  } finally {
    if (previousVault === undefined) delete process.env.PANGO_MCP_KNOWLEDGE_VAULT;
    else process.env.PANGO_MCP_KNOWLEDGE_VAULT = previousVault;
    rmSync(vaultDir, { recursive: true, force: true });
  }
});

console.log(`\nvault-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
