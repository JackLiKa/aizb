# 大肥鱼直播

一个跑在 Windows 桌面上的 AI 虚拟形象陪伴直播端：3D 鲸鱼娘虚拟形象（three.js/WebGL）、实时口型、TTS 语音、礼物点名、评论区点歌，以及屏幕上的 token 消耗与礼物榜。

它是一台机器上的完整直播源：渲染画面 + 音频都在本机，抖音直播伴侣（或 OBS）用「窗口捕获 + 系统声音」把它当成一个摄像头推出去。

```
┌──────────────────────────── 大肥鱼直播 (Electron) ────────────────────────────┐
│                                                                              │
│  弹幕源            导演 (director)              渲染层 (stage)   控制台 (admin) │
│  ├ 模拟器  ──┐     ├ 优先级队列                ├ 3D 鲸鱼娘 WebGL   ├ 状态/暂停    │
│  ├ /ingest ──┼──▶  ├ 冷却/去重/夜间降频  ────▶  ├ 口型 + 表情粒子    ├ 手动说话    │
│  └ WebSocket ┘     ├ LLM 流式生成              ├ 弹幕 / 字幕        ├ 点歌/切歌    │
│                    ├ Edge TTS 并行合成         ├ token/礼物/点歌    ├ 配置热更新  │
│                    └ 单串行播放队列            └ SSE /events        └ 日志        │
│                                                                              │
│                          本地 HTTP 服务 127.0.0.1:17890                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 功能

- **形象**：程序化生成的 3D 鲸鱼娘（three.js/WebGL）——圆脸、鳍耳、鲸尾、白蓝裙装；眨眼、摆尾、呼吸浮动、说话口型，唱歌时尾巴加速摆动；送礼触发 3D 爱心与弹跳。WebGL 不可用时自动回退到原 2D Canvas 形象。
- **口型**：WebAudio `AnalyserNode` 取 TTS 音频的 RMS 驱动嘴形，没有音频时退化为节奏性张嘴。
- **语音**：`msedge-tts`（Edge 朗读，免费、无需 Key），默认 `zh-CN-XiaoxiaoNeural`；可切 OpenAI TTS。按句切分、最多 3 路并行合成、严格按顺序播放。
- **对话**：OpenAI 兼容接口流式输出（默认 DeepSeek）。没填 Key 时进入 Echo 模式，用内置台词跑通全链路，方便先调画面。
- **礼物**：高优先级插入、可打断当前播报、屏幕横幅 + 粒子 + 礼物榜。
- **点歌**：`data/music` 即曲库，文件名 `歌手 - 歌名.mp3` 自动解析；弹幕「点歌 晴天」或控制台搜索入队；放完自动下一首。
- **计量**：今日 token / 预估花费 / TTS 字数 / 礼物价值，舞台右上角和控制台同步显示；`displayMultiplier` 可只放大展示数字，真实成本单独记账。
- **24 小时运行**：舞台心跳看门狗（12s 无心跳自动重载，每小时最多 6 次）、`powerSaveBlocker` 防休眠、托盘常驻、日志按天滚动保留 7 天、夜间时段自动降频。

## 快速开始

需要 **Node.js 22 LTS**。

```bash
npm ci            # 或 npm install（会下载 Electron 二进制）
npm start         # 舞台窗口 + 控制台窗口 + 托盘
```

首次启动生成 `data/config.json`，此时没有 Key，处于 **Echo 模式**：模拟弹幕 + 内置台词 + Edge 语音，能直接看到完整效果。

> **换新环境部署**：`git clone` 后先 `Copy-Item .env.example .env` 并填入 `LLM_API_KEY`（`.env` 不会入库），再 `npm ci`；**默认开启合规模式** `compliance.humanInLoop=true`（AI 仅出草稿，真人在控制台确认后播报），数据看板在 `/dashboard/`。抖音直播相关配置（房间号/弹幕源）在控制台里设置。

只想在浏览器里调页面（不启动 Electron）：

```bash
npm run server              # http://127.0.0.1:17890/stage/ 与 /admin/
npm run server -- --seed    # 弹幕更快，方便看效果
```

### 第一次配置

1. 打开控制台（托盘 → 打开控制台，或 `http://127.0.0.1:17890/admin/`）。
2. 在项目根目录的 `.env` 里填 `LLM_API_KEY`（模板见 `.env.example`，该文件已 gitignore，不会上传 GitHub），改完重启服务即进入 LLM 模式。
3. 改人设改 `persona.system`；改音色改 `tts.voice`（中文推荐 `zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`）。
4. 把 mp3 放进 `data/music/`，点歌台会立刻索引。

