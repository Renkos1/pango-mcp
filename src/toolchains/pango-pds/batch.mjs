// Safe orchestration for independent PDS project variants.
//
// PDS does not lock a shared .pds/prj_tasks tree across pds_shell processes.
// Batch execution therefore requires one complete, non-overlapping project
// directory per variant and never tries to manufacture isolation with
// pds_shell -work_dir (which still rewrites the source .pds).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

export const MAX_PDS_BATCH_VARIANTS = 8;
export const MAX_PDS_BATCH_PARALLEL = 2;

const canonical = (path) => {
  return realpathSync.native ? realpathSync.native(path) : realpathSync(path);
};

const containsPath = (parent, child) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function assertProjectLocalBuildDirs(pdsPath) {
  const text = readFileSync(pdsPath, "utf8");
  const assertLocal = (name, rawValue) => {
    const value = String(rawValue || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (value && value !== ".") {
      throw new Error(`${name} 必须为项目本地 '.'；收到 '${rawValue}'。batch 不允许 variant 共享或外置 PDS 输出目录`);
    }
  };
  for (const match of text.matchAll(/\(_option\s+(prj_(?:work|impl)_dir)\s+\(_string\s+"([^"]*)"\)\)/gi)) {
    assertLocal(match[1], match[2]);
  }
  for (const match of text.matchAll(/<option\b[^>]*>/gi)) {
    const tag = match[0];
    const name = /\bname="([^"]+)"/i.exec(tag)?.[1];
    if (!/^prj_(?:work|impl)_dir$/i.test(name || "")) continue;
    assertLocal(name, /\bvalue="([^"]*)"/i.exec(tag)?.[1] || "");
  }
}

export function validatePdsBatchVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) throw new Error("variants 必须是非空数组");
  if (variants.length > MAX_PDS_BATCH_VARIANTS) throw new Error(`variants 最多 ${MAX_PDS_BATCH_VARIANTS} 个`);

  const ids = new Set();
  const normalized = variants.map((variant, index) => {
    const id = String(variant?.id || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`variants[${index}].id 非法；仅允许 1-64 位字母/数字/._-`);
    if (ids.has(id)) throw new Error(`variant id 重复: ${id}`);
    ids.add(id);

    const requested = String(variant?.pdsPath || "");
    if (!isAbsolute(requested) || extname(requested).toLowerCase() !== ".pds" || !existsSync(requested)) {
      throw new Error(`variant '${id}' 的 pdsPath 不存在、非绝对路径或不是 .pds: ${requested}`);
    }
    const pdsPath = canonical(resolve(requested));
    const projectDir = canonical(dirname(pdsPath));
    assertProjectLocalBuildDirs(pdsPath);
    return { ...variant, id, pdsPath, projectDir };
  });

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.pdsPath === b.pdsPath || containsPath(a.projectDir, b.projectDir) || containsPath(b.projectDir, a.projectDir)) {
        throw new Error(`variant '${a.id}' 与 '${b.id}' 的项目目录相同或互相嵌套；每个 variant 必须使用独立、非重叠 clone`);
      }
    }
  }
  return normalized;
}

const compactVariantResult = (variant, envelope) => {
  const result = envelope?.structuredContent || envelope || {};
  return {
    id: variant.id,
    ok: result.ok === true,
    pdsPath: variant.pdsPath,
    projectDir: variant.projectDir,
    runTarget: variant.runTarget,
    cached: result.cached === true,
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut === true,
    durationMs: result.durationMs ?? null,
    stage: result.stage ?? null,
    error: result.error,
    errorCount: result.errorCount ?? (result.errors || []).length,
    errors: result.errors || (result.error ? [result.error] : []),
    errorsDetailed: result.errorsDetailed || [],
    warnings: result.warnings,
    timing: result.timing,
    utilization: result.utilization,
    artifacts: result.artifacts,
    diagnostics: result.diagnostics,
    logPath: result.logPath,
    hint: result.hint,
  };
};

export async function executePdsBatch(variants, { maxParallel = MAX_PDS_BATCH_PARALLEL, runVariant } = {}) {
  if (typeof runVariant !== "function") throw new Error("runVariant worker is required");
  const parallel = Math.max(1, Math.min(MAX_PDS_BATCH_PARALLEL, Math.trunc(Number(maxParallel) || MAX_PDS_BATCH_PARALLEL), variants.length));
  const envelopes = new Array(variants.length);
  let cursor = 0;
  const started = Date.now();

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= variants.length) return;
      try {
        envelopes[index] = await runVariant(variants[index], index);
      } catch (error) {
        envelopes[index] = { structuredContent: { ok: false, error: error?.message || String(error), stage: "batch_worker" } };
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, () => worker()));

  const results = variants.map((variant, index) => compactVariantResult(variant, envelopes[index]));
  const failed = results.filter((result) => !result.ok).map((result) => result.id);
  return {
    ok: failed.length === 0,
    phase: "pds_batch",
    maxParallel: parallel,
    durationMs: Date.now() - started,
    variantCount: results.length,
    failed,
    variants: results,
    hint: failed.length ? `失败 variant: ${failed.join(", ")}；逐项查看 errors/timing/logPath` : undefined,
  };
}
