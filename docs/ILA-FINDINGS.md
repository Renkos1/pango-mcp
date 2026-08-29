# ILA / on-chip debug — MCP 现状、硬墙与前路（2026-06-17 落档）

> 这份文档是 ILA 一整轮调试的真值留存。上下文很长易被压缩,关键结论先看「突破」与「TL;DR」。

## 突破：用 GUI 的 Tcl Console 旁路硬墙(已验证,2026-06-17)
无头 cdt_dbg 开不了 cable(下文硬墙),但 **Fabric Debugger GUI 里有一个「Tcl Console」**,跑的是同一个 tcl 引擎、**cable 已被 GUI 打开**。在 GUI 所在的 **session 1** 里用 **UIAutomation** 往这个 Console 的输入框打字、回车,就能执行 `dbg_adc_read_reg`/`dbg_fla_*`/`source {capture.tcl}`,**纯 AI 驱动、零人工操作、cable 现成**。验证链:
- 248 SSH 落在 **session 0(服务会话,非交互)**;GUI 在 **session 1(Administrator,断开但存活)**:`pds.exe` `cdt_dbg.exe`(GUI 模式,工程 tg_fpga2)`cdt_js.exe`(持 cable,port 65425)全在跑。
- 用**交互式计划任务**(`schtasks /create ... /ru Administrator /it`)把一个 PowerShell+UIAutomation 脚本**送进 session 1** 执行 → 能完整枚举 cdt_dbg 的 UIA 控件树。
- 树里:`Window 'Fabric Debugger ...' → Window 'Console' → Tab 'Tcl Console'`;两个 Edit:`edit[0]` 只读 transcript(含 `read_adc_register execute successfully` = 设备在线),`edit[1]` 可写输入框。
- 往 `edit[1]` `ValuePattern.SetValue("puts ...")` + `SendKeys {ENTER}` → transcript 出现并执行 → **PING_ECHOED=True**。
- **落地**(MCP 化):session-1 helper 找到输入框 → `source {远端tcl}` 一行 → 轮询 transcript 出现结束 marker → 取 transcript 增量 / SFTP 拉回导出文件。raw 能力 = "给 AI 的调试控制台",上层叠 `fpga_ila_capture`/`fpga_ila_adc_read` + `show_widget` 可视化。
- 真正无人值守还差一步:GUI 当前是用户开的;后续用同一个 `/it` 计划任务技巧让 MCP 自己在 session 1 拉起 pds+debugger(session 0 拉起会渲染到非交互桌面,UIA 够不到)。

## TL;DR
- **ILA 插入链路：MCP 已自动化、已验证。** `fpga_ila_generate_fic`(纯代码生成 .fic)+ `fpga_pds_register_fic`(把 .fic 写进 .pds 的 Fabric-Inserter widget)→ 正常 `fpga_pds_run gen_bit_stream` 就出 **instrumented bitstream**。实测 248 上构建：FF 29→**353**、LUT 29→**272**、USCM 1→**2**(JTAG hub),timing 仍 met,9MB sbit 拉回本地、已烧 done bit=1。
- **抓波/读 ADC 这一步：被硬件/工具卡死,无头不可行(见硬墙)。** 只有 PDS 的 **Fabric Debugger GUI** 能开 cable;无头 `cdt_dbg -file` 的 `open_cable` 在这块板上**永久死锁**。
- **前路二选一(用户定调)**:① 程序化驱动 GUI(UIAutomation/AHK,在 248 上);② 自己实现一个调试核读取器替代 debugger(经 cdt_cfg 的 cable 访问 + 裸 JTAG 读 debug-core/JTAG-hub,工程量大)。核心只是「数据获取 + 显示」。

## MCP-native ILA 工具(已落地,`toolchains/pango-pds/ila.mjs`)
- **`fpga_ila_generate_fic`** `{ ficPath, part{device,...}, clockNet, signals[], dataDepth, busGroups[] }`
  纯字符串拼 .fic(不调 cdt_ins——cdt_ins 的 `ins_set_net` 是不稳定的整数索引,规范明确建议按名手写)。
