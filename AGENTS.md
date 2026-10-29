# AGENTS.md · 大肥鱼直播（aizb）项目记忆

> 本文件是本工作区的**项目记忆与操作约定**，DSH 会把 `A:\project\aizb\AGENTS.md` 自动注入到该工作区的会话。
> 最后更新：2026-10-29 00:00（Asia/Shanghai）。已包含：拉取/分析/运行记录、真实直播接入（.env + 抖音采集器）、合规人工确认模式、数据持久化看板、虚拟形象报备素材。
> 事实优先级：本文件 < 代码 < `_analysis/` 下的深度报告（有 file:line 证据）。

---

## 1. 项目身份

- **仓库**：`https://github.com/JackLiKa/aizb`（public，**无 LICENSE** → 默认版权保留，不可随意商用/分发；0 star）
- **产品名**：大肥鱼直播（`package.json` name=`dyzb`，appId=`com.dyzb.fish`）
- **定位**：Windows 桌面上的 **AI 虚拟主播「无人直播」终端**。本机渲染 1280×720 画面 + 语音，抖音直播伴侣/OBS 用「窗口捕获 + 系统声音」推流。
- **技术栈**：Electron 45 + 原生 Node HTTP/SSE/WS（**零 IPC**）+ 原生 JS 前端（零框架）+ three.js r180（vendor 内置）+ msedge-tts + DeepSeek/OpenAI 兼容 LLM
- **代码规模**：手写 ≈8,100 行（stage 3,682 / electron 2,167 / scripts 1,658 / admin 601）；3 个生产依赖
- **提交历史**：仅 2 个 commit（`4919b2f` Initial、`0450838` 功能全量），同一人、同一天、单提交快照；`main` 与 `origin/main` 一致

## 2. 本机当前运行方式（重要：默认跑浏览器模式，不是 Electron）

本机 Electron 版**不可用**（原因见 §3），当前验证可用的运行方式是项目自带的浏览器模式：

```powershell
cd A:\project\aizb
# 1) 本地服务（纯 Node，无需 Electron）
Start-Process node -ArgumentList 'scripts/dev-server.js' -WindowStyle Hidden -RedirectStandardOutput '_analysis\server.out.log' -RedirectStandardError '_analysis\server.err.log'
# 2) 舞台 + 控制台（Chrome 应用窗口）
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --app=http://127.0.0.1:17890/stage/ --window-size=1280,720 --window-position=0,0 --autoplay-policy=no-user-gesture-required --user-data-dir=A:\project\aizb\.tmp\chrome-profile
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --app=http://127.0.0.1:17890/admin/ --window-size=1180,820 --window-position=80,80 --user-data-dir=A:\project\aizb\.tmp\chrome-profile
```

- 双击版启动脚本：`_analysis\start-browser-mode.cmd`
- 地址：舞台 `http://127.0.0.1:17890/stage/`（F11 全屏后用于窗口捕获）｜控制台 `http://127.0.0.1:17890/admin/`
- 健康检查：`GET /health`；状态：`GET /api/state`
- 停止：结束 `node.exe`（dev-server）与对应 Chrome 窗口即可
- 数据目录（dev 模式）：`A:\project\aizb\data\`（config.json、state.json、logs/、tts-cache/、music/），已 gitignore
- 未配 LLM Key 时为 **Echo 模式**：内置台词 + Edge TTS，全链路可跑，方便先看画面

### 真实直播接入（2026-10-28 新增，已实测）

| 链路 | 实现 | 入口 |
| --- | --- | --- |
| API Key | `.env`（`LLM_API_KEY` 等 9 个键）→ `electron/core/env.js` 解析 → 运行时覆盖 config，**绝不写盘/不进 Git** | 编辑仓库根 `.env` 后重启服务；`/api/state.llm.status.keySource` 显示 `env/config/none` |
| 真实弹幕/礼物 | `scripts/douyin-collector.js`：无头 Chrome + CDP 观察 `live.douyin.com/<room>` 聊天 DOM → `POST /ingest`（`x-ingest-token`） | 控制台「抖音真实直播」卡片填房间号一键连接；或 `npm run douyin -- --room <id> --ingest http://127.0.0.1:17890 --token xxx` |
| 采集器托管 | `electron/core/sources.js` 的 `DouyinSource`：spawn 子进程、解析 `EVENT`/`STATUS`、异常 5s 重启、SIGTERM 杀进程树；`source.type='douyin'` | `POST /api/source {type:'douyin'}` 或控制台下拉框 |
| 真实 token | LLM 带 `stream_options.include_usage`，统计供应商返回的真实 `usage`；Edge TTS 免费 → 把 `metering.ttsPricePer1kChars` 设为 0 | 控制台「今日数据」/ `/api/state.metering` |
| 推流 | 本应用只出画面+声音；直播伴侣窗口捕获 1280×720/30fps + VB-Cable 音频路由 | 见 `docs/真实直播接入指南.md` |
| 人工确认模式（合规） | `config.compliance.humanInLoop=true` 时 AI 只生成草稿，控制台「AI 回复草稿」面板点「发送这条」才播报（真人驱动/值守）；`POST /api/speak {exact:true}`、`POST /api/draft/discard` | 控制台 `/admin/`；`status.draft` |
| 数据持久化 + 看板 | `electron/core/analytics.js`：事件逐条落盘 `data/analytics/events-YYYY-MM-DD.jsonl`（排除 source=test）、计量 30s 快照 `metering-*.json`；`GET /api/stats?days=1..90`；`/dashboard/` 看板（零框架，2s 轮询） | `http://127.0.0.1:17890/dashboard/` |

