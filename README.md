# Koubo 通用口播工作台

Koubo 是一个本地优先的通用口播稿生成、真人视频剪辑和人工审核平台。它不再绑定某个个人账号、固定领域或“AI 成长”主题：用户可以选择任意合法内容方向、目标受众、视频目标、语气、语言和时长，然后完成从稿件到成片的完整流程。

当前交付首先面向本地自托管使用；数据模型已经带稳定 `workspaceId`，未来可以把本地工作区替换为登录用户和团队，而不重写内容、视频任务和审核领域模型。

## 用户流程

1. 双击 `打开AI口播工作台.vbs`。
2. 选择内容领域、目标受众、视频目标、表达语气和目标时长。
3. 填写明确方向以及真实事实、素材或可引用信息；需要严格证据时，可附工作区相对文件路径，由服务器读取并生成 SHA-256 证据快照。
4. Content Strategist 只分析方向、受众价值和证据缺口；用户明确确认后才生成稿件。
5. Creator Vault 的 trial 内容原则只允许单次显式 opt-in；默认生产路径不读取 trial，
   每次读取会在分析 artifact 中记录知识 ID、状态、命名空间和内容哈希。
6. 阅读 Ordinary Viewer Critic 的独立稿件意见，决定修改或拍摄。
7. 上传真人原片，进入本地 `faster-whisper + keepSegments + visual-director-v4` 主链。
8. 依次审核素材、关键帧、15—25 秒动态样片和完整成片。
9. 最终人工批准后，可以下载视频、派生平台版本或生成新的剪映草稿。

平台不会自动发布、评论、连接社交账号、批准素材或把真人媒体上传到云服务。

## 唯一生产主链

```text
工作区 + 通用内容配置
  → 方向与证据分析
  → 人工确认
  → 同题研究 + reference-distillation-v1.json
  → 通用口播稿 + Ordinary Viewer 审稿
  → 本地 faster-whisper
  → keepSegments（唯一语义剪辑决策）
  → content-breakdown + timeline + 派生 storyboard
  → exact / semantic / hybrid 素材锚点
  → Visual Director 选择 HyperFrames / FFmpeg / 可选镜头后端
  → 关键帧审核
  → 动态样片审核
  → 全片渲染 + QA + 普通观众审查
  → 最终人工批准
       ├─ MP4 / 平台画幅
       ├─ CMX 3600 EDL
       ├─ 剪映草稿
       └─ per-video retro
```

`visual-director-v4`、`job.json`、版本化审核和 `trial → approved → promoted` 是唯一总控。TouGe、video-shotcraft、Remotion、WhisperX、Manim 等第三方能力只能通过窄适配器、派生 artifact 或镜头资产接入，不得建立第二套 ASR、时间线、任务状态或审核系统。

## P0：安全与可重建运行时

- 服务只监听 `127.0.0.1`。
- CORS 只允许当前 `127.0.0.1/localhost` 工作台和显式配置的可信 Origin。
- 正常启动时，所有写操作都要求进程生命周期随机会话令牌；同源 UI 通过 `/api/session` 自动获取。
- 内容和视频任务带 `workspaceId`，列表与任务访问按工作区隔离。
- 客户端摘要始终视为 `user_provided`；只有服务器实际读取工作区文本文件后才能派生 `workspace_verified`，且证据、分析、确认 artifact 均绑定工作区。
- `config/runtime-lock.json` 固定 Node、Python、HyperFrames 和 FFmpeg 版本/哈希。
- `scripts/setup_runtime.ps1` 从锁文件建立独立 `.runtime`、`.runtime-exporters` 和可选 `.runtime-multi-agent`。
- `scripts/verify_runtime_lock.mjs` 检查版本、二进制哈希、Python 包、HyperFrames 固定版本、项目 Skill 路由以及 P3 默认关闭状态。

初始化：

```powershell
.\scripts\setup_runtime.ps1 -FfmpegBin "包含 ffmpeg.exe 和 ffprobe.exe 的目录" -IncludeMultiAgent
node .\scripts\verify_runtime_lock.mjs
```

当前锁定基线：

- Node `22.20.0`
- Python `3.11.15`
- faster-whisper `1.2.1`
- OpenAI Python `2.45.0`
- HyperFrames `0.7.71`
- FFmpeg `N-125573-g90436de5e1-20260713`，SHA-256 见 `config/runtime-lock.json`
- 剪映导出器 `pyJianYingDraft 0.3.0`

## P1：可编辑交付与真实证据

### 剪映导出

只有最终人工批准且与当前输出版本一致的 `timeline-vN.json` 才能调用：

```text
POST /api/jobs/{jobId}/exports/jianying
```

导出器只读批准时间线，生成新草稿目录，不覆盖旧草稿，不重跑 ASR，也不修改 `job.json`、批准状态或原时间线。它会验证独立片段数、源范围、目标时长、连续性、源路径和每段 30ms 淡入淡出。

