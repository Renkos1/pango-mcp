// Persistent v0.3 integration hook: known-bad RTL -> objective red -> known-good
// fix -> green simulation/assertion -> candidate/trace/recall. Optional cumulative
// digital and hardware levels add PDS and explicitly gated real-board ILA work.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = dirname(here);
// Provenance anchors at the PACKAGE, not an enclosing monorepo: post-split
// `../..` is above the checkout and the recorded sourcePaths resolve nowhere.
const serverPath = join(pkgRoot, "src", "index.mjs");
const fixtureDir = join(here, "fixtures", "loop2");
const workRoot = join(here, ".integration-loop");
const simDir = join(workRoot, "sim");
const pdsDir = join(workRoot, "pds");
const vaultDir = join(workRoot, "vault");
const traceFile = join(workRoot, "trace.jsonl");
const reportPath = join(workRoot, "latest-report.json");

const LEVELS = ["software", "digital", "hardware"];
const now = () => new Date().toISOString();
const toolPath = (path) => resolve(path).replace(/\\/g, "/");

class IntegrationFailure extends Error {
  constructor(stage, message, result = null) {
    super(message);
    this.name = "IntegrationFailure";
    this.stage = stage;
    this.result = result;
  }
}

function compactResult(result) {
  if (!result || typeof result !== "object") return result;
  const stages = Array.isArray(result.stages)
    ? result.stages.slice(0, 12).map((item) => ({
        stage: item?.stage || null,
        ok: item?.ok ?? null,
        idcode: item?.idcode,
        doneBit: item?.doneBit,
        device: item?.device,
        cores: Array.isArray(item?.cores) ? item.cores.slice(0, 8) : item?.cores,
        error: item?.error,
        hint: item?.hint,
      }))
    : undefined;
  return {
    ok: result.ok ?? null,
    phase: result.phase || null,
    stage: result.stage || null,
    source: result.source || null,
    cached: result.cached || false,
    passed: result.passed,
    failed: result.failed,
    error: result.error,
    hint: result.hint,
    artifacts: result.artifacts,
    timing: result.timing,
    serverVersion: result.serverVersion,
    stages,
    consoleTail: typeof result.consoleTail === "string" ? result.consoleTail.slice(-1000) : undefined,
  };
}

function firstFailureReason(result) {
  if (!result || typeof result !== "object") return null;
  const inner = Array.isArray(result.stages) ? result.stages.find((item) => item?.ok === false) : null;
  if (inner) {
    const detail = inner.error || inner.hint || "inner stage returned ok:false";
    return `${inner.stage || "inner"}: ${detail}`;
  }
  return result.error || result.hint || null;
}

function captureProvesIncrement(capture) {
  return !!capture
    && capture.monotonic === true
    && Number(capture.sampleCount) > 0
    && Number(capture.distinct) > 1
    && Array.isArray(capture.steps)
    && capture.steps.length > 0
    && capture.steps.every((step) => Number(step) === 1);
}

const LOCAL_HARDWARE_ROUTE = Object.freeze({
  kind: "bare",
  scan: "fpga_jtag_scan",
  flash: "fpga_jtag_flash",
  capture: "fpga_jtag_capture",
});
const REMOTE_HARDWARE_ROUTE = Object.freeze({
  kind: "remote",
  scan: "fpga_pds_scan",
  flow: "fpga_ila_flow",
});

function hardwareRoute(boardProfile) {
  return boardProfile?.host ? REMOTE_HARDWARE_ROUTE : LOCAL_HARDWARE_ROUTE;
}

class StageRunner {
  constructor(report, persist = () => {}) {
    this.report = report;
    this.persist = persist;
  }

