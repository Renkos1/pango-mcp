// MCP facade for the governed personal knowledge vault. Mutating tier/status is
// intentionally absent: promotion and recall remain human frontmatter edits +
// Git commits. Candidate creation happens only inside verified tool handlers.

import { existsSync } from "node:fs";
import { z } from "zod";

import { appendTraceEvent, tracePath } from "./trace.mjs";
import { defaultVaultDir, getVaultEntry, listVaultEntries, scanRecallImpact, searchVault } from "./vault.mjs";

export function registerVaultTool(server, toolResult, toolError) {
  server.registerTool(
    "fpga_vault",
    {
      title: "验证资产知识库",
      description:
        "检索/读取/校验 knowledge-vault，并在资产被读取时写 trace asset_use；recall 只读扫描 trace 反查受影响会话，不自动改 tier/status。candidate 只由 fpga_assert 或 fpga_ila_flow 的客观绿结果写入。",
      inputSchema: {
        action: z.enum(["search", "get", "validate", "recall"]).describe("search=检索，get=读取并记 asset_use，validate=校验 schema，recall=反查消费会话"),
        query: z.string().optional().describe("search 关键词；空值列出最近条目"),
        id: z.string().optional().describe("get/validate/recall 的知识条目 id"),
        tier: z.enum(["candidate", "trusted", "golden"]).optional().describe("search tier 过滤"),
        status: z.enum(["active", "recalled"]).optional().describe("search status 过滤；默认 active"),
        includeRecalled: z.boolean().optional().describe("search 是否允许返回 recalled；默认 false"),
        limit: z.number().int().min(1).max(100).optional().describe("search 最大返回数，默认 10"),
        tracePaths: z.array(z.string()).optional().describe("recall 要扫描的 JSONL 文件/目录路径"),
        traceDir: z.string().optional().describe("recall 要递归扫描的 trace 目录"),
        vaultDir: z.string().optional().describe("可选 vault 根目录；省略使用仓库 knowledge-vault 或配置路径"),
      },
    },
    async ({ action, query = "", id, tier, status, includeRecalled = false, limit = 10, tracePaths = [], traceDir, vaultDir } = {}) => {
      const root = vaultDir || defaultVaultDir();
      try {
        if (action === "search") {
          const entries = searchVault({ vaultDir: root, query, tier, status, includeRecalled, limit });
          return toolResult({
            ok: true,
            phase: "vault_search",
            vaultDir: root,
            count: entries.length,
            entries,
            hint: entries.length ? "用 fpga_vault action:get + id 读取完整条目；get 会在当前 trace 记 asset_use。" : "未找到匹配资产；不要把 recalled/candidate 当成 golden 使用。",
          });
        }

        if (action === "get") {
          if (!id) return toolError("fpga_vault action:get 需要 id");
          const entry = getVaultEntry({ vaultDir: root, id });
          if (!entry) return toolError(`knowledge entry 不存在: ${id}`);
          const traceRecorded = appendTraceEvent("asset_use", {
            entryId: entry.id,
            revision: entry.revision,
            tier: entry.data.tier,
            status: entry.data.status,
          });
          return toolResult({
            ok: entry.errors.length === 0,
            phase: "vault_get",
            vaultDir: root,
            traceRecorded,
            entry: {
              id: entry.id,
              path: entry.path,
              revision: entry.revision,
              frontmatter: entry.data,
              body: entry.body,
              errors: entry.errors,
            },
            hint: entry.data.tier === "golden" && entry.data.status === "active" ? undefined : `当前 tier=${entry.data.tier}/status=${entry.data.status}；candidate/trusted 仍需强模型或人复核，不能当 golden。`,
          });
        }

        if (action === "validate") {
          const entries = id ? [getVaultEntry({ vaultDir: root, id })].filter(Boolean) : listVaultEntries({ vaultDir: root });
          if (id && entries.length === 0) return toolError(`knowledge entry 不存在: ${id}`);
          const results = entries.map((entry) => ({ id: entry.id, path: entry.path, ok: entry.errors.length === 0, errors: entry.errors }));
          const invalid = results.filter((entry) => !entry.ok).length;
          return toolResult({
            ok: invalid === 0,
            phase: "vault_validate",
            vaultDir: root,
            total: results.length,
            valid: results.length - invalid,
            invalid,
            results,
            hint: invalid ? "修 frontmatter 后重跑 validate；工具不会自动改人管资产。" : undefined,
          });
        }

        if (action === "recall") {
          if (!id) return toolError("fpga_vault action:recall 需要 id");
          const entry = getVaultEntry({ vaultDir: root, id });
          if (!entry) return toolError(`knowledge entry 不存在: ${id}`);
          const paths = tracePaths.length || traceDir ? tracePaths : existsSync(tracePath()) ? [tracePath()] : [];
          const impact = scanRecallImpact({ entryId: id, tracePaths: paths, traceDir });
          return toolResult({
            ok: true,
            phase: "vault_recall",
            vaultDir: root,
            entry: { id, tier: entry.data.tier, status: entry.data.status, revision: entry.revision, path: entry.path },
            ...impact,
            mutating: false,
            hint: "若资产有误：人工把 frontmatter tier 降级或 status/recall.state 改为 recalled，填写 reason，再 git commit；随后复核这里列出的消费会话。",
          });
        }

        return toolError(`未知 fpga_vault action: ${action}`);
      } catch (error) {
        return toolError(`fpga_vault ${action || "unknown"} 失败: ${error.message}`);
      }
    }
  );
}
