# 虚拟形象 · 报备素材（最新版）

本目录是项目当前虚拟形象（AI 生成的鲸鱼娘「肥鱼」）的**报备用形象图**，与 `stage/assets/avatar/` 中运行时使用的 2D 立绘为同一套形象。

用于：抖音主播中心 →「虚拟直播开播报备」上传。

| 文件 | 内容 | 说明 |
| --- | --- | --- |
| `avatar-front.jpg` | 全身正面（纯白底） | **必传**：页面要求至少 1 张全身、正面图 |
| `avatar-side.jpg` | 全身侧面 | 选传（补充角度） |
| `avatar-back.jpg` | 全身背面 | 选传（补充角度） |
| `avatar-face.jpg` | 面部细节 | 选传 |
| `avatar-4views.jpg` | 四视图合集 | 备查 |

规格：JPG、纯白背景、单文件 <300KB（页面限制 5MB 以内）、全身/多角度齐全。

## 重新生成

源图在 `stage/assets/avatar/view0.png` ~ `view3.png`（运行时立绘切片；同一形象由 `refs/workflows/*.json` 的 ComfyUI 工作流生成，经 `scripts/sheet_cut.py`、`scripts/build_layers.py` 拆层）。

本地生成脚本（不属于仓库运行代码，仓库外保留）：`_analysis/make-filing-assets.py`、`_analysis/make-filing-final.py`、`_analysis/make-filing-compat.py`。

## 报备注意

1. 报备页要求勾选「承诺开播形象均无侵权风险，并仅用于真人直播」——本项目默认 AI 自动播报、运营者全程在旁值守（`compliance.humanInLoop=false`）；需要逐条人工确认时改为 `true`；
2. 不要做无人值守的纯自动直播；平台对无人直播有治理规则，被判定为无人直播仍可能处罚；
3. 报备通过后必须使用已报备形象开播，换装/换形象需重新报备；
4. 若因着装被驳回，需要换更保守的服装形象重新生成（源工作流在 `refs/workflows/`）。

详见 `docs/抖音合规整改.md`。
