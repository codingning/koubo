# Koubo 多 Agent 与长期记忆开源方案调研

状态：第一轮完成

日期：2026-07-23

分支：`codex/koubo-multi-agent-research`

## 1. 结论

不建议现在用某个“多 Agent 视频编辑器”整体替换 koubo，也不建议先创建一批自由协作的 Agent。

更稳妥的路线是：

1. 保留 Visual Director v4 作为黄金基线和确定性控制器。
2. 只在“提案、评审、记忆检索”三个位置引入受约束的 Agent。
3. 优先复用成熟的编排、评测、转录、镜头检测和 HyperFrames 组件。
4. 剪辑技法、字幕、音效、动效、配音位置等长期资产仍采用 koubo 自己的领域模型和本地存储；通用 Agent 记忆框架只作为可替换的检索层，不拥有最终真相。
5. 先用 3—5 条真实口播做 A/B 试验。只有当多 Agent 在风格多样性、返修量、可解释性和稳定性上持续超过 v4，才扩大使用范围。

GitHub 上已经出现了多款 Agent 原生视频编辑器，但本轮发现的直接候选大多创建于 2026 年 4—7 月，提交数和发布历史仍短。它们适合借鉴 JSON 时间线、MCP 编辑接口、提案审批和 Reviewer 回路，不适合直接承担多年生产基线。

## 2. 调研边界与方法

本轮只读取 GitHub 官方仓库、README、许可证、Release 和仓库维护信息，没有安装、克隆或执行第三方项目。

评估维度：

- 与现有 Node 控制器、Python AI bridge、OpenAI 兼容接口、faster-whisper、FFmpeg、HyperFrames 的适配程度；
- 是否支持确定性流程、人工审核、失败恢复、结构化输出和可追溯记录；
- 是否能本地部署，是否会把逐字稿、视频或评测数据上传到第三方；
- 许可证是否允许未来长期使用和可能的产品化；
- 创建时间、提交数、发布数、维护状态与迁移风险；
- 能否退出：框架被替换后，记忆、素材、评测集和时间线是否仍可读取。

仓库数据为 2026-07-23 的观察快照。Star 只作为社区关注度参考，不等同于生产验证。

## 3. Koubo 当前不可丢失的边界

Visual Director v4 已经具备多 Agent 改造最重要的骨架：

- 状态机和人工审核门由本地 Node 控制器掌握；
- 原视频与音频在本地处理，文本模型只接收必要文字；
- faster-whisper 本地转录；
- HyperFrames 负责确定性画面与动效渲染；
- FFmpeg 负责合成和技术 QA；
- 关键帧、动态样片和全片分别审核；
- 所有版本保留，不自动发布；
- 旧 FFmpeg v3 路径仍可回退。

因此，开源方案必须作为可替换组件接入这套骨架，而不是反过来让框架接管发布、记忆晋升或渲染状态。

## 4. 编排框架

