# Koubo 受控多 Agent 视频工作流

## 当前定位

`controlled-multi-agent-v1` 创意提案管线是 Visual Director v4 旁边的可关闭影子实验，不是新的默认生产管线。2026-07-24 增加的 Content Strategist 与 Ordinary Viewer Critic 使用独立的内容顾问开关，默认可用而无需打开 Caption/Motion/Sound 实验。两个角色已经完成本地合同、真实模型与工作台的有界运行验收，但这不授予生产批准或发布权限；16 条来源原则仍待用户逐项审核。

- v4 继续拥有任务状态、阶段门、超时、重试、渲染、版本、最终批准和发布边界。
- 内容方向默认由用户提供并锁定；只有用户明确允许 Agent 帮助找题时，才进入 Agent 选题路径。
- Content Strategist 只访谈和分析方向；用户确认前不能进入 Script Agent / 现有稿件生成器。
- Ordinary Viewer Critic 在稿件和成片两个阶段做独立建议性评审，不修改稿件、job、批准状态或发布状态。
- Caption、Motion、Sound 只提案；Director 只组合；Blind Critic 和 Retention Critic 只评审。
- Agent 不能批准成片、发布、修改品牌骨架或晋升记忆。
- 新能力失败或关闭时，v4 可独立运行。
- 当前真实媒体验收未批准扩大到生产，原因见
  `docs/acceptance/multi-agent-v1-acceptance.md`。

## 架构

```text
用户提供并锁定内容方向
  ↓
Content Strategist（只分析，不写稿、不换题）
  ↓
用户确认门（human actor + 方向哈希 + 完整证据）
  ↓
Script Agent / 现有稿件生成器
  ↓
Ordinary Viewer Critic：稿件评审（匿名、只读）
  ↓
Visual Director v4（生产总控）
  ├─ 冻结输入、逐字稿、已批准素材、QA 与审核门
  ├─ Caption Agent ─ caption.private
  ├─ Motion Agent  ─ motion.private
  ├─ Sound Agent   ─ sound.private
  └─ Director      ─ 最多组合两个结构候选
  ↓
真实渲染候选
  ├─ Ordinary Viewer Critic：成片评审（匿名、只读）
  ├─ Blind Critic：匿名候选质量与反对意见
  └─ Retention Critic：时间码、观看理由、疲劳与必要停顿
  ↓
技术 QA → 用户最终审核

SQLite（权威索引和状态）
  ↕ 原子导出
JSON（审阅、迁移、Git diff）
  ↕
本地资产目录（复刻工程、截图、短样片和 QA）
```

当前合同面包含 8 个角色档案：Caption、Motion、Sound、Director、Blind Critic、Retention Critic、Content Strategist、Ordinary Viewer Critic。仓库共有 9 个版本化 schema；新增的第 9 个是 `content-principle.schema.json`。Script Agent / 现有稿件生成器是既有内容生成阶段，不计入这 8 个多 Agent 角色档案。

## 内容方向门禁

默认路径是“用户方向优先”，不是让 Agent 从上一条内容自行推导下一条主题：

```text
POST /api/multi-agent/content-strategy/analyze
→ 生成独立 analysis artifact
→ POST /api/multi-agent/content-strategy/confirm
→ 生成仅 human actor 可确认或拒绝的 confirmation artifact
→ 成稿请求提交 strategyConfirmationArtifactId
→ 服务端重新读取 confirmation 及其绑定的 analysis artifact
→ scriptHandoffAllowed=true 后才可进入成稿
```

进入成稿必须同时满足：

- `lockedDirection`、方向 SHA-256、confirmation artifact 和其绑定的 analysis artifact 相互一致；
- Content Strategist 原样保留用户锁定方向；
- 分析状态为 `ready_for_script`；
- 至少有一条真实可追溯证据，且没有未解决的证据缺口；
- 用户明确确认分析与方向；
- confirmation 的 `approvedDirection` 与服务端 analysis 一致；服务端再为权威策略链计算 `contentHash`。

