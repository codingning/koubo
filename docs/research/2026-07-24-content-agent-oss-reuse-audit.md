# Content Strategist 与 Ordinary Viewer Critic 开源复用审计

- 日期：2026-07-24
- 研究快照：2026-07-24 16:50（Asia/Shanghai）
- 状态：完成，只读审计；不引入新依赖，不修改生产代码
- 范围：Koubo 的 Content Strategist、Ordinary Viewer Critic，以及承载二者的受控多 Agent 运行边界

## 1. 结论

当前不应再引入 LangGraph、AutoGen、CrewAI、Pydantic AI、Mastra 或 Microsoft Agent Framework 作为这两个角色的新运行内核。

准确的复用层级不是“全部最小自建”，而是：

1. **直接复用**：继续使用已固定的 `openai-agents==0.18.3` 承担模型调用；继续使用现有 Promptfoo 和本地测试承担回归评测。
2. **适配**：`video/multi_agent_bridge.py` 把 Agents SDK 收敛成少量 allowlist JSON 操作，使模型运行时可替换、可离线 fixture 测试，也不拥有工作流状态。
3. **组合**：把上述适配层与现有 Node 确定性总控、本地 artifact、SQLite 状态、人工确认门和视频渲染链组合起来。
4. **最小自建**：仅保留 Koubo 特有的领域合同，包括用户方向锁、证据哈希、候选原则权限、稿件门禁、最多三个阻断点、画面/音频证据边界、不可批准发布等。
5. **不 fork**：没有候选框架值得为了这两个轻量角色维护项目级 fork。

因此，**系统级选择停在“组合”层；两个角色的领域 policy/validator 属于“最小自建”层；Python JSON bridge 本身属于“适配”层**。这符合“直接复用 → 适配 → 组合 → fork → 最小自建”的优先级，因为前三级已经解决通用运行能力，只有没有现成实现的 Koubo 领域约束才进入最小自建。

唯一需要在正式承载私有素材前补充确认的安全项是 OpenAI Agents SDK 的 tracing：官方文档说明 tracing 默认开启，且默认包含模型和工具的输入输出；当前仓库没有检索到显式关闭或关闭敏感内容采集的配置。此项不改变框架选择，但应在生产运行规范中明确选择以下至少一种策略：

- `OPENAI_AGENTS_DISABLE_TRACING=1`；或
- `OPENAI_AGENTS_TRACE_INCLUDE_SENSITIVE_DATA=0`；或
- 每次运行显式设置 `RunConfig` 的 tracing/sensitive-data 策略，并验证真实请求没有把私有证据写入远端 trace。

**收口实施（同日）**：主实现已采用更严格的默认策略，在 `video/multi_agent_bridge.py` 中调用 Agents SDK 的 `set_tracing_disabled(True)`；只有显式设置 `KOUBO_AGENT_TRACING_ENABLED=1` 才会开启 tracing。`.env.example`、单元测试和工作流文档均已同步。这解决了本审计发现的上线前隐私门禁，不改变模型完成任务所需的正常请求。

## 2. 当前实现真正需要解决的问题

这两个角色不是通用自治 Agent 群，其核心难点是跨字段、跨阶段的领域权限与证据约束。

### 2.1 Content Strategist

当前合同要求：

- 方向必须来自用户，并逐字锁定；Strategist 无权换题；
- 只能访谈、分析、缩小、拆分、补证、建议暂缓或放弃；
- 不得输出稿件、标题、Hook、镜头或剪辑方案；
- 输出最多三个下一轮问题；
- `ready_for_script` 必须同时满足证据完整、分析状态正确和用户确认；
- 候选原则必须带来源、时间码和内容哈希，未被用户接受时只能作为 advisory candidate；
- 不得批准、发布或晋升记忆。

实现证据见：

- [`content-strategy.mjs`](../../video/multi-agent/content-strategy.mjs)
- [`api.mjs`](../../video/multi-agent/api.mjs)
- [`content-principles.json`](../../config/multi-agent/content-principles.json)

### 2.2 Ordinary Viewer Critic

当前合同要求：

- 稿件阶段必须引用真实原句，成片阶段必须引用合法时间码；
- 最多给三个阻断问题，允许“整体不接受”；
- 只能评价普通观众价值、理解成本、可信度、证据与行动性；
- 不得换题、整篇重写、选赢家、预测留存、执行技术 QA、批准发布或晋升记忆；
- 没有审核帧时，只能使用 `transcript_and_metadata_only`，不得声称看见画面问题；
- 当前没有审核音频证据接口，不得声称听见音量、BGM、噪声或人声覆盖问题；
- 成片点评绑定具体输出版本、媒体哈希与转录哈希，旧点评不能冒充当前版本点评。