默认输出到任务目录的 `exports/jianying/`。如需直接写入用户选择的剪映草稿根目录，使用本机环境变量 `KOUBO_JIANYING_DRAFT_ROOT`。

### 证据化拉片

每次完成同题研究后生成 `reference-distillation-v1.json`，记录来源、完整媒体证据、时间线、Hook、镜头、节奏、视觉、音频、可借鉴项、禁止复制项和不确定性。未经完整核验的目录条目或 metadata 不能冒充已分析视频。

### 语义素材锚点

素材兼容三种锚点：

- `exact`：严格绑定输出时间。
- `semantic`：绑定稳定 `segmentId` 和段内偏移。
- `hybrid`：先绑定语义段，再用精确范围收紧。

旧任务的 `placement.start/end/mode` 保持兼容。

### PageCam

使用本机 Chrome/Edge 的 DevTools 协议捕获真实页面，不依赖 Puppeteer：

```powershell
node .\scripts\capture_pagecam.mjs `
  --url http://127.0.0.1:8787 `
  --output outputs/pagecam/demo `
  --selector=hero=#hero-topic
```

输出 `page.png`、`elements/*.png` 和 `layout.json`。默认只允许 `localhost/127.0.0.1/file`；捕获前需要完成隐私脱敏。产物必须经过镜头注册表 trial 审核后才能成为生产默认。

## P2：派生资产与复盘

- 内容拆解阶段从权威 JSON 派生 `storyboard-vN.json/md`；Markdown 明确禁止反向写回状态。
- `config/shot_registry.json` 登记真实页面、元素特写、AI 流式回复、命令面板、前后对比和数据变化六类首批镜头。当前均为 `trial`，不会自动进入生产默认。
- `POST /api/jobs/{jobId}/retro` 生成 `video-retro-vN.json/md`。单期复盘永不自动晋升长期规则。
- 当前 Sound sandbox 中的 speech-aware ducking 和 semantic SFX 继续遵守 trial 门禁；只有许可清晰、真实片段审核通过后才可进入生产配置，默认不添加 BGM。
- Director 继续按镜头选择渲染后端并保留 fallback；Remotion 不成为统一默认引擎。

## P3：默认关闭插件

`config/plugins.json` 注册：

- Collage：可能上传已批准素材并产生费用。
- WhisperX：仅适合多人访谈或当前词级对齐失败。
- Manim：仅适合数学、算法和技术解释镜头。

三者默认全部关闭，不会自动安装依赖、下载模型或调用云服务。健康接口和 `/api/platform` 会报告启用状态、隐私与成本边界。

## 隐私与权限

- 原视频、音频、成片、逐字稿和剪映草稿默认只在本机处理。
- 文本模型只接收脱敏文字、稿件、逐字稿和技术参数，不接收真人视频或音频。
- 上传任何媒体到云服务前，必须说明服务、文件、用途和预计费用，并取得当次明确确认。
- 来源标注不等于素材授权；外部素材必须保存创作者、作品、链接、片段、用途、许可依据和画面署名。
- 不自动发布，不把 API Key、Token、Cookie 或密码写入仓库。

## 关键目录

- `config/platform.json`：通用产品、默认内容配置、安全和治理边界。
- `config/plugins.json`：P3 插件状态。
- `config/shot_registry.json`：受治理镜头资产。
- `content-items/`：按工作区生成的稿件和研究 artifact，Git 忽略。
- `video-jobs/`：原片、时间线、审核、成片、导出和复盘，Git 忽略。
- `video/platform/`：安全、工作区和插件边界。
- `video/exporters/`：只读导出器适配层。
- `video/assets/anchors.mjs`：素材锚点合同。
- `video/research/reference_distillation.mjs`：证据化拉片合同。
- `video/shots/`：镜头注册和 PageCam。
- `video/server.mjs`：本地 API 和生产工作流。
- `web/`：通用口播工作台 UI。

## 文本模型配置

复制 `.env.example` 为被 Git 忽略的 `.env`：

```dotenv
OPENAI_API_KEY=
OPENAI_BASE_URL=
OPENAI_MODEL=
```

使用 OpenAI 官方接口时 `OPENAI_BASE_URL` 可留空。不要把密钥提交到 Git。

## 验证

```powershell
node .\scripts\verify_runtime_lock.mjs

$tests = @()
$tests += Get-ChildItem tests\baseline\*.test.mjs
$tests += Get-ChildItem tests\multi-agent\*.test.mjs
$tests += Get-ChildItem tests\*.test.mjs
node --test $tests.FullName

.\.runtime-multi-agent\Scripts\python.exe -m unittest discover -s tests/python -v
node .\scripts\verify_workbench.mjs
```

最终验收还必须包括真实浏览器 UI、真实 PageCam 输出、真实媒体完整解码，以及剪映草稿的 JSON 验证；生成文件本身不等于可用交付。