Content Strategist 无权输出完整口播稿、标题、钩子、镜头或剪辑方案，也无权换题、修改 content/job、批准生产、批准发布或晋升记忆。客户端内嵌的 `strategyArtifact` 会被拒绝，不能伪造已确认策略。只有显式设置 `allowAgentTopicSearch=true` 才允许 Agent 帮助找题；该路径不能同时提交用户锁定方向或 `strategyConfirmationArtifactId`。

## 候选内容原则治理

`config/multi-agent/content-principles.json` 当前含 16 条原则，全部仍为 `candidate_awaiting_user_review`：

- 候选原则只能作为分析镜头，Content Strategist 会将其标为 `advisory_candidate_only`；
- `candidateIsNotProductionPolicy=true`，不会因进入配置文件就自动成为生产规则；
- 禁止复制来源视频的原句、标题、案例、人设、镜头、字幕样式或视频形式；
- 用户未逐项接受前，不得改写品牌骨架、批准内容、发布或晋升长期记忆；
- 接受、拒绝或废止必须保留来源、时间码、适用条件、反例和状态。

来源蒸馏与当前追溯边界见 `docs/research/2026-07-24-reference-creator-content-distillation.md` 和 `docs/acceptance/multi-agent-content-advisory-completion-audit.md`。

## 评审职责与媒体观察边界

三个内容评审角色不得互相代替。下表区分角色目标与当前代码已经硬校验的边界：

| 角色 | 角色目标 | 当前硬合同与明确排除 |
| --- | --- | --- |
| Ordinary Viewer Critic | 普通观众相关性、理解成本、可信度、证据缺口、当天可执行性 | 最多 3 个 blocker；稿件引用或成片时间码；禁止技术 QA、留存字段、节奏/动效密度、排名、选优、换题和整篇重写 |
| Blind Critic | 匿名候选质量、反对意见和量表评审 | 硬保证隐藏作者、Agent、理由、提示词和顺序；当前并未强制 `scores` 的完整维度或非空结构；不得批准、发布或修改候选 |
| Retention Critic | 继续观看理由、信息疲劳、前段/中段风险和必要停顿 | 当前硬保证时间码、观看理由，并禁止“每秒必须加效果”；疲劳、前中段风险和必要停顿属于角色目标，尚不是每次输出都必填的独立字段 |

Ordinary Viewer Critic 有两个评审阶段，均使用权威服务端内容和匿名候选标识。稿件审查已经自动接入新内容生成；v4 全片和旧 FFmpeg 两条最终渲染路径也会自动创建绑定当前输出版本的成片点评，job 路由仍可按需重跑并生成新的 create-only artifact：

1. 稿件阶段读取服务端权威方向记录、事实表和权威稿件，不读取 Script Agent 的自我解释；提供并校验 confirmation artifact 时，该方向才有明确的人类批准证据。
2. 成片阶段读取权威 job、转录、媒体元数据和可选的已审核帧证据，不读取作者、Agent 名称、Director 理由或客户端伪造的候选内容；同样只有绑定 confirmation artifact 时才保证方向已经由人确认。

必须在 artifact 中记录下列 inspection mode：

| inspection mode | 实际可见证据 | 允许的结论边界 |
| --- | --- | --- |
| `script_text` | 服务端权威方向记录、事实表、稿件文字 | 只能引用原稿句子评审理解、相关性、可信度和行动性；是否有人类批准取决于是否绑定 confirmation artifact |
| `transcript_and_metadata_only` | 转录、时长、尺寸和事实表 | 规则上不得声称看见画面、字幕、截图、构图或听见声音、音效、语气 |
| `sampled_frames_and_transcript` | 上述内容，加服务端已审核且带时间范围的帧观察记录 | 只能引用这些已审核帧观察和对应时间码；不得声称完整观看或听过整条视频 |