- **`fpga_pds_register_fic`** `{ pdsPath, ficPath }`
  PDS 2025.2 的 .pds 是 XML:把 `<action name="fic">`(Fabric Inserter widget)的空 `<inputs/>` 填上 `<item type="FILE" file="<rel>.fic" .../>`。自动备份 `.bak_<ts>`。也支持早期 sexpr 形态(`wgt_my_fic_src`)。
- 远程构建已支持 **aux 文件 staging**:`parsePdsProject` 多解析 `auxFiles`(.fic 等),`stageInputs` 推上去,并把 .pds 里 .fic 的相对路径**改写成远端绝对路径**(否则 PDS 的 inserter 子进程 CWD 在 user home,报 `Inserter-0002: File ... can not be read`)。

## .fic 格式要点(INI,手写可用)
```
#Fabric Core Inserter Project File
Project.device.designInputFile=<syn .adf 绝对路径,正斜杠>
Project.device.deviceFamily=Logos2 / deviceModel=PG2L200H / devicePackage=FBB676 / deviceSpeedGrade=-6
Project.unit.dimension=1
Project.unit<0>.clockChannel=<时钟网名,如 clk>   ; 必须是运行时真在跑的时钟
Project.unit<0>.clockEdge=Rising / ramType=1 / dataDepth=1024 / dataEqualsTrigger=true
Project.unit<0>.triggerChannel<0><i>=<net 名>     ; 每个被抓信号一行,i=0..W-1
Project.unit<0>.triggerPortWidth<0>=<W>
```
net 名是 post-synth 层次名(顶层端口/未优化内部信号常保留 RTL 名,如 `counter[0]`)。

## 硬墙：无头 cdt_dbg 开不了 cable（5 次独立验证,已排除一切软件因素）

| 客户端 / 模式 | open_cable |
|---|---|
| `cdt_cfg -file`(无头配置器) | ✅ 秒开（"D2XX DLL", 选 "USB Cable II", 读到 IDCODE 0x00603899）|
| `cdt_dbg` **GUI 模式**(pds.exe 启动) | ✅（用户手动可扫可连可读 ADC）|
| `cdt_dbg -file`(无头调试器) | ❌ **`dbg_scan_chain → COMMAND: open_cable` 永久死锁** |

**已逐一排除**:license（package 含 `fabric_debugger`)、进程残留/强杀句柄（全清+全新仍卡）、慢 vs 死（100s 无进展）、PDS 版本（2022.2/2025.2 都卡）、cable 物理（cdt_cfg 秒读）、cable 独占（cdt_cfg 能与 GUI 共享同一 cdt_js）、cdt_js `-work_dir`（连 GUI 自己带 work_dir 的 cdt_js 也卡）。
**`dbg_adc_read_reg`** 不 scan 直接读 → `E: Debugger-0009: 没有 device,请先 open cable`,即也要 per-process open cable → 同样撞墙。
**结论**:这块 FT2232 "USB Cable II" 上,只有 GUI 模式(pds.exe 带 `-parent_process_key` 启动 cdt_dbg + cdt_js `-work_dir`)能开 debugger 的 cable。无头 `-file` 模式不行。**不是 MCP 代码问题。**

## 2025.2 cdt_dbg 真实命令（语料里的 2022.2 recipe 已过时,待修）
- 选核:`-fla <核号>`(不是旧的 `dbg_set_cur_core -core`)
- `dbg_connect -ip -port` → `dbg_scan_chain`(无参) → `dbg_program -device -file` / `dbg_import_fic -device -file`
- 抓波:`dbg_fla_set_capture -fla 0 -type n -samples 1024` → `dbg_fla_trig_immd -fla 0` → `dbg_fla_run -fla 0 [-async]` → `dbg_fla_export_wf_data`
- ADC:`dbg_adc_read_reg -address <hex>` / `dbg_adc_write_reg -address -value`
- 其它:`dbg_dvio_*`(virtual-IO)、`dbg_hsst_*`(SerDes)、`dbg_axi_*`、`dbg_open_project`/`dbg_save_project`、`clean`(错误后 latch,需 clean)
- **旧 recipe(`dbg_run`/`dbg_set_capture`/`dbg_trig_immd`/`dbg_set_cur_core`)在 2025.2 不存在** → 语料 chunk 034 待更新。