实现证据见：

- [`ordinary-viewer-critic.mjs`](../../video/multi-agent/ordinary-viewer-critic.mjs)
- [`ordinary-viewer-rubric.json`](../../config/multi-agent/ordinary-viewer-rubric.json)
- [`rendered-ordinary-viewer-audit.mjs`](../../video/multi-agent/rendered-ordinary-viewer-audit.mjs)

这些约束无法仅靠“结构化输出”“人工批准”或“多 Agent 编排”自动获得。例如，通用 JSON Schema 不能单独证明方向没有被同义改写，框架级 HITL 也不能自动验证候选原则哈希、画面证据覆盖范围或 Critic 是否越权做留存预测。无论采用哪一个框架，这部分仍须由 Koubo 持有。

## 3. 研究方法与证据口径

本次按开源复用优先顺序执行了以下只读检查：

1. 使用 Agent Reach 体检当前互联网后端；GitHub CLI 已安装但未登录，因此不改变登录状态。
2. 使用 Agent Reach / Exa 检索官方 LangGraph HITL、interrupt 和 persistence 文档。
3. 使用 GitHub Search API 读取仓库维护快照；由于匿名 core API 配额已耗尽，仓库元数据使用独立的 Search API 配额读取。
4. 直接读取各项目官方 GitHub README、许可证、安全说明和官方文档源文件。
5. 使用 PyPI 与 npm 官方 registry 核对当前发布版本、发布时间和运行时要求。
6. 对照当前 Koubo 代码、依赖锁、Node/Python 实际版本和现有本地验证边界。

限制与解释：

- GitHub 的 `open_issues_count` 同时包含 issue 和 pull request，只用于观察维护负载，不作为质量分数。
- Star、官方 README 中的客户名称、开发者数量和“production-ready”均属于项目方自述；本审计把命名案例、端到端示例和营销宣称分开处理。
- Exa 首次查询成功后触发免费 MCP 429 限流；其余候选改用 GitHub、官方文档、PyPI 与 npm 原始来源，不使用二手博客补空白。
- AutoGen 仓库 API 的主许可证字段显示 CC-BY-4.0，是因为文档使用该许可；官方 `LICENSE-CODE` 明确代码使用 MIT。

## 4. 维护与兼容性快照

| 候选 | GitHub 快照 | 当前发布 | 许可证 | 一等运行时 |
| --- | --- | --- | --- | --- |
| OpenAI Agents SDK Python | 28,139 Star；4,370 Fork；58 open；2026-07-24 有 push | PyPI `0.18.3`，2026-07-17 | MIT | Python >=3.10；另有官方 JS/TS SDK |
| LangGraph | 38,009 Star；6,386 Fork；640 open；2026-07-22 有 push | PyPI `1.2.9`，2026-07-10；npm `@langchain/langgraph@1.4.8`，2026-07-15 | MIT | Python >=3.10；Node >18 |
| Microsoft AutoGen | 59,932 Star；9,022 Fork；970 open；最后 push 2026-04-15 | PyPI `autogen-agentchat@0.7.5`，2025-09-30 | 代码 MIT；文档 CC-BY-4.0 | Python >=3.10、.NET；无一等 Node 运行时 |
| CrewAI | 56,061 Star；7,931 Fork；663 open；2026-07-24 有 push | PyPI `1.15.5`，2026-07-20 | MIT | Python >=3.10 且 <3.14 |
| Pydantic AI | 18,783 Star；2,407 Fork；505 open；2026-07-24 有 push | PyPI `2.17.0`，2026-07-24 | MIT | Python >=3.10 |
| Mastra | 26,518 Star；2,505 Fork；545 open；2026-07-24 有 push | npm `@mastra/core@1.52.1`，2026-07-23 | core Apache-2.0；任意 `ee/` 目录为 Mastra Enterprise License | Node >22.13 |
| Microsoft Agent Framework | 12,357 Star；2,070 Fork；644 open；2026-07-24 有 push | 官方 1.0 路线；本次未引入包 | MIT | Python、.NET；无一等 Node 运行时 |