媒体附件只使用 `media://` / `artifact://` 不透明引用；本地绝对路径和原媒体不会写入模型请求。没有帧证据时必须自动降级为 `transcript_and_metadata_only`。验证器已覆盖常见视觉断言以及“听见、听到、声音、音频、音效、音量、背景音乐、BGM、噪声、语气、盖过人声”等听觉断言。真实 v5 成片已在无帧、无音频证据模式完成一次点评；结论只讨论转录措辞、证据、观众价值和可执行性，没有声称完整观看或收听。

## 固定依赖

| 组件 | 固定版本 | 用途 | 许可证 | 退出方案 |
| --- | ---: | --- | --- | --- |
| OpenAI Agents SDK | 0.18.3 | Python Agent 运行边界 | MIT | 回退现有 v4 / 直接调用兼容模型 |
| PySceneDetect | 0.7.1 | 本地镜头检测 | BSD-3-Clause | FFmpeg scene filter |
| HyperFrames | 0.7.70 | 技法隔离复刻与短样片 | Apache-2.0 | FFmpeg/ASS、Remotion 与现有 v4；具体镜头由 Director 按证据选择 |
| Promptfoo | 0.120.0 | 离线提示词/结构回归 | MIT | Node 测试与固定夹具 |
| SQLite | Node 22 内置 | 权威本地状态和事件 | Public Domain | JSON 导出后迁移 |

版本、维护状态、兼容性、安全和候选取舍记录在
`docs/research/2026-07-23-koubo-multi-agent-open-source-landscape.md`。
Python 顶层固定依赖在仓库根目录 `requirements-multi-agent.lock.txt`，完整解析环境记录在 `requirements-multi-agent.resolved.txt`；隔离运行时位于未提交的 `.runtime-multi-agent/`。

## 启动与关闭

默认启动状态是：内容顾问层开启，创意多 Agent 提案/记忆写操作关闭，v4 仍为默认渲染管线。

```powershell
node video/server.mjs
```

显式配置默认内容顾问层：

```powershell
$env:KOUBO_CONTENT_ADVISORY_ENABLED = "1"
$env:KOUBO_MULTI_AGENT_ENABLED = "0"
$env:KOUBO_AGENT_TRACING_ENABLED = "0"
node video/server.mjs
```

显式开启完整本地影子实验：

```powershell
$env:KOUBO_CONTENT_ADVISORY_ENABLED = "1"
$env:KOUBO_MULTI_AGENT_ENABLED = "1"
$env:KOUBO_MULTI_AGENT_DATA_ROOT = "data/multi-agent"
node video/server.mjs
```

将 `KOUBO_MULTI_AGENT_ENABLED=0` 只会关闭 Caption/Motion/Sound、教程、记忆和 A/B 等创意实验路由；Content Strategist 与 Ordinary Viewer Critic 仍可工作。若要同时关闭内容顾问层，设置 `KOUBO_CONTENT_ADVISORY_ENABLED=0` 并重启。关闭不会删除记忆或历史产物。

可选的教程允许目录使用 Windows 路径分隔符连接：

```powershell
$env:KOUBO_TUTORIAL_ROOTS = "F:\approved-tutorials;D:\self-created-lessons"
```

## 教程：从视频到候选记忆

教程必须是本人所有、明确授权或许可可用的本地文件。摄取不会复制原视频。

```powershell
$env:KOUBO_MULTI_AGENT_DATA_ROOT = "data/multi-agent"
$env:KOUBO_MULTI_AGENT_PYTHON = ".runtime-multi-agent\Scripts\python.exe"

node scripts/ingest_tutorial.mjs `
  --input "F:\approved-tutorials\lesson.mp4" `
  --author "作者或来源" `
  --license "self-created" `
  --resume
```

输出检查点后，在隔离环境复刻：

```powershell
node scripts/recreate_tutorial_techniques.mjs `
  --checkpoint "data\multi-agent\runtime\tutorial-ingest\checkpoints\<source-hash>.json" `
  --output ".cache\technique-reconstructions" `
  --data-root "data\multi-agent"