> 打包后的数据目录在 `%APPDATA%\大肥鱼直播\data`；开发模式在仓库的 `data/`。

## 接入真实直播（Key / 弹幕 / 礼物）

- **API Key**：填项目根目录的 **`.env`**（模板 `.env.example`，已加入 `.gitignore`，不会上传 GitHub），改完重启服务。控制台「运行状态 → LLM 密钥」会显示来源（`.env` / config.json / 未配置）。
- **真实弹幕 + 礼物**：抖音没有公开观众弹幕接口，项目提供 `scripts/douyin-collector.js`：用无头 Chrome 打开你的直播间、观察聊天区 DOM，把弹幕/礼物/关注转成事件 `POST /ingest`。控制台「抖音真实直播」卡片填房间号即可一键连接；采集器由主进程托管，异常退出自动重连。选择器在 `scripts/douyin-selectors.json`，平台改版只改这里。
- **真实 token 计量**：配好 Key 后，token 直接来自供应商返回的 `usage`（不再估算）；单价在 `data/config.json → metering` 按你的供应商实际价格设置。
- **推流**：本应用只负责「画面 + 声音」，窗口捕获与音频路由交给直播伴侣/OBS；完整步骤（窗口捕获、VB-Cable 音频、合规、排错）见 **[docs/真实直播接入指南.md](docs/真实直播接入指南.md)**。
- **合规模式（重要）**：`data/config.json → compliance.humanInLoop = true` 时，AI 只生成回复草稿，控制台「AI 回复草稿（需人工确认）」点「发送这条」才播报——对应抖音「虚拟人直播须真人驱动/值守」的要求；舞台已内置显著的 AI 标识（左上标签 + 右下水印）。
- **数据看板**：真实事件逐条落盘 `data/analytics/events-YYYY-MM-DD.jsonl`，计量每 30s 快照；看板地址 **http://127.0.0.1:17890/dashboard/**，接口 `GET /api/stats?days=7`。
- **抖音合规/报备**：处罚类型、整改方案、申诉模板见 **[docs/抖音合规整改.md](docs/抖音合规整改.md)**；报备用形象图见 **[docs/虚拟形象-报备素材/](docs/虚拟形象-报备素材/)**。

## 3D 虚拟形象

形象是**完全原创、程序化生成**的 3D 模型，不依赖外部模型文件或贴图，参考图只用于配色与比例。

