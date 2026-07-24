# 多 Agent 内容顾问层完成审计

日期：2026-07-24

审计对象：Content Strategist、Ordinary Viewer Critic、16 条候选内容原则，以及稿件/成片自动点评集成

结论：**有界内容顾问运行已通过本地合同、真实模型、真实工作台和真实 content/job 验收；没有获得选题、批准、发布或长期记忆权限。16 条原则仍为 `candidate_awaiting_user_review`。**

## 1. 来源研究与创作独立

三条用户指定抖音视频均已完整冻结、转录和按时间码核对，不是根据标题或简介推测：

| 作品 ID | 时长 | 转录段数 | transcript.json SHA-256 |
| --- | ---: | ---: | --- |
| `7665740666193874227` | 10:41 | 243 | `8be3b68cd678ccc5a554b81972f945243b1667ff42a4b5dfbc49f4a2bd6a07b1` |
| `7665371144572177700` | 8:59 | 206 | `de120b3e8e02995192cfe25c232a3e8d5f8b6ebf932961eb731592823f9e570e` |
| `7665003502212582683` | 6:06 | 152 | `1aca1b0fbd2e1a14aac37499533b2acd077af7952995ab9cf33e77f9ad423b47` |

研究报告保留用户三个原始 URL、账号 `sec_uid`、实际访问时间 `2026-07-24T14:32:26+08:00` 和媒体冻结开始时间 `2026-07-24T14:32:59+08:00`。第二个用户 URL 的 `vid` 与 `modal_id` 不一致，报告已原样记录并以账号公开作品 ID 为准。

蒸馏结果为 16 条候选原则，来源分布 4/6/6。每条都包含来源视频、时间码、适用条件、反例和内容哈希。系统只吸收抽象观点，不复制原句、案例、标题、人设、镜头、字幕样式、音频或视频形式。

主要抽象为：

- 信任资产：真实、连续、可回看的行动历史；
- 学习资产：问题、假设、修改、结果和淘汰理由；
- 系统资产：下一次从已有版本继续，而不是重新从零开始。

完整证据见：

- `docs/research/2026-07-24-reference-creator-content-distillation.md`
- `config/multi-agent/content-principles.json`

## 2. Content Strategist 权限与门禁

固定边界：

- 默认必须由用户先提供方向；只有 `allowAgentTopicSearch=true` 才允许帮助找题；
- Agent 原样锁定 `lockedDirection`，不得换题；
- 只能复述、访谈、分析、缩小、拆分、补证、建议暂缓或放弃；
- 不得输出完整稿件、标题、Hook、镜头或剪辑方案；
- 最多提出三个下一轮问题；
- 候选原则只能以 `advisory_candidate_only` 使用；
- 不得修改 content/job、批准生产、发布或晋升记忆。

进入成稿必须同时满足：

1. analysis artifact 完整且内容哈希未变化；
2. 分析状态为 `ready_for_script`；
3. 至少一条服务端权威证据被引用；
4. 没有未解决证据缺口；
5. 用户以独立 human confirmation artifact 确认；
6. 方向文本、方向 SHA-256、analysis 与 confirmation 完全一致。

真实工作台试跑使用方向：

> 分享我如何把一个博主的观点蒸馏成内容顾问 Agent，并加入普通观众尖锐点评

实际结果：

- artifact：`content-strategy.365a766ef108.json`；
- `status=needs_evidence`；
- `recommendation=single_piece`；
- 证据缺口 6 项；
- 下一轮问题 3 个；
- `scriptGate.mayHandOffToScriptAgent=false`；
- 网页确认框与“确认并生成口播”按钮保持禁用。

这证明真实模型不会为了让流程继续而把不完整证据归一化为可写稿状态。

## 3. Ordinary Viewer Critic 权限与媒体边界

固定边界：

- 最多三个阻断点，允许“整体不接受”；
- 稿件阶段必须引用原稿文字；成片阶段必须引用合法时间范围；
- 只评价普通观众相关性、理解成本、可信度、证据和行动性；
- 不得侮辱、换题、整篇重写、预测留存、分析节奏、执行技术 QA、排名、选优、批准或发布；
- 所有字段拒绝或脱敏绝对本地路径；
- 输出采用 Agents SDK + Pydantic 严格结构化合同，语义验证失败只允许一次有界格式修复，不放宽最终校验。

成片 inspection mode：

| 模式 | 可用证据 | 明确不能宣称 |
| --- | --- | --- |
| `script_text` | 权威方向、事实表、稿件 | 不能把稿件声明当成已验证成片事实 |
| `transcript_and_metadata_only` | 权威转录、时长、尺寸、事实表 | 不能声称看见画面、字幕、构图或听见音量、BGM、噪声、语气 |
| `sampled_frames_and_transcript` | 上述内容和已审核帧观察 | 不能推断帧外内容，仍不能声称听过音频 |

