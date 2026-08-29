// Waveform visualization tool — backend-agnostic (any VCD from fpga_sim or
// fpga_msim_sim). Renders a digital timing diagram (SVG + standalone HTML) so
// the MCP can give the user VISUAL feedback through every channel:
//   - image file (SVG/HTML path) the user can open;
//   - open:true pops the HTML in the default browser ("show it to me");
//   - inline SVG in the result for AI clients that can render it;
//   - deep interactive inspection lives in fpga_msim_view (ModelSim GUI).

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { toolError, toolResult } from "../../core/exec.mjs";
import { renderVcdToFiles } from "../../core/waveform.mjs";

export function register(server) {
  server.registerTool(
    "fpga_wave",
    {
      title: "仿真波形绘图 (VCD→SVG/HTML 图像)",
      description:
        "把 VCD(任意来源：fpga_sim/iverilog 或 fpga_msim_sim/ModelSim 的 artifacts.vcd)渲染成数字时序图。产出 .wave.svg + .wave.html 文件并返回路径；inlineSvg(默认 true)在结果里带完整 SVG 供能渲染的 AI 直接展示；open:true 用默认浏览器把波形弹给用户看。signals 选信号、maxSignals 控规模(默认 40)。需要交互式深查/缩放用 fpga_msim_view 打开 ModelSim GUI。",
      inputSchema: {
        vcdPath: z.string().describe("VCD 文件绝对路径(来自 fpga_sim/fpga_msim_sim 的 artifacts.vcd)"),
        signals: z.array(z.string()).optional().describe("要显示的信号名(ref 或全名 a.b.c)；省略=全部(上限 maxSignals)"),
        maxSignals: z.number().optional().describe("最多渲染信号数，默认 40(超出截断并提示)"),
        width: z.number().optional().describe("SVG 像素宽，默认 1100"),
        open: z.boolean().optional().describe("是否用默认浏览器弹出 HTML 给用户看，默认 false"),
        inlineSvg: z.boolean().optional().describe("是否在结果里返回完整 SVG 文本(供 AI 客户端内联渲染)，默认 true"),
      },
    },
    async ({ vcdPath, signals, maxSignals = 40, width = 1100, open = false, inlineSvg = true }) => {
      if (!isAbsolute(vcdPath) || !existsSync(vcdPath)) return toolError(`vcdPath 不存在或非绝对路径: ${vcdPath}`);
      try {
        if (statSync(vcdPath).size === 0) return toolError(`VCD 为空: ${vcdPath}（仿真可能未 dump；ModelSim 需 vcd:true 且自动 +acc，iverilog 需 vcd:true）`);
        const r = await renderVcdToFiles(vcdPath, { signals, maxSignals, width, open });
        const out = {
          ok: true,
          phase: "wave",
          source: "vcd",
          svgPath: r.svgPath,
          htmlPath: r.htmlPath,
          signalCount: r.signalCount,
          truncated: r.truncated,
          missing: r.missing.length ? r.missing : undefined,
          endTime: r.endTime,
          timescale: r.timescale,
          opened: r.opened,
          hint:
            (r.truncated ? `信号过多已截断到 ${maxSignals}，用 signals 选关键信号。` : "") +
            (r.missing.length ? `未找到信号: ${r.missing.join(", ")}。` : "") ||
            "已生成波形图：svgPath/htmlPath 可直接打开；open:true 可弹给用户；深查用 fpga_msim_view。",
        };
        if (inlineSvg) out.svg = r.svg;
        return toolResult(out);
      } catch (e) {
        return toolError(`波形渲染失败: ${e.message}`);
      }
    }
  );
}
