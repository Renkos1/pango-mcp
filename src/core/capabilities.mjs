// Tiered capability catalog. Keeping the always-on tool list small saves
// tokens; this one tool lets an agent discover the full surface on demand —
// including the long tail reachable through the guarded generic dispatchers
// (fpga_cdt for any cfg_*/dbg_*, fpga_exe for any bin tool).

import { CODE_VERSION } from "./version.mjs";

export const CAPABILITY_CATALOG = {
  tiers: {
    "tier0_hot": [
      { tool: "fpga_capabilities", does: "返回完整分层能力目录、长尾 howto 与 serverVersion" },
      { tool: "fpga_env", does: "探测工具链/license，并结构化报告本机 MCP server 实例归属" },
      { tool: "fpga_sim", does: "iverilog+vvp 仿真(可出 VCD)；detail 控返回粒度" },
      { tool: "fpga_msim_sim", does: "ModelSim 仿真(vlog/vcom+vsim -c)；支持 VHDL/SV，出 VCD，不信退出码" },
      { tool: "fpga_assert", does: "对日志/VCD 做声明式断言(闭环标尺；iverilog 与 ModelSim 的 VCD 通用)" },
      { tool: "fpga_vault", does: "检索/读取/校验验证资产；读取记 trace，recall 反查消费会话" },
      { tool: "fpga_wave", does: "VCD→波形图(SVG/HTML)给用户视觉反馈；open:true 弹浏览器；sim 也可 wave:true 一步出图" },
      { tool: "fpga_project_info", does: "解析 .pds：器件/顶层/源/约束" },
      { tool: "fpga_pds_run", does: "任意 -run 目标(compile/dev_map/pnr/gen_bit_stream...)；紧凑摘要+缓存" },
      { tool: "fpga_pds_reports", does: "解析构建日志/时序/资源/.sbit(不跑 PDS)" },
      { tool: "fpga_pds_scan", does: "JTAG 扫链读 IDCODE(只读，设备安全前置)" },
      { tool: "fpga_flash_sram", does: "烧 .sbit 到 SRAM(易失，需 confirm+IDCODE)" },
      { tool: "fpga_log_extract", does: "对落盘日志二次廉价提取关键信息(pds/cdt/sim)" },
    ],
    "tier1_common": [
      { tool: "fpga_pds_create_project", does: "创建最小可编译 .pds 工程" },
      { tool: "fpga_pds_create_blink_project", does: "创建面向真板的 LED blink 工程" },
      { tool: "fpga_pds_compile", does: "fpga_pds_run 的 gen_bit_stream 预设" },
      { tool: "fpga_pds_batch", does: "并行运行独立 PDS project clones；fail-closed 汇总 timing/errors" },
      { tool: "fpga_msim_compile", does: "ModelSim 仅编译(vlog/vcom)做语法/早期检查" },
      { tool: "fpga_flash_spi", does: "经 JTAG→SPI bridge 持久烧录(需 confirm+IDCODE)" },
      { tool: "fpga_cdt", does: "受护栏通用 Tcl 直通(读类自由；写器件需 confirm+IDCODE)" },
      { tool: "fpga_primitive_lookup", does: "检索 Pango 原语端口、参数与最小例化模板" },
      { tool: "fpga_ip_lookup", does: "检索 PDS IP 参数、支持器件与 datasheet" },
      { tool: "fpga_doc_search", does: "检索 PDS 文本知识、手册与 IP datasheet" },
      { tool: "fpga_jtag_scan", does: "裸机 FT2232/MPSSE 扫描 IDCODE(只读，不启动 cdt_js)" },
      { tool: "fpga_jtag_flash", does: "裸机回放 CRAM SVF 配置 SRAM(需 confirm+IDCODE)" },
      { tool: "fpga_jtag_capture", does: "本地首选：裸机 FLA 抓波并导出 VCD/JSON/CSV（无 GUI）" },
      { tool: "fpga_ila_build", does: "为现有 PDS 工程生成/注册 FIC 并构建插桩 bitstream" },
      { tool: "fpga_ila_flow", does: "GUI fallback：远程交互桌面的 guarded flash→ILA capture" },
    ],
    "tier2_expert": [
      { tool: "fpga_exe", does: "PDS bin 构建/分析工具直通 + 任意 exe -help 探测" },
      { tool: "fpga_gen_sfc", does: "把 .sbit 与可选用户数据打包为 SPI flash .sfc" },
      { tool: "fpga_gen_multi_file", does: "生成 multi-boot/upgrade/multi-function 位流容器" },
      { tool: "fpga_gen_chain_file", does: "合并 JTAG chain 位流并可导出 bin" },
      { tool: "fpga_jtag_gen_svf", does: "离线把 .sbit 转为裸机 JTAG 可回放的 CRAM SVF" },
      { tool: "fpga_ila_list_nets", does: "从综合网表列出可插桩信号并校验 net 名" },
      { tool: "fpga_ila_generate_fic", does: "按 clock/data/trigger 配置生成 FIC 调试核描述" },
      { tool: "fpga_pds_register_fic", does: "把 FIC 注册进现有 PDS 工程" },
      { tool: "fpga_ila_console", does: "执行 GUI Debugger Tcl；dbg_program 需 confirm+IDCODE 预读匹配" },
      { tool: "fpga_ila_adc_read", does: "经 ILA Console 读取器件 ADC/温度数据" },
      { tool: "fpga_ila_open", does: "GUI fallback：远程交互桌面或裸机不支持功能时打开 Fabric Debugger" },
      { tool: "fpga_ila_capture", does: "GUI fallback：驱动 Debugger 抓波并拉回 VCD/JSON/HTML" },
      { tool: "fpga_msim_do", does: "vsim -c 通用 do/Tcl 直通(coverage/force/UVM/WLF；纯软件无 confirm 门)" },
      { tool: "fpga_msim_exe", does: "ModelSim bin 工具直通(vcover/wlf2vcd/vdir...) + 任意 exe -help" },
      { tool: "fpga_msim_view", does: "本机开 ModelSim GUI 交互看波形(缩放/测量/层级)；远程仿真的 VCD 拉回本地后亦用此" },
      { tool: "fpga_msim_doc_search", does: "ModelSim 命令参考(346)+手册 PDF 注册表检索" },
      { tool: "fpga_server_cleanup", does: "审计 MCP server 父进程/内存；confirm 后仅清理二次复核的孤儿实例" },
    ],
  },
  // The long tail is reached through dispatchers, not dedicated tools.
  howto: {
    "上板点灯 / 数字→烧录全流程": "fpga_pds_create_blink_project → fpga_pds_compile 出 .sbit → fpga_pds_scan 读 IDCODE → fpga_flash_sram(confirm:true + expectIdcode)。远程板子各步加 host:<id>(可用 host 见 fpga_env.hosts)。",
    "VHDL / SystemVerilog 仿真": "fpga_msim_sim(vcom 编 VHDL、vlog -sv 编 SV；fpga_sim(iverilog) 仅 Verilog)",
    "覆盖率 / UVM / force-examine": "fpga_msim_do(vsim -coverage + coverage save/report；+UVM_TESTNAME；force/examine 自定义 run)",
    "WLF↔VCD / 库管理 / 覆盖率合并": "fpga_msim_exe(wlf2vcd/vcd2wlf/vmap/vdir/vcover)",
    "仿真波形断言": "fpga_msim_sim vcd:true 出 VCD → fpga_assert(vcd_final_eq/vcd_at_eq/...)，与 iverilog 路径同一判定器",
    "一步出结论(turnkey)": "fpga_msim_sim 一次给 compile+sim+coverage+uvm+wave+assertions：传 assertions[] 直接判规格(失败则 ok=false)、wave:true 同时出波形图——免再串 fpga_assert/fpga_wave",
    "波形给用户看(可视化反馈)": "三渠道：①fpga_msim_sim/fpga_sim wave:true 一步出 SVG/HTML 图(artifacts.waveSvg/waveHtml)；②fpga_wave 渲染任意 VCD(open:true 弹默认浏览器给用户)；③fpga_msim_view 开本机 ModelSim GUI 交互深查",
    "远程仿真后给用户看波形": "host 跑 fpga_msim_sim wave:true → VCD+波形图拉回本地镜像；本地 fpga_wave/fpga_msim_view 再展示/深查",
    "本地单驱动 JTAG 真机闭环": "fpga_ila_build 出插桩 .sbit/.fic → fpga_jtag_scan → fpga_jtag_flash(confirm:true + expectIdcode) → fpga_jtag_capture → fpga_assert；全程只用 D2XX/MPSSE，不混用 cdt_js",
    "远程/特殊功能 GUI ILA fallback": "仅当裸机 capture 不支持目标功能，或必须操作远程交互桌面时，用 fpga_ila_flow；需 Target Profile、confirm:true 与 expectIdcode",
    "ILA 低层构建/抓波": "fpga_ila_list_nets → fpga_ila_generate_fic → fpga_pds_register_fic → fpga_ila_build；本地默认 fpga_jtag_flash → fpga_jtag_capture，GUI open/console/capture 只作 fallback",
    "virtual-IO / 原始 debugger Tcl": "fpga_cdt interpreter:cdt_dbg(dbg_program/dbg_import_fic/dbg_trig_immd/dbg_run/dbg_dvio_*)",
    "器件原语/IP/手册检索": "fpga_primitive_lookup / fpga_ip_lookup / fpga_doc_search；auto 模式有向量时走语义，否则回退关键词",
    "SPI flash(细粒度)": "fpga_flash_spi，或 fpga_cdt cfg_jtag_flash_*(confirm+expectIdcode)",
    "SPI/multi-boot/chain 文件打包": "fpga_gen_sfc / fpga_gen_multi_file / fpga_gen_chain_file；只生成文件，不访问 cable",
    "读配置状态/IDCODE/user code": "fpga_cdt cfg_read_device_property / dbg_read_status_register(只读)",
    "生成/配置 IP 核": "fpga_exe ip_generate(先 fpga_exe ip_generate -help 看用法)",
    "功耗估算/规划": "fpga_exe ppc(Power Calculator) / ppp(Power Planner)",
    "比特流格式转换": "fpga_exe cdt_bts(Bitstream Tool)",
    "时序/资源": "fpga_pds_run report_timing / dev_map，再 fpga_pds_reports 解析",
    "探查任意工具用法": "fpga_exe <exe> -help（任意 bin exe 都可只读探测）",
  },
  notes: [
    "默认返回紧凑摘要省 token；需全文用 detail:'full'。",
    "写器件动作(flash/program)一律 confirm:true + expectIdcode + 先 scan 校验(AI 无执行权红线)。",
    "GUI(pds.exe/assistant) 与设备解释器原始直跑不开放：构建用 fpga_pds_run，设备用 fpga_cdt。",
  ],
};

export function registerCapabilities(server, toolResult) {
  server.registerTool(
    "fpga_capabilities",
    {
      title: "能力目录 (分层)",
      description: "返回分层工具目录(tier0 热点/tier1 常用/tier2 专家) + 长尾能力如何经 fpga_cdt/fpga_exe 触达 + 成本/安全注意。用于发现完整 PDS 控制面而不撑大每个工具 schema。也回 serverVersion(运行实例的代码指纹)——与工作树 HEAD 不一致即服务陈旧,需重启。",
      inputSchema: {},
    },
    async () => toolResult({ ok: true, phase: "capabilities", serverVersion: CODE_VERSION, ...CAPABILITY_CATALOG })
  );
}
