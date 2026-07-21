---
name: koubo-ai-video-editor
description: Edit and package talking-head口播 videos created through F:\code\koubo. Use when the user asks to剪辑口播、删除停顿或错句、加字幕、做动态标题/B-roll、生成竖屏或多平台版本、检查已完成的video-jobs任务，或继续处理网页“拍完AI剪辑”创建的 job.json / edit-plan.json / MP4 素材。
---

# 口播 AI 视频剪辑

把网页创建的本地剪辑任务变成可审查、可复现的成片。默认使用本机 FFmpeg；需要语义转写、动态包装或云服务时按门禁升级。

## 入口

1. 若用户给出任务目录，使用该目录。
2. 否则在 `F:\code\koubo\video-jobs\` 中选择 `updatedAt` 最新且包含 `job.json` 的目录。
3. 先运行：

```powershell
node .agents\skills\koubo-ai-video-editor\scripts\inspect_job.mjs "<任务目录>"
```

4. 读取 `job.json`、`edit-plan.json`、`ai-brief.md`；如果已有 `final.mp4`，先把它当作基础版，不覆盖原片。
5. 若任务状态是 `awaiting_asset_review`，先检查 `asset-candidates.json` 和网页素材审核板；所有候选必须逐条批准或拒绝，不能绕过审核直接渲染。

## 路由

- **只删长停顿、加字幕、调响度、转9:16**：复用网页本地服务生成的 `final.mp4`，检查后交付。
- **有错句、假启动、多条 take 需要语义选择**：优先用 `video-use`。只有检测到 `ELEVENLABS_API_KEY` 或其 `.env` 已配置时才运行；未配置时不要索要或猜测密钥，改用 HyperFrames 本地 Whisper 或当前口播稿进行 best-effort 方案。
- **需要逐字字幕**：使用 HyperFrames `embedded-captions` 或 `npx -y hyperframes transcribe`；中文本地转写明确提示模型下载和耗时。
- **需要动态标题、证据卡片、数字重点、画中画**：使用 HyperFrames `talking-head-recut`，先写 storyboard，再渲染。
- **需要从脚本生成动态图形/B-roll**：采用富媒体优先，先找真实工作台/项目证据和同片前后对比，再补动态流程与必要AI视觉；纯文字卡片只作标题、重点或转场，不能成为主要B-roll。
- **需要抖音、小红书、微博多版本**：从批准的主成片派生 9:16、1:1、原比例版本，保持同一事实、字幕和色彩基线。

详细映射见 `references/skill-map.md`。

## 标准流程

### 1. 盘点与策略

- 核对源文件、时长、分辨率、fps、音轨、当前口播稿和目标平台。
- 查看 `frames/` 中的关键帧；不足时按开头、切点前后、结尾补截图。
- 输出 3—8 句剪辑策略：保留什么、删除什么、字幕样式、是否加卡片、目标时长。
- 只生成新文件，不修改或删除原片。

### 2. 基础剪辑

遵守：

- 切点落在词边界或安静区；
- 每个音频切点加入约 30ms 淡入淡出，避免爆音；
- 不删除表达含义所需的自然停顿；
- 竖屏默认使用模糊背景 + 完整前景，不盲目裁脸；
- 音频目标约 `-16 LUFS`，真峰值不高于 `-1.5 dBTP`；
- 字幕最后烧录，避免被后续图形遮挡。

### 3. AI增强

- 从逐字稿中只挑 3—6 个真正需要视觉强化的节点。
- 卡片必须对应正在说的内容；落地帧与关键词时间对齐。
- 动态素材和 B-roll 不得改变事实，不得把计划包装成已完成。
- 需要外部素材时默认确认版权和公开边界；若当前任务明确启用 `rightsReviewMode=advisory`，版权依据只提示不阻塞，但仍必须保留创作者、链接、片段时间、用途、画面署名和逐条审核。
- 标注来源不等于授权。外部创作者素材必须记录创作者、作品、原链接、片段时长、用途、授权/引用依据和画面署名；未明确授权时只能为介绍、评论或说明原作品使用短且必要的片段。
- 外部视频只有在口播稿自然说明创作者、网页逐条批准且本地文件已附加后才能进入渲染；纯装饰性搬运不得批准。
- 付费素材或付费生成默认必须展示用途和预计费用并获得当次确认；若当前任务明确把图像生成设为预授权，则可不逐次询问，但不能自动批准素材、自动渲染或自动发布。

### 4. 输出与QA

主输出命名：

- `final.mp4`：网页基础剪辑；
- `final-ai.mp4`：语义或动态增强版；
- `variants/final-vertical.mp4`、`final-square.mp4`：平台派生版；
- `qa-report.json`：技术检查；
- `project.md`：本次策略、决策和待办。

至少验证：

```powershell
ffprobe -v error -show_streams -show_format -of json "<成片>"
ffmpeg -v error -i "<成片>" -f null -
```

确认 H.264、AAC、yuv420p、完整解码、时长合理、无明显黑帧/冻结、字幕未越界、切点无爆音。
同时检查 `media-manifest-vN.json`：审核是否完成、批准素材是否 `composited: true`、外部来源署名是否渲染、稿件是否披露创作者；任一失败不得最终审核。

## 隐私与费用门禁

- 本地 FFmpeg、ffprobe、HyperFrames 本地渲染可直接运行。
- 上传原视频、音频、照片或字幕到 ElevenLabs、HeyGen、Hedra、OpenAI 或其他云服务前，必须说明目标服务、文件、用途和费用，并获得当前任务的明确确认。
- 不把 API Key、Cookie、令牌写入项目或提交 Git。
- 不自动发布，不替用户上传平台。