当前 Koubo 环境为 Node `22.20.0`、Python `3.13.9`，已安装并固定 `openai-agents==0.18.3`。因此除 CrewAI 的 `<3.14` 上限需要持续留意外，上述 Python 方案当前均可运行；Mastra 的 Node 门槛也满足。兼容并不等于值得接入，主要区别在于架构重叠和退出成本。

## 5. 候选逐项评估

### 5.1 OpenAI Agents SDK：继续直接复用

**功能**

- 官方提供 Agent、tool、handoff、guardrail、session、tracing 和 HITL。
- HITL 可在工具、嵌套 agent-as-tool、Shell、Apply Patch 与 MCP 调用处暂停；`RunState` 可序列化后批准、拒绝并恢复。
- Koubo 当前只复用最小的 `Agent + Runner` 模型调用面，不把 SDK session、handoff 或工具审批当作项目工作流总控。

**许可证与维护**

- MIT；官方仓库和 PyPI 在本次快照日仍活跃。
- 当前项目固定版本与 PyPI 最新版同为 `0.18.3`，没有版本漂移。

**安全与隐私**

- 优点：SDK 很薄，当前被 JSON bridge 隔离，替换成本低。
- 风险：官方 tracing 默认开启，`trace_include_sensitive_data` 默认也是 `True`；生成输入输出和函数调用输入输出可能进入 OpenAI trace 后端。
- HITL 文档还明确提醒序列化 `RunState` 会包含应用 context、tool input、审批和 trace 元数据，持久化时必须把它视作敏感数据。

**真实案例证据**

- 官方仓库提供覆盖 handoff、HITL、MCP、session、Realtime 等完整示例；本次官方 README 没有给出可独立复核的外部客户生产案例。
- 对 Koubo 而言，真实有效证据是本地固定版本、fixture 模式和现有回归测试，而不是 Star 或示例数量。

**兼容性、退出成本与结论**

- Python 3.13.9 可用；Node 通过一个窄 JSON bridge 调用。
- 退出成本低：未来可以保持 JSON 合同不变，只替换 bridge 内部 SDK。
- **结论：保留，属于直接复用；不扩大它的权限。**

### 5.2 LangGraph：HITL 最强，但与现有总控高度重叠

**功能**

- 这是本次候选中对持久状态、长任务恢复、人工中断、审批、人工编辑状态和多分支恢复支持最完整的方案之一。
- Python 与 JS/TS 都支持 `interrupt`、checkpointer、thread ID 和 `Command(resume=...)`。
- 官方文档明确支持 approve/reject、review/edit state、工具调用审批和人工输入校验。

**许可证、安全与维护**

- MIT；Python 与 JS 包均持续发布，仓库维护活跃。
- 可独立使用 OSS core；LangSmith 调试、评测和部署是可选服务，不是运行 core 的必需条件。
- interrupt 恢复会从所在 node 的开头重新执行，官方要求 interrupt 前的副作用必须幂等。这会给已有渲染、artifact 写入和人工确认逻辑带来新的重放审计责任。
- checkpointer 会保存完整图状态，若放入稿件、用户证据或媒体定位信息，必须重新设计数据最小化、加密和保留策略。

**真实案例证据**

- 官方 README 命名 Klarna、Replit、Elastic，并链接官方 case studies；证据强于只有 demo 的候选，但仍属于供应方材料。

**兼容性与退出成本**

- Node 与 Python 均兼容当前环境。
- 直接采用意味着把现有 Node 状态机、SQLite 状态、确认 artifact、重试和恢复语义搬入 graph/checkpointer/thread 模型，退出成本高。
- 两个新角色本身都是一次有界模型调用加确定性校验，不需要长任务图。

**结论**

- **当前不采用。**
- 只有当 Koubo 出现“跨进程等待数天、人工编辑中间状态、多分支恢复、现有状态机无法可靠表达”的真实问题时，才做隔离 A/B；不能为了已有的人审按钮重写总控。

### 5.3 AutoGen：新项目排除；只把 Microsoft Agent Framework 作为远期替代观察项

**功能**

- AutoGen 提供 AgentChat、事件驱动 core、分布式 runtime、群聊、Studio 和 Python/.NET 跨运行时能力。
- 能构建人与 Agent 协作，但其优势集中在通用多 Agent 自治与消息编排，不会替代 Koubo 的方向锁和 Critic 证据合同。

**许可证、安全与维护**

