// Isolated project-input staging for synthesis sidecars.
//
// The project parser owns the explicit input inventory. This module copies only
// those inputs plus bounded, manifest/dependency-derived files into a temporary
// root. It never copies a whole project tree and never writes beside the source
// .pds. Relative layout is preserved so Verilog `include` and PDS IP manifests
// keep the same lookup semantics inside the sidecar.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { xmlAttr } from "../../core/exec.mjs";

const VERILOG_TEXT = /\.(?:v|sv|vh|svh)$/i;

const fwd = (path) => String(path || "").replace(/\\/g, "/");
const isWithin = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const looksAbsolute = (path) => isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
const cleanSegment = (value) => String(value || "root").replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^_+|_+$/g, "") || "root";

export class ProjectInputStageError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectInputStageError";
    this.stage = "staging";
    this.details = details;
  }
}

// Map an explicit input outside projectDir into a deterministic namespace under
// the sidecar. Keeping the full drive/share-relative tail preserves relative
// includes between external source files without ever allowing ../ to escape.
export function stagedRelativePath(projectDir, absPath) {
  const root = resolve(projectDir);
  const abs = resolve(absPath);
  if (isWithin(root, abs)) return fwd(relative(root, abs));

  const parsed = parse(abs);
  const rootParts = String(parsed.root || "root").split(/[\\/]+/).filter(Boolean).map(cleanSegment);
  const rootLabel = `${String(parsed.root || "").startsWith("\\\\") ? "UNC_" : ""}${rootParts.join("_") || "root"}`;
  const tail = relative(parsed.root, abs).split(/[\\/]+/).filter(Boolean).map(cleanSegment);
  return ["_external", rootLabel, ...tail].join("/");
}

