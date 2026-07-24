# Candidate Principle 场景沙盒首批验证

日期：2026-07-24
状态：`sandbox_scenario_validation_passed / candidate_only / no_runtime_integration / awaiting_real_clip_trial_admission_review`
范围：Content 三条原则、Director 三条原则，以及 Motion 报告提供的 Director 跨组支持原则。

## 结论

- 7 条候选原则已进入同一个无模型、无数据库、无生产配置依赖的声明式场景沙盒。
- 每条原则均覆盖 1 个适用、1 个阻断、1 个反例或退化场景，共 21 个场景。
- 结果为 `applicable 7 / blocked 7 / degraded 7`，全部与 fixture 预期一致。
- 所有单场景结果和整组拒绝结果始终保持 `candidateStatus: "candidate"`。
- 整组拒绝被建模为独立的 `whole_set_rejected` 结果，不要求也不生成相对优胜者。
- 本轮没有修改 `config/multi-agent/`、Agent prompt、数据库、记忆状态、生产默认或发布链路。

## 新增资产

- `video/multi-agent/candidate-principle-sandbox.mjs`
- `tests/fixtures/candidate-principle-scenarios.json`
- `tests/multi-agent/candidate-principle-sandbox.test.mjs`
- 本报告

## 复用评估

按“直接复用 → 适配 → 组合 → fork → 最小自建”顺序，先比较了现有方案：

| 候选 | 许可证与状态 | 适配代价 | 结论 |
|---|---|---|---|
| 仓库现有 `canonicalJson` / `contentHash` 算法语义 | 当前代码事实，已被多 Agent 合同使用 | `contracts.mjs` 顶层会读取配置 schema，直接导入会破坏本沙盒隔离 | 复用语义，做最小独立实现 |
| `CacheControl/json-rules-engine` | ISC，持续维护；npm 7.3.1，含 4 个运行依赖 | 事件、事实和异步能力明显超过本轮 7 条静态判断的需要 | 不引入 |
| `jwadhams/json-logic-js` | MIT，npm 2.0.5，无运行依赖 | 轻量，但会增加一套外部表达式合同和迁移成本 | 不引入 |
| Open Policy Agent | Apache-2.0，持续维护 | 需要额外运行时、Rego 与跨语言运维，退出成本高 | 不引入 |

最终沿用仓库 canonical JSON 与 SHA-256 的行为语义，但在新模块内做无配置读取的最小实现，再增加声明式条件求值器。支持的操作仅包括 `all / any / not / equals / notEquals / exists / in / notIn / gte / lte / empty / nonEmpty`；未知操作直接失败，证据不足默认 `blocked`。

## 分类合同

| 分类 | 含义 | 优先级 |
|---|---|---:|
| `blocked` | 当前事实触发原则所描述的停止条件，不能继续原计划 | 3 |
| `degraded` | 命中合法反例或边界，应采用更窄的替代判断 | 2 |
| `applicable` | 前置事实足够，原则可以作为建议性检查镜头 | 1 |
| `whole_set_rejected` | 人类可以拒绝整组候选，不产生优胜者 | 批次级独立结果 |

同一场景若同时命中多个规则，固定使用 `blocked > degraded > applicable`。输出只包含候选状态、分类、命中规则、原因、建议动作和确定性哈希，不透传输入中的权限类字段。

## 21 个场景结果