实测结论：真实房间（如 `171498223751`、`805625782512`）可抓到 comment/enter/like；礼物真实 DOM 未在真房间确认（测试窗口无人送礼），采集器 mock 已验证礼物解析，主进程侧另有「送出/赠送 xxx ×N」文案兜底；未登录时昵称被平台脱敏；平台改版只改 `scripts/douyin-selectors.json`。

## 3. 本机环境坑（踩过的顺序，别再重复踩）

1. **Electron 二进制缺失**：`npm ci` 后 `node_modules\electron\dist` 不存在、`path.txt` 缺失 → 手动执行
   `node node_modules\electron\install.js`（可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`）。
2. **`ELECTRON_RUN_AS_NODE=1`** 在本机会话环境里存在 → Electron 被当纯 Node 跑，报
   `TypeError: Cannot read properties of undefined (reading 'isPackaged')`。启动前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
3. **`%APPDATA%` 写入被拒**（agent 会话的沙箱限制，Electron 报 `Lock file can not be created / GPUPersistentCache 拒绝访问 0x5`）→ 启动参数加 `--no-sandbox` + `--user-data-dir=A:\project\aizb\.tmp\electron-userdata`。
4. **Nahimic（Alienware 音频 OSD）注入 `NahimicOSD.dll` → Electron GPU 进程反复崩溃**（`exit_code=-1073741819`，事件日志 faulting module=NahimicOSD.dll），主进程 `FATAL: GPU process isn't usable. Goodbye.`；即使加 `--disable-gpu --disable-gpu-process-crash-limit` 让进程存活，窗口也因 compositor 挂了而**白屏**。
   当前账号非管理员，无法停 `NahimicService`。**要修 Electron 版**：管理员 PowerShell 执行
   `Stop-Service NahimicService -Force`（临时）或卸载「Alienware Sound Center / Nahimic」，然后 `npm start`。
5. **`scripts/shot.js`、`export-glb.js` 硬编码 macOS Chrome 路径**（`/Applications/Google Chrome.app/...`），Windows 下不可用；本机改用临时脚本 `_analysis/shot-win.js`（CDP + 无头 Chrome + SwiftShader）。
6. PowerShell 执行策略禁止跑 `.ps1` → 用 `powershell.exe -ExecutionPolicy Bypass -File ...` 或直接内联命令。

## 4. 架构速记

```
弹幕源(simulator / POST /ingest[token] / ws://…/ingest) → director 归一化+冷却+去重+概率
 → 优先级队列(上限24) → brain(OpenAI 兼容 SSE / Echo) → 标点切句(40字) → voice(Edge TTS, 并发3, 磁盘缓存)
 → server 广播 SSE /events?role=stage → 舞台页(音频+口型+形象+HUD) → POST /stage/report 回执 → 释放队列
控制台 admin：2s 轮询 /api/state（不走 SSE，SSE 只收 role=stage）
```