export function parseVerilogIncludes(text) {
  const input = String(text || "");
  let source = "";
  let state = "code";
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (state === "line_comment") {
      if (ch === "\n") {
        source += ch;
        state = "code";
      } else source += " ";
      continue;
    }
    if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        source += "  ";
        i += 1;
        state = "code";
      } else source += ch === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      source += ch;
      if (ch === "\\" && next) {
        source += next;
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      source += "  ";
      i += 1;
      state = "line_comment";
    } else if (ch === "/" && next === "*") {
      source += "  ";
      i += 1;
      state = "block_comment";
    } else {
      source += ch;
      if (ch === '"') quote = ch;
    }
  }
  const out = [];
  for (const match of source.matchAll(/^\s*`include\s+"([^"\r\n]+)"/gm)) {
    const path = match[1].trim();
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

// IDF input sources are the <file> entries under <source>. Files under <output>
// are generated logs/templates/examples and are deliberately not staged.
export function parseIdfSourcePaths(text) {
  const src = String(text || "");
  const blocks = [...src.matchAll(/<source\b[^>]*>([\s\S]*?)<\/source>/gi)].map((match) => match[1]);
  const regions = blocks.length
    ? blocks
    : [...src.matchAll(/<file_list\b[^>]*>([\s\S]*?)<\/file_list>/gi)].map((match) => match[1].replace(/<output\b[^>]*>[\s\S]*?<\/output>/gi, ""));
  const out = [];
  for (const region of regions) {
    for (const match of region.matchAll(/<file\b[^>]*>/gi)) {
      const path = xmlAttr(match[0], "pathname");
      if (path && !out.includes(path)) out.push(path);
    }
  }
  return out;
}

export function stageProjectInputs({ projectInfo, workDir }) {
  const work = resolve(workDir);
  const projectDir = resolve(projectInfo.projectDir);
  mkdirSync(work, { recursive: true });

  const copiedByDest = new Map();
  const copied = [];
  const includeFiles = [];
  const includeQueueSeen = new Set();

  const destinationFor = (relPath) => {
    const dest = resolve(work, ...fwd(relPath).split("/").filter(Boolean));
    if (!isWithin(work, dest)) {
      throw new ProjectInputStageError(`sidecar 路径越界，拒绝 staging: ${relPath}`, {
        code: "stage_path_escape",
        path: relPath,
      });
    }
    return { dest, rel: fwd(relative(work, dest)) };
  };

  const copyOne = (absPath, relHint = null, details = {}) => {
    const abs = resolve(absPath);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new ProjectInputStageError(`工程输入不存在或不是文件: ${abs}`, {
        code: "project_input_missing",
        path: abs,
        ...details,
      });
    }
    const target = destinationFor(relHint || stagedRelativePath(projectDir, abs));
    const key = target.dest.toLowerCase();
    const prior = copiedByDest.get(key);
    if (prior && prior.toLowerCase() !== abs.toLowerCase()) {
      throw new ProjectInputStageError(`两个输入映射到同一 sidecar 路径: ${target.rel}`, {
        code: "stage_path_collision",
        path: target.rel,
        sources: [prior, abs],
      });
    }
    if (!prior) {
      mkdirSync(dirname(target.dest), { recursive: true });
      copyFileSync(abs, target.dest);
      copiedByDest.set(key, abs);
      copied.push({ source: abs, destination: target.dest, path: target.rel });
    }
    return target.rel;
  };

  const includeDirs = (projectInfo.includeDirs || []).map((path) => resolve(path));
  const processIncludes = (absPath, stagedPath) => {
    if (!VERILOG_TEXT.test(absPath)) return;
    const visitKey = `${resolve(absPath).toLowerCase()}\0${stagedPath.toLowerCase()}`;
    if (includeQueueSeen.has(visitKey)) return;
    includeQueueSeen.add(visitKey);

    const text = readFileSync(absPath, "utf8");
    for (const includePath of parseVerilogIncludes(text)) {
      if (looksAbsolute(includePath)) {
        throw new ProjectInputStageError(
          `RTL 使用绝对 include，无法在隔离 sidecar 中安全保持语义: ${includePath}（由 ${absPath} 引用）。请改为相对 include 或把目录加入工程 include path。`,
          { code: "absolute_include_unsupported", include: includePath, from: absPath }
        );
      }

      const normalizedInclude = includePath.replace(/\//g, sep).replace(/\\/g, sep);
      const candidates = [
        { kind: "source", path: resolve(dirname(absPath), normalizedInclude) },
        ...includeDirs.map((dir) => ({ kind: "include_dir", path: resolve(dir, normalizedInclude) })),
        { kind: "project", path: resolve(projectDir, normalizedInclude) },
      ];
      const found = candidates.find((candidate, index) =>
        candidates.findIndex((other) => other.path.toLowerCase() === candidate.path.toLowerCase()) === index &&
        existsSync(candidate.path) && statSync(candidate.path).isFile()
      );
      if (!found) {
        throw new ProjectInputStageError(`RTL include 不存在: '${includePath}'（由 ${absPath} 引用）`, {
          code: "include_not_found",
          include: includePath,
          from: absPath,
          searched: candidates.map((candidate) => candidate.path),
        });
      }

      const base = found.kind === "source" ? dirname(resolve(work, ...stagedPath.split("/"))) : work;
      const includeDest = resolve(base, normalizedInclude);
      if (!isWithin(work, includeDest)) {
        throw new ProjectInputStageError(
          `RTL include 的相对布局会逃出 sidecar: '${includePath}'（由 ${absPath} 引用）。请改为工程内相对路径或显式工程 include path。`,
          { code: "include_path_escape", include: includePath, from: absPath, resolved: found.path }
        );
      }
      const includeRel = fwd(relative(work, includeDest));
      const copiedRel = copyOne(found.path, includeRel, { include: includePath, from: absPath });
      if (!includeFiles.some((item) => item.path.toLowerCase() === copiedRel.toLowerCase())) {
        includeFiles.push({ path: copiedRel, absPath: resolve(found.path), includedBy: absPath });
      }
      processIncludes(found.path, copiedRel);
    }
  };

  const sources = (projectInfo.sources || []).map((item) => {
    const stagedPath = copyOne(item.absPath, null, { kind: "source", projectPath: item.path });
    processIncludes(item.absPath, stagedPath);
    return { ...item, stagedPath };
  });
  const constraints = (projectInfo.constraints || []).map((item) => ({
    ...item,
    stagedPath: copyOne(item.absPath, null, { kind: "constraint", projectPath: item.path }),
  }));
  const ipFiles = (projectInfo.ipFiles || []).map((item) => {
    const stagedPath = copyOne(item.absPath, null, { kind: "ip", projectPath: item.path });
    const idfText = readFileSync(item.absPath, "utf8");
    const sourceItems = parseIdfSourcePaths(idfText).map((manifestPath) => {
      const absPath = looksAbsolute(manifestPath)
        ? resolve(manifestPath)
        : resolve(dirname(item.absPath), manifestPath.replace(/\//g, sep).replace(/\\/g, sep));
      const sourceStagedPath = copyOne(absPath, null, { kind: "ip_source", ip: item.absPath, manifestPath });
      processIncludes(absPath, sourceStagedPath);
      return { path: manifestPath, absPath, stagedPath: sourceStagedPath };
    });
    return { ...item, stagedPath, sourceItems };
  });

  return {
    workDir: work,
    projectDir,
    sources,
    constraints,
    ipFiles,
    includeFiles,
    copied,
    stagedFiles: copied.map((item) => item.destination),
  };
}