```

摄取链：

```text
来源哈希登记
→ PySceneDetect
→ 本地 sidecar / faster-whisper
→ 带时间码的技巧候选
→ inbox
→ 抽象复刻（不执行教程代码）
→ HyperFrames strict check / render
→ FFmpeg 技术 QA
→ recreated
```

允许的复刻 primitive 只有经过审计的八种：`caption-pop`、`keyword-emphasis`、`pause-aware-follow-caption`、`element-slide`、`element-bounce`、`semantic-layout-router`、`sfx-cue`、`voice-pause`。其中两个专项 Motion primitive 必须使用各自的 proof verifier，通用复刻入口不会为它们写入 `recreated` transition；教程工程文件、字体、音效和代码不会被直接复制。

## 记忆治理

状态机：

```text
inbox → extracted → recreated → trial → approved → promoted
                    ↘ rejected / expired / disabled
```

关键约束：

- 自动提取只能进入 `inbox`。
- `trial` 前必须有复刻与媒体 QA。
- `approved` 必须有真实的人类审批证据。
- `promoted` 必须有两个不同项目的已批准试用记录。
- Agent 默认只读取 `approved` 和 `promoted`。
- `brand.core` 在 v1 完全不支持写入。
- 每次写入必须提交当前 `contentHash` 作为 `expectedHash`。
- 失败记录保留为负面记忆，不做静默删除。

本地 API 示例：

```text
GET  /api/multi-agent/memory
POST /api/multi-agent/memory/:kind/:id/extract
POST /api/multi-agent/memory/:kind/:id/recreate
POST /api/multi-agent/memory/:kind/:id/trial
POST /api/multi-agent/memory/:kind/:id/approve
POST /api/multi-agent/memory/:kind/:id/promote
POST /api/multi-agent/memory/:kind/:id/reject
POST /api/multi-agent/memory/:kind/:id/expire
POST /api/multi-agent/memory/:kind/:id/disable
POST /api/multi-agent/memory/:kind/:id/rollback
```

所有 POST 都要求 `Idempotency-Key`。人工批准/晋级还要求 `actor.type=human` 和完整证据。

## 提案、组合和评审

打开一个现有 job 后：

```text
POST /api/contents/:id/multi-agent/ordinary-review
POST /api/jobs/:id/multi-agent/ordinary-review
POST /api/jobs/:id/multi-agent/proposals
POST /api/jobs/:id/multi-agent/ab
POST /api/jobs/:id/multi-agent/reviews
```

两个 Ordinary Viewer 路由只读取服务端权威 content/job；客户端不得提交稿件、转录、媒体、事实表、帧证据、批准方向或评审结果来替换权威输入。所有新写路由都要求 `Idempotency-Key`，评审 artifact 独立保存且不回写生产状态。

提案接口：

- 只读取 job 的逐字稿、当前计划和已批准素材元数据。
- 每个专家只拿到自己的 role input 和命名空间。
- 每个专家最多两个提案，超时重试一次。
- 引用不存在或哈希不匹配时，逐项回退 v4。
- Director 最多输出两个结构差异候选，不能带批准、发布或记忆晋升字段。

匿名评审：

- 必须有真实渲染的 SHA-256 `renderHash`。
- 隐藏候选 ID、作者、Agent、理由、提示词和提案顺序。
- Blind Critic 与 Retention Critic 都必须返回时间码。
- Retention Critic 不得执行“每秒一个效果”规则，并可标记必要停顿。

## 基线与验收

冻结样本：

```powershell
$env:KOUBO_VIDEO_JOBS_ROOT = "F:\code\koubo\video-jobs"
node --test tests/baseline/*.test.mjs
```

生成本地验收材料：

```powershell
node scripts/run_multi_agent_acceptance.mjs `
  --jobs-root "F:\code\koubo\video-jobs" `
  --run-id "YYYYMMDD-run"
```

验收器会：

1. 重算冻结清单哈希；
2. 运行合法教程摄取、复刻、试用、夹具审批、晋级、回滚和恢复；
3. 为每个冻结样本生成一个控制轨和两个结构候选；
4. 控制轨使用冻结完成成片，挑战轨从同一冻结 job 的原始母版和时间线零点重渲染；
5. 执行解码、时长、H.264/AAC、BT.709、响度、黑帧、冻结回归、实际字体宽度和覆盖几何检查；
6. 生成联络表、匿名媒体、Critic 记录和版本清单；
7. 只在媒体与人工视觉门都通过后进入最终主观盲审。

`.cache/multi-agent-acceptance/` 是本地忽略目录，不进入 Git。已完成的 run 不会被覆盖。

上面的运行用于技术基线、记忆闭环与渲染门。主观风格结论必须另行使用真实口播材料：

```powershell
node scripts/run_multi_agent_subjective_review.mjs `
  --jobs-root "F:\code\koubo\video-jobs" `
  --run-id "YYYYMMDD-real-subjective"
```

主观审核规则：

1. 只接受真实口播，不用合成 fixture 判断账号风格；
2. 每组写明一个审核重点和一个核心问题；
3. 允许选择“全组不合格”，不得强迫选出相对优胜者；
4. 至少给出一个分类原因或具体例子；
5. 字幕逐字准确性单独验收，不得把它伪装成已自动证明；
6. 匿名映射留在服务目录之外；
7. 主观结果不会自动发布或晋升长期记忆。

`.cache/multi-agent-subjective-review/` 同样是本地忽略目录，已完成的 run 不会被覆盖。

审核页用本地受控服务打开，避免要求用户手工传递 JSON：

```powershell
node scripts/serve_multi_agent_subjective_review.mjs `
  --run-root ".cache/multi-agent-subjective-review/YYYYMMDD-real-subjective" `
  --port 8766
```

服务只绑定 loopback，支持视频 Range 请求，只暴露 `review/` 下的页面和匿名媒体。`blind-map-private.json`、manifest 和最终记录不通过静态路由公开。`POST /api/subjective-review` 只记录一次经过校验的人类结果；不会批准生产、发布视频或晋升记忆。离线下载的审核 JSON 可用 `scripts/record_multi_agent_subjective_review.mjs` 导入，仍执行相同校验和不可覆盖门。

## 迁移、回滚和恢复

迁移文件位于 `video/multi-agent/migrations/`：

- 按序执行；
- 校验文件 SHA-256；
- 已应用迁移不可静默修改；
- v1 没有删除列、删除表或不可逆数据变换。

记忆回滚只允许最近且未被后续变更覆盖的 transition。回滚会恢复旧 JSON 与旧 `contentHash`，并追加 `memory_transition_rolled_back` 事件。

恢复顺序：

1. 关闭多 Agent 开关，继续使用 v4；
2. 检查 `events` 和 `transitions`；
3. 回滚最近 transition；
4. 从 `data/multi-agent/library/` 的 JSON 导出核对；
5. 必要时使用新数据库导入 JSON，不覆盖旧数据库。

不要删除 `memory.sqlite`、历史 JSON、原片或旧 job。

## 隐私和安全

- 服务只绑定 `127.0.0.1`。
- 多 Agent API 拒绝非 loopback 请求。
- 原视频不发给文本模型；确定性媒体处理保持本地。
- API 和导出会剔除 token、API key、Cookie、密码、私钥、raw media 等字段。
- Strategist 模型请求不携带本地 `locator/source`；Ordinary Viewer 的全部模型字段拒绝或脱敏绝对路径，server 事实表也会移除本地路径。
- OpenAI Agents SDK tracing 默认关闭；只有显式设置 `KOUBO_AGENT_TRACING_ENABLED=1` 才会开启。模型完成任务所需的正常请求不受该开关影响。
- 没有自动发布路由；真实任务最终批准仍由 v4 门控制。

## 当前生产决策

截至 2026-07-24：

- 数据层、记忆闭环、教程复刻、角色隔离、A/B、双 Critic、回滚和工作台影子模式均已实现并验证。
- 第一评测周期的编码技术门通过，但人工联络表发现候选字幕重复和证据卡长句溢出；该周期已按两轮上限封存。
- 第二评测周期 `20260723-cycle2-v1b` 已从冻结原始母版重渲染挑战轨，并加入实际字体测量、自动换行、动态卡片高度和几何门。
- 第二周期 9/9 技术门、6/6 挑战轨布局门及 6/6 Codex 人工视觉预检通过。
- 用户观看第二周期材料后指出九个候选均有不足，而且审核对象不清；由于其中两组是合成 fixture 且页面强制选优，第二周期只保留为技术证据，不形成主观风格结论。
- 新运行 `20260723-real-subjective-v1` 使用同一条真实口播的 S01、S04、S09 三个语义窗口，页面按钩子、方法解释和品牌可信度分别提问，并允许全组拒绝。
- 新运行 9/9 技术门、3/3 接触表预检和 9/9 浏览器媒体加载通过；用户最终将三组全部判为不合格，原因是两个挑战轨缺少足够可感知的动效且字幕不是实时跟随。
- 解盲和代码复核确认：挑战轨来自固定 FFmpeg 验收配方，没有以 v4 等价完成度渲染 Director 的实际提案；这解释了自动结构差异通过但人工质量门失败。
- 主观拒绝已作为本地 `production-event` 写入领域库，不触发生产批准、发布、记忆晋升或品牌骨架修改。
- 遵守两轮迭代上限，不再进行第三轮风格粉饰；`controlled-multi-agent-v1` 创意渲染不批准扩大，v4 继续作为默认和回退。已验证的摄取、记忆、提案、Critic、评测和工作台影子基础设施保留。
- Content Strategist、Ordinary Viewer Critic、16 条候选内容原则、方向确认 artifact 和两阶段评审合同已加入当前本地实现；它们扩大了内容决策前后的审计能力，但没有改变 v4 的批准、发布或回退权限。
- 16 条原则仍待用户逐项审核；当前 4/6/6 的来源分布、三个原始 URL、访问时间、媒体冻结时间和完整转录 SHA-256 均已记录。
- 角色级开源复用审计已完成：继续直接复用固定版本 OpenAI Agents SDK，以窄 Python JSON bridge 适配，与 Node 总控组合；只最小自建 Koubo 特有的方向、证据和点评权限合同。
- 真实工作台已经完成一次方向分析：结果为 `needs_evidence`、3 个追问、6 个证据缺口，确认与写稿按钮保持关闭，证明 Agent 没有为了跑通流程而放宽证据门。
- 真实 Day 2 稿件点评返回“证据不足”和 2 个阻断点；真实 v5 成片在 `transcript_and_metadata_only` 模式返回“证据不足”和 3 个时间码阻断点。两次点评前后 content/job 的审核状态、批准、发布和输出版本均未变化。
- 成片点评 artifact 绑定 `output.version=5`、媒体 SHA-256 `1b3f12ec...f7d39` 和转录 SHA-256 `e5d76033...ce9b`；返修后旧点评不会被视为当前版本点评。
- 尚未完成的主观门只有：用户逐项审核 16 条候选原则，以及在未来真实方向证据补齐后亲自确认进入写稿。没有审核帧或审核音频时，Ordinary Viewer 仍不能评价完整画面或声音。

技术第二周期报告：`docs/acceptance/multi-agent-v2-blind-review.md`。

当前真实口播主观审核报告：`docs/acceptance/multi-agent-real-subjective-v1.md`。

15 条完成标准的最终逐项审计：
`docs/acceptance/multi-agent-completion-audit.md`。本轮以负向生产决策收口，不声称多 Agent 成片质量获得提升。

内容顾问层的独立完成审计：
`docs/acceptance/multi-agent-content-advisory-completion-audit.md`。该审计将“有界顾问运行已验收”与“用户候选原则审核、最终生产批准仍未发生”分开记录。