## GUI 启动内幕（探到的真实命令行,用于「驱动/复刻 GUI」）
```
pds.exe(IDE) 启动:
  cdt_dbg.exe <项目目录 .../tg_fpga2> -parent_process_key <pds的pid>     # 无 -file = GUI 模式
cdt_dbg(GUI) 又起:
  cdt_js.exe -work_dir <项目目录 .../tg_fpga2> -port 65425
```
GUI 的 `dbg.log` 只记 `read_adc_register 执行成功`,**不记数值**(温度算在界面)。项目目录无自动保存的数据文件。

## 前路（用户定调:ILA 关键,必须拿回）
1. **程序化驱动 GUI（推荐先试）**:在 248 上用 UIAutomation(PowerShell `UIAutomationClient` / FlaUI / AutoHotkey)驱动 Fabric Debugger GUI 的"连接/扫链/trigger/导出"按钮,GUI 能开 cable → 拿到 VCD/ADC,再 SSH 拉回本地用 `core/vcd.mjs` 解析 + `show_widget` 可视化。难点:UIAutomation 脚本要稳、要能定位控件。
2. **复刻 debugger（替代界面）**:核心只是「数据获取 + 显示」。获取要经 JTAG 读 debug-core/JTAG-hub 寄存器——而 cdt_cfg 能开 cable。可研究能否用 `cdt_cfg` 的 cable 通道 + 裸 JTAG 时序读 debug core(ips_debug_core/ips_jtag_hub 的寄存器协议),绕过 cdt_dbg。工程量大,需 debug-core/JTAG-hub 寄存器规范。
3. **换 cable**:这根 FT2232 的无头 debugger 路径有问题;官方/兼容 cable 也许无头可用。

## 远程 cdt 编排的技术经验（避坑）
- Windows OpenSSH 下 **cmd 的 console/job 语义会破坏 cdt_js↔cdt_cfg**:cdt_js 随会话死,或其 console 吞掉客户端 stdout。**解法 = 单个 PowerShell 会话**:`Start-Process cdt_js -PassThru` 让它存活,`& cdt_cfg | Out-String` 落文件读回。
- **GUI-subsystem exe(cdt_dbg/cdt_ins)** 用 `& ... | Out-String` 抓不到 stdout,必须 `Start-Process -RedirectStandardOutput -RedirectStandardError -PassThru` + `WaitForExit(ms)/Kill`。
- **inline node `-e` 里的反斜杠路径会被 bash 工具吃掉** → 用脚本文件,或 **base64 内联 PowerShell**(`powershell -EncodedCommand <utf16le-base64>`,不传文件、不被转义)最稳。
- **SFTP putFile 偶发 "No such file"、SSH 偶发 "handshake timeout"**:都是密集连接/并发下的瞬态,重试即可。→ 加固项:SSH 连接池 + 持久 cdt_js(见 ROADMAP 方向1 后续加固)。
- **千万别强杀正卡在 open_cable 的 cdt_dbg**(早期教训:疑似把 FTDI 留半开;虽然后来证明无头本就开不了,但强杀会污染状态、误导诊断)。

## 反污染(已做)
`cdt_ins` 教程类知识 chunk(007/030/031/032/035)已加 `deprecated:true` + 文首 `[MCP-DEPRECATED]`;检索(关键词+语义)对 deprecated chunk 评分 ×0.3 并回报 `deprecated:true`,自然沉底。`.fic 规范`(033)、`cdt_dbg recipe`(034,**待按 2025.2 更新**)、`端到端例`(036)保留。