- **比例**：按「成熟比例」三视图量出来的约 5.5 头身——头高 0.43 单位、总高 2.49 单位，腰线在 0.61H、裙摆 0.34H、及膝袜 0.23H，腰围收窄、腿拉长。
- **模型定义** `stage/whale-model.js`：用 three.js 几何体拼出身体、头部、鳍耳、鲸尾、深蓝女仆长裙和五官；长裙用 `LatheGeometry` 车出 A 字廓形，围裙/裙摆是带弧度的开口圆柱；眼睛是画在 canvas 上的虹膜纹理，再贴合到脸椭球面的曲面贴片上（`faceDecal`），所以平贴图不会穿帮。节点按 `WhaleGirl / Body / Head / EyeL / Mouth / Tail / EarL / FinBlade / Skirt / Apron / SideLock / Ahoge …` 命名，关节分组可直接驱动动画。
- **渲染与动作** `stage/whale-girl-3d.js`：三点布光、相机取景、眨眼、口型、待机呼吸、思考气泡、唱歌摆尾、庆祝爱心粒子；与 2D 渲染器保持同一套 `setPalette / setMode / setMouth / celebrate` 接口。
- **配色**：复用 `config.avatar` 的五个颜色键（`hairColor / hairShadeColor / skinColor / finColor / blushColor`），控制台改色热更新。默认值取自三视图实测：发色 `#414d85`（受光处 `#606ca8`、暗部 `#3c3c60`）、皮肤 `#fdebdf`、鳍耳/尾巴 `#3a4a8c`、腮红 `#fdc5bd`；裙装深蓝 `#20233c`、蕾丝/围裙白 `#ffffff`、金扣 `#c8a35c`、鞋 `#1e2342` 由模型内部调色板给出（`buildPalette` 的 `cloth / lace / gold / shoe / pleat` 键，也可通过 `avatar.clothColor` 覆盖裙子颜色）。
- **服装要点**：白立领衬衫 + 竖褶 + 一排扣、深蓝领结镶金边椭圆宝石、白色荷叶边肩饰、泡泡袖白袖口、双排金扣腰封、多层白色蕾丝裙摆 + 金十字星、白围裙（波浪下摆 + 蓝鲸图案）、背后大白蝴蝶结与飘带；白色过膝袜（蕾丝边 + 小蓝结）配深蓝圆头玛丽珍鞋（金扣 + 方跟）。
- **自动回退**：舞台页优先初始化 WebGL；没有 WebGL2 或上下文创建失败时，会替换成新的 canvas 并退回 2D 渲染器（`stage/whale-girl.js`），直播不中断。弱显卡/虚拟机可加 `?avatar=2d` 强制使用 2D。
- **模型预览**：`http://127.0.0.1:17890/stage/model-preview.html?view=0.6&mouth=0.8`（`view` 为水平转角，`mouth` 为 0–1 张嘴幅度）。
- **导出 GLB**：`npm run export:glb` → `stage/assets/whale-girl.glb`（351 节点 / 281 网格 / 28 材质 / 2 段动画 `Idle`、`Talk`，含命名节点）。导出脚本默认连接 `http://127.0.0.1:17890`，可用第一个参数覆盖，例如 `node scripts/export-glb.js http://127.0.0.1:17895`。

> three.js 运行时已放在 `stage/vendor/`，舞台页通过 import map 离线加载，不需要外网。

## 抖音直播伴侣 / OBS

本应用负责「画面 + 声音」，推流交给直播伴侣。

