# 字幕与动效训练批次 1：原创离线沙盒复刻

> 历史状态说明：文中“等待第二级候选审核”已被内部技术治理取代；用户不再阅读规则页，只审核真实口播片段中的字幕与动效效果。

日期：2026-07-24

状态：`sandbox_recreation_complete / candidate_state_unchanged / awaiting_real_clip_trial_admission_review`

研究来源：`docs/research/2026-07-24-motion-caption-training-batch-1.md`

## 1. 本批范围

本批只把两条已经完成研究的候选技巧转成原创、离线、可寻址的 HyperFrames 沙盒：

1. `pause-aware-follow-caption`
2. `semantic-layout-router`

`plan-preview-promote-gates` 属于 Director 编排和权限合同，不是画面 primitive，本批没有把它伪装成视觉动效。

实现只修改：

- `video/multi-agent/tutorial-sandbox.mjs`
- `tests/multi-agent/tutorial-sandbox.test.mjs`

本报告为新增文件。没有修改 `config/`、生产渲染路径、Agent prompt、内容/声音沙盒、SQLite、memory transition 或发布状态。

## 2. 安全与原创边界

- 没有复制三条教程的代码、工程、字幕、配色、字体、模板、参数、截图、音频或其他资产。
- 画面、中文示例、布局、时间线和验证数据均为本地程序化创建。
- 运行时只复制仓库已有的本地 `gsap.min.js`，生成项目不含远程 URL，网络策略为 `offline-local-assets-only`。
- 新项目固定一个同步创建的 paused GSAP timeline，并注册到 `window.__timelines["main"]`。
- 画面 clip 由 HyperFrames 控制；退出淡化只作用于 clip 内部的 `#lab-frame` wrapper，没有直接修改 `.clip` 可见性。
- `Math.random()`、`Date.now()`、`performance.now()`、定时器、交互状态和无限循环均未进入渲染逻辑。
- 生成 artifact 不包含 approve、publish 或 promote 权限字段。

## 3. HyperFrames 版本

初始沙盒沿用仓库历史固定版 `0.7.68`。执行强制版本探针：

```text
npx hyperframes@latest upgrade --project . --check
```

结果显示可升级到 `0.7.70`。本批把教程沙盒生成器和新项目脚本固定为 `0.7.70`，重新运行全部检查和渲染后通过；`upgrade --check` 最终返回项目已在 `0.7.70`。

这次升级只作用于教程沙盒生成器和复刻入口，没有修改 Koubo 生产渲染配置和 v4 回退关系。`scripts/recreate_tutorial_techniques.mjs` 已同步固定 `0.7.70`，并统一使用 strict `check` 与高质量 render；两个专项 Motion primitive 仍必须经过各自 proof verifier，不能借通用入口写入 `recreated` transition。

## 4. `pause-aware-follow-caption`

### 原创实现

- 使用低强调的完整底层字幕和五个独立活跃 token。
- token 分别在 `0.62–0.94`、`1.24–1.58`、`3.06–3.42`、`4.02–4.32`、`4.76–5.12` 秒推进。
- `1.82–2.94` 秒为显式暂停区间；高亮在第二个 token 后保持，第三个 token 只能在暂停结束后出现。
- `index.motion.json` 验证首 token 出现、第二 token 先于第三 token、字幕保持在画内，并允许受控暂停而不把它误判为整片冻结。
- `technique-proof.json` 保存 token 时间窗、暂停区间和两张比较帧时间。

### 暂停保持实证

在 `2.12` 秒和 `2.62` 秒用 HyperFrames 直接从可寻址时间线生成 PNG，两个文件的 SHA-256 完全相同：

```text
e972791ebd57f6b74e07973b10e5165847529543db0f297860f23bfa304a9716
```

这证明暂停区间内完整源画面状态没有推进，而不只是句子最终总时长相同。

### 产物

根目录：`.cache/technique-reconstructions/2026-07-24-motion-batch-1/pause-aware-follow-caption`

| 产物 | SHA-256 |
| --- | --- |
| `index.html` | `a011bb39f841675162252c3289758d818b2ac3e56cdf57280c249932dd8cd10b` |
| `index.motion.json` | `9b22797cb8f0c2594e9abb41a1062c81027f449a2b5019561903e0d5a1633709` |
| `technique-proof.json` | `30a4654d205bf359f19b99fdf7cf721b379c5b572fb885dd1cb9ef84ee38af75` |
| `render.mp4` | `0bba6104daef0a572feafc49c5321ea92854e3ded46b2068d4a9356fa021d781` |