  async run(name, action, { accept = (result) => result?.ok === true, expectedFailure = false, summarize = compactResult } = {}) {
    const startedAt = now();
    const t0 = Date.now();
    console.log(`\n[stage] ${name}`);
    try {
      const result = await action();
      if (!accept(result)) {
        const detail = firstFailureReason(result) || `unexpected result: ${JSON.stringify(compactResult(result))}`;
        throw new IntegrationFailure(name, detail, result);
      }
      const record = {
        name,
        status: expectedFailure ? "expected-failure" : "pass",
        startedAt,
        durationMs: Date.now() - t0,
        summary: summarize(result),
      };
      this.report.stages.push(record);
      this.persist();
      console.log(`[${record.status}] ${name} (${record.durationMs} ms)`);
      return result;
    } catch (error) {
      const failure = error instanceof IntegrationFailure ? error : new IntegrationFailure(name, error.message, error.result || null);
      const record = {
        name,
        status: "failed",
        startedAt,
        durationMs: Date.now() - t0,
        error: failure.message,
        summary: compactResult(failure.result),
      };
      this.report.stages.push(record);
      this.report.ok = false;
      this.report.firstFailure = { stage: name, reason: failure.message };
      this.report.finishedAt = now();
      this.persist();
      throw failure;
    }
  }

  skip(name, reason) {
    this.report.stages.push({ name, status: "skipped", startedAt: now(), durationMs: 0, reason });
    this.persist();
    console.log(`[skipped] ${name} — ${reason}`);
  }
}

function requestedConfig(env = process.env) {
  const level = String(env.FPGA_INTEGRATION_LEVEL || "software").toLowerCase();
  if (!LEVELS.includes(level)) throw new Error(`FPGA_INTEGRATION_LEVEL must be one of: ${LEVELS.join(", ")}`);
  const rank = LEVELS.indexOf(level);
  const board = env.FPGA_INTEGRATION_BOARD || null;
  const expectIdcode = env.FPGA_INTEGRATION_EXPECT_IDCODE || null;
  if (rank >= LEVELS.indexOf("digital") && !board) {
    throw new Error("digital/hardware level requires explicit FPGA_INTEGRATION_BOARD Target Profile");
  }
  if (level === "hardware") {
    if (env.FPGA_INTEGRATION_CONFIRM !== "1") throw new Error("hardware level requires FPGA_INTEGRATION_CONFIRM=1");
    if (!expectIdcode) throw new Error("hardware level requires explicit FPGA_INTEGRATION_EXPECT_IDCODE");
  }
  return {
    level,
    rank,
    board,
    expectIdcode,
    backend: env.FPGA_INTEGRATION_SIM || null,
    remoteProjectDir: env.FPGA_INTEGRATION_REMOTE_PROJECT_DIR || null,
  };
}

