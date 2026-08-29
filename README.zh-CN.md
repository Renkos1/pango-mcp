# pango-mcp

[English](README.md) · [简体中文](README.zh-CN.md)

FPGA 工作流的**引擎无关能力层**：通过 MCP/stdio 暴露 FPGA 专用工具，让任意 MCP 客户端
（Claude Code、Codex CLI，或你自己写的客户端）都能驱动真实的 FPGA 工具链。

> 设计原则：工具只做 **FPGA 专用动作**（仿真 / PDS / 扫链 / 烧录 / 断言）；通用文件编辑交给宿主 agent。
> 能力层与客户端解耦——同一套工具在任何 MCP 客户端上都一样。
>
> 完整社区文档见 [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md) ·
> [CHANGELOG](CHANGELOG.md) · [test/README](test/README.md)。本文是工具面与本机配置的完整参考。

> **关于命名**：服务器叫 `pango-mcp`，因为它端到端驱动的是 Pango Design Suite
> ——综合、布局布线、比特流、ILA、器件配置。MCP 工具名仍保留 `fpga_*` 前缀：其中
> `fpga_sim`、`fpga_msim_*` 驱动的是 Icarus Verilog 与 ModelSim/Questa，与 Pango
> 无关，叫成 `pango_*` 反而不准确。

## 工具

按"少量精选 + 受护栏通用直通 + 按需检索"分层；用 `fpga_capabilities` 查完整分层目录。

**仿真 / 断言 / 工程**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_env` | 报告本机可用工具（iverilog/vvp、gcc、PDS pds_shell/cdt、ModelSim vsim/vlog/vcom 路径） | 无 |
| `fpga_project_info` | 解析 `.pds`：器件、顶层、源/约束列表、括号平衡 | `pdsPath` |
| `fpga_sim` | iverilog+vvp 仿真，返回日志与 ok；可选 VCD；`wave:true` 一步出波形图 | `workdir`, `top`, `sources?`, `vcd?`, `wave?`, `detail?`, ... |
| `fpga_assert` | 对仿真日志/VCD 做声明式断言判定（闭环标尺） | `log?`, `vcdPath?`, `assertions[]` |
| `fpga_wave` | VCD（任意来源）→ 数字时序图（`.wave.svg`+`.wave.html`）；`open:true` 用默认浏览器弹给用户看；结果带内联 SVG。给用户的视觉反馈渠道 | `vcdPath`, `signals?`, `open?`, `inlineSvg?`, ... |
| `fpga_pds_create_project` / `fpga_pds_create_blink_project` | 创建最小可编译 / LED blink 工程 | `projectDir`, `part?`, ... |

**ModelSim/Questa 仿真（独立 toolchain，与 PDS 同级；VHDL 是相对 iverilog 的增量能力）**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_msim_sim` | `vlib`+`vlog`/`vcom`+`vsim -c` 编译并运行（含 testbench）；不信退出码（以 transcript `** Error/Fatal`+`Errors:N` 判定 ok，`$fatal` 时 vsim 仍退 0）；可出 VCD 喂 `fpga_assert`（VCD 时自动加 `-voptargs=+acc` 保信号可见，否则 vopt 优化掉信号 VCD 为空）；`coverage:true` 出结构化覆盖率（branch/statement/condition/toggle 的 bins/hits/misses/% + total + `.ucdb`）；`uvm:true [uvmTest]` 用预编译 mtiUvm 跑 UVM，解析 UVM Report Summary 且 **UVM_ERROR/UVM_FATAL>0→ok=false**（反幻觉）；含 IP：`fileList`(-F 喂 PDS 的 IP 仿真清单) / `libDirs`(-y 自动解析厂商原语)，加密 IP(.vp/.svp，IEEE-1735 含 Mentor key)由 vlog 原生解密；`host` 在远程执行设备(SSH)上 stage+build+sim 并拉回 VCD/coverage；`wave:true` 仿真后一步渲染波形图(artifacts.waveSvg/waveHtml)；`assertions[]` 一步内判规格(同 fpga_assert，失败则 ok=false)——**一次调用 = 编译+仿真+覆盖率+UVM+波形+断言**；紧凑摘要 + `detail:full` + 输入 hash 缓存 | `workdir`, `top`, `sources?`, `fileList?`, `libDirs?`, `host?`, `vcd?`, `coverage?`, `uvm?`, `uvmTest?`, `wave?`, `assertions?`, `detail?`, ... |
| `fpga_msim_compile` | 仅编译（语法/早期检查），不运行 vsim | `workdir`, `sources?`, `lib?`, ... |
| `fpga_msim_do` | 对 `vsim -c` 跑任意 do/Tcl（coverage/force/examine/UVM/WLF/...）；纯仿真自由跑，**含可触达宿主的命令（Tcl `exec`/`file delete\|rename\|copy\|mkdir`/`open` 写）需 `confirm:true`** | `workdir`, `commands?`/`doScript?`, `top?`, `confirm?`, ... |
| `fpga_msim_exe` | ModelSim bin 工具受白名单直通（vlib/vmap/vdir/vcover/wlf2vcd/vcd2wlf/...）；任意 exe 可 `-help`/`-version` 探测 | `exe`, `args?`, ... |
| `fpga_msim_doc_search` | ModelSim 命令参考（`docs/cmd_help/*.txt` → 346 条 command/description/arguments）+ 手册 PDF 注册表（16 份，返回路径供直接 Read）。`command`=精确命令；`query`=关键词召回（命令名加权）；`kind`=all/command/manual | `command?`, `query?`, `kind?`, `limit?` |
| `fpga_msim_view` | 本机打开 ModelSim GUI 交互看波形（VCD 自动 vcd2wlf 转 WLF；`vsim -gui -view`，detached）；给用户深度查看的渠道 | `vcdPath?`/`wlfPath?`, `signals?`, `launch?` |