- 代码 MIT，文档 CC-BY-4.0。
- 官方 README 已明确进入 **maintenance mode**：不再增加新功能，由社区维护，新项目应使用 Microsoft Agent Framework；现有用户被建议迁移。
- 官方警告只连接可信 MCP server；AutoGen Studio 明确不是 production-ready 应用，认证与安全需由使用者自行实现。
- 2026-07-24 快照中仓库最后 push 为 2026-04-15，`autogen-agentchat` 最新发布仍为 2025-09-30，与其他活跃候选相比维护信号明显较弱。

**真实案例证据**

- 官方 Magentic-One 和 AutoGen Studio 属于研究/示例资产，不是 Koubo 这类受控内容工作流的生产案例。

**兼容性、隐私与退出成本**

- Python 兼容，Node 没有一等支持；接入仍需 bridge。
- 多 Agent 消息、代码执行、MCP 与 Studio 会扩大本地攻击面和数据流；当前两个只读角色不需要这些能力。
- 已知需要迁往后继框架，作为新依赖的退出成本不可接受。

**Microsoft Agent Framework 补充**

- MAF 是官方后继，MIT，支持 Python/.NET、checkpoint、streaming、HITL、time-travel 和多种 graph pattern，维护活跃。
- 它仍没有一等 Node 运行时，并会与 Koubo 现有 Node 总控重叠；官方也明确要求使用者自行完成第三方数据边界、权限和 responsible-AI 安全措施。

**结论：AutoGen 排除；MAF 仅在未来明确采用 Microsoft/.NET/Foundry 运行栈时重新评估。**

### 5.4 CrewAI：Flow 能做确定性编排，但范围和默认行为过大

**功能**

- CrewAI 同时提供自治 Crews 和事件驱动 Flows；官方 README 明确支持 structured output、human review、checkpointing 和普通 Python 业务逻辑。
- 与 Content Strategist/Critic 最相关的是 Flow、`output_pydantic`/`output_json` 和 human review，而不是角色 backstory 或自治 delegation。

**许可证、安全与维护**

- MIT；仓库与 PyPI 发布活跃。
- 官方 README 说明默认收集匿名 telemetry，包括版本、操作系统、agent/task 数、所用模型、角色和工具名；可通过 `OTEL_SDK_DISABLED=true` 关闭。只有显式启用 `share_crew` 才会收集任务、backstory、context 和输出等详细信息。
- 高级治理、安全、观测和支持主要由商业 AMP 提供；本次检查根目录 `SECURITY.md` 返回 404，不能据此断言没有安全响应渠道，但 OSS README 没有给出与 Microsoft/OpenAI 同等明确的漏洞披露文件。

**真实案例证据**

- 官方提供 trip planner、stock analysis、job description 等示例，并自述有超过十万名完成认证的开发者。
- 本次查看的官方 README 没有命名可复核的外部生产客户；示例不能证明其适合 Koubo 的证据和发布门禁。

**兼容性、隐私与退出成本**

- Python 3.13.9 当前满足 `>=3.10,<3.14`，但下一次 Python 大版本会触发兼容门。
- 需新增 Crew/Task/Flow 对象、telemetry 配置和更多依赖，再通过 Python bridge 接回 Node。
- 把一次模型调用包装成 Crew/Flow 不会减少任何领域校验，反而提高退出成本。

**结论：不采用。若未来出现真正需要自治团队的隔离实验，只允许以 Flow 为外层、关闭 telemetry，并保持现有确认 artifact 为权威。**

### 5.5 Pydantic AI：最适合做 Python 结构化 Agent 备选，但当前不会减少代码

**功能**

- 原生 Pydantic structured output、依赖注入、类型验证、graph、eval、OTel 和多模型适配。
- Deferred Tools 支持总是审批、按参数/上下文审批、外部异步执行、拒绝信息和恢复；官方还提供 Temporal、DBOS、Prefect、Restate 等 durable execution 集成。
- 在所有 Python 候选中，它最贴近“结构化结果 + 人工门禁”。

**许可证、安全与维护**

- MIT；本次快照日发布 `2.17.0`，维护很活跃。
- 官方文档明确警告：HITL approval 不是对不可信客户端的 authorization boundary；服务端仍必须认证请求，并在工具函数内实施权限检查。这与 Koubo 坚持由服务端 authoritative read 和确认 artifact 决定权限的方向一致。
- 模型可替换，也支持本地模型；Logfire/OTel 是可选观测面。接 durable provider 时会新增对应外部运行时、存储和数据保留责任。

**真实案例证据**

