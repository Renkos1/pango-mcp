// Backend-agnostic configuration loading for the pango-mcp capability layer.
//
// Resolves an optional JSON config and a dotenv-style file, then exposes a
// merged `toolEnv()` used by every tool invocation. Toolchain-specific install
// resolution (PDS paths/ports/IDCODEs) lives under its own toolchain folder.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
// src/core/config.mjs -> package root is two levels up.
export const PACKAGE_DIR = resolve(CORE_DIR, "..", "..");

function loadConfig() {
  const candidates = [
    process.env.PANGO_MCP_CONFIG,
    join(process.cwd(), "pango-mcp.config.json"),
    join(PACKAGE_DIR, "pango-mcp.config.json"),
  ].filter(Boolean);
  for (const path of [...new Set(candidates)].map((p) => resolve(p))) {
    if (!existsSync(path)) continue;
    try {
      return { path, data: JSON.parse(readFileSync(path, "utf8")), error: null };
    } catch (err) {
      return { path, data: {}, error: err.message };
    }
  }
  return { path: null, data: {}, error: null };
}

function loadEnvFile() {
  const candidates = [
    process.env.PANGO_MCP_ENV_FILE,
    join(process.cwd(), "pango-mcp.env"),
    join(PACKAGE_DIR, "pango-mcp.env"),
  ].filter(Boolean);
  for (const path of [...new Set(candidates)].map((p) => resolve(p))) {
    if (!existsSync(path)) continue;
    try {
      const values = {};
      for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (!match) continue;
        const value = match[2].trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
        values[match[1]] = value;
      }
      return { path, values, error: null };
    } catch (err) {
      return { path, values: {}, error: err.message };
    }
  }
  return { path: null, values: {}, error: null };
}

export const CONFIG_SOURCE = loadConfig();
export const CONFIG = CONFIG_SOURCE.data || {};
export const ENV_FILE_SOURCE = loadEnvFile();
export const ENV_FILE = ENV_FILE_SOURCE.values || {};

const configuredValue = (value) => value !== undefined && value !== null && String(value).trim() !== "";

// Resolve one tool environment variable with the same documented precedence as
// toolEnv(), while retaining provenance for diagnostics. Callers can inject the
// source maps in unit tests; no secret values are logged here automatically.
export function resolveEnvValue(
  name,
  {
    processEnv = process.env,
    envFile = ENV_FILE,
    configEnv = CONFIG.env || {},
    fallbackValue = null,
    fallbackSource = null,
  } = {}
) {
  const ordered = [
    { source: "process_env", value: processEnv?.[name], path: null },
    { source: "env_file", value: envFile?.[name], path: ENV_FILE_SOURCE.path },
    { source: "config_env", value: configEnv?.[name], path: CONFIG_SOURCE.path },
    { source: fallbackSource, value: fallbackValue, path: CONFIG_SOURCE.path },
  ].filter((item) => item.source && configuredValue(item.value));
  const effective = ordered[0] || null;
  const distinct = [...new Set(ordered.map((item) => String(item.value)))];
  return {
    name,
    value: effective ? effective.value : null,
    source: effective ? effective.source : null,
    sourcePath: effective ? effective.path : null,
    conflict: distinct.length > 1,
    candidates: ordered.map((item) => ({ source: item.source, value: item.value, path: item.path })),
    shadowed: effective ? ordered.slice(1).filter((item) => String(item.value) !== String(effective.value)).map((item) => item.source) : [],
  };
}

export function toolEnv(extra = {}) {
  // Documented priority: process environment > pango-mcp.env > JSON config.
  const env = { ...(CONFIG.env || {}), ...ENV_FILE, ...process.env };
  if (!env.PANGO_LICENSE_FILE && CONFIG.pdsLicenseFile) env.PANGO_LICENSE_FILE = CONFIG.pdsLicenseFile;
  // ModelSim/Questa license. MCP servers are launched over stdio with only a
  // safe env subset (no *_LICENSE_FILE), so the license can't be relied on from
  // the ambient shell — it must come from our own config/.env and be injected
  // into the vars ModelSim reads (MGLS first, LM as fallback). Only fill when
  // unset so an explicitly-provided ambient value still wins.
  const msimLicense = env.PANGO_MCP_MODELSIM_LICENSE || CONFIG.modelsimLicenseFile;
  if (msimLicense) {
    if (!env.MGLS_LICENSE_FILE) env.MGLS_LICENSE_FILE = msimLicense;
    if (!env.LM_LICENSE_FILE) env.LM_LICENSE_FILE = msimLicense;
  }
  return { ...env, ...extra };
}
