# 30天AI实践成长账号工作流

本项目用于运营一个真实、连续、可验证的个人成长账号：

> **一个普通人从零学习AI、使用AI完成真实项目，每天公开进度、结果和踩坑。**

热点不再是账号主线，只用于发现问题、包装真实进展、选择相关AI功能亲测，以及辅助标题、封面和互动问题。

## 第一阶段目标

先完成一个可验收的 **30天AI实践成长计划**，而不是直接承诺无限日更。

初始内容比例：

- 真实AI成长日志：45%；
- AI工具和真实项目实验：30%；
- AI热点亲测和普通人解读：15%；
- 个人成长反思和真实粉丝共创：10%。

固定栏目：

1. 《普通人学AI第X天》
2. 《今天被AI坑了一次》
3. 《我用AI做了个真东西》
4. 《这个AI热点我亲手试了》
5. 《AI学习周报》
6. 《粉丝问题我来实测》——只有收到真实问题时启用

## 当前状态

- 旧定位Day 1热点试运行资料完整保留在 `runs/2026-07-15/` 根目录，并标记为**旧定位基线样本**。
- 新定位样例保存在 `runs/2026-07-15/growth/`。
- 热点来源矩阵、事实核验、风险检查和采集原始数据继续保留。
- **不自动发布、不自动评论、不上传私人资料。**
- 暂不配置定时发布；先由用户审核新成长型样例。

## 每日运行顺序

```powershell
# 1. 创建当天成长记录目录；不会覆盖已有文件
powershell -ExecutionPolicy Bypass -File .\scripts\new_daily_run.ps1

# 2. 先填写 runs\YYYY-MM-DD\growth\00_daily_progress.md
#    只记录当天真实Codex任务、产物、错误、证据和昨天挑战的结果

# 3. 可选：采集与当前学习路线相关的AI热点
powershell -ExecutionPolicy Bypass -File .\scripts\collect_hotspots.ps1

# 4. 填写候选和素材包
#    growth\01_candidates.md
#    growth\02_main_package.md

# 5. 完整结构校验
powershell -ExecutionPolicy Bypass -File .\scripts\validate_daily_package.ps1
```

## 目录

- `docs/CREATOR_PROFILE.md`：创作者档案、账号承诺和公开边界。
- `docs/30_DAY_AI_GROWTH_ROADMAP.md`：30天实践路线。
- `docs/WORKFLOW.md`：成长优先的每日生产流程。
- `docs/SOURCE_MATRIX.md`：真实进展证据与热点辅助来源矩阵。
- `templates/daily_progress.md`：每日真实进展记录模板。
- `templates/daily_research.md`：最多5个候选方向模板。
- `templates/daily_content_package.md`：16项成长型素材包模板。
- `templates/weekly_review.md`：个人学习和账号内容双重复盘。
- `data/content_ledger.xlsx`：成长台账、路线、评分、双重复盘和旧定位基线。
- `runs/YYYY-MM-DD/growth/`：当天成长型内容资料。
- `runs/YYYY-MM-DD/raw/`：热点和工具原始采集资料。

## 每条视频的硬门槛

必须同时具备：

1. 真实进展或真实实验；
2. 具体变化、冲突、成功或失败；
3. 至少一个可公开展示的结果；
4. 一条普通观众能带走的经验；
5. 与30天成长主线的连续关系；
6. 明天继续验证的挑战。

如果证据不足、涉及私人资料或只有“今天学了什么”，当天可以不产出主选题，不得编造补齐。

## 网页工作台（推荐使用）

不需要运行脚本。直接双击项目根目录的 `打开口播工作台.html`，即可在网页中查看当前要拍的内容、使用提词器、复制文案、选择标题封面、填写审核意见和查看30天路线。

网页审核结果只保存在本地浏览器，不会自动发布或上传。以后Codex生成新口播时会同步更新网页内容数据。

## 拍完后的AI剪辑

口播拍摄完成后，推荐双击：

`F:\code\koubo\打开AI口播工作台.vbs`

它会静默启动本地剪辑服务并打开网页，不需要在终端运行脚本。进入左侧“拍完AI剪辑”后：

1. 选择拍好的 MP4/MOV/WebM；
2. 选择 9:16、原比例或 1:1；
3. 本地分析长停顿和素材规格；
4. 确认后生成 H.264/AAC 成片；
5. 下载成片，或复制高级 AI 剪辑指令交给 Codex 继续做错句检查、动态图卡和多版本包装。

默认能力：

- 自动删除长停顿并保留自然呼吸；
- 切点加入短音频淡化，避免爆音；
- 使用当前口播稿生成字幕；
- 音频响度标准化；
- 竖屏使用模糊背景和完整前景，避免直接裁脸；
- 生成 `edit-plan.json`、技术 QA 和本地任务目录；
- 原片不覆盖，视频默认不上传网络。

项目 Skill：`.agents/skills/koubo-ai-video-editor/`。它吸收 HyperFrames、Video Use、Promotion、Generative Media、Video Cut 和 AI Video Workflow 的可复用原则。HyperFrames 本地能力已安装；Video Use 已安装但高级语义转写仍需用户自行配置 ElevenLabs API Key，密钥不得写入本仓库。