- 项目来源于 Pydantic 团队在 Logfire 中构建 GenAI 功能的实际需要；README 的银行支持 Agent 是完整示例，但不是外部生产案例。

**兼容性、隐私与退出成本**

- Python 3.13.9 兼容；没有一等 Node 运行时，但可在现有 JSON bridge 内替换 Agents SDK。
- 退出成本中等且可控，因为 bridge 可以保持不变。
- 当前 JS 已经校验方向相等、原则哈希、时间码覆盖、权限字段和跨阶段门禁。仅改用 Pydantic output model 会重复这些合同，并不能删除它们。

**结论：不并行安装。保留为 Python bridge 的首要替换候选；只有出现多模型强需求、现有字符串 JSON 修复率明显过高，或需要 Python 内部 deferred-tool HITL 时再做窄对比。**

### 5.6 Mastra：Node 兼容最好，但会吞并现有总控边界

**功能**

- TypeScript/Node 原生；提供 agent、graph workflow、branch/parallel、HITL suspend/resume、持久 storage、memory、eval 和 observability。
- suspend/resume 和现有网页确认体验非常接近；如果从零建设 Node Agent 产品，它是强候选。

**许可证、安全与维护**

- core 和大部分仓库为 Apache-2.0；任何名为 `ee/` 的目录使用 Mastra Enterprise License，生产复用必须逐路径确认许可证，不能只看 npm package 的 Apache 标识。
- npm 与仓库维护活跃，`@mastra/core` 要求 Node >22.13，当前 Node 22.20.0 满足。
- 官方 README 提供 security 邮箱和 CodeQL；模型、storage 与 observability 的隐私仍取决于具体 provider 和部署配置。

**真实案例证据**

- 官方 README 提供模板、课程、Studio 和功能说明，但本次读取材料没有命名可复核的外部生产客户。

**兼容性、隐私与退出成本**

- 技术兼容最好，不需要 Python bridge。
- 但若直接采用，Mastra workflow/storage/server 会与现有 Node API、artifact store、SQLite memory 和渲染状态机竞争权威；迁移不是“复用一个组件”，而是更换应用框架。
- 同时需要持续审计 core 与 `ee/` 的导入边界。

**结论：当前不采用。只有未来新建独立 Node Agent 产品，或现有总控被证明无法支持通用 suspend/resume 时，才在隔离目录做无 `ee/` 依赖的 PoC。**

## 6. 横向决策矩阵

评分只针对当前两个内容角色，不代表框架的通用质量。

| 候选 | 领域功能匹配 | 人审/恢复 | Node/Python 适配 | 隐私与安全负担 | 退出成本 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI Agents SDK | 中；通用调用足够，领域合同仍自建 | 中高；工具审批与 RunState 完整 | Python 原生，Node 经现有 bridge | **中高**；默认 tracing/sensitive data 必须明确关闭或收敛 | 低 | **保留直接复用** |
| LangGraph | 中；能力远超两个单次角色 | **最高**；interrupt/checkpoint 很成熟 | Python、JS/TS 均好 | 中高；完整图状态持久化和 node 重放 | 高 | 暂不采用 |
| AutoGen | 低中；偏自治消息编排 | 中 | Python/.NET，无一等 Node | 高；MCP/代码执行/Studio 且已维护模式 | 很高 | **排除新采用** |
| Microsoft Agent Framework | 中高；后继能力完整 | 高 | Python/.NET，无一等 Node | 中高；第三方数据与权限需自行治理 | 高 | 远期观察 |
| CrewAI | 中；Flow 合适，Crew 过重 | 中高 | Python only，经 bridge | 中高；默认匿名 telemetry，商业控制面边界 | 高 | 暂不采用 |
| Pydantic AI | **高**；结构化输出和审批最贴近 | 高 | Python only，经 bridge | 中；需自行做服务端 authorization，观测可选 | 中 | **首要替换备选** |
| Mastra | 高；Node workflow 与 HITL 贴近 | 高 | **Node 最佳** | 中高；storage/observability 与双许可证路径 | 中高至高 | 隔离 PoC 备选 |

## 7. 为什么不能“直接复用一个完整框架”代替当前代码