1. 舞台窗口是 **1280×720 无边框**窗口，先拖到副屏。
2. 直播伴侣 → 添加素材 → **窗口捕获** → 选择「大肥鱼直播」。
3. 分辨率 1280×720、30fps，与舞台保持一致。
4. 音频用 **系统声音**。为了只收直播声音，装 [VB-Audio Virtual Cable](https://vb-audio.com/Cable/)：
   - Windows 声音设置 → 输出设备改为 `CABLE Input`；
   - 直播伴侣 → 麦克风 → 选 `CABLE Output`；
   - 想自己监听就再给 CABLE Output 开「侦听此设备」。
5. 舞台是 frameless 窗口，`Alt+F4` 会被拦截，退出请用托盘菜单。

## 在 VirtualBox 的 Win11 里试

- 建议 **4 vCPU / 8 GB 内存**，显存 128 MB，开启 3D 加速，关闭 Windows 透明效果。
- 窗口捕获在 VirtualBox 内可用，但**不要用 RDP**：RDP 会切到新会话导致捕获黑屏。用 VNC / VirtualBox 远程显示，或在 RDP 中执行 `tscon %sessionname% /dest:console` 切回控制台。
- 虚拟机需要能访问外网才能用 Edge TTS；被拦截就把 `tts.provider` 换成 `openai` 或 `none`（`none` 只做口型不出声）。
- 没有麦克风也能跑，因为走的是系统声音 + 虚拟声卡。

## 打包

```bash
npm run dist     # NSIS 安装包 + 免安装 portable，输出到 release/
npm run pack     # 只解包目录，调试用
```

在 Windows 上直接打包最省事。macOS/Linux 交叉打 Windows 包时 NSIS 需要 wine，更推荐 Windows 机器或 GitHub Actions。

产物：

- `release/dyzb-0.1.0-x64.exe`（安装版）
- `release/dyzb-0.1.0-portable-x64.exe`（便携版）

安装版可在配置里把 `app.autoStart` 设为 `true` 注册开机自启（仅打包版生效）。

## 24 小时无人值守

- **登录**：必须有已登录的桌面会话，窗口捕获才有画面。用 `netplwiz` 或 [Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon) 配自动登录，再配合 `app.autoStart`。
- **电源**：电源计划设为从不睡眠、从不关屏；应用内还会开 `powerSaveBlocker`。
- **看门狗**：舞台每 2 秒上报心跳，12 秒无心跳即重载渲染进程；每小时最多 6 次，避免死循环。
- **日志**：`data/logs/app-YYYY-MM-DD.log`，保留 7 天，控制台可看最近 80 条。
- **崩溃**：主进程捕获 `uncaughtException` / `unhandledRejection`；渲染进程崩溃 2 秒后自动重载。主进程整体挂掉需外部拉起（任务计划程序 / NSSM），但服务模式拿不到桌面，仍要配合登录会话。

## 接入真实弹幕

抖音没有公开的观众弹幕接口。本项目把「事件源」抽象成 `push(event)`，默认模拟器；接真实直播间时，用转发器把弹幕/礼物 POST 过来，应用侧无需改动。

```bash
curl -X POST http://127.0.0.1:17890/ingest \
  -H 'Content-Type: application/json' \
  -H 'x-ingest-token: change-me' \
  -d '{"type":"comment","user":"张三","text":"肥鱼你好呀"}'
```

也支持 WebSocket：`ws://127.0.0.1:17890/ingest?token=change-me`，连上后发同样的 JSON。

| type | 必填 | 说明 |
| --- | --- | --- |
| `comment` | `user`, `text` | 普通弹幕；文本含「点歌/来一首/想听」会自动转点歌 |
| `gift` | `user`, `giftName`，可选 `count`/`value` | 礼物，高优先级、可打断播报 |
| `follow` | `user` | 关注欢迎 |
| `song` | `user`, `query` | 直接点歌 |
| `like` / `enter` | `user` | 只上弹幕墙，不触发回复 |

`ingest.token` 务必改掉默认的 `change-me`；服务只监听 `127.0.0.1`，不要暴露公网。

## 计量口径

`data/config.json` → `metering`：

- `inputPricePerM` / `outputPricePerM`：每百万 token 价格，默认 2 / 8（按 DeepSeek 缓存未命中价，按实际供应商改）。
- `ttsPricePer1kChars`：每千字语音价格；Edge 免费，默认 0.15 只是等价成本示意，可设 0。
- `displayMultiplier`：只影响展示数字，不影响记账，用来做节目效果。

真实账单以供应商后台为准。

## 测试

```bash
npm test          # 核心链路冒烟 + HTTP/SSE 联调
npm run smoke     # 纯 Node：导演/LLM/TTS/点歌，不出网不发声
npm run server    # 起本地服务手动点
npm run export:glb  # 重新生成并校验 stage/assets/whale-girl.glb
node scripts/shot.js http://127.0.0.1:17890/stage/ shot.png --speak "你好呀"
```

`scripts/http-test.js` 会真实建服务、连 SSE、注入事件、模拟舞台回报，验证 `say → say:done → utterance:finished → 队列释放` 闭环。

## 目录

```
electron/
  main.js               应用生命周期、舞台/控制台窗口、托盘
  core/
    config.js           默认配置 + 深合并 + 原子写盘
    store.js            JSON 状态持久化（800ms 防抖）
    logger.js           环形缓冲 + 按天日志
    brain.js            LLM 流式（OpenAI 兼容）与 Echo 模式
    voice.js            Edge/OpenAI TTS、磁盘缓存、并发闸门
    jukebox.js          曲库索引、模糊搜索、点歌队列
    director.js         事件 → 优先级队列 → 生成 → 分句 → 播报
    sources.js          模拟弹幕源 / 事件源切换
    metering.js         token、花费、礼物、点歌统计
    watchdog.js         舞台心跳与重启节流
    server.js           HTTP/SSE/WS、REST API、静态资源
stage/                  舞台页（3D 鲸鱼娘、2D 回退、音频、SSE）
  whale-model.js        程序化 3D 模型、调色板与节点分组
  whale-girl-3d.js      WebGL 渲染器与动作
  whale-girl.js         2D Canvas 渲染器（回退）
  model-preview.html    3D 模型预览 / GLB 导出页
  vendor/               three.js 运行时与 GLTFExporter
  assets/whale-girl.glb 导出的 3D 模型
admin/                  控制台页
scripts/                冒烟、HTTP 联调、无 Electron 调试、截图
build/                  应用图标
```

## HTTP 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/health` | 健康检查（舞台连接数、看门狗状态） |
| GET | `/events?role=stage` | SSE 事件流 |
| POST | `/stage/report` | 舞台心跳 / 播报完成 / 音乐结束 |
| POST | `/ingest` | 外部事件入口（需 token） |
| GET | `/api/state` | 全量状态（apiKey 已打码） |
| POST | `/api/speak` | 让肥鱼说一句 |
| POST | `/api/event` | 注入一条事件 |
| POST | `/api/pause` | 暂停/恢复自动回复 |
| POST | `/api/source` | 切换 `simulator` / `ingest` / `off` |
| GET/POST | `/api/songs`、`/api/songs/queue`、`/api/songs/skip` | 曲库、入队、切歌 |
| POST | `/api/config` | 保存配置 |
| POST | `/api/restart-stage` | 重载舞台渲染 |

## 已知限制

- **Edge TTS 是非官方通道**，微软改动就可能失效；失效时切 `tts.provider` 到 `openai`，或至少设 `none` 保证直播不挂。
- **没有抖音官方弹幕源**，需要自己接转发器；本项目只保证事件进来之后的链路。
- 单机 720p30 是稳妥档位；4C8G 不建议上 1080p60，3D 渲染与 TTS 会抢 CPU。虚拟机/无独立显卡时 WebGL 会走软件渲染，若舞台帧率过低，可在舞台地址加 `?avatar=2d` 使用 2D 回退。
- 3D 模型是程序化生成的低多边形风格，没有骨骼蒙皮；动作由节点变换驱动（头、呆毛、侧发、鳍耳、尾巴、手臂、口型），适合当前直播半身/全身固定机位，不适合做复杂全身动画。
- 打包版的数据、日志、曲库都在 `%APPDATA%`，升级/重装不丢，但别随手删。

## 合规提醒（重要）

- 抖音对「无人直播 / 挂机直播」有明确治理规则；AI 虚拟形象直播需按平台要求报备，并对 AI 生成内容做显著标识（参考 2025-09-01 起施行的《人工智能生成合成内容标识办法》及平台规则）。舞台左上角已有「AI 虚拟形象」标识，但**标识不等于豁免**。
- 背景音乐必须有授权；请使用你拥有直播/信息网络传播权的版本，并遵守商业曲库的使用范围。
- 不要做「送礼物就做某个动作/说某句话」的诱导性玩法，礼物话术保持感谢即可。
- 本文档只描述技术实现，不构成合规建议；开播前请自行确认平台最新规则。

## 路线图

- [x] M0 工程骨架 / 配置 / 日志 / 持久化
- [x] M1 形象渲染 + 口型 + 弹幕 + overlay
- [x] M2 LLM + Edge TTS + 单串行播报队列
- [x] M3 礼物 / 点歌 / 曲库 / 计量
- [x] M4 控制台 / 看门狗 / 托盘 / 打包
- [ ] 真实弹幕源适配器（按平台补一个 `sources/*.js`）
- [ ] 多套形象皮肤 / 表情包
- [ ] 直播数据回流（在线人数、留存）驱动话术