媒体结果：6.300 秒，1080×1920，30 fps，H.264，yuv420p，BT.709；无音轨；完整解码通过。

## 5. `semantic-layout-router`

### 原创实现

- `single-focus`：只显示一个中心重点，不展示后续步骤或证据内容。
- `steps`：显示输入、动作、结果三张步骤卡，不展示证据面板。
- `evidence`：显示本地程序化运行窗口、结果箭头和解释卡。
- 三类结构的 reveal 时间依次为 `0.42`、`2.28`、`4.68` 秒。
- 底部标签也按当前结构单独显隐；第一屏不再提前列出“步骤”和“证据”。
- `index.motion.json` 验证三类结构严格按顺序出现、保持画内并持续具有可识别的时间线变化。
- `technique-proof.json` 为 `1.20`、`3.35`、`5.95` 秒分别定义 visible/hidden selector 集合。

### 不提前剧透实证

三张可寻址快照已目视核对，每张只出现当前语义结构和当前标签：

| 时间 | 结构 | 快照 SHA-256 |
| ---: | --- | --- |
| 1.20 秒 | 单重点 | `7d2bf45d6c3609ee6ab4f49564717416ea8ddbd9bc317bec8144d1fce051bcec` |
| 3.35 秒 | 步骤 | `75db72caed7aeb219894fbf0d59f237f34a6556bc75880aba89a6d7a353d8f34` |
| 5.95 秒 | 证据 | `b2e73cf51b36d59041aa6e337c3d379b4afcaaf47e743cfb65173885e35f7751` |

### 产物

根目录：`.cache/technique-reconstructions/2026-07-24-motion-batch-1/semantic-layout-router`

| 产物 | SHA-256 |
| --- | --- |
| `index.html` | `0b2a7e0d281d912eea019f6c3f2b19d43f79294fa0b86b2926236694326f8832` |
| `index.motion.json` | `a525045ebddc553bd5e696990bd3ba0da1b4b2b5dec8c5364d0a8d4bd05e04fd` |
| `technique-proof.json` | `ee3477b78a5cdd2dcfb820229cfe5249f0a29f82d5b4e8c245323bb8666ec7a2` |
| `render.mp4` | `8fcef2cb838e829a47d9ef137ca95da9dd0f822c3bbddea390939e27aa0d7c0a` |

媒体结果：7.400 秒，1080×1920，30 fps，H.264，yuv420p，BT.709；无音轨；完整解码通过。

## 6. 自动检查与测试

### HyperFrames

两项均使用 `hyperframes@0.7.70`：

- `lint --json`：0 error，0 warning。
- `check --strict --snapshots`：runtime、layout、motion、contrast 全部通过。
- 暂停字幕：motion sidecar 127 个采样；contrast 63/63。
- 语义路由：motion sidecar 149 个采样；contrast 38/38。
- `render --quality high --workers 1 --sdr --strict-all`：两项成功。
- FFmpeg 完整解码：两项 exit 0。
- 所有关键快照均已实际打开并目视检查。

### Node

```text
node --test tests/multi-agent/tutorial-sandbox.test.mjs
9/9 passed

node --test tests/multi-agent/*.test.mjs
160/160 passed
```

`node --check` 与 `git diff --check` 均通过。

## 7. QA 状态与权限边界

两份本地 `qa-report.json` 的技术检查均通过，并返回 `eligibleTransition: "recreated"`。本批没有调用 `applyRecreationQa()`，没有执行 memory transition，因此两条知识仍保持 Candidate，不能被 Agent 当作 approved 或 promoted 知识读取。

本批没有用户主观审核，没有生产批准，也没有发布授权。允许后续把两项放入真实口播小样接受评测，也允许用户整组拒绝；技术通过不要求产生相对胜出者。

## 8. 尚未验证的限制

- 当前使用程序化无声 fixture，只证明视觉时间线和布局合同，不证明真实中文 ASR 时间码质量。
- `syncErrorMs: 0` 表示沙盒采用同一份 authored token 时间，不代表已经测量真人语音的转录误差。
- 暂停保持已用源 PNG 字节一致证明；H.264 成片经过有损编码，不应以压缩后帧文件哈希作为源状态相等的判据。
- 语义路由只验证三类基础结构，尚未覆盖多证据、长文本、多人画面、横屏或真实录屏遮挡。
- 两项尚未取得第二级候选审核的真实片段试用准入，也未进入真人口播或 Caption/Motion/Director 组合测试；这不是正式知识晋升。