| 模块 | 职责 |
| --- | --- |
| `electron/main.js` | 生命周期、舞台/控制台窗口、托盘、单实例锁、powerSaveBlocker、崩溃兜底 |
| `core/director.js` | 事件归一化、优先级队列、冷却/去重/夜间降频、LLM→分句→TTS→串行播报、打断、点歌/音乐状态机 |
| `core/brain.js` | OpenAI 兼容流式（`stream_options` 400 自动重试）、Echo 模式、token 估算 |
| `core/voice.js` | msedge-tts / OpenAI TTS、sha1 缓存、信号量 3、启动清理 400 文件/7 天 |
| `core/server.js` | HTTP/SSE/WS 路由、Range 静态服务、/api/state 打码、`/api/config` 热更新 |
| `core/jukebox.js` | 曲库索引（`歌手 - 歌名.mp3`）、模糊搜索打分、队列、在线曲目缓存 |
| `core/music-providers.js` | Jamendo（`JAMENDO_CLIENT_ID`）/ Internet Archive 搜索，只放行 CC BY / BY-SA / CC0 / 公版 |
| `core/metering.js` / `store.js` / `logger.js` / `watchdog.js` / `sources.js` | 计量、800ms 防抖持久化、日志滚动、心跳看门狗、模拟弹幕源 |
| `stage/` | 三层渲染器：`whale-girl-3d.js`（程序化 3D）、`whale-girl-layered.js`（**默认**）、`whale-girl.js`（程序化 2D 回退）；`stage.js` 协议/HUD；`audio.js` TTS 队列+AnalyserNode 口型+BGM duck |
| `admin/` | 零框架控制台：状态/手动说话/事件注入/点歌/配置 JSON/日志 |

**关键数字**：优先级 gift100/manual95/song70/follow55/comment30/like10；队列上限 24；最小间隔 2s；用户冷却 25s；去重 60s；点歌冷却 300s；回复概率 0.5（夜间 02:00-07:00 为 0.08）；LLM 超时 20s / maxTokens 120（夜 60）/ 历史 16 条；TTS 并发 3；SSE ping 15s；心跳 2s、看门狗 12s / 每小时最多 6 次。

## 5. 关键代码事实（易踩的坑）

- **默认形象是分层 2D，不是 3D**：`main.js:207` 加载 `/stage/` 不带参数，`stage.js:30` 默认 `'2d'` → `LayeredGirlRenderer`；3D 需手动 `?avatar=3d`（还需 WebGL2）。与 README「3D 优先、失败回退 2D」相反。
- 渲染器回退链：`3d` →（失败换 canvas）分层 2D → 程序化 2D（`stage.js:28-55`），鸭子接口 `setPalette/setMode/setMouth/celebrate/start`，无共享基类。
- 3D 模型：`stage/whale-model.js` 1,031 行纯几何拼装，311 Mesh / 96,598 面 / 28 材质 / 108 命名节点，无骨骼；`faceDecal` 投影贴片 + 运行时 192² 虹膜 DataTexture；运行时 330 draw calls/帧。
- `stage/assets/whale-girl.glb` 实测 **351 节点 / 281 mesh / 28 材质 / 2 动画(Idle,Talk) / 0 skin**，2.43 MB；是旧代码导出快照，运行时**不加载**（仅导出/测试用）。
- 默认 2D 模式下 `config.avatar` 只有 `finColor` 生效；admin 没有配色 UI；README 的「控制台改色热更新/clothColor」不成立。
- 形象素材来源：`refs/workflows/*.json` = **ComfyUI Qwen-Image 2.1 工作流**（seed 42/777/20260929）→ `sheet.png` → `scripts/sheet_cut.py` → `build_layers.py` → 运行时贴片。3D 几何是程序化原创，但默认 2D 立绘是 AI 生成，README 未披露。
- **安全面**：默认只监听 127.0.0.1 但代码不强制；除 `/ingest`（token 默认 `change-me`）外全部 `/api/*` 无鉴权且 `Access-Control-Allow-Origin: *` → 任意网页可改配置、把 `llm.baseURL` 指向攻击者以窃取 Bearer apiKey；`/api/state` 会回传 `ingest.token`。**密钥已迁移到 `.env`**（运行时覆盖、不写盘、不进 Git），config.json 仅作回退；但上述 API 鉴权缺口仍未修。
- **打包**：`files` 已补 `build/**/*`（托盘图标）与 `scripts/douyin-collector*.json`（asarUnpack）；`artifactName` 已按 target 拆分（win 默认 `dyzb-<ver>-<arch>`、nsis `-setup`、portable `-portable`），`${target}` 不是合法宏。

