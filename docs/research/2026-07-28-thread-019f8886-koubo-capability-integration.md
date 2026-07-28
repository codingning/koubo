# 会话 019f8886：Koubo 能力、Skills 与架构整合表

> 基线：`codex/koubo-multi-agent-research@6a29b98`
> 实施分支：`codex/koubo-universal-platform`
> 原则：Koubo 保持唯一总控和唯一权威状态源；外部项目只作为窄适配器、规则或镜头资产来源，不引入第二套编排系统。

## 总结

原 Koubo 已经具备内容策略、参考研究、本地 Whisper、保守语义粗剪、Visual Director v4、素材审核、三道人工门、版本化证据和多画幅交付。最高价值增量不是再建一套剪辑主链，而是补齐安全与可重建性、可编辑 NLE 交付、证据化拉片、真实 UI 镜头和更稳的素材锚点。

本分支按用户确认的边界实施：P0/P1 为真实可用实现；P2 为受控生产能力；P3 只提供可插拔接口且默认关闭。

## 能力与当前 Koubo 对比

| 优先级 | 能力 / 来源 | 作用 | 原 Koubo 基线 | 优点 | 缺点 / 风险 | 本分支结果 |
|---|---|---|---|---|---|---|
| P0 | 可重建运行时锁 | 固定 Node、Python、Python 包、HyperFrames、FFmpeg 版本与哈希 | 当前机器可运行，但换机重建弱；文档与实际版本存在漂移 | 降低换机、升级和上游变化导致的结果漂移 | 需要维护锁文件和升级验证 | 已接入 `config/runtime-lock.json`、隔离运行时、安装脚本和漂移检查 |
| P0 | Trusted-Origin + 写会话令牌 | 阻止恶意网页跨域调用本地写接口 | 仅监听回环地址，但原基线 CORS 过宽且写接口无会话认证 | 明显降低本机素材和任务被越权操作的风险 | 进程重启后令牌变化；未来 SaaS 仍需正式身份系统 | 已接入可信 Origin、随机进程令牌和 HTTP 回归测试 |
| P0 | 工作区隔离 | 让不同用户/团队的稿件、任务和静态产物逻辑隔离 | 原基线以单用户本地目录为主 | 为未来多用户架构保留迁移路径 | 目前仍是本地逻辑工作区，不等于公网多租户 | API、列表、静态产物、草稿和内容配置均按 `workspaceId` 失败关闭 |
| P0 | Skill / README / runtime 漂移检查 | 保证 Agent 路由和真实生产链一致 | 项目 Skill 仍偏向 `video-use + ElevenLabs`，实际主链已是本地 Whisper + v4 | 防止后续任务误上传媒体或走旧链路 | 关键声明变化时需同步维护检查 | Skill 已改成本地 Whisper + v4，运行时验证脚本会检查关键路由 |
| P1 | TouGe Spoken Cut 的剪映导出模式 | 从已批准时间线生成可继续手工编辑的剪映草稿 | 只有 MP4、Timeline JSON 和 CMX EDL，没有可编辑剪映工程 | 非技术用户可在熟悉的 NLE 中继续拖动、恢复和精修 | 剪映格式兼容脆弱；仍需真实应用打开验收 | 采用 `pyJianYingDraft==0.3.0` 的窄适配器；只读批准时间线，新建草稿，不覆盖旧草稿；逐段核对源入点、源时长、淡化和路径 |
| P1 | video-distillation / TouGe Storyboard 的证据化拉片合同 | 把参考内容转成带证据、边界和不确定性的结构化输入 | 已有完整转录和研究摘要，但缺统一拉片 artifact | 内容、脚本和 Director 可共享同一证据层 | 自动分析不能证明因果；缺失媒体时必须保留不确定性 | 已接入 `reference-distillation-v1.json`，权威 JSON 派生 Markdown，不反向写状态 |
| P1 | naive-video-skill 的 `exact / semantic / hybrid` 锚点 | 剪辑变化后按语义段重定位 B-roll、录屏和证据 | 原基线主要使用绝对 `placement.start/end` | 降低返修时整条时间线重排成本 | 依赖稳定 `segmentId`，冲突仍需人工校正 | 已接入三类锚点的规范化与重定位模块及测试 |
| P1 | video-shotcraft 的 PageCam 思路 | 捕获真实网页全页、元素切片和布局数据，生成可信 UI 镜头 | 可使用证据素材，但没有稳定的页面捕获资产层 | 避免伪造产品 UI，适合教程、产品和工具演示 | 页面改版会使选择器失效；只能捕获授权或本地页面 | 已用原生 Chrome DevTools 实现本地 PageCam，真实产出全页图、三张元素切片和 `layout.json` |
| P2 | Storyboard JSON / Markdown | 为人工审核和不同渲染器提供统一分镜视图 | 关键帧与 choreography 已有，但人类可读中间分镜不稳定 | 可 diff、可审查、可移交 | 若 Markdown 成为第二状态源会产生双写 | 已接入：JSON 为权威，Markdown 只读派生 |
| P2 | video-shotcraft 镜头卡注册表 | 将 PageCam、终端、流式回复、前后对比、图表变化等镜头映射到实现与 QA | Director 可选引擎，但缺统一可检索镜头合同 | Director 从抽象指令落到可执行实现 | 镜头库需要持续维护许可证、版本和预览 | 已接入首批 6 种受治理镜头；trial 镜头不能直接进入生产选择 |
| P2 | Sound Agent / video-shotcraft 动作 SFX | 为关键动作、证据出现和转场增加许可清晰的本地 SFX 与 ducking | 原基线以人声规范化为主，BGM/SFX 仍在影子层 | 增强节奏和动作反馈，且可保持视频码流不重编码 | 音频许可、遮蔽人声和响度更复杂 | 已接入本地 trial-gated 语义 SFX/ducking；默认不自动加 BGM |
| P2 | naive-video-skill 的 per-video retro | 把单期问题与长期规则分离 | 已有 trial/approved/promoted 知识治理，但单期复盘 artifact 不稳定 | 防止一次意见直接污染长期默认 | 自动总结仍不能自行晋升规则 | 已接入每期 JSON/Markdown 复盘；`autoPromote=false` |
| P2 | Remotion / HyperFrames / FFmpeg 按镜头选择 | 由 Director 根据镜头需要选择渲染器 | 原基线已以 HyperFrames 为主，也保留 FFmpeg 和隔离 Remotion 对照 | 各取所长，不强迫一种引擎处理所有镜头 | 多引擎带来字体、帧率、色彩、透明通道和同步 QA 成本 | 保留现有架构，不把 Remotion 固定为默认；镜头注册表记录 renderer 和 fallback |
| P3 | TouGe Collage | 在缺素材时生成拼贴式 B-roll | 已有素材候选、审核和哈希冻结，缺自动拼贴供应器 | 可补纯音频或缺画面段落 | 云端成本、隐私、生成真实性和风格漂移风险高 | 只登记插件接口，默认关闭，未接生产 |
| P3 | WhisperX | 强制对齐和说话人分离 | 单人口播已有 faster-whisper 词/句时间 | 多人访谈或现有对齐失败时有价值 | GPU、模型和运维成本较高；单人口播收益有限 | 只登记插件接口，默认关闭 |
| P3 | Manim | 数学、算法和技术概念动画 | 不属于通用口播默认剪辑能力 | 特定知识段落表达清晰 | 制作成本高、风格融合难、适用面窄 | 只登记按镜头调用接口，默认关闭 |
| 不接入 | TouGe 第二套 ASR/语义剪辑 | 重新转录并重新决定删留 | Koubo 已有本地 Whisper、`keepSegments` 和 v4 主链 | 可作为实现参考 | 会形成双时间轴、双决策源和额外模型成本 | 明确不接主链 |
| 不接入 | `video-use` 整包替换 | 通用视频对话编辑 | Koubo 大部分能力已覆盖，且隐私边界更严格 | 适合项目外临时通用视频任务 | 云端转录/服务依赖与本地媒体边界冲突 | 保留为外围工具，不替换 Koubo runtime |
| 不接入 | naive-video-skill / video-shotcraft / vibe-motion 整包 | 引入完整状态、渲染或特效体系 | Koubo 已有唯一 job、workflow、review 和版本状态 | Demo 和规则可供参考 | 会产生第二总控、双状态源、依赖与许可风险 | 只吸收窄合同、少量镜头和设计规则 |

## 架构结论

```text
通用方向 + 受众 + 目标 + 真实证据
  -> Content Strategist 与人工确认门
  -> 通用 Script Agent
  -> 本地 Whisper / 唯一 keepSegments 决策
  -> exact / semantic / hybrid 素材锚点
  -> Director 选择 HyperFrames / FFmpeg / 可选渲染器
  -> 关键帧 -> 动态样片 -> 全片 -> QA -> 人工批准
  -> 同一批准时间线
       |- MP4 与多画幅版本
       |- CMX 3600 EDL
       |- 剪映草稿
       |- Storyboard 与单期复盘
```

## No-Go

- 不允许第三方 Skill 成为第二总控或第二状态源。
- 不允许 exporter 修改批准状态、原时间线或覆盖已有草稿。
- 不为剪映导出重跑 ASR 或重新决定 `keepSegments`。
- 不把自动 QA、渲染成功、人工批准和发布授权合并为一个状态。
- 不默认上传真人媒体到云端服务。
- 不把来源标注等同于素材授权。
- P3 插件没有用户主动启用、许可和成本确认时不得运行。