| 场景 | 原则 | 类别 | 实际结果 | 命中规则 |
|---|---|---|---|---|
| `audience-payoff.applicable.project-share` | `content-principle.one-primary-audience-payoff.v1` | 适用 | `applicable` | `payoff.one-primary-gain-is-clear` |
| `audience-payoff.blocked.creator-log-only` | 同上 | 阻断 | `blocked` | `payoff.creator-log-without-viewer-gain` |
| `audience-payoff.degraded.companionship` | 同上 | 退化 | `degraded` | `payoff.non-tool-boundary` |
| `audience-contract.applicable.promise-paid` | `content-principle.opening-creates-audience-contract.v1` | 适用 | `applicable` | `contract.opening-and-payoff-align` |
| `audience-contract.blocked.good-but-unrelated` | 同上 | 阻断 | `blocked` | `contract.unrelated-value-without-bridge` |
| `audience-contract.degraded.story-bridge` | 同上 | 退化 | `degraded` | `contract.story-or-pause-still-serves-promise` |
| `voice-source.applicable.interview-first` | `content-principle.voice-source-before-verbatim-draft.v1` | 适用 | `applicable` | `voice.source-and-readiness-drive-format` |
| `voice-source.blocked.generic-script-first` | 同上 | 阻断 | `blocked` | `voice.generic-verbatim-before-source` |
| `voice-source.degraded.accessibility-verbatim` | 同上 | 退化 | `degraded` | `voice.exact-wording-exception` |
| `plan-preview-gates.applicable.material-forks` | `director-technique.plan-preview-promote-gates.v1` | 适用 | `applicable` | `gates.material-fork-keeps-three-decisions-separate` |
| `plan-preview-gates.blocked.one-click-full-build` | 同上 | 阻断 | `blocked` | `gates.vague-request-collapses-independent-gates` |
| `plan-preview-gates.degraded.safe-area` | 同上 | 退化 | `degraded` | `gates.deterministic-constraint-exception` |
| `freeze-structure.applicable.timeline-confirmed` | `director-principle.freeze-structure-before-packaging.v1` | 适用 | `applicable` | `freeze.semantic-timeline-is-stable` |
| `freeze-structure.blocked.unresolved-source-defect` | 同上 | 阻断 | `blocked` | `freeze.unresolved-structure-or-source-defect` |
| `freeze-structure.degraded.deterministic-repair` | 同上 | 退化 | `degraded` | `freeze.deterministic-technical-fix` |
| `semantic-role.applicable.evidence-card` | `director-principle.semantic-role-before-effect.v1` | 适用 | `applicable` | `semantic.role-drives-expression` |
| `semantic-role.blocked.template-first` | 同上 | 阻断 | `blocked` | `semantic.effect-name-without-purpose` |
| `semantic-role.degraded.noise-repair` | 同上 | 退化 | `degraded` | `semantic.technical-repair-exception` |
| `offer-choices.applicable.small-distinct-set` | `director-principle.offer-choices-then-freeze-after-evidence.v1` | 适用 | `applicable` | `choices.small-distinct-set-with-evidence` |
| `offer-choices.blocked.freeze-first-preference` | 同上 | 阻断 | `blocked` | `choices.first-preference-is-frozen-or-rejection-is-missing` |
| `offer-choices.degraded.encoding-constraint` | 同上 | 退化 | `degraded` | `choices.deterministic-constraint-exception` |

确定性证据：

- 21 个 evaluation hash 的集合哈希：`1d62e3c36902a1fd325fe955fbcbe3d1dd1486fef6135448be121966c3716759`
- 整组拒绝记录哈希：`0722d5783a936d3540d85628eec6a35cd8088b3c57622650df3eaa399a636fb3`

## 原则重叠边界

- `director-technique.plan-preview-promote-gates.v1` 约束的是方案、预览、引擎理由和经验规则三个决策门是否分离。
- `director-principle.freeze-structure-before-packaging.v1` 约束的是内容和时间线何时足够稳定，可以开始昂贵包装。
- `director-principle.offer-choices-then-freeze-after-evidence.v1` 约束的是存在审美分叉时，怎样提供少量候选、保留整组拒绝，并在多轮证据后再冻结。
- 三者相邻但不重复：流程门、结构门、候选冻结门分别独立，任何一条都不拥有生产或知识状态变更能力。

## 自动验证

`node --test tests/multi-agent/candidate-principle-sandbox.test.mjs`

结果：8 项测试全部通过，覆盖：

1. 7 条原则、21 个场景和三类场景完整性；
2. fixture 预期与实际分类一致；
3. 属性顺序变化不影响哈希和输出；
4. 证据不足 fail closed；
5. 权限类输入键拒绝透传，输出无权限、优胜者或选中字段；
6. 整组拒绝不强制选优；
7. 模块不访问模型、网络、文件系统、子进程、数据库或生产配置。

## 局限与下一门

- 本轮只证明声明式场景合同可重复执行，不证明这些原则能提升真实口播质量或留存。
- `applicable` 仅表示原则在该场景可作为建议性检查，不表示原则本身已经被用户第二级接受。
- 21 个 fixture 是边界测试，不替代真实方向访谈、稿件、口播片段和用户主观审核。
- 本报告已与 Caption、Motion、Sound 的原创复刻结果合并为第二级候选审核包；只有用户明确保留的具体条目，才取得真实口播片段试用准入。