## 6. 常用操作

```powershell
cd A:\project\aizb
npm start            # Electron（本机因 Nahimic 白屏，见 §3）
npm run server       # 仅本地服务：http://127.0.0.1:17890/stage/ 与 /admin/
npm test             # smoke(18 断言) + http-test(29 断言)，零外网，Echo 模式；本机实测通过
npm run douyin -- --room <房间号> --ingest http://127.0.0.1:17890 --token <ingestToken>   # 单独跑真实弹幕采集器
npm run pack         # electron-builder --dir → release/win-unpacked（实测成功，383 MB）
npm run dist         # NSIS + portable（artifactName 已拆分；macOS 上打 win 包见 §10 2026-10-29）
```

**密钥**：编辑仓库根 `.env`（`LLM_API_KEY` 等，模板 `.env.example`），改完**重启服务**生效；`.env` 已 gitignore。控制台「配置」面板不再用于改 Key（env 托管字段会被服务端丢弃并在 note 里提示）。验证：`/api/state.llm.status.keySource` 应为 `env`，`mode` 为 `llm`。

配置 `/data/config.json`（或控制台「配置」面板，保存即热生效，端口/窗口尺寸需重启）：
- `llm.baseURL` / `llm.model`（Key 放 `.env`，空 Key = Echo 模式）
- `persona.system` 人设；`tts.provider`（edge/openai/none）、`tts.voice`（默认 `zh-CN-XiaoxiaoNeural`）
- `data/music/*.mp3`（`歌手 - 歌名.mp3`）即曲库；`ingest.token` 必改（也可放 `.env` 的 `INGEST_TOKEN`）
- `douyin.roomId` / `douyin.enabled` / `douyin.headless`；（控制台「抖音真实直播」卡片可一键设置）
- `metering.inputPricePerM=2`、`outputPricePerM=8`（按供应商实价改）、`ttsPricePer1kChars=0`（Edge 免费，已设为 0）
- 真实弹幕：控制台选 `douyin`，或 `POST /ingest`（`x-ingest-token`）/ `ws://127.0.0.1:17890/ingest?token=…`，事件类型见 README

## 7. 测试与验证现状（2026-10-28 实测）

- `npm ci` 298 包 OK；Node v24.14.1 可跑（README 要求 Node 22，但无 `engines` 约束）
- `node scripts/smoke.js` / `http-test.js` 均通过；测试总量仅 **47 条断言，零浏览器断言**
- 浏览器模式实测：`/health`、`/stage/`、`/admin/`、`/api/state`、GLB 200；Edge TTS 真实合成 mp3 成功（偶发 `Edge TTS WebSocket error` 会自动降级继续）
- 三层渲染器均实测可渲染（无头 Chrome + SwiftShader）；默认入口 `dataset.avatar === '2d'`
- electron-builder 打包成功；打包版运行时本机未验证成功（受 §3 环境影响）
- 截图/报告产物见 §8

## 8. 分析产物索引

