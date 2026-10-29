# AGENTS.md · 大肥鱼直播（aizb）项目记忆

> 本文件是本工作区的**项目记忆与操作约定**，DSH 会把 `A:\project\aizb\AGENTS.md` 自动注入到该工作区的会话。
> 最后更新：2026-10-29 18:10（Asia/Shanghai）。已包含：拉取/分析/运行记录、真实直播接入（.env + 抖音采集器）、合规人工确认模式、数据持久化看板、虚拟形象报备素材。
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
| 播报模式 | 默认 `compliance.humanInLoop=false`：AI 直接播报，真人全程值守；改为 `true` 则只生成草稿，控制台点「发送这条」才播报；`POST /api/speak {exact:true}`、`POST /api/draft/discard` | 控制台 `/admin/`；`status.draft` |
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
- 渲染器回退链：`3d` →（失败换 canvas）分层 2D → 程序化 2D（`stage.js:28-55`），鸭子接口 `setPalette/setMode/setMouth/celebrate/start` + 可选 `bow()/shakeHead()`，无共享基类；舞台 `emote` 按 `name` 分流（`gift`→鞠躬、`sad`→摇头、其余→celebrate）。
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
- 2026-10-29：**形象待机动作 + Windows 便携版 + 在线曲库**。① `stage/whale-girl-layered.js` 待机随机动作（张望/歪头/点头/哼歌/轻颤/连眨），`mode!=='idle'` 自动让位；② `package.json` artifactName 按 target 拆分，macOS 上离线打包成功（`-c.electronDist=` 解压好的 electron，`HOME`/`ELECTRON_BUILDER_CACHE` 指到工作区避开 EPERM），产物 `release/dyzb-0.1.0-x64-portable.exe`；③ 新增 `core/music-providers.js` + `jukebox` 在线搜索/缓存：Jamendo（`JAMENDO_CLIENT_ID`）+ Internet Archive，`commercialOnly` 只放行 CC BY/BY-SA/CC0/公版，播放前缓存到 `data/music-cache/`，`/api/songs` 支持在线、控制台点歌台「在线」按钮；④ 测试配置改为 `jukebox.provider='local'` 保持零外网。已提交 `ad3f363`/`ba66023` 并推送；Jamendo client_id 已配置在本地 `.env`（不入库），Windows 端用 ISO 里的 `setup-jamendo.cmd` 写入 `%APPDATA%\大肥鱼直播\.env`；Jamendo 候选窗口放大到最少 80 条并对偶发空结果重试一次。重新打包 `release/dyzb-0.1.0-x64-portable.exe`（asar 含 `music-providers.js`），新 ISO `.vm-share/update-ba66023.iso` 已挂到 VM 光驱 `SATA-1-0`（含源码包 `aizb-ba66023.zip`）。⑤ 按抖音客服口径调整播报模式：`compliance.humanInLoop` 默认改为 `false`（AI 直接播报 + 真人全程值守），需要逐条确认再改回 `true`；ISO 增加 `enable-autospeak.cmd` 用于把已保存的配置改回自动播报。
- 2026-10-29（中午）：**虚拟机全链路实测 + 在线音频下载超时修复**。Windows 11 VirtualBox（无 Guest Additions）内跑 `release/dyzb-0.1.0-x64-portable.exe`：`/health`、舞台 SSE、模拟弹幕→Echo 回复→Edge TTS 播报、Jamendo 搜索/入队/播放、`/dashboard/` 全部打通。定位并修复 `electron/core/jukebox.js` 的 `ensureLocal` 超时 bug：单曲常有 10–15 MB，客户机下载实测 31.5s，而原超时 30s 必然中止（日志 `fetch failed` / `This operation was aborted`）；现放宽到 120s 并失败重试一次。复测新曲 `jamendo:1268018` 成功缓存 9,687,040 字节并进入 singing。VM 操作要点：便携版真实进程不在 `taskkill /im dyzb-*.exe` 覆盖范围内，需按监听 17890 的 PID 强杀；`go.bat` 已改为 PowerShell 按端口杀进程。
- 2026-10-29（下午）：**真实数据默认 + 点歌队列管理 + 礼物鞠躬/找不到摇头**。① `source.type` 默认改 `ingest`（`config.js` 与本地 `data/config.json`），模拟弹幕只用于 `dev-server --seed` 或控制台显式选择，控制台数据源标签区分 外部接入/抖音直播/已关闭。② 评论点歌链路实测：`POST /ingest` 评论「点歌 晴天」→ 本地/在线检索 → 入队 → `music` SSE（真实 LLM + Edge TTS）。③ 新增队列手动管理：`Jukebox.move(id,{index|to})`、`POST /api/songs/move`、`POST /api/songs/remove`；控制台点歌台显示完整队列，支持置顶/上移/下移/移除，操作后 `refreshOverlay()` 立即刷新舞台叠层。④ 表情动作协议扩展：礼物 `emote{name:'gift'}` → `avatar.bow()` 鞠躬；点歌未找到 → `emote{name:'sad'}` → 无奈脸（闭眼+撇嘴+汗滴）+ 摇头；三层渲染器全部实现。⑤ 穿模修复：无界弹跳改 `sin(πp)·amp`、头部倾斜限幅 ±0.09、嘴部贴片按自身框裁剪（张口不再顶到下巴/领结）、鞠躬/摇头期间待机动作让位；像素差分确认嘴部变化不越出贴片框。⑥ `npm test` 增加队列移动/移除、礼物鞠躬、未找到摇头断言；三层渲染器经真实 SSE 动作链路 E2E 验证。
- 2026-10-29（下午·VM 复验）：**Windows 虚拟机复验新包**。`release/dyzb-0.1.0-x64-portable.exe`（13:10 构建）+ `.vm-share/update-d6595ac.iso` 实测：`/api/state` → `llm=llm keySource=env configured=True`（真实 DeepSeek）；`POST /ingest` 评论点歌 → Jamendo 曲目 `jazz spring2010_90` 进入 current 并持续播放 42s+；礼物事件 → 鞠躬帧（头部前倾下沉）；点歌未找到 → 无奈脸（闭眼+撇嘴）与摇头帧；空队列下入队 3 首 → `/api/songs/move {to:'top'}` 首位校验通过 → `/api/songs/remove` 通过。坑：① VM 运行中热换 ISO 后 Windows 仍缓存旧光盘内容（`dir D:` 显示旧文件；`storageattach --medium none` 报 `does not support hot-plugging`），需重启客户机才能刷新；本次改为从宿主 `http://10.0.2.2:8000/` 下载脚本 + Run 对话框执行。② 批处理/命令行里的中文会被按 ANSI 解码，改为在 PowerShell 里用 `[char]0x70B9` + `[char]0x6B4C` 构造「点歌」。
- 2026-10-29（下午·动作柔化）：**三层渲染器动作自然化**。① 鞠躬改为 `smoothstep` 缓入 → 保持（带轻微呼吸波纹）→ 回弹，头部经一阶阻尼 `bowHead` 跟随（`dt*9`），身体压缩收到 3.5% 以内，不再“砸下去”；② 摇头（点歌未找到）加阻尼包络 `sadShakeAmp` 与 2.1Hz 相位，2D 横向摆幅 13.3px（连续抓帧实测）、3D 头部 yaw ±0.20，并同步轻微下点；③ 思考/唱歌姿态改为 `thinkEnv`/`singEnv` 阻尼过渡，待机张望/歪头/点头/轻颤的时长与振幅全部调柔（颤振 36Hz→24Hz）；④ 三渲染器共用 `_bowCurve`/`smoothstep`，`bowHead` 限幅防发梢穿模。验证：改用 CDP `Page.startScreencast` 连续抓帧（约 22fps，替代 250ms/帧的截图接口），逐帧像素量测鞠躬 topY 63px、摇头 cx 13.3px 且无跳变；3D/2D-canvas 冒烟正常；`npm test` 双套件通过。新包 SHA256 `64f94c7a…` 在 VM 内复验：`llm=llm key=env`、`source=ingest`、点歌 jazz 14s 起播（by 真实事件用户）、礼物/未找到 handled 各 +1、errors=0。坑：宿主机 `curl 127.0.0.1:17890` 打到的是本机 dev server，**不是** VM，客户机状态只能由客户机内脚本回传（本次因此漏带 `--user-data-dir=C:\dyzb-run\profile`，落进 Echo 模式）。
- 2026-10-29（下午·表情返修）：**修掉“摇头诡异”**。根因三条：① 底层 `head.png` 自带张嘴，`mouth-closed.png` 只是遮罩，旧版难过时用纯色皮肤椭圆去盖，盖不全 → 脸上出现“补丁嘴/双嘴”；② 摇头 2.1Hz + 双倍频上下 bob + 整头 ±4.3° 滚转，像通电抽搐；③ 待机 `shiver` 用 24Hz 位移，精灵高频抖动会闪。改法：③ 改为慢速 `sway`（2.6s，1.8px）；② 摇头降到 1.1Hz、去掉双倍频 bob、加 `1-0.5p` 衰减，头部先改为绕颈剪切（**曾被圆柱投影替换，已按要求还原，见 14:52 条目**），躯干反向轻带 0.004；① 难过时把 `mouth-closed.png` **上下翻转**画回原位置（同画风撇嘴、完整遮住底图嘴），再叠一条极淡的嘴角弧线，删除皮肤椭圆。实拍确认嘴部干净、头部剪切自然；`npm test` 通过。
- 2026-10-29（下午·真转头，**已还原**）：**分层 2D 头部改为圆柱切片投影**。① 眨眼/口型/无奈表情先合成到离屏头贴片，再按 30×12 切片逐列做圆柱映射（`asin((x-cx)/R)` + 偏航角），五官与头发整片跟着转，不再是整块斜切；② 颈部接缝 y=230 留 6px 余量后从 208→236 用 `smoothstep` 把权重归零，下巴跟着转、脖子钉在身体上；③ `idle.x` 映射偏航角 0.018/px（张望 ±3.8px ≈ ±4°），摇头再叠 `sadWave*0.078`；④ 摇头重定时为 2.15Hz、前 1.15s `sin(πp)^0.65` 包络（快速左右两下后停在无奈表情），3D/程序化 2D 渲染器同步；⑤ CDP 连续抓帧实测：摇头时眼/嘴/下颌摆幅 16–19px、颈部 12px，待机张望 23–26px，面部列梯度无 ~8px 周期尖峰（无切片竖缝），3D 层改用 SwiftShader 抓帧确认头部真的左右转；⑥ `npm test` 双套件通过，重打包 `release/dyzb-0.1.0-x64-portable.exe`（SHA256 `76575524…`）。
- 2026-10-29（下午·还原模型）：**撤销圆柱切片投影，形象恢复原版**。用户反馈改造后“好怪”，要求形象与原来完全一致。做法：`stage/whale-girl-layered.js`、`stage/whale-girl-3d.js`、`stage/whale-girl.js` 全部回滚到 `7ca0703` 的绘制路径（绕颈剪切、原 `headPan`、原 tilt 系数），只保留用户明确要求的摇头节奏：`sadPhase` 2.15Hz、前 1.15s `sin(πp)^0.65` 包络、`sadShakeAmp` 攻起 `dt*6`，包络归零后停在无奈表情。验证方式：用 `git worktree` 起旧版服务（17891）与本版（17890）同一页面同一状态各画一帧做逐像素对比（`.tmp/freeze-diff.js`，冻结 `idle/blink/mouth` 后直接调用 `draw()`），静止、待机张望、眨眼、口型四组均 **0 像素差异**；连续抓帧量测摇头为 1.15s 内 2 次过零、摆幅 9.6px（旧版 10.6px、连摆 5.5s），之后静止。教训：整头逐列重投影会“脸心位移、发梢不动”，观感是拉扯而非转头；若要真转头应做多视图素材，而不是对单张立绘做几何变形。
- 2026-10-29（下午·VM 复验·还原版）：**Windows 虚拟机跑通还原后的包**。ISO `.vm-share/update-bb510fa.iso`（SHA256 `a0b0c1b6…`）内含 `dyzb-0.1.0-x64-portable.exe`（SHA256 `56750c81…`），asar 里的 `whale-girl-layered.js` 与工作区逐字节一致；`update.ps1` 按端口强杀 17890 → 复制 exe/`.env` 到 `C:\dyzb-run` → 带 `--user-data-dir=C:\dyzb-run\profile` 启动。功能复验（脚本经宿主 `http://10.0.2.2:8000/` 下发）：3 次点歌未找到 + 3 次礼物，`FINAL handled=11 speaks=12 errors=0 src=ingest`，`llm=llm key=env`。**抓帧量测**：客户机开 `--remote-debugging-port=9222`，PowerShell `ClientWebSocket` 直连 CDP 的 `Page.captureScreenshot`（约 21fps，45 帧/2.2s），JPEG 用 `curl.exe --data-binary @file` 回传宿主 8001 端口。摇头：头顶基准 cx 在 1.1s 内做 2 个来回（±2.3px，边缘 4px 峰峰），1.15s 后归零、只剩呼吸漂移；鞠躬：整头 dy 由 +8 → −13（下沉约 21px）再回弹归零，无跳变。坑：① 宿主 `VBoxManage screenshotpng` 约 5fps，会把 2.15Hz 摇头混叠掉，必须用客户机内 CDP 高速抓帧；② VM 屏 800×600、CDP 帧 792×446，坐标不能套宿主 1280×720 的裁剪框；③ 客户机 PowerShell 的 `Invoke-WebRequest -InFile` 上传二进制会挂起，改用 `curl.exe`。
- 2026-10-29（下午·闭眼与摇头像素级返修）：**闭眼不再穿模，摇头只做刚体**。① 闭眼贴片重做：`build_layers.py` 新增 `eye_closed_patch()`，眼睛开口（椭圆 ≤1.07 倍，含原画睫毛抗锯齿边）整片替换为皮肤，填色改为“每列取眼睛上/下最近皮肤色 → 沿列线性插值 → 列间中值平滑 → 24 次扩散”，消除竖条纹与惨白色块；眼睑线改用**原画睫毛实测色**（约 `(62,53,94)`，不是头发蓝）画在独立图层，两端收尖，下方叠 10% 淡阴影；刘海像素 alpha=0 完全不参与重绘，所以贴片可以整块不透明地盖上去——半透明边缘透出虹膜正是之前“穿模”的根因。`layers.json` 的眼框/半径同步更新。② 删掉整头横向剪切 `headShear`（0.095 会把脸拉斜），摇头改为纯刚体：绕颈根滚转 ±0.036rad + 平移 0.8px + 躯干反向 0.004，1.7Hz、前 1.15s 两下后停住。③ 闭眼只在 `blink>0.5` 或 `sadEnv>0.5` 时整块盖（不做 alpha 渐变，避免半透明过渡再次透出虹膜），并删掉 `_drawSadFace` 里的二次绘制（那是双重叠加的另一半根因）。验证：无头 Chrome 直接 `draw()`，睁眼→闭眼仅 445 像素变化且全部落在两个眼框内；9× 特写确认睫毛线、刘海、眼睑填充均正常；`npm test` exit 0。**尚未打包/提交**，等用户看效果。
- 2026-10-29（OpenDesign 能力核实）：`/Applications/Open Design.app` 自带 `prebundled/daemon/daemon-cli.mjs`，子命令 `media generate` 可直连本机 daemon（运行中监听 59165/59179）：`--surface image|video|audio --model <id> --image <参考图> --prompt`。图片模型有 `vela/gpt-image-2`、`vela/nano-banana-2`、`vela/seedream-5.0`（均支持 t2i+i2i，`--image` 可重复 5 次，属于 OpenDesign Cloud 托管、`credentialsRequired:false`，但会消耗账户额度）；视频有 `vela/doubao-seedance-2-0`（i2v，可拿立绘当首帧）。本机**没有装 ComfyUI**（8188 无响应），旧的 `refs/workflows` 流程在本机不可复跑。结论：让 OpenDesign 生成“同一角色的闭眼/侧脸/动作帧”可行，但要走它的项目会话或直接用 `media generate --daemon-url` + 项目 id，且需要用户同意花额度。
- 2026-10-29（下午·OpenDesign 实测结论）：**能调，但现在调不动**。① 机制已跑通：`prebundled/daemon/daemon-cli.mjs` 的 `media generate --daemon-url http://127.0.0.1:59165` 可驱动本机 daemon，项目可用 `POST /api/projects {"id":...}` 无 UI 创建，daemon 的 `/api/media/models` 列出 50 个图片模型（`vela/gpt-image-2`、`vela/nano-banana-2`、`vela/seedream-5.0`，均 t2i+i2i，`--image` 最多 5 张）。② 三条硬约束实测：`--image` 必须是**项目目录内**的相对路径（放 `files/` 也不行，得放项目根，绝对路径会被 `resolves outside the project directory` 拒绝）；生成会真的落 `media_tasks` 表；输出写到项目里。③ **阻塞点**：`od amr status` → `loggedIn:false`、`sessionState:signed_out`，`vela` 直接报 `profile "prod" is not logged in; run vela login`；DB 里没有任何 provider 的 key，因此所有 `vela/*` 云模型都不可用，需用户登录 OpenDesign Cloud（耗额度）或在「设置→媒体」里配 OpenAI/火山等自有 key。④ 质量判断：i2i 只能生成**重新绘制**的同角色图，天然做不到与现有立绘逐像素一致；可作为新动作/多视图的**参考素材**，不能直接替换现在的分层贴片。⑤ 本机无 ComfyUI（8188 不通），旧的 `refs/workflows` 流水线不可复跑。
- 2026-10-29（下午·摇头补测）：**摇头不露脖子断层**。用「贴片临时换成纯色剪影 + 关掉背景/装饰」的办法量头部底边与身体顶边的列轮廓：静止与最大摆幅下均有 5–8px 重叠（28/30 列），没有一列出现正缝隙，所以“怪”不是脖子断缝；刚体旋转的位移是 cx 1.2px、cy 4.8px（含呼吸）。闭眼贴片边界色差实测 ≤3.5（RGB 最大通道），贴片内部无半透明像素（semi=0），虹膜 `(107,116,181)` 已被整片覆盖，保留的 33 个蓝灰像素位于内眼角，属于压在眼睛上的刘海。
- 2026-10-29（下午·VM 更新到闭眼/摇头返修版）：**客户机已跑上新包，未提交、未推送**。打包命令要显式 `--x64`（默认跟随宿主 arm64，VM 装不上）：`HOME=.tmp/home ELECTRON_BUILDER_CACHE=.tmp/eb-cache npx electron-builder --win portable --x64 -c.electronDist=.tmp/electron-dist` → `release/dyzb-0.1.0-x64-portable.exe`（SHA256 `3636b751…`，119,149,532 B）。asar 内 `whale-girl-layered.js` / `eye-*-closed.png` / `layers.json` / `head.png` 与工作区 sha256 逐字节一致。VM 无 Guest Additions，更新靠「宿主 8000 端口静态服务 + `VBoxManage controlvm keyboardputstring` 打进 Win+R」两步：先下 `update2.ps1` 到 `C:\dyzb-run\u2.ps1`，再执行；脚本按 17890 端口杀进程 → 从 `http://10.0.2.2:8000/dyzb-3636b751.exe` 下载（119 MB / 86 s）→ 替换 `C:\dyzb-run\dyzb-motion.exe` → 以 `--user-data-dir=C:\dyzb-run\profile` 启动。复验：`UP llm=llm key=env source=ingest errors=0`；`RENDERER headShear=False sadShake=True gate=True sadDur4200=True len=26012`；加 `--remote-debugging-port=9222` 重启后 `stageClients=1`。客户机内 CDP 抓帧（`cdp-capture.ps1` + 宿主 8001 `frame-sink.js`）得 78 帧，闭眼用 `__stageDebug.avatar.setBlink(1)` 定格即可。坑：宿主 8000/8001 是这次更新/回传通道，**不要把 NAT 的 17890 转发加上去**，会和宿主 dev server 撞端口，`curl 127.0.0.1:17890` 打到的是宿主机；客户机状态只认 guest.log。OpenDesign 侧：用户绑的 LLM key 不等于媒体 key，`media generate --model gpt-image-2` 仍报 `no OpenAI credential`，要在 Settings → Media providers 里单独配。
- 2026-10-29（下午·尾巴接缝返修 + 桌面 exe）：**尾摆改成按行位移，接缝台阶归零**。用户反馈“脚”（其实是尾鳍）动起来突兀。根因：`_drawBody` 把 y≥760 整段绕 `(180,760)` 旋转，接缝两侧像素错开 5–6px 形成台阶。改为 24 条横带依次水平位移 `dx = amp * k²`（`k` 为到接缝的归一化距离），接缝行位移 0、鳍尖最大 13px；尾根以上单独整块绘制，不再有静止尾巴透出的重影。客户机内 CDP 冻结相位实测（先 `window.requestAnimationFrame=()=>0` 再 `avatar.t=相位; avatar.draw(performance.now())`，否则循环会把 t 覆盖掉——第一次测量就栽在这）：接缝处行间位移 0px，向下平滑增至鳍尖 ~10px（max↔min 两相），无台阶；自然摆动 30 帧位移连续。验证 `npm test` exit 0，重打包 SHA256 `f6bdff1e…`（119,146,800 B，asar 内 `const bands = 24` 且无 `ctx.rotate(ang)`）。客户机部署脚本 `deploy5.ps1`：按 17890 端口杀进程 → 从宿主 8000 下载 → 覆盖 `C:\dyzb-run\dyzb-motion.exe` → **同时复制到 `C:\Users\vboxuser\Desktop\dyzb-0.1.0-x64-portable.exe`**，日志 `REPLACED run=f6bdff1e desk=f6bdff1e` 表示两处哈希一致；`RENDERER tailBands=True rotateTail=False`。仍未提交、未推送。
- 2026-10-29（下午·第二个 exe：后台看板）：**新增独立「后台」客户端 exe**，与主程序组成两个 exe。① 入口 `electron/dashboard-main.js`：独立 Electron 主进程，只做看板/控制台窗口，不跑服务；`--url=` 可指定数据源，否则读主程序 `%APPDATA%\大肥鱼直播\data\config.json` 的 host/port，最终回落 `http://127.0.0.1:17890`；启动先 `GET /health` 探活，不通则加载 `electron/dashboard-wait.html`（暗色卡片 + 每 2s 重试）并自动进入，主程序中途挂掉时 `did-fail-load` 同样退回等待页，不会白屏。菜单提供「数据看板 / 控制台 / 重新连接 / 在浏览器中打开」。② 打包配置 `electron-builder.dashboard.yml`：`productName: 大肥鱼直播-后台`（**必须与主程序不同**，否则 `requestSingleInstanceLock` 用同一个 userData 目录会互相顶掉）、`appId: com.dyzb.fish.dashboard`、`extraMetadata.main` 指到 dashboard 入口、`files` 只含 4 个文件并显式 `!node_modules/**`（asar 仅 6 条，exe 110 MB）；脚本 `npm run dist:dashboard`，产物 `release-dashboard/dyzb-0.1.0-x64-dashboard.exe`（SHA256 `3c6794d1…`）。③ 客户机实测（`diag9/10/11.ps1`）：桌面副本 `C:\Users\vboxuser\Desktop\dyzb-0.1.0-x64-dashboard.exe` 哈希一致；`--url=17999` → 等待页（title `等待主程序 · 大肥鱼直播`，URL 为 asar 内 `dashboard-wait.html?base=…`）；正常启动 → `http://127.0.0.1:17890/dashboard/`，CDP 读 DOM：`events=32 comments=20 gifts=12 updated=08:44:42 pills=[弹幕源 外部接入, 房间 -, 舞台在线 1, LLM 模式] rows=10`。④ VM 操作坑：便携版自解压在 800×600 虚拟机上要 **~31s**，探测 CDP 必须轮询到 60s 以上，之前 9s 就判定失败是误判；`board.exe` 旧实例会占单实例锁，重测前按 `ProcessName -eq 'board'` 或含「后台」杀干净（别误杀主程序「大肥鱼直播」，它没有「后台」后缀）；Win+R 重复注入会把已开着的运行框关掉，脚本里固定「Esc → Win+R → Ctrl+A → 输入 → Enter」。
- 2026-10-29（下午·身体跟随尾摆）：**尾鳍摆动时上身不再“只有脚在动”**。`stage/whale-girl-layered.js` 新增 `_tailSwing()`：尾摆相位与振幅只算一次，上身按 `bodyDx = -0.55 * tailAmp * sin(ph - 0.3)` 反向侧移（略滞后尾尖 0.3rad）。绘制上把尾根以上拆成两段：髋部以上整体平移（1 次 drawImage），髋部往上 120px 用 16 条横带把位移 `smoothstep` 归零，正好与尾根 0 位移接上；头部平移同步加上 `bodyDx`，脖子不会错位。量测（宿主 1280 宽 / 客户机 792×446 冻结两相）：上身与头边缘位移 9–10px（客户机 7–8px），髋部 120px 内平滑收 0，尾巴 0→14.5px（客户机 0→10px），接缝行位移仍为 0，无台阶。`npm test` exit 0；重打包 `release/dyzb-0.1.0-x64-portable.exe`（SHA256 `a02c9cfb…`，119,165,725 B），客户机 `REPLACED hash=a02c9cfb`，桌面副本同步更新，`UP stage=1 llm=llm key=env`。仍未提交、未推送。
- 2026-10-29（傍晚·身体剪切 + 竖压 bug）：**上身跟随改成绕髋剪切，并修掉一个 26% 竖向压缩的隐形 bug**。① 上一版“髋部以上平移 + 120px 过渡带”在截图里看不到台阶，但头和肩是整体刚性平移，尾鳍反向甩时观感仍像只动了脚。改为 **整张上半身绕髋做剪切**：`k = lean / (hipY - pivotY)`，`x' = x + k*(hipY - y)`，`lean = -0.5*tailAmp*sin(ph-0.22)`（滞后尾尖 0.22rad，`hipY=600`），一段 `ctx.transform(1,0,-k,1,k*hipY,0)` 画完，髋部以下自然过渡到 Tail 段；头部只做刚体变换（绕颈根旋转 + 平移 `swing.lean`），tilt 附加 `swing.k*0.5` 并仍限幅 ±0.095，脖子不会脱开。② **根因修复**：`_drawBody` 原本用 5 参数 `ctx.drawImage(img,0,0,sw,t0)`，把 1034 行的身体图压进 760 行目标高度（竖向压缩 26%），y≈537 处那道“接缝尖刺”其实是这个压缩把源 y≈1010 的宽行挪了上来的鬼影；改为 9 参数 `drawImage(img,0,0,sw,t0, 0,0,sw,t0)`。修复后逐行相位比对 530–540 行位移恒为 2–3px，无台阶。③ 摇头节奏 `sadPhase` 2.15→1.7Hz，`sadShake` 改 `sin(sadPhase)*0.036`（原 `sin(phase-0.45)*0.022`），`headPan` 从 `sadWave*3.0` 收到 `0.8`，去掉横向剪切；闭眼贴片改为整像素不透明覆盖。④ 新增确定性胶片 harness `.tmp/motion-film.js`（冻结 RAF、假时钟、手动 `update/draw`、30fps + 2 子步）与 `.tmp/make-motion-videos.sh`，产出 `.shots/motion4/`（7 段：尾摆/张望/眨眼/说话/弹跳/鞠躬/摇头，48–164 帧）和 14 个 mp4；`.tmp/check-invariants.py` 给出各高度轮廓振幅（头 7.9px、腰 2.6px、髋 1.5px、鳍 1.6→18.9px）。⑤ 说话片段原本只张嘴一次就被 `update()` 衰减回去，harness 改为每子步重申 `setMode('speaking')+setMouth(0.85)`，口型差异从 28px 提升到 128px。`npm test` exit 0；重打包 `release/dyzb-0.1.0-x64-portable.exe`（SHA256 `8e4a46d3…`，119,160,435 B），asar 内 `stage/whale-girl-layered.js` 与工作区逐字节一致（`ab31fb24…`）。**仍未提交、未推送**（等用户看效果）。
