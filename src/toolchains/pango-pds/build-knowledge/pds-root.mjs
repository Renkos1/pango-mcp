// Where the offline corpus builders read the vendor install from.
//
// Same rule as install.mjs DEFAULT_PDS_INSTALLS: NO baked-in machine path. A
// hardcoded default short-circuits the `||` chain and silently shadows the PDS
// install the user already configured, so a builder run on someone else's
// machine would look for the maintainer's D: drive, fail, and give no hint that
// a config exists. Resolve explicit -> dedicated env -> the configured install,
// then fail closed naming the exact knobs to set.

import { join } from "node:path";
import { pdsHome } from "../install.mjs";

export { fromVendorRel, pdsHome, toVendorRel } from "../install.mjs";

// `sub` is the path under the install root, e.g. ["doc"] or ["ip"].
export function resolveVendorPath({ explicit, envKey, sub, what }) {
  const direct = explicit || process.env[envKey];
  if (direct) return direct;
  const home = pdsHome();
  if (home) return join(home, ...sub);
  throw new Error(
    `无法定位 ${what}：未配置 PDS 安装。三选一——\n` +
      `  1) 直接传路径：node <builder>.mjs <path>\n` +
      `  2) 设 ${envKey}=<path>\n` +
      `  3) 配好 PDS 安装（pango-mcp.config.json 的 pdsInstalls[].shell，或 PANGO_MCP_PDS_2025 环境变量），\n` +
      `     builder 自动取 <install-root>/${sub.join("/")}。\n` +
      `参考 pango-mcp.config.example.json / pango-mcp.env.example。`
  );
}
