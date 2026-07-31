# Creator Vault Content Strategist Trial Suite v2 验收

日期：2026-07-31

## 最终结论

第二轮修正提高了安全性和局部稳定性，但仍未达到进入真实稿件试用的固定门槛。

16 条 Creator Vault 内容原则继续保持 `trial`：

- 不进入 `approved` 或 `promoted`；
- 不成为生产默认；
- 不进入 Script Agent 或真实稿件；
- 不声称 Content Strategist 已经因知识库而整体变聪明；
- 不改变批准、发布或长期知识晋升权限。

最终建议仍为：

```text
keep_trial_and_do_not_advance
```

## 本轮修正

本轮没有修改五个方向、两轮重复次数、匿名评分量表或通过门槛，只修改知识检索与使用合同：

1. 检索查询从单独的锁定方向扩展为方向、受众、用户事实、证据摘要、约束和访谈答案；
2. Creator Vault 先返回最多 20 条候选，再按适用性、正文匹配、来源多样性和候选相似度选出最多 5 条；
3. 常见宽泛词不再主导排序；
4. 每次最多引用 3 条原则，也允许在没有实质增量时引用 0 条；
5. 每条引用必须说明 `appliedJudgment`、`applicabilityCheck` 和 `counterexampleCheck`；
6. 明确禁止把已完成、已量化或已有证据的事实削弱为“部分”“可能”或“尚未证明”；
7. 盲评的证据纪律明确检查是否削弱、缩小、矛盾改写或遗漏共享事实。

这些约束只作用于显式 `creator-vault + includeTrial=true` 试验路径，不改变生产默认。

## 固定门槛与结果

| 指标 | 通过要求 | v1 | v2 |
|---|---:|---:|---:|
| Trial 稳定胜出方向 | 至少 4/5 | 0/5 | 1/5 |
| Trial 平均分提升 | 至少 +1.0 | +0.2 | +0.3 |
| 知识引用准确率 | 至少 90% | 100% | 100% |
| 两轮结论一致方向 | 至少 4/5 | 1/5 | 2/5 |
| 明显退化方向 | 0 | 1 | 0 |

v2 消除了硬退化，并产生一个可重复的稳定胜出方向，但总体提升仍不足，最终 `passed=false`。

## 分方向结果

| 方向 | Control | Trial | 差值 | 两轮结论 | 结果 |
|---|---:|---:|---:|---|---|
| 知识桥 | 8.0 | 8.0 | 0 | Tie / Tie | 无新增收益 |
| 开源 Skill 审计 | 7.0 | 8.0 | +1.0 | Trial / Trial | 稳定胜出 |
| 素材库接入 | 7.5 | 8.0 | +0.5 | Tie / Trial | 不稳定 |
| 失败经验回写 | 8.0 | 7.5 | -0.5 | Control / Tie | 无硬失败但略弱 |
| 工作台真实证明 | 7.5 | 8.0 | +0.5 | Trial / Tie | 不稳定 |

### 开源 Skill 审计为什么稳定胜出

两轮 Trial 都把宽泛的“审计和隔离试用”进一步转成了可决定安装、暂缓或放弃的阈值，并补足：

- 具体 Skill 的审计记录和最终结论；
- 隔离试用的成功指标；
- 跨 Skill、操作系统、运行权限和风险范围的适用边界；
- 安装成功与真实可用之间的区别。

这说明当前知识对“重复出现、可以明确列出决策门槛的工具审计问题”存在局部价值。

### 失败经验回写为什么没有提升

Trial 更具体地讨论了规则触发、迁移边界、降级和撤销，但一次评审认为 Control 更直接要求比较知识调用前后的真实成片与用户审核结果。

这说明“如何保存和治理经验”不能替代“经验是否真的改善下一次输出”的结果证据。当前知识仍容易把注意力带到知识资产结构，而不是最终内容效果。

## 引用行为

- 10 次 Trial 共引用 26 条原则，平均每次 2.6 条；
- 0 次选择完全不引用，说明“允许不引用”尚未真正改变模型行为；
- `version-failures-and-results.v1` 被引用 6 次；
- `versions-compound-with-maintenance.v1`、`learning-corrects-errors.v1` 和 `change-one-main-variable.v1` 各被引用 4 次；
- 所有引用 ID 和内容哈希均通过确定性审核，准确率 100%。

引用数量下降并不等于分析必然变好。当前主要问题已经从“错误或过度引用”转成“原则虽然相关，但没有稳定增加超越基础模型的新判断”。

## 验收解释

本轮证明了：

- 事实保真门禁有效，上一轮的明确事实削弱没有再次出现；
- 上下文检索和来源多样性可以减少明显退化；
- 条件化引用可以让知识使用更可审计；
- 一小类任务已经观察到重复收益。

本轮没有证明：

- 16 条宽泛内容原则能让 Content Strategist 整体稳定提升；
- 只靠增加检索或提示词约束就能完成 Agent 训练；
- 当前原则适合进入所有短视频方向；
- 任意知识引用都比不引用更好。

## 下一阶段建议

不继续为当前 16 条宽泛原则微调门槛或更换题目。下一阶段应新增更窄、可判定的任务型知识卡，例如：

- 开源 Skill 审计的放弃条件、比较基线和真实可用指标；
- 素材选择的语义意图、时间线位置、人工接受结果与失败反例；
- 失败经验是否真正改善下一次成片的前后对照合同。

新增知识仍从 `trial` 开始，并继续使用同一套五题和原门槛。除非稳定胜出至少 4/5，否则不进入真实稿件。

## 证据位置

- 机器汇总：`data/acceptance/creator-vault-content-trial-suite-v2/summary.json`
- 完整运行：`data/acceptance/creator-vault-content-trial-suite-v2/run.json`
- 逐轮结果：`data/acceptance/creator-vault-content-trial-suite-v2/runs/`
- 20 份分析：`data/acceptance/creator-vault-content-trial-suite-v2/artifacts/content-strategy-analyses/`
- 10 份匿名评审：`data/acceptance/creator-vault-content-trial-suite-v2/artifacts/content-training-evaluations/`
- 运行日志与隔离运行时：`G:\CreatorVault-Backups\test-runs\20260731-content-trial-suite-v2`

## 代码与回归验证

- Node 全量串行回归：342 项，339 通过、3 跳过、0 失败；
- Python 全量回归：18/18 通过；
- 本轮相关 Node 定向测试：66/66 通过；
- `git diff --check` 通过；
- v2 验收数据的秘密形态和用户目录路径扫描无输出；
- 试验服务已经停止，8791 不再监听。

默认并行全量测试曾因多个历史服务器测试共享仓库运行目录产生 2 个非确定性冲突；两个失败文件单独复跑均通过，使用 `--test-concurrency=1` 的完整 342 项回归也通过。本轮知识代码没有修改相关媒体或工作区测试。

本报告及全部评测 artifact 均不授予批准、发布、生产默认或知识晋升权限。
