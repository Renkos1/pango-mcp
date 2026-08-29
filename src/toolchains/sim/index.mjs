// Simulation toolchain — engine-pluggable. Current backend: iverilog + vvp.
// Owns Verilog/SystemVerilog simulation (optional VCD) and the declarative
// assertion judge (log + VCD). A future verilator/commercial backend slots in
// behind the same fpga_sim contract.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { run, toTclPath, toolError, toolResult, which } from "../../core/exec.mjs";
import { attachLog } from "../../core/logparse.mjs";
import { parseVcd } from "../../core/vcd.mjs";
import { evaluateAssertions } from "../../core/assert.mjs";
import { register as registerWave } from "./waveform.mjs";
import { renderVcdToFiles } from "../../core/waveform.mjs";
import { captureVerifiedResult, knowledgeCaptureSchema } from "../../core/vault.mjs";

export function register(server) {
  registerWave(server); // fpga_wave — VCD -> SVG/HTML, shared by iverilog + ModelSim
  server.registerTool(
    "fpga_sim",
    {
      title: "Verilog 仿真 (iverilog+vvp)",
      description:
        "用 iverilog 编译 + vvp 运行一个 Verilog/SystemVerilog 设计(含 testbench)，返回日志与 ok 判定；可选注入 wrapper 生成 VCD。",
      inputSchema: {
        workdir: z.string().describe("工作目录绝对路径(.v/.sv 文件所在)"),
        top: z.string().describe("顶层模块名，通常是零端口 testbench"),
        sources: z.array(z.string()).optional().describe("相对 workdir 的源文件；省略=workdir 下所有 .v/.sv，排除 ._fpga_*"),
        vcd: z.boolean().optional().describe("是否注入 wrapper 生成 VCD，默认 false"),
        vcdPath: z.string().optional().describe("VCD 输出路径；相对 workdir 或绝对路径。vcd=true 时默认 ._fpga_sim.vcd"),
        wave: z.boolean().optional().describe("仿真后把 VCD 渲染成波形图(SVG+HTML)，默认 false。开启自动启用 VCD；产出见 artifacts.waveSvg/waveHtml。一步出图，免再调 fpga_wave。"),
        waveSignals: z.array(z.string()).optional().describe("wave 只画这些信号(省略=全部，上限 40)"),
        waveOpen: z.boolean().optional().describe("wave 出图后用默认浏览器弹给用户看，默认 false"),
        detail: z.enum(["summary", "full"]).optional().describe("返回粒度，默认 summary(日志小则完整返回，超阈值则只回 tail)；full 强制全文"),
        timeoutSec: z.number().optional().describe("超时秒数，默认 30"),
      },
    },
    async ({ workdir, top, sources, vcd, vcdPath, wave = false, waveSignals, waveOpen = false, detail = "summary", timeoutSec }) => {
      if (!isAbsolute(workdir) || !existsSync(workdir)) return toolError(`workdir 不存在或非绝对路径: ${workdir}`);
      const iv = which("iverilog");
      const vvp = which("vvp");
      if (!iv || !vvp) return toolError("未找到 iverilog/vvp，请先安装(scoop install iverilog)");
      let files =
        sources && sources.length
          ? sources
          : readdirSync(workdir).filter((f) => /\.(v|sv)$/i.test(f) && !f.startsWith("._fpga_"));
      if (!files.length) return toolError(`workdir 无 .v/.sv 源文件: ${workdir}`);

      const artifacts = {};
      let compileTop = top;
      if (vcd || vcdPath || wave) {
        const resolvedVcd = vcdPath ? (isAbsolute(vcdPath) ? vcdPath : resolve(workdir, vcdPath)) : resolve(workdir, "._fpga_sim.vcd");
        mkdirSync(dirname(resolvedVcd), { recursive: true });
        const wrapper = "._fpga_vcd_wrapper.v";
        writeFileSync(
          join(workdir, wrapper),
          `module __fpga_vcd_wrapper;\n  ${top} __dut();\n  initial begin\n    $dumpfile("${toTclPath(resolvedVcd)}");\n    $dumpvars(0, __dut);\n  end\nendmodule\n`,
          "utf8"
        );
        files = [...files, wrapper];
        compileTop = "__fpga_vcd_wrapper";
        artifacts.vcd = resolvedVcd;
      }

      const out = "._fpga_sim.vvp";
      const comp = await run(iv, ["-g2012", "-o", out, "-s", compileTop, ...files], { cwd: workdir, timeoutSec });
      if (comp.code !== 0) {
        return toolResult(attachLog({ ok: false, phase: "compile", source: "iverilog", exitCode: comp.code, artifacts }, (comp.stdout + comp.stderr).trim(), { detail }));
      }
      const sim = await run(vvp, [out], { cwd: workdir, timeoutSec });
      const log = (sim.stdout + sim.stderr).trim();
      const failMark = /\b(error|fail|fatal|assertion failed)\b/i.test(log);
      // Turnkey waveform: render the just-produced VCD to SVG/HTML in one call.
      if (wave && artifacts.vcd && existsSync(artifacts.vcd)) {
        try {
          const w = await renderVcdToFiles(artifacts.vcd, { signals: waveSignals, open: waveOpen, title: `${top} waveform` });
          artifacts.waveSvg = w.svgPath;
          artifacts.waveHtml = w.htmlPath;
          artifacts.waveOpened = w.opened;
        } catch {}
      }
      return toolResult(
        attachLog(
          {
            ok: sim.code === 0 && !failMark,
            phase: "run",
            source: "iverilog/vvp",
            exitCode: sim.code,
            timedOut: sim.timedOut,
            artifacts,
            hint: failMark ? "运行日志含 error/fail/fatal 标记" : undefined,
          },
          log,
          { detail }
        )
      );
    }
  );

  server.registerTool(
    "fpga_assert",
    {
      title: "仿真断言判定",
      description: "对 fpga_sim 日志和/或 VCD 做声明式断言判定。支持日志包含/正则与 VCD 终值/指定时刻/永不等于。",
      inputSchema: {
        log: z.string().optional().describe("仿真日志文本"),
        vcdPath: z.string().optional().describe("VCD 文件绝对路径"),
        assertions: z
          .array(
            z.object({
              name: z.string().optional(),
              type: z.enum(["log_contains", "log_not_contains", "log_regex", "log_not_regex", "vcd_final_eq", "vcd_at_eq", "vcd_never_eq"]),
              pattern: z.string().optional(),
              flags: z.string().optional(),
              signal: z.string().optional(),
              value: z.union([z.string(), z.number(), z.boolean()]).optional(),
              time: z.number().optional(),
            })
          )
          .describe("断言列表"),
        knowledge: knowledgeCaptureSchema(z).optional(),
      },
    },
    async ({ log = "", vcdPath, assertions, knowledge }) => {
      if (!assertions?.length) return toolError("assertions 不能为空");
      let vcdParsed = null;
      if (vcdPath) {
        if (!isAbsolute(vcdPath) || !existsSync(vcdPath)) return toolError(`vcdPath 不存在或非绝对路径: ${vcdPath}`);
        vcdParsed = parseVcd(vcdPath);
      }
      const results = evaluateAssertions({ log, vcd: vcdParsed, assertions });
      const failed = results.filter((r) => !r.ok);
      const result = {
        ok: failed.length === 0,
        phase: "assert",
        source: vcdPath ? "log+vcd" : "log",
        passed: results.length - failed.length,
        failed: failed.length,
        results,
      };
      if (knowledge) {
        try {
          const candidate = captureVerifiedResult({ toolName: "fpga_assert", args: { log, vcdPath, assertions, knowledge }, result });
          if (candidate) result.knowledgeCandidate = candidate;
        } catch (error) {
          return toolError(`断言已通过但 candidate 写回失败: ${error.message}`, { phase: "knowledge_write", verification: result });
        }
      }
      return toolResult(result);
    }
  );
}