1. **当前痛点不是缺少多 Agent 调度。** 两个角色各自只需要一次有界模型调用；重试、超时、API、artifact 和人工确认已经存在。
2. **关键规则是 Koubo 独有的。** 方向逐字锁、候选原则哈希、审核帧覆盖、无音频证据禁言、最多三个阻断点和发布权分离，在候选框架中都没有即插即用实现。
3. **结构化输出不是权限证明。** Pydantic、Zod 或框架 schema 能验证形状，但跨阶段 authoritative data、旧版本点评失效和服务端确认凭证仍须由项目状态机验证。
4. **完整框架会制造第二权威。** LangGraph/Mastra/CrewAI 的 workflow state、checkpoint 或 storage 会与现有 SQLite、artifact 和渲染 job 状态竞争，需要重新证明恢复、幂等、回滚和审核语义。
5. **替换收益小于退出成本。** 当前 SDK 已被窄 bridge 隔离；换底层模型库很容易。把应用迁入第三方 workflow runtime 后，未来退出反而更难。
6. **fork 没有合理对象。** 候选都不缺我们需要修改的通用底层能力；缺的是 Koubo 领域 policy。fork 上游只会带来长期合并与安全补丁成本。

## 8. 建议的后续门禁

本次不改代码，但后续上线前建议把以下事项加入验收：

1. **关闭或收敛 Agents SDK tracing。** 用真实 fixture 以外的一次最小调用验证远端 trace 是否包含方向、稿件、证据摘要和点评。
2. **继续固定版本。** `openai-agents` 升级时重新跑 bridge、Content Strategist、Ordinary Viewer Critic、API 和 rendered-audit 全量回归。
3. **不把框架 HITL 当权限系统。** 即使未来采用 Pydantic AI、LangGraph 或 Mastra，用户确认必须继续由服务端 authoritative artifact 与内容哈希验证。
4. **为候选设置重评触发器，而非按热度迁移：**
   - 跨进程长暂停、多分支恢复成为真实故障点：对比 LangGraph 与 Mastra；
   - 多模型切换和 Python typed output 成为主要成本：对比 Pydantic AI 与现有 Agents SDK；
   - 明确进入 Microsoft Foundry/.NET 技术栈：评估 Microsoft Agent Framework；
   - 需要自治营销团队而不是只读顾问：隔离评估 CrewAI Flow，并默认关闭 telemetry。
5. **继续保持退出通道。** 模型运行时只通过 JSON bridge 交换数据，长期状态只认 Koubo artifact/SQLite，第三方 trace、memory 或 workflow store 不得成为发布和记忆晋升的唯一事实源。

## 9. 官方来源

### 当前实现

- [Koubo multi-agent dependency decision](2026-07-23-multi-agent-dependency-lock.md)
- [Pinned Python requirements](../../requirements-multi-agent.lock.txt)
- [Python Agents SDK bridge](../../video/multi_agent_bridge.py)
- [Content Strategist contract](../../video/multi-agent/content-strategy.mjs)
- [Ordinary Viewer Critic contract](../../video/multi-agent/ordinary-viewer-critic.mjs)

### OpenAI Agents SDK

- <https://github.com/openai/openai-agents-python>
- <https://openai.github.io/openai-agents-python/human_in_the_loop/>
- <https://openai.github.io/openai-agents-python/tracing/>
- <https://pypi.org/project/openai-agents/>

### LangGraph

- <https://github.com/langchain-ai/langgraph>
- <https://docs.langchain.com/oss/python/langgraph/interrupts>
- <https://docs.langchain.com/oss/javascript/langgraph/interrupts>
- <https://pypi.org/project/langgraph/>
- <https://www.npmjs.com/package/@langchain/langgraph>

### AutoGen 与 Microsoft Agent Framework

- <https://github.com/microsoft/autogen>
- <https://github.com/microsoft/autogen/blob/main/LICENSE-CODE>
- <https://pypi.org/project/autogen-agentchat/>
- <https://github.com/microsoft/agent-framework>
- <https://learn.microsoft.com/en-us/agent-framework/migration-guide/from-autogen/>

### CrewAI

- <https://github.com/crewAIInc/crewAI>
- <https://docs.crewai.com>
- <https://pypi.org/project/crewai/>

### Pydantic AI

- <https://github.com/pydantic/pydantic-ai>
- <https://ai.pydantic.dev/deferred-tools/>
- <https://ai.pydantic.dev/durable_execution/overview/>
- <https://pypi.org/project/pydantic-ai/>

### Mastra

- <https://github.com/mastra-ai/mastra>
- <https://mastra.ai/docs/workflows/suspend-and-resume>
- <https://github.com/mastra-ai/mastra/blob/main/LICENSE.md>
- <https://www.npmjs.com/package/@mastra/core>