| 候选 | 官方证据与成熟度快照 | 与 koubo 的适配 | 决策 |
| --- | --- | --- | --- |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | MIT；约 28.1k Star、1,763 次提交、109 个 Release；官方提供 Agent、工具、handoff、guardrail 和 tracing；支持 OpenAI Responses、Chat Completions 和其他模型 | 轻量，适合放进现有 Python bridge；可以把字幕、动效、声音、评审做成有界工具或 Agent，同时继续由 Node 状态机控场 | **首选小规模技术验证**，不立即替换控制器 |
| [LangGraph](https://github.com/langchain-ai/langgraph) | MIT；约 37.9k Star、7,005 次提交、553 个 Release；主打长任务、持久执行、人工介入和状态记忆 | 恢复、检查点和人工中断很强，但与现有 v4 状态机能力重叠，接入复杂度更高 | **保留为第二候选**；只有现有状态恢复不足时再验证 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | MIT；约 12.3k Star、2,634 次提交、105 个 Release；支持顺序、并发、handoff、群组、checkpoint、OpenTelemetry 和 human-in-the-loop | 能力全面，但平台体量较大；对当前单机工作台可能过度设计 | **架构参考/后备方案** |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | MIT；约 18.7k Star；强调类型化输出、多模型、OTel、人工批准、持久执行和图 | 很适合结构化输出和 Python 数据模型；多 Agent 编排不是采用它的唯一理由 | **结构化 Agent 备选**，可与首选做一次窄对比 |
| [Microsoft AutoGen](https://github.com/microsoft/autogen) | README 明确说明进入 maintenance mode，并建议新项目采用 Microsoft Agent Framework | 不适合作为新基线 | **排除** |

### 编排层建议

第一轮只验证 OpenAI Agents SDK，不验证“群聊式自治团队”。建议把 Agent 限制为纯提案者：

- Caption Agent：返回字幕布局候选和理由；
- Motion Agent：返回动效 recipe ID、参数和适用时间段；
- Sound Agent：返回 SFX/BGM/静音策略；
- Retention Critic：逐秒检查注意力抓手；
- Blind Critic：只看样片，不读取其他 Agent 的理由；
- Director：汇总候选，但不能直接晋升记忆或发布。

Node 控制器继续掌握阶段转换、超时、重试、审核、渲染和回滚。模型输出必须通过既有或新增 JSON Schema。

## 5. 记忆与资产治理

用户需要的不是“Agent 记住聊天”，而是可验证的剪辑知识库：

- 技法卡：适用内容、禁用条件、输入要求、参数范围、来源与时间码；
- 字幕、动效、音效、配音位置等本地资产；
- 组合 recipe：哪些技法一起使用、在哪个节奏点使用；
- 证据：教程原片、逐字稿、关键帧、复刻样片、使用过的视频；
- 评测：人工选择、返修原因、平台表现和失败案例；
- 生命周期：候选、已验证、推荐、降级、过期、禁用；
- 负面记忆：什么做法曾经失败，为什么不能再自动采用。

| 候选 | 官方证据 | 价值 | 主要问题 | 决策 |
| --- | --- | --- | --- | --- |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0；约 61.5k Star；支持自托管、用户/会话/Agent 多级记忆以及语义、关键词、实体和时间检索 | 可借鉴检索和记忆提取；可本地部署 | 主要面向个性化对话记忆，自动提取容易把未经验证的剪辑偏好变成“事实” | **以后只试检索适配层**，不做权威库 |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0；约 29.1k Star；支持来源、关系和时间有效期；需要 Neo4j、FalkorDB 或 Neptune 等图数据库 | 很适合表达“技法—风格—内容—结果—时间”的关系和历史版本 | 初期运维和数据建模成本明显过高；本地轻量 Kuzu 后端已被标为 deprecated | **数据量和关系查询变复杂后再评估** |
| [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) | MIT；默认本地 SQLite + sqlite-vec；强调分层记忆、原始证据回溯和技能资产 | “分层 + 可追溯 + 本地 SQLite”的设计与 koubo 很接近 | 仓库创建于 2026-04，主要集成目标是 OpenClaw/Hermes，尚不是 koubo 的即插即用组件 | **重点借鉴 schema 与追溯设计，隔离验证** |
| [Agent File](https://github.com/letta-ai/agent-file) | Apache-2.0；可序列化系统提示、工具、模型设置和可编辑 memory blocks | 适合 Agent 配置快照、迁移和版本控制 | README 明确暂不支持 archival memory passages，不能承载大量技法与素材 | **可用于 Agent 配置导入导出，不作为长期资产库** |

### 记忆层建议

第一版不要引入向量数据库或图数据库。采用：

- SQLite：索引、状态、来源、适用条件、评测、版本和关系；
- JSON：可审阅、可 Git diff 的技法卡与 recipe；
- 本地文件目录：字幕模板、音效、动效、截图、短样片和教程证据；
- 内容哈希：去重并保证资产不可被悄悄替换；
- 明确的晋升状态机：`inbox → extracted → recreated → trial → approved → promoted`；
- 所有自动写入先进入 `inbox`，只有经过复刻或真实项目审核才进入推荐库；
- Agent 只读已晋升记忆；候选记忆必须显式请求，避免污染生产决策。

这能保留退出自由。未来接 Mem0 或 Graphiti 时，它们只索引上述权威数据，移除框架不会丢失知识。

## 6. 评测、可观测性与“是否真的进化”

| 候选 | 官方证据 | 适配 | 决策 |
| --- | --- | --- | --- |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | MIT；约 23.5k Star、9,255 次提交、419 个 Release；支持本地评测、模型横向比较、断言和 CI | 适合测试结构化提案、评审一致性、边界条件和模型升级回归；默认可本地运行 | **第一阶段首选** |
| [Langfuse](https://github.com/langfuse/langfuse) | 核心 MIT，`ee` 目录另有许可证；支持 tracing、数据集、实验、人工标注和自托管；本地部署依赖 Docker/ClickHouse 等 | 适合后续观察跨 Agent 调用、成本、时延、反馈和数据集演化 | **第二阶段自托管候选**；启用前关闭或审查遥测 |
| [Arize Phoenix](https://github.com/Arize-ai/phoenix) | 支持 OTel、tracing、版本化数据集和实验，可本地运行；根许可证为 Elastic License 2.0 | 功能很完整，与 OpenAI Agents SDK 有现成 instrumentation | **许可证受限的后备方案**；未来若对外提供托管服务需重新审查 |

评测必须同时包含：

1. 确定性 QA：解码、时长、响度、黑帧、冻结、安全区、遮脸、字幕同步；
2. 内容 QA：口播原意、事实准确、信息层级、节奏和平台规格；
3. 风格多样性：布局、节奏、字幕动画、音效、视觉类型的分布，防止只是换颜色；
4. 品牌一致性：是否仍然体现“从知道到做到”和 AI 实践证据；
5. 人工成本：每条视频的修改轮数、修改类型、审阅时间；
6. 盲评：评审者不知道哪个方案来自 v4 或多 Agent；
7. 发布后指标：前 3 秒留存、完播、互动和转化，但不把单条爆款直接晋升为长期规则。

多 Agent 的验收标准不是“方案更多”，而是：

- 至少在同一输入上稳定生成有意义的不同方案；
- 最终选择比 v4 基线更好，或以相近质量显著减少返修；
- 失败可定位到某个 Agent、记忆条目或 recipe；
- 同一版本可复现，旧版本可回滚；
- 新经验经过证据与审核才改变下一次决策。

## 7. 视频理解、字幕和动效组件

| 候选 | 证据与适用点 | 决策 |
| --- | --- | --- |
| [HyperFrames](https://github.com/heygen-com/hyperframes) | Apache-2.0；约 36.9k Star、3,082 次提交、308 个 Release；本地、确定性 HTML/CSS/动画转 MP4；包含字幕、动效、媒体账本和 Agent Skills | **继续作为主渲染内核** |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | BSD-3-Clause；2014 年创建；提供镜头切分、关键帧保存、Windows 包、算法 benchmark | **优先用于教程摄取和参考视频分镜** |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | MIT；现有 v4 已使用；本地、速度快、资源占用低 | **继续使用** |
| [WhisperX](https://github.com/m-bain/whisperX) | BSD-2-Clause；提供强制对齐和更精细词级时间戳 | **仅在字幕同步误差成为真实瓶颈时验证**；Windows/CUDA 依赖更重，部分符号词无法对齐，README 标注 ASS 输出尚未恢复 |
| [FableCut](https://github.com/ronak-create/FableCut) | MIT；浏览器时间线由单一 `project.json` 驱动，支持 MCP/REST、热更新、关键帧、动效字幕和 FFmpeg 导出；创建于 2026-07-06，约 78 次提交、5 个 Release | **最值得研究的编辑接口参考**；先读取 schema/架构，不能直接替换生产渲染 |
| [OpenChatCut](https://github.com/0xsline/OpenChatCut) | 本地项目、多轨时间线、MCP、提案式编辑、逐字稿和 Remotion；创建于 2026-07-15，约 49 次提交、4 个 Release；AGPL-3.0 | **隔离参考**；许可证和成熟度未过生产门 |
| [Pireel](https://github.com/pireel/pireel) | 浏览器本地 talking-head、动态图形、动效字幕、WebCodecs 和 MCP；AGPL-3.0；创建于 2026-07-20，仅约 3 次提交、无 Release | **只作产品交互参考** |
| [Agentic Video Editor](https://github.com/poseljacob/agentic-video-editor) | MIT；Director → Editor → Reviewer，YAML gate/retry，FFmpeg 渲染；创建于 2026-04，仅约 6 次提交、无 Release | **借鉴 Reviewer 回路，不采用代码基线** |

补充：

- [video-spec-builder](https://github.com/feicaiclub/video-spec-builder) 为 MIT，可借鉴“从模糊意图到逐秒分镜规格”的访谈方法，但它解决的是上游需求澄清，不是长期记忆或生产编排。
- [hyperframes-motion-library](https://github.com/nutllwhy/hyperframes-motion-library) 的模板化动效思路与需求高度相关，但仓库未发现许可证文件。**在获得明确许可证前不能复制代码或资产**，只能把它当作目录结构与入库规范的参考。

## 8. Skill 与 Agent 包装方式

- [openai/skills](https://github.com/openai/skills) README 已标记 deprecated，不应再作为新方案来源。
- 官方当前示例转向 [openai/plugins](https://github.com/openai/plugins)：一个 Codex plugin 可包含 manifest、skills、MCP、agents 和 commands。
- [Agent Skills specification](https://github.com/agentskills/agentskills) 定义了以 `SKILL.md`、脚本、参考资料和模板组成的可移植格式，代码 Apache-2.0、文档 CC-BY-4.0。
- [Superpowers](https://github.com/obra/superpowers) 适合软件开发过程的设计、计划、测试和复核，不是视频生产运行时编排器。

建议区分两层：

1. **开发与知识层**：用 Agent Skills/Plugin 包装教程摄取、技法复刻、记忆治理、评测和维护流程。
2. **视频生产运行时**：用明确 JSON Schema、受限工具和状态机运行各专业 Agent，不依赖 Codex 会话本身保存生产记忆。

这样即使未来更换 Codex、模型或编排 SDK，技法库、素材库和视频任务仍然可读。

## 9. 推荐的最小试验栈

第一轮只验证以下组合：

- 编排：OpenAI Agents SDK，嵌入现有 Python bridge；
- 控制：现有 Node Visual Director v4 状态机；
- 评测：Promptfoo + 现有技术 QA；
- 记忆：SQLite + JSON + 本地资产目录，不接通用记忆服务；
- 摄取：faster-whisper + PySceneDetect + FFmpeg；
- 渲染：HyperFrames + FFmpeg；
- 观察：先写本地 JSONL/SQLite 事件；需要跨任务追踪后再评估 Langfuse；
- 交互参考：只研究 FableCut 的 `project.json` 与 Agent patch 方式。

本轮明确不采用：

- AutoGen：官方已进入维护模式；
- 任一直接 AI 视频编辑器作为生产主干：创建时间和验证历史不足；
- Graphiti：第一阶段过重；
- Agent File 作为长期记忆：不支持大规模 archival passages；
- 无许可证动效仓库的代码或资产；
- 让 Agent 自动发布、自动晋升长期记忆或无边界互相对话。

## 10. 下一步建议

### 第一步：冻结可比较基线

从现有 v4 任务中挑选 3—5 个代表样本，覆盖：

- 普通方法教学；
- 强钩子/热点评论；
- 需要证据画面；
- 字幕密集；
- 音效和动效较多。

保存输入、v4 输出、人工评价、修改记录和技术 QA，形成不可随意修改的基准集。

### 第二步：先定义数据，不先创建 Agent

定义以下稳定 schema：

- `technique-card`
- `asset-record`
- `combination-recipe`
- `agent-proposal`
- `review-score`
- `memory-promotion`
- `production-event`

所有 schema 都包含 `id`、版本、来源、证据、状态、适用条件、禁用条件、创建者、模型/代码版本和回滚信息。

### 第三步：做一个最小双轨实验

只挑一个 15—25 秒片段：

- A 轨：原 v4；
- B 轨：Caption、Motion、Sound 三个 Agent 独立提案，Director 组合；
- 两轨使用相同原片、逐字稿、渲染器和技术 QA；
- Blind Critic 和用户盲选；
- 未获胜的 B 轨不会写入已晋升记忆。

### 第四步：接入教程摄取

把一条教学视频处理为：

`原视频 → 镜头/段落切分 → 逐字稿 → 技法候选 → 人工确认 → 沙盒复刻 → 技法卡与资产 → 真实项目试用 → 晋升或淘汰`

教程只证明“有人这样教”，不证明“适合你的账号”。必须经过复刻和真实项目审核。

### 第五步：依据实验决定是否扩大

如果 3—5 个样本中多 Agent 没有稳定降低返修或提高盲评，不扩大 Agent 数量，优先改进技法库和评测。

如果优势稳定，再增加 Retention Critic、Blind Critic 和 Brand Archivist，并评估 Langfuse 或更强的持久编排。

## 11. 需要用户在实施前确认的两个决策

1. 第一批基准视频由哪些现有 job 组成；
2. 第一轮多 Agent 只做“字幕 + 动效 + 声音”，还是把内容拆解也纳入实验。

在这两个决策确认前，不应安装新框架或改造生产路径。