视觉与听觉词覆盖已包含：画面、字幕、截图、构图、颜色、听见、听到、声音、音频、音效、音量、背景音乐、BGM、噪声、语气和盖过人声等。无审核帧时固定降级为 `transcript_and_metadata_only`。

## 4. 真实稿件与成片验收

### 4.1 真实稿件点评

对象：`growth-day-2-revision-20260721070515-b5e403`

artifact：`content-growth-day-2-revision-20260721070515-b5e403-ordinary-review.1bbd4e1b6a7a`

结果：

- `inspectionMode=script_text`；
- 决定：`证据不足`；
- 尖锐结论：方法清楚且可执行，但“真实返修有效”的核心结论缺少可核对的原始记录和前后结果；
- 阻断点 2 个；
- content 状态在点评前后均为“待审核”；
- 没有修改批准、发布或审核状态。

### 4.2 真实 v5 成片点评

对象：job `20260721132116-0831f6` 的 `final-v5.mp4`

artifact：`job-20260721132116-0831f6-b9c896d6.v5.1b3f12ec3f1f5aae.e5d76033c78c543e.a33c8156099d`

不可变身份：

- `outputVersion=5`；
- media SHA-256：`1b3f12ec3f1f5aae9dd78e66dd63b1f42e4d3914a4c757b486c329ae960f7d39`；
- transcript SHA-256：`e5d76033c78c543e0d9780f12626d325cadad2a236d96d05662ffe20dbddce9b`；
- `inspectionMode=transcript_and_metadata_only`。

结果：

- 决定：`证据不足`；
- 尖锐结论：方法框架可复用，但关键效果缺少可核验证据，且工具术语与返修示例不够清楚；
- 阻断点 3 个，均带时间范围；
- 其中一个准确指出转录中的“地级秒时”无法让观众照做；
- job 在点评前后均为 `awaiting_review`；
- `output.version` 前后均为 5；
- 没有批准、发布或记忆变化。

第一次真实成片调用因模型越过 `transcript_and_metadata_only` 边界而生成一个 `failed` artifact。系统没有吞掉失败，也没有修改 job；随后补强证据边界和一次有界修复提示，第二次真实调用通过。失败记录保留用于审计，不覆盖成功 artifact。

v4 全片与旧 FFmpeg 两条最终渲染路径都会自动触发相同审查。artifact 身份包含输出版本、实际媒体哈希和最终转录哈希，因此返修后旧点评不能冒充当前版本。

## 5. 开源复用与隐私

角色级专项审计已完成，结论为：

- 直接复用：`openai-agents==0.18.3`；
- 适配：窄 Python JSON bridge；
- 组合：Node 确定性总控、SQLite/artifact、人工确认门和 v4；
- 最小自建：Koubo 特有的方向权、证据哈希、候选原则和点评权限合同；
- 不引入 LangGraph、AutoGen、CrewAI、Pydantic AI 或 Mastra；Pydantic AI 仅保留为未来 bridge 替换候选。

完整审计见 `docs/research/2026-07-24-content-agent-oss-reuse-audit.md`。

OpenAI Agents SDK tracing 默认会包含模型输入输出。本实现已将 tracing 改为默认关闭；只有显式设置 `KOUBO_AGENT_TRACING_ENABLED=1` 才允许开启。原视频不会传给文本模型，模型只收到脱敏文字、权威转录、公开事实和不透明 artifact/media 引用。

## 6. 验证矩阵

本次最终验证结果：

- Node：baseline、multi-agent、server content strategy、server rendered audit，`167/167` 通过；
- Python：bridge 与方向锁，`13/13` 通过；
- 工作台静态验证：165 个控件引用有效；
- 在线服务：`127.0.0.1:8787` 健康检查与 v4 默认工作流通过；
- 浏览器：方向分析真实点击成功、无页面 console error、证据缺口时确认与生成按钮保持关闭；
- `git diff --check` 通过。

## 7. 仍需用户决定的事项

以下不是工程失败，而是必须保留给用户的权力：

1. 逐项接受、修改或拒绝 16 条候选原则；
2. 为下一条真实方向补足目标受众、真实运行案例和对比证据；
3. 在分析达到 `ready_for_script` 后亲自勾选确认是否进入写稿；
4. 对最终稿件和成片做主观审核；
5. 决定是否发布。

localhost 的 `actor.type=human` 仍是本机 JSON 声明，不是强身份认证；这对单用户本机工具可接受，但若未来开放远程访问，必须增加真实认证和 CSRF/权限边界。

正确的完成表述是：**三条视频研究、候选知识包、内容顾问与普通观众 Critic 的有界本地运行已经完成；候选原则的长期采用和任何内容生产/发布决定仍等待用户。**