| 路径（`A:\project\aizb\`） | 内容 |
| --- | --- |
| `_analysis/项目分析报告.md` | **主报告**：仓库情况、架构、三层渲染器、实测证据、P0/P1 问题表、README 不一致清单、成熟度≈3.5/10、改进建议 |
| `_analysis/01-stage.md` | 舞台渲染层 256 行深度报告（事件协议/渲染器/3D 模型/口型/性能实测） |
| `_analysis/02-core.md` | 主进程 + core 283 行报告（生命周期/配置/队列/LLM/TTS/HTTP/安全/风险 13 项） |
| `_analysis/03-toolchain.md` | 控制台/脚本/资产流水线/打包/工程化 209 行报告 |
| `_analysis/douyin-采集器报告.md` | 抖音采集器实现/真实房间实测/DOM 结论/限制（138 行） |
| `docs/真实直播接入指南.md` | **真实开播手册**：.env、直播伴侣捕获、VB-Cable 音频、真实弹幕、token 计量、合规、排错 |
| `docs/抖音合规整改.md` | **合规必读**：违规记录复盘（易被混淆的直播形象）、5 个触发点、A/B 方案、申诉模板 |
| `docs/虚拟形象-报备素材/` | 报备用形象图（正面/侧面/背面/面部 + 四视图，JPG 纯白底） |
| `_analysis/admin-real.png`、`running-douyin.png` | 新控制台（抖音卡片 + .env 状态）/ 真实弹幕时舞台实拍 |
| `_analysis/run*/app*/*.log` | 本机启动排查日志（Electron 崩溃、GPU、浏览器模式） |
| `_analysis/shot-win.js` | 临时 Windows CDP 截图脚本（替代 macOS-only 的 `scripts/shot.js`） |
| `_analysis/stage-default.png`、`stage-3dmodel.png`、`admin.png`、`running-stage.png` | 默认 2D / `?avatar=3d` / 控制台 / 当前运行实拍 |

## 9. 工作约定

- `_analysis/` 已写入 `.git/info/exclude`：分析产物不进 git，可随意增删；`node_modules/`、`release/`、`data/`、`.tmp/` 在 `.gitignore` 内；**`.env` 与 `.env.*` 已忽略，只提交 `.env.example`**——永远不要把真实 Key 写进任何会被提交的文件。
- **不要为了让它跑起来去改仓库源码**：本机问题都在环境层（§3）。真实接入相关的改动（env.js/config/server/main/dev-server/sources/admin/docs/README/package.json）是有意的新功能，改动说明见 §10。
- 清空 `data/` 可重置今日计量、礼物榜、TTS 缓存与配置；配置由代码默认值重建。
- 删除 `release/`（383 MB）与 `node_modules/`（含 Electron 约 400 MB）可回收空间，需要时再 `npm ci` + `install.js`。
- 合规：抖音对无人直播有治理规则，AI 生成内容需显著标识（舞台左上角已有）；BGM 需授权；仓库无 LICENSE。

## 10. 变更日志
- 2026-10-28（下午）：拉取仓库（修复工作区 ACL 后克隆）→ 依赖安装 → 三路并行深度分析（stage / core / toolchain）→ 实测（测试、起服务、三层渲染器截图、GLB 解析、打包）→ 本机运行（浏览器模式）+ Electron 环境问题定位 → 初版本文件。
- 2026-10-28（晚上）：**真实直播接入**。新增 `.env` 密钥体系（`electron/core/env.js`、config 两层模型、`llm.status`、`POST /api/config` 不落盘 env 值）；新增抖音真实弹幕/礼物采集器（`scripts/douyin-collector.js` ~1.6k 行 + `selectors.json`）与主进程托管（`DouyinSource`，自动重启、系统消息过滤、礼物文案兜底）；控制台新增「抖音真实直播」卡片与 `.env` 状态；新增 `docs/真实直播接入指南.md`、`npm run douyin`；TTS 单价按真实值设为 0。实测：真实房间抓到 comment/enter/like，E2E 60s 26 事件、导演处理 6 条并播报；`.env` 假 Key 测试 → keySource=env / mode=llm / config.json 无泄漏；`npm test` 通过。
- 2026-10-29：**形象待机动作 + Windows 便携版 + 在线曲库**。① `stage/whale-girl-layered.js` 待机随机动作（张望/歪头/点头/哼歌/轻颤/连眨），`mode!=='idle'` 自动让位；② `package.json` artifactName 按 target 拆分，macOS 上离线打包成功（`-c.electronDist=` 解压好的 electron，`HOME`/`ELECTRON_BUILDER_CACHE` 指到工作区避开 EPERM），产物 `release/dyzb-0.1.0-x64-portable.exe`；③ 新增 `core/music-providers.js` + `jukebox` 在线搜索/缓存：Jamendo（`JAMENDO_CLIENT_ID`）+ Internet Archive，`commercialOnly` 只放行 CC BY/BY-SA/CC0/公版，播放前缓存到 `data/music-cache/`，`/api/songs` 支持在线、控制台点歌台「在线」按钮；④ 测试配置改为 `jukebox.provider='local'` 保持零外网。已提交 `ad3f363`/`ba66023` 并推送；Jamendo client_id 已配置在本地 `.env`（不入库），Windows 端用 ISO 里的 `setup-jamendo.cmd` 写入 `%APPDATA%\大肥鱼直播\.env`；Jamendo 候选窗口放大到最少 80 条并对偶发空结果重试一次。重新打包 `release/dyzb-0.1.0-x64-portable.exe`（asar 含 `music-providers.js`），新 ISO `.vm-share/update-ba66023.iso` 已挂到 VM 光驱 `SATA-1-0`（含源码包 `aizb-ba66023.zip`）。