> **波形给用户看 = 三渠道**：① `wave:true`（`fpga_msim_sim`/`fpga_sim` 一步出图）或 `fpga_wave`（任意 VCD）→ SVG/HTML 静态图 + 内联 SVG；② `fpga_wave open:true` 用默认浏览器弹出；③ `fpga_msim_view` 开本机 ModelSim GUI 交互深查。三者都基于 `core/waveform.mjs`（VCD→SVG，零依赖）。详见 `src/core/waveform.mjs`。

> **含 IP（含加密 IP）的仿真**：不需要走 PDS 的仿真启动渠道——Pango 自己的 ModelSim 流程就是文件清单编译。PDS 只作**生成器/库来源**：用它生成 IP（`fpga_exe ip_generate`，产出 `pnr/ipcore/<ip>/<ip>.v`）。仿真则把 {RTL + IP 生成的 `.v` + 厂商原语仿真模型 + TB} 直接喂 `fpga_msim_sim`。**加密 IP（PCIe/DDR/SerDes 的 `.vp`/`.svp`，IEEE-1735）含 Mentor key block，vlog 2020.4 原生解密**（已实测 PCIe `.vp` 编译通过）。便捷入口：`fileList`(-F 直接喂 PDS 随附的 `filelist_pciegen*_gtp.f` 等 IP 清单)、`libDirs`(-y +libext 让 vlog 按需自动拉取实例化到的 `GTP_*` 原语模型)。