function writeReport(report) {
  mkdirSync(workRoot, { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
}

function extractLog(result) {
  if (typeof result?.log === "string") return result.log;
  if (typeof result?.tail === "string") return result.tail;
  if (Array.isArray(result?.keyLines)) return result.keyLines.join("\n");
  return "";
}

function chooseBackend(envResult, override) {
  const hasIverilog = !!envResult?.tools?.iverilog && !!envResult?.tools?.vvp;
  const hasModelsim = !!envResult?.modelsim?.tools?.vlog && !!envResult?.modelsim?.tools?.vsim;
  if (override === "iverilog" && !hasIverilog) throw new Error("requested iverilog backend is unavailable (need iverilog + vvp)");
  if (override === "modelsim" && !hasModelsim) throw new Error("requested modelsim backend is unavailable (need vlog + vsim)");
  if (override && !["iverilog", "modelsim"].includes(override)) throw new Error("FPGA_INTEGRATION_SIM must be iverilog or modelsim");
  if (override) return override;
  if (hasIverilog) return "iverilog";
  if (hasModelsim) return "modelsim";
  throw new Error("no complete simulation backend: need iverilog+vvp or ModelSim vlog+vsim");
}

async function selftest() {
  let persisted = 0;
  const report = { ok: null, stages: [], firstFailure: null };
  const runner = new StageRunner(report, () => { persisted += 1; });
  await runner.run("known_negative", async () => ({ ok: false, signature: "expected" }), {
    expectedFailure: true,
    accept: (result) => result.ok === false && result.signature === "expected",
  });
  await runner.run("green", async () => ({ ok: true }));
  let reachedAfterFailure = false;
  let caught = null;
  try {
    await runner.run("first_broken", async () => ({ ok: false, hint: "broken here" }));
    reachedAfterFailure = true;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof IntegrationFailure) || caught.stage !== "first_broken") throw new Error("selftest did not identify the first broken stage");
  if (reachedAfterFailure) throw new Error("selftest continued after first failure");
  if (report.firstFailure?.stage !== "first_broken") throw new Error("report firstFailure is wrong");
  if (report.stages[0].status !== "expected-failure") throw new Error("known negative was not recorded as expected-failure");
  if (persisted < 3) throw new Error("stage updates were not persisted");

  let gateRejected = false;
  try {
    requestedConfig({ FPGA_INTEGRATION_LEVEL: "hardware", FPGA_INTEGRATION_BOARD: "explicit", FPGA_INTEGRATION_EXPECT_IDCODE: "X" });
  } catch (error) {
    gateRejected = /CONFIRM/.test(error.message);
  }
  if (!gateRejected) throw new Error("hardware gate did not reject missing confirmation before execution");

  const localRoute = hardwareRoute({});
  if (localRoute.kind !== "bare" || localRoute.scan !== "fpga_jtag_scan" || localRoute.flash !== "fpga_jtag_flash" || localRoute.capture !== "fpga_jtag_capture") {
    throw new Error(`local hardware route is not single-driver bare JTAG: ${JSON.stringify(localRoute)}`);
  }
  const remoteRoute = hardwareRoute({ host: "lab" });
  if (remoteRoute.kind !== "remote" || remoteRoute.scan !== "fpga_pds_scan" || remoteRoute.flow !== "fpga_ila_flow") {
    throw new Error(`remote hardware route changed unexpectedly: ${JSON.stringify(remoteRoute)}`);
  }

  const innerResult = {
    ok: false,
    phase: "ila_flow",
    hint: "see stages",
    stages: [
      { stage: "scan", ok: true, idcode: "0x00603899" },
      { stage: "flash", ok: true, doneBit: true },
      { stage: "open", ok: false, hint: "GUI did not expose a core" },
    ],
    consoleTail: "bounded diagnostic tail",
  };
  const compact = compactResult(innerResult);
  if (compact.stages?.length !== 3 || compact.stages[2].stage !== "open") throw new Error("compact result dropped nested stages");
  if (compact.consoleTail !== "bounded diagnostic tail") throw new Error("compact result dropped bounded console tail");
  if (!/open.*GUI did not expose a core/.test(firstFailureReason(innerResult))) throw new Error("inner failure reason is not actionable");
  const nestedReport = { ok: null, stages: [], firstFailure: null };
  const nestedRunner = new StageRunner(nestedReport);
  try {
    await nestedRunner.run("composite", async () => innerResult);
  } catch {}
  if (!/open.*GUI did not expose a core/.test(nestedReport.firstFailure?.reason || "")) throw new Error("runner did not persist inner failure reason");
  if (nestedReport.stages[0]?.summary?.stages?.[2]?.stage !== "open") throw new Error("runner report dropped inner stages");

  if (!captureProvesIncrement({ sampleCount: 1024, distinct: 16, steps: [1], monotonic: true })) {
    throw new Error("valid bare capture did not prove +1");
  }
  if (captureProvesIncrement({ sampleCount: 1024, distinct: 16, steps: [2], monotonic: true })) {
    throw new Error("+2 capture falsely proved +1");
  }
  console.log("integration-loop selftest: PASS (expected negative, first-failure cutoff, hardware pre-gate, single-driver route)");
}

async function main() {
  let config;
  try {
    config = requestedConfig();
  } catch (error) {
    rmSync(workRoot, { recursive: true, force: true });
    mkdirSync(workRoot, { recursive: true });
    const failed = {
      schemaVersion: 1,
      kind: "fpga-integration-loop",
      ok: false,
      level: process.env.FPGA_INTEGRATION_LEVEL || "software",
      startedAt: now(),
      finishedAt: now(),
      firstFailure: { stage: "configuration", reason: error.message },
      reportPath: toolPath(reportPath),
      stages: [{ name: "configuration", status: "failed", startedAt: now(), durationMs: 0, error: error.message }],
    };
    writeReport(failed);
    console.error(`FIRST FAILURE: configuration — ${error.message}`);
    console.error(`report: ${reportPath}`);
    process.exitCode = 1;
    return;
  }
  rmSync(workRoot, { recursive: true, force: true });
  mkdirSync(simDir, { recursive: true });
  mkdirSync(vaultDir, { recursive: true });

  const report = {
    schemaVersion: 1,
    kind: "fpga-integration-loop",
    ok: null,
    level: config.level,
    board: config.board,
    backend: null,
    startedAt: now(),
    finishedAt: null,
    firstFailure: null,
    tracePath: toolPath(traceFile),
    vaultPath: toolPath(vaultDir),
    reportPath: toolPath(reportPath),
    candidateId: null,
    serverVersion: null,
    stages: [],
  };
  const runner = new StageRunner(report, () => writeReport(report));
  writeReport(report);

  const serverEnv = {
    ...process.env,
    PANGO_MCP_TRACE: "1",
    PANGO_MCP_TRACE_FILE: traceFile,
    PANGO_MCP_KNOWLEDGE_VAULT: vaultDir,
  };
  const client = new Client({ name: "integration-loop", version: "0.3.1" });
  await client.connect(new StdioClientTransport({ command: "node", args: [serverPath], env: serverEnv }));

  const call = async (name, args = {}, timeout = 180000) => {
    const response = await client.callTool({ name, arguments: args }, undefined, {
      timeout,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: Math.max(timeout, 1800000),
      onprogress: (progress) => console.error(`[progress:${name}] ${progress.progress} ${progress.message || ""}`),
    });
    const text = response.content?.[0]?.text || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, phase: "tool_error", error: text || `${name} returned no JSON` };
    }
    if (response.isError && parsed.ok !== false) parsed.ok = false;
    parsed.__isError = !!response.isError;
    return parsed;
  };

  try {
    const envResult = await runner.run("preflight", () => call("fpga_env"), {
      accept: (result) => result.ok === true,
      summarize: (result) => ({ ok: result.ok, scope: result.scope, serverVersion: result.serverVersion, tools: result.tools, modelsim: result.modelsim }),
    });
    report.serverVersion = envResult.serverVersion || null;
    const backendResult = await runner.run("select_simulation_backend", async () => {
      try {
        return { ok: true, backend: chooseBackend(envResult, config.backend) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    });
    report.backend = backendResult.backend;
    let boardProfile = null;
    if (config.board) {
      boardProfile = await runner.run("target_profile", async () => {
        const profile = (envResult.boards || []).find((board) => board.name === config.board);
        if (!profile) return { ok: false, error: `configured Target Profile not found: ${config.board}` };
        if (config.level === "hardware" && profile.host && !config.remoteProjectDir) {
          return { ok: false, error: "remote hardware profile requires FPGA_INTEGRATION_REMOTE_PROJECT_DIR" };
        }
        return { ok: true, ...profile };
      });
    } else {
      runner.skip("target_profile", "software level has no physical target");
    }
    writeReport(report);

    await runner.run("prepare_buggy_fixture", async () => {
      copyFileSync(join(fixtureDir, "democount_buggy.v"), join(simDir, "democount.v"));
      copyFileSync(join(fixtureDir, "tb_democount.v"), join(simDir, "tb_democount.v"));
      return { ok: true, files: ["democount.v", "tb_democount.v"] };
    });

    const simulate = () =>
      report.backend === "iverilog"
        ? call("fpga_sim", {
            workdir: toolPath(simDir),
            top: "tb_democount",
            sources: ["democount.v", "tb_democount.v"],
            vcd: true,
            detail: "full",
            timeoutSec: 60,
          })
        : call("fpga_msim_sim", {
            workdir: toolPath(simDir),
            top: "tb_democount",
            sources: ["democount.v", "tb_democount.v"],
            vcd: true,
            detail: "full",
            cache: false,
            timeoutSec: 120,
          });

    await runner.run("buggy_simulation_must_fail", simulate, {
      expectedFailure: true,
      accept: (result) => result.ok === false && /MISMATCH|democount q must increment/i.test(extractLog(result)),
      summarize: (result) => ({ ok: result.ok, phase: result.phase, source: result.source, diagnostic: extractLog(result).match(/MISMATCH[^\r\n]*|democount q must increment[^\r\n]*/i)?.[0] || null }),
    });

    await runner.run("apply_known_fix", async () => {
      copyFileSync(join(fixtureDir, "democount.v"), join(simDir, "democount.v"));
      return { ok: readFileSync(join(simDir, "democount.v"), "utf8").includes("q + 4'd1") };
    });

    const fixedSim = await runner.run("fixed_simulation_must_pass", simulate, {
      accept: (result) => result.ok === true && /ALL CHECKS PASSED/i.test(extractLog(result)),
      summarize: (result) => ({ ok: result.ok, phase: result.phase, source: result.source, vcd: result.artifacts?.vcd || null, allChecksPassed: /ALL CHECKS PASSED/i.test(extractLog(result)) }),
    });

    const fixedLog = extractLog(fixedSim);
    if (!fixedLog) throw new IntegrationFailure("fixed_simulation_must_pass", "green simulator result did not expose its transcript");
    const assertion = await runner.run(
      "assert_and_capture_candidate",
      () =>
        call("fpga_assert", {
          log: fixedLog,
          vcdPath: fixedSim.artifacts?.vcd || undefined,
          assertions: [{ name: "all_checks", type: "log_contains", pattern: "ALL CHECKS PASSED" }],
          knowledge: {
            key: "integration-loop-democount-plus-one",
            title: "democount increments by one",
            intent: "Prove the corrected democount increments q by one on every rising edge",
            summary: "The self-checking testbench passes after replacing the +2 bug with +1",
            rationale: "This is the permanent v0.3 closed-loop regression and its verified result must remain reusable",
            projectPath: toolPath(pkgRoot),
            sourcePaths: [
              "test/fixtures/loop2/democount.v",
              "test/fixtures/loop2/tb_democount.v",
              "test/fixtures/loop2/spec.md",
            ],
            tags: ["integration-loop", "counter", "tdd"],
            aliases: ["democount", "q"],
            targets: [report.backend, "fpga"],
          },
        }),
      {
        accept: (result) => result.ok === true && result.failed === 0 && !!result.knowledgeCandidate?.id,
        summarize: (result) => ({ ok: result.ok, passed: result.passed, failed: result.failed, knowledgeCandidate: result.knowledgeCandidate }),
      }
    );
    report.candidateId = assertion.knowledgeCandidate.id;
    writeReport(report);

    await runner.run("vault_get_records_asset_use", () => call("fpga_vault", { action: "get", id: report.candidateId, vaultDir: toolPath(vaultDir) }), {
      accept: (result) => result.ok === true && result.traceRecorded === true && result.entry?.id === report.candidateId,
      summarize: (result) => ({ ok: result.ok, traceRecorded: result.traceRecorded, entry: { id: result.entry?.id, revision: result.entry?.revision, tier: result.entry?.frontmatter?.tier } }),
    });

    await runner.run("vault_recall_finds_consumer", () => call("fpga_vault", { action: "recall", id: report.candidateId, vaultDir: toolPath(vaultDir), tracePaths: [toolPath(traceFile)] }), {
      accept: (result) => result.ok === true && result.sessions?.some((session) => session.uses?.some((use) => use.entryId === report.candidateId)),
      summarize: (result) => ({ ok: result.ok, traceFilesScanned: result.traceFilesScanned, sessionIds: (result.sessions || []).map((session) => session.sessionId) }),
    });

    let created = null;
    let compiled = null;
    if (config.rank >= LEVELS.indexOf("digital")) {
      created = await runner.run("pds_create_project", () => call("fpga_pds_create_project", {
        projectDir: toolPath(pdsDir),
        name: "integration_loop",
        top: "democount",
        board: config.board,
        pinNames: ["clk", "led[0]", "led[1]", "led[2]", "led[3]", "led[4]"],
        force: true,
      }));

      await runner.run("pds_install_fixed_rtl", async () => {
        const source = created.artifacts?.source;
        if (!source) return { ok: false, error: "create_project returned no artifacts.source" };
        copyFileSync(join(fixtureDir, "democount.v"), source);
        return { ok: existsSync(source), source };
      });

      compiled = await runner.run("pds_build_bitstream", () => call("fpga_pds_compile", {
        pdsPath: created.artifacts.pds,
        runTarget: "gen_bit_stream",
        host: boardProfile?.host || undefined,
        cache: false,
        detail: "summary",
        timeoutSec: 900,
      }, 1200000), {
        accept: (result) => result.ok === true && !!result.artifacts?.sbit,
        summarize: (result) => ({ ok: result.ok, phase: result.phase, stage: result.stage, sbit: result.artifacts?.sbit, timing: result.timing, errors: result.errors }),
      });

      await runner.run("pds_reports", () => call("fpga_pds_reports", { pdsPath: created.artifacts.pds }), {
        accept: (result) => result.ok === true && result.health?.verdict !== "fail",
        summarize: (result) => ({ ok: result.ok, health: result.health, timing: result.timing, artifacts: result.artifacts }),
      });
    } else {
      runner.skip("pds_create_project", "software level");
      runner.skip("pds_build_bitstream", "software level");
      runner.skip("pds_reports", "software level");
    }

    if (config.level === "hardware") {
      const instrumented = await runner.run("ila_build", () => call("fpga_ila_build", {
        pdsPath: created.artifacts.pds,
        signals: ["q"],
        dataDepth: 1024,
        host: boardProfile?.host || undefined,
      }, 1800000), {
        accept: (result) => result.ok === true && !!result.sbit,
        summarize: (result) => ({ ok: result.ok, stage: result.stage, sbit: result.sbit, fic: result.fic, resolved: result.resolved }),
      });

      const route = hardwareRoute(boardProfile);

      if (route.kind === "bare") {
        await runner.run("hardware_scan", () => call(route.scan, {
          channel: 0,
          timeoutSec: 60,
        }, 120000), {
          accept: (result) => result.ok === true && Array.isArray(result.idcodes) && result.idcodes.length > 0,
          summarize: (result) => ({ ok: result.ok, idcodes: result.idcodes, cable: result.cable, diagnostics: result.diagnostics }),
        });

        runner.skip("hardware_flash_ila_capture", "local route uses guarded bare SRAM flash + bare FT2232 capture");
        await runner.run("hardware_flash_sram", () => call(route.flash, {
          sbit: instrumented.sbit,
          expectIdcode: config.expectIdcode,
          confirm: true,
          channel: 0,
          timeoutSec: 180,
        }, 300000), {
          accept: (result) => result.ok === true && result.doneBit === true,
          summarize: (result) => ({ ok: result.ok, phase: result.phase, doneBit: result.doneBit, device: result.device, cable: result.cable }),
        });

        const captureArgs = {
          fic: instrumented.fic,
          signals: "q[0],q[1],q[2],q[3]",
          vcd: toolPath(join(workRoot, "hardware-q.vcd")),
          json: toolPath(join(workRoot, "hardware-q.json")),
          timeoutSec: 120,
        };
        const bare = await runner.run("hardware_bare_capture", async () => {
          const first = await call(route.capture, captureArgs, 180000);
          if (first.ok || first.cable?.state !== "channels_open_elsewhere") return { ...first, attempts: [compactResult(first)] };
          await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
          const second = await call(route.capture, captureArgs, 180000);
          return { ...second, attempts: [compactResult(first), compactResult(second)] };
        }, {
          accept: (result) => result.ok === true && !!result.capture,
          summarize: (result) => ({ ok: result.ok, capture: result.capture, artifacts: result.artifacts, attempts: result.attempts }),
        });

        await runner.run("hardware_q_increments_by_one", async () => ({
          ok: captureProvesIncrement(bare.capture),
          capture: bare.capture,
          error: "bare capture is not a non-constant monotonic +1 sequence",
        }), {
          summarize: (result) => ({ ok: result.ok, capture: result.capture }),
        });
      } else {
        await runner.run("hardware_scan", () => call(route.scan, {
          host: boardProfile.host,
          retryOnTransient: true,
          timeoutSec: 60,
        }, 120000), {
          accept: (result) => result.ok === true && Array.isArray(result.devices) && result.devices.length > 0,
          summarize: (result) => ({ ok: result.ok, devices: result.devices, diagnostics: result.diagnostics }),
        });

        runner.skip("hardware_flash_sram", "remote route uses fpga_ila_flow on the target host");
        runner.skip("hardware_bare_capture", "bare FT2232 capture is local-only");
        const flow = await runner.run("hardware_flash_ila_capture", () => call(route.flow, {
          host: boardProfile.host,
          sbit: instrumented.sbit,
          projectDir: toolPath(config.remoteProjectDir),
          builtDir: toolPath(pdsDir),
          expectIdcode: config.expectIdcode,
          confirm: true,
          capture: { type: "n", samples: 1024 },
          signalNames: ["q[0]", "q[1]", "q[2]", "q[3]"],
          busAlias: { DataPort: "q" },
          title: "integration-loop democount q",
          outDir: toolPath(join(workRoot, "ila")),
        }, 900000), {
          accept: (result) => result.ok === true,
          summarize: (result) => ({ ok: result.ok, stages: result.stages, summary: result.summary, viewer: result.viewer, data: result.data }),
        });

        await runner.run("hardware_q_increments_by_one", async () => {
          const group = flow.summary?.groups?.find((item) => item.name === "q" || item.base === "DataPort");
          return {
            ok: !!group && group.monotonicIncrement === true && group.transitions > 0,
            group: group || null,
            error: group ? "captured q is not a changing +1 sequence" : "capture summary has no q/DataPort group",
          };
        }, {
          summarize: (result) => ({ ok: result.ok, group: result.group }),
        });
      }
    } else {
      runner.skip("ila_build", `${config.level} level`);
      runner.skip("hardware_scan", `${config.level} level`);
      runner.skip("hardware_flash_sram", `${config.level} level`);
      runner.skip("hardware_bare_capture", `${config.level} level`);
      runner.skip("hardware_flash_ila_capture", `${config.level} level`);
      runner.skip("hardware_q_increments_by_one", `${config.level} level`);
    }

    report.ok = true;
    report.finishedAt = now();
    writeReport(report);
    console.log(`\nINTEGRATION LOOP PASS (${config.level})`);
    console.log(`report: ${reportPath}`);
    console.log(`trace:  ${traceFile}`);
  } catch (error) {
    const stage = error.stage || report.firstFailure?.stage || "startup";
    const reason = error.message || String(error);
    if (!report.firstFailure) {
      report.ok = false;
      report.firstFailure = { stage, reason };
      report.finishedAt = now();
      writeReport(report);
    }
    console.error(`\nFIRST FAILURE: ${stage} — ${reason}`);
    console.error(`report: ${reportPath}`);
    console.error(`trace:  ${traceFile}`);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (process.argv.includes("--selftest")) await selftest();
else await main();