**构建 / 报告 / 日志（紧凑摘要 + detail:full 兜底 + 按输入 hash 缓存）**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_pds_run` | `pds_shell -run <target>` 任意阶段（compile/dev_map/pnr/gen_bit_stream/...）；不信退出码、解析 `E:`/bitstream line/加密自检 | `pdsPath`, `runTarget`, `detail?`, `cache?`, ... |
| `fpga_pds_compile` | `fpga_pds_run` 的 `gen_bit_stream` 预设 | 同上（`runTarget?` 默认 gen_bit_stream） |
| `fpga_pds_batch` | 最多 2-way 并行运行独立 project clones；拒绝共享/嵌套目录，逐 variant 汇总 timing/errors/artifacts，任一失败则顶层失败 | `variants[]`, `runTarget?`, `maxParallel?`, ... |
| `fpga_pds_reports` | 解析日志/时序/资源/`.sbit`；不运行 PDS | `pdsPath?`, `buildDir?`, `log?` |
| `fpga_log_extract` | 对落盘日志二次廉价提取关键信息（pds/cdt/sim profile） | `profile?`, `log?`/`logPath?` |

**设备 / 全 PDS 控制（受护栏通用直通）**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_pds_scan` | `cdt_js`+`cdt_cfg` 扫 JTAG 链读 IDCODE（只读、设备安全前置） | `pdsVersion?`, `port?`, `maxDevices?` |
| `fpga_flash_sram` / `fpga_flash_spi` | 烧 SRAM / 经 JTAG→SPI bridge 持久烧录；`confirm:true` + 先 scan 校验 IDCODE | `sbit`, `expectIdcode`, `confirm`, ... |
| `fpga_gen_sfc` | 离线 `.sbit`→`.sfc`（`cfg_gen_sfc`）；**不连器件**、无需 confirm。flash 型号/opcode/起始地址全参数化 | `sbit`, `sfc?`, `deviceName?`, `opcode?`, `sbitStartAddress?`, ... |
| `fpga_gen_multi_file` | 离线多启动/升级数据流（黄金+应用回退、SPI/BPI 升级，`cfg_gen_multi_file`）；偏移不写死 | `infile[]`, `type`, `sbitStartAddress[]?`, `goldenOutFile?`, ... |
| `fpga_gen_chain_file` | 离线 SPI 链式文件（`cfg_gen_chain_file`），可选生成 bin/字节位反转 | `infile[]`, `outfile?`, `createBinFile?`, ... |
| `fpga_cdt` | 对 `cdt_js` 跑任意 `cfg_*`(cdt_cfg)/`dbg_*`(cdt_dbg) Tcl：扫链/读属性/SPI flash/ILA 抓波/virtual-IO 全覆盖；读类自由，**写器件类需 confirm+expectIdcode+先 scan 校验** | `interpreter?`, `commands?`/`tcl?`, `confirm?`, `expectIdcode?`, ... |

**裸机 JTAG（FT2232 MPSSE，不走 cdt_js/GUI/运行期 license；与上面 cdt_js 路径互斥用 cable）**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_jtag_scan` | MPSSE 直读 IDCODE，只读、设备安全 | `channel?`, `tckHz?` |
| `fpga_jtag_gen_svf` | **离线**(不连 cable) `.sbit`→CRAM `.svf`（cdt_cfg `cfg_one_step_create_svf`） | `sbit`, `svf?`, `property?` |
| `fpga_jtag_flash` | 回放 CRAM SVF 配置 SRAM（易失/可逆，~15s@6MHz），校验 done bit；需 `confirm:true`，先裸机 scan 校验 `expectIdcode`，`sbit` 输入会自动生成/缓存 SVF | `svf?`/`sbit?`, `expectIdcode`, `confirm`, `channel?`, `tckHz?`, ... |
| `fpga_jtag_capture` | **本地 ILA 默认路径**：武装片上 FLA 抓波回读、导 VCD/JSON/CSV/原始 TDO（parent 自动创建）；物理 stride 运行时探测，歧义 fail-closed；可选值/边沿触发(`trig`) | `fic?`/`width?`+`depth?`, `trig?`, `raw?`, `paddingBits?`, ... |
| `fpga_exe` | bin 构建/分析工具直通（ip_generate/ip_compiler/cdt_bts/ppc/ppp/rf_analyzer/...）；任意 exe 可 `-help` 探测 | `exe`, `args?`, ... |

**发现 / 知识检索（纯关键词打分，无 embedding、零额外成本）**
| 工具 | 作用 | 输入 |
|---|---|---|
| `fpga_capabilities` | 分层工具目录（tier0/1/2）+ 长尾经 fpga_cdt/fpga_exe 触达的 howto + 成本/安全注意 | 无 |
| `fpga_vault` | 个人验证资产库：search/get/validate/recall；get 记 `asset_use`，recall 从 trace 反查消费会话 | `action`, `query?`/`id?`, ... |
| `fpga_primitive_lookup` | 查 Logos2 原语库（gtp_lib.v，153 个 GTP_*）端口/参数/最小例化模板 | `name?`/`category?`/`query?` |
| `fpga_ip_lookup` | 查 PDS IP 目录（~65 核）header/支持器件/参数/datasheet PDF 路径 | `slug?`/`query?`/`category?` |
| `fpga_doc_search` | 检索抽取文本 chunk + 21 手册/62 IP 数据手册注册表（返回 PDF 路径供直接 Read） | `query?`, `kind?` |

> 知识语料随包提供于 `src/toolchains/pango-pds/knowledge/`，由 `pnpm knowledge:build` 从本机 PDS 安装离线抽取（原语/IP/手册）。换机或换 PDS 版本后重跑即可刷新。

**语义检索（可选，默认关闭、零成本回退）**：三个检索工具支持 `mode:auto|keyword|semantic` 并回报 `retrieval`。配置 `PANGO_MCP_EMBED_*`（OpenAI 兼容 `/embeddings`，见 `pango-mcp.env.example`）后跑一次 `pnpm knowledge:embed` 把语料嵌入并落盘缓存；此后 `auto` 自动走语义（概念召回，如"phase locked loop"→`GTP_GPLL`，关键词搜不到）。**成本控制**：语料只在构建期嵌入一次，查询仅嵌入一句且有内存缓存；未配置或调用失败一律静默回退关键词，绝不更差。向量文件本地缓存、不入库（模型相关、可 `knowledge:embed` 重生）。

PDS/设备护栏：
- `fpga_pds_compile` 只用 `pds_shell.exe`，不调用会挂 GUI 的 `pds.exe`。
- PDS 退出码不能单独作为成功依据；工具会解析日志里的 `E:`、`The bitstream file is
  "...sbit"` 与 post-PnR timing。`report_timing` / `gen_bit_stream` 无权威时序结论、出现负
  setup/hold slack 或 failing endpoint 时，顶层 `ok=false`，即使 PDS 已产出位流并以 0 退出。
- 构建前默认把旧 PDS 输出目录挪到 `_pds_build_bak_*`，避免复用 GUI/旧产物污染。
- `.sbit` 头部若含 `effsoftecrypt` 标记会判失败，避免透明加密产物被当成可烧录 bitstream。
- PDS 2025.2 默认使用 `cdt_js` 端口 `65425`，避免误连旧 PDS 2022.2 常见的 `65420` server。
- JTAG scan 默认只读取 `deviceIndex=0`（单板/单 FPGA）。多器件链才显式传 `maxDevices`；这避免为探测不存在器件而触发 PDS 的 invalid device index 错误状态。
- `cdt_js` 启动后会等待 TCP 端口真实就绪再运行 `cdt_cfg`，减少不同机器上的启动时序问题。
- `fpga_flash_sram` / `fpga_flash_spi` 的内部安全 scan 若遇到 CDT 瞬态超时或未读到设备，会短重试并在 `scanAttempts` 中返回每次诊断；普通 `fpga_pds_scan` 默认不自动重试，便于诊断真实连接状态，需要时可传 `retryOnTransient:true`。
- 烧录工具默认停在确认门；只有 `confirm:true` 才会先 scan、校验 `expectIdcode`，再执行烧录。
- `fpga_jtag_flash` 同样执行确认门和独立裸机 IDCODE scan；确认缺失时不会启动 Python/访问 cable，IDCODE 不匹配时不会生成或回放 SVF。SVF 内的掩码 IDCODE 校验仍是第二道保护。
- 本地 ILA 默认走 `fpga_jtag_flash → fpga_jtag_capture`，全程 D2XX/MPSSE、无 GUI；`fpga_ila_open` / `fpga_ila_capture` / `fpga_ila_flow` 仅在裸机 capture 不支持所需功能或远程交互桌面场景下作为 fallback。
- `fpga_ila_flow` 内含 SRAM 写入，也必须显式传 `confirm:true`；缺确认时在路径检查、进程清理和 cable 访问前返回，确认后仍先 scan 并校验 `expectIdcode`。
- `fpga_ila_console` 的 `dbg_program` 同样要求 `confirm:true + expectIdcode`；先经 GUI Console 只读 `dbg_read_device_id`，读不到或不匹配时不会提交写命令。
- PDS 2025.2 编译后可能把 `.pds` 改写为 XML；`fpga_project_info` / `fpga_pds_reports` 已支持 XML `.pds` 的器件、顶层、源文件、约束解析。
- `fpga_pds_reports` 会读取 PDS 2025.2 `report_timing/*.rtr`，返回 `timing.met` 和 `timing.worst`（最差裕量/slack）。

PDS 2025.2 task / 并发边界：
- Tcl 可用 `create_task -stage syn|pnr -title <run>` 创建独立 run，PNR 用 `-syn_task <syn-run>` 绑定；`launch_tasks -to_action <action> [get_tasks {...}]` 异步启动，`wait_on_tasks` 等待。单一 `pds_shell` 管理多个 task 时，输出天然分到 `prj_tasks/<run-title>/`。
- **不要**让两个独立 `pds_shell` 同时写同一 `.pds` 或同一 `prj_tasks`：PDS 没有可依赖的项目/输出锁，两个进程可能都退出 0 但混写 XML、run.log 与产物。
- `-work_dir` 只改变输出位置，仍会重写源 `.pds`，因此不能把“同一 `.pds` + 两个 work_dir”当成完整隔离。
- 多变体并发应为每个 variant 准备完整、互不嵌套的 project clone，再交给 `fpga_pds_batch`；该工具最多 2-way，并在共享/外置输出目录时启动前失败。

## 本机配置

MCP 会按优先级读取：
1. 当前进程环境变量。
2. `pango-mcp.env`（或 `PANGO_MCP_ENV_FILE` 指向的文件）。
3. `pango-mcp.config.json`（或 `PANGO_MCP_CONFIG` 指向的文件）。
4. 内置默认路径（仅覆盖常见本机 `D:\pango` 安装）。

常用可配置项：
- `PANGO_MCP_PDS_2025` / `PANGO_MCP_PDS_2022`：`pds_shell.exe` 路径。
- `PANGO_LICENSE_FILE`：PDS license 文件。
- `fpga_env` 会把 PDS 的“已安装”与“可用”分开报告，并对本地 license 做无副作用 preflight：缺失、过期或读取失败时 `pds[*].available=false`，同时返回 `license.source/conflict/candidates`，明确实际采用 process env、env file 还是 JSON config。node-lock 归属、floating server/未知格式不能可靠静态验证时明确标为 `unverified/unknown`，留给运行时 checkout，不猜主机身份。
- `PANGO_MCP_MODELSIM_HOME`：ModelSim/Questa 安装根目录（含 `win64/` + `modelsim.ini`）；亦可用 `MODELSIM_HOME`/`MODEL_TECH` 或 `config.modelsimHome`。
- `PANGO_MCP_MODELSIM_LICENSE`：ModelSim license 文件（FlexLM/Mentor，含 vsim/vlog/vcom features）。**真机 `fpga_msim_*` 仿真必配**——MCP 经 stdio 拉起只继承安全 env 子集，**不继承宿主的 `LM_LICENSE_FILE`/`MGLS_LICENSE_FILE`**；此值会注入两者给 vlog/vcom/vsim 子进程。亦可用 `config.modelsimLicenseFile`。

> **DPI/SystemC（可选，UVM 不需要）**：ModelSim 2020.4 不自带 gcc，用户 DPI（`import/export "DPI-C"`）、SystemC（`sccom`）、源码编译 UVM 需要**兼容的 gcc**。把 Mentor 官方 `gcc-X-mingw64vcN`（如 `gcc-4.5.0-mingw64vc12`）**完整**解压到 ModelSim 安装根（`<modelsimHome>\gcc-4.5.0-mingw64vc12`），ModelSim 自动探测（`$MODEL_TECH/../gcc-*`，无需 env）。务必用原始压缩包全量解压（含 `libexec` 的 `as`/`ld`/`cc1`）；过新的 gcc（如 w64devkit gcc-12）会因 DPI 蹦床汇编不兼容而失败。**UVM（`uvm:true`）走预编译 `mtiUvm`，不需要此 gcc。**
- `PANGO_MCP_CDT_PORT_2025` / `PANGO_MCP_CDT_PORT`：JTAG server 端口。
- `PANGO_MCP_SCAN_MAX_DEVICES`：默认 scan 读取设备数，默认 `1`。
- `PANGO_MCP_CDT_STARTUP_TIMEOUT_MS`：启动 `cdt_js` 后等待端口就绪的超时，默认 `10000`。
- `PANGO_MCP_FLASH_SCAN_RETRIES`：flash 前置安全 scan 失败后的重试次数，默认 `1`。
- `PANGO_MCP_FLASH_SCAN_RETRY_DELAY_MS`：flash 前置 scan 重试间隔，默认 `1500`。
- `PANGO_MCP_KNOWLEDGE_VAULT` / `config.knowledgeVaultPath`：个人验证资产库目录；默认 `~/.pango-mcp/knowledge-vault`。

### 可复现 Trace（v0.3）

设置 `PANGO_MCP_TRACE=1`（或配置 `"trace": true`）启用 JSONL 审计；用
`PANGO_MCP_TRACE_FILE`（或 `traceFile`）指定路径。每个 MCP 进程视为一个会话：首行固定为
`session_start`，记录 `assets.gitSha`、`standardsVersion`、`serverVersion` 和 `sessionId`；后续
`tool_call` 行保留原有 `ts/tool/ms/ok/args` 字段，并用相同 `sessionId` 关联。规范版本的单一事实源为
包内 `assets/manifest.json`。Trace 默认关闭，不改变未启用时的运行开销和文件行为。

### 验证资产自动沉淀（v0.3）

`fpga_assert` 与 `fpga_ila_flow` 接受可选 `knowledge` 元数据（标题、意图、rationale、来源路径和检索标签）。
只有工具的结构化结果客观全绿时才写 `knowledge-vault/entries/*.md`：断言要求 `failed=0`，真机流程要求
同一次 `ila_flow` 的 flash 与 capture stage 都成功。调用方不能传“已通过”布尔值；失败不写条目。
自动层只产生 `candidate`，绝不升 `trusted/golden`，也不会覆盖已被人提升或 recalled 的条目。
用 `fpga_vault action:get` 读取条目会在 Trace 记 `asset_use`；发现错误后人工降级/召回并提交，再用
`action:recall` 扫 Trace 查看 blast radius。

## 安装

```powershell
cd C:\pango-mcp
pnpm install
pnpm check                   # 全模块语法自检
pnpm knowledge:build         # 从本机 PDS 安装离线抽取原语/IP/手册语料（随包）
pnpm test:jtag                # JTAG 日志/IDCODE/诊断规则单测
pnpm knowledge:build:msim     # 从本机 ModelSim 安装抽 cmd_help 命令参考 + 手册注册表（随包语料）
pnpm test:msim-unit           # ModelSim transcript/覆盖率/UVM/cmd_help 解析单测（无需安装）
pnpm smoke                   # MCP 端到端冒烟（sim/assert/PDS报告/确认门/护栏/检索）
# 需真机/PDS 的实测：pnpm test:n1（编译摘要+缓存）/ pnpm test:n2（exe直通+cdt读路）/ pnpm actual
# 需 ModelSim 的实测：pnpm test:msim（Verilog/VHDL/$fatal反幻觉/VCD→assert/缓存/coverage/UVM/do确认门/doc_search e2e）
# 需另一台装有 ModelSim 并可 SSH 到达的机器（在 config 的 hosts{} 里配置，传 PANGO_MCP_TEST_HOST）：pnpm test:msim-remote（在 host 上 sim/compile/do/exe + 拉回 VCD→assert + $fatal 反幻觉 + 远程缓存 + libDirs 接线；不可达自动跳过）
# v0.3 常驻闭环：pnpm test:integration-loop（默认 software；见下方执行等级）
```

pnpm 11 的依赖构建策略由同目录 `pnpm-workspace.yaml` 固定：`ssh2` 的可选 crypto binding 与
`cpu-features` native addon 均不执行安装脚本，运行时使用已验证的纯 JavaScript SSH 路径。若以后确需原生
加速，先在目标 Node/Windows 环境单独验证 node-gyp 产物，再显式调整该策略。

### 常驻闭环钩子（v0.3）

`test:integration-loop` 通过真实 MCP/stdio 单会话重跑 `loop2`：坏 RTL 必须失败 → 换入已知修复 →
仿真/断言必须通过 → 自动 candidate → `asset_use`/recall 反查。输出固定写到
`test/.integration-loop/latest-report.json`，失败会打印 `FIRST FAILURE: <stage>` 并保留 Trace/工作区。

- 默认 `FPGA_INTEGRATION_LEVEL=software`：无设备写；自动选择完整的 iverilog 或 ModelSim 后端。
- `digital`：额外要求显式 `FPGA_INTEGRATION_BOARD=<profile>`，创建 PDS 工程并真实构建 `.sbit`。
- `hardware`：在 digital 之上还必须提供 `FPGA_INTEGRATION_CONFIRM=1` 和
  `FPGA_INTEGRATION_EXPECT_IDCODE=<id/alias>`，才会 scan/flash/ILA；不会因检测到板卡而自动写设备。本地 Target Profile 走
  “裸机 FT2232 扫描 → 受护栏裸机 SRAM 烧录 → 裸机 FLA 抓波 → 结构化单调 `+1` 判定”，避免同一 MCP 会话里的
  `cdt_js`/D2XX cable 所有权冲突且不依赖 GUI；远程 profile 保留 PDS 扫描与 `fpga_ila_flow` GUI 路径。

可先跑 `node test/integration-loop.mjs --selftest`，它不启动 MCP/EDA/硬件，只验证负向判定、首失败截断和
硬件确认门。

## 在 Codex CLI 注册（`~/.codex/config.toml`）

```toml
[mcp_servers.pango]
command = "node"
args = ["C:\\pango-mcp\\src\\index.mjs"]
```

## 在 Claude Code 注册

命令行：
```powershell
claude mcp add pango -- node <ABSOLUTE_PATH_TO_REPO>\src\index.mjs
```
或项目级 `.mcp.json`：
```json
{
  "mcpServers": {
    "pango": { "command": "node", "args": ["C:\\pango-mcp\\src\\index.mjs"] }
  }
}
```

## 试一下（在 Codex/Claude 里）
1. 让它调 `fpga_env` —— 应看到 iverilog/vvp 路径、PDS 两个版本路径。
2. 让它写一个小设计 + testbench 到某目录（用它自己的文件工具），再调 `fpga_sim`（传 `workdir` 与 `top`，需要波形时加 `vcd:true`）—— 应返回仿真日志、`ok` 与可选 VCD 路径。
3. 调 `fpga_assert` 对日志/VCD 判定，例如 `log_contains: PASS`、`vcd_final_eq: q == 10`。
4. 对 PDS 工程先调 `fpga_project_info`，再调 `fpga_pds_compile`；失败时读返回的 `errors`/`log`/`reports` 修 RTL 或约束。
5. 有真板时先调 `fpga_pds_scan` 记录 IDCODE；烧录必须传 `expectIdcode` 与 `confirm:true`。未确认时 `fpga_flash_sram`/`fpga_flash_spi` 会返回 `phase:"confirm"`，不执行烧录。
6. 负向对照：故意写一个会 `$fatal`/输出 error 的 testbench —— `ok` 必须为 false（验证不静默"看似通过"）。

scan 失败决策：
- `diagnostics.knownIssues` 含 `cdt_scan_transient_timeout` 或 `cdt_scan_no_devices`：可重调 `fpga_pds_scan` 并传 `retryOnTransient:true`；仍失败再重启 `cdt_js` 或重新插拔 cable。
- 含 `cdt_version_mismatch`：检查 `pdsVersion`/端口，PDS 2025.2 默认应走 `65425`。
- 含 `cdt_no_cable`：先检查 USB cable、驱动、板卡供电。
- 含 `cdt_invalid_device_index`：单 FPGA 板保持 `maxDevices=1`，多器件链才显式加大。

## 已验证配置

PG2L200H 等具体板卡的实测记录见 [docs/hardware-notes.md](docs/hardware-notes.md)。
工具本身不假设任何器件——`create_project` 要求传入完整 target，绝不默认/猜测。

## 诊断知识边界

主流程只内置少量可稳定判定、会影响下一步动作的规则，例如 no cable、cdt 版本/端口不匹配、invalid device index、cdt 错误状态、scan transient timeout/no devices。它们会出现在 `diagnostics.knownIssues`。后续若要随 MCP 附带 PDS 手册、器件数据手册或更多错误库，应作为独立资源/检索工具接入，不放进 scan/flash 的热路径。

## 架构（多工具链）
- `src/index.mjs` = bootstrap：注册 `fpga_env` + 各 toolchain 的 `register` + `fpga_capabilities`。
- `src/core/`：后端无关基础设施——`config`（配置/env 加载）、`exec`（run/toolResult/which）、`vcd`、`logparse`（紧凑/截断/已知问题规则/阶段检测）、`runstore`（按输入 hash 缓存与日志落盘）、`knowledge`（关键词检索）。
- `src/toolchains/pango-pds/`：PDS 链自包含——`index`（工具注册+高层流程）、`install`/`project`/`reports`/`diagnostics`/`jtag`/`knowledge`，以及 `build-knowledge/`（离线语料 builder）与随包 `knowledge/`（原语/IP/文档语料）。
- `src/toolchains/sim/`：iverilog 仿真链。`toolchains/vivado/` 占位——"加文件夹即接新链"。
- 长尾不再每个动作塞一个工具：ILA/virtual-IO/SPI 细控经 `fpga_cdt`（dbg_*/cfg_*），IP 生成/功耗/比特流工具经 `fpga_exe`——工具数小、token 省、能控全 PDS。

## 成本控制
- 默认返回**紧凑摘要**（errors/timing/util/diagnostics/keyLines），完整日志落盘并给 `logPath`+`tail`；需要时 `detail:"full"` 取全文。
- `fpga_pds_run`/`compile` 按"源内容+工程语义投影+target" hash 缓存：源未变直接秒回上次摘要（**绕开 pds_shell 每次重写 `.pds` 的干扰**）；`cache:false` 可强制重跑。
- 知识检索用**纯关键词打分**，无 embedding 模型、无 API 调用——零额外推理成本；手册以 PDF 路径返回，由宿主 agent 按需 Read。
- 分层削峰：内圈快用 `fpga_sim`（秒级）；过了再 `fpga_pds_run`（分钟级）；真机烧录最后且需确认。

## 备注
- 当前用 ESM JavaScript 实现以求"开箱即跑"；后续可 TS 化并并入 monorepo。
- `fpga_sim` 用 `-g2012`。仿真 `ok` 含日志启发式（exit code + error/fail/fatal 标记）；更可靠的通过标准放在 `fpga_assert`。
- `test/smoke.mjs` 不实际烧录硬件，只验证危险动作的确认门与护栏；真实 PDS 编译/scan/flash 仍需在具体工程和板卡上跑。
