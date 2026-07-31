# Creator Vault Content Strategist Trial Suite v1 验收

日期：2026-07-31

## 最终结论

本轮 **未通过进入真实稿件试用的门槛**。

16 条 Creator Vault 内容原则继续保持 `trial`：

- 不进入 `approved`；
- 不进入 `promoted`；
- 不成为生产默认；
- 不进入 Script Agent 或真实稿件；
- 不声称 Content Strategist 已经因为知识库而变聪明。

## 固定门槛

套件在运行前冻结以下门槛：

| 指标 | 通过要求 | 最终结果 |
|---|---:|---:|
| Trial 稳定胜出方向 | 至少 4/5 | 0/5 |
| Trial 平均分提升 | 至少 +1.0 | +0.2 |
| 知识引用准确率 | 至少 90% | 100% |
| 两轮结论一致方向 | 至少 4/5 | 1/5 |
| 明显退化方向 | 0 | 1 |

因此最终建议固定为：

```text
keep_trial_and_do_not_advance
```

## 实验规模

- 固定真实方向：5 个；
- 每个方向重复：2 轮；
- Content Strategist 分析：20 次；
- 匿名盲评：10 次最终有效评审；
- Control：显式 `knowledgeContext.mode=none`；
- Trial：显式读取 Creator Vault，`includeTrial=true`、`topK=5`；
- 盲评不可见 A/B、Vault、知识 ID、引用和实验组身份；
- 引用准确性由确定性程序单独审核。

## 分方向结果

| 方向 | Control 均分 | Trial 均分 | 差值 | 两轮盲评 | 结论 |
|---|---:|---:|---:|---|---|
| 知识桥 | 8.0 | 7.5 | -0.5 | Control / Tie | 退化 |
| 开源 Skill 审计 | 7.5 | 8.0 | +0.5 | Tie / Trial | 不稳定 |
| 素材库接入 | 7.5 | 8.0 | +0.5 | Tie / Trial | 不稳定 |
| 失败经验回写 | 8.0 | 8.0 | 0 | Tie / Tie | 无增益 |
| 工作台真实证明 | 7.5 | 8.0 | +0.5 | Trial / Tie | 不稳定 |

Trial 在三类方向中各出现一次单轮胜出，但第二轮均未复现，因此不能算稳定收益。

## 真实退化证据

知识桥方向的一个 Trial 输出把共享事实：

> 16 条原则已导入 Creator Vault trial 且 doctor 通过

改写成：

> 其中已导入部分通过本地 doctor 检查

并进一步写成：

> 当前证据只能证明部分 trial 原则已导入

这不是文风差异，而是削弱并改变了已经提供的事实，因此盲评正确标记
`unsupported_claim`。对应原始 artifact：

`content-strategy.0de4092cd225.json`

## 引用审计

所有 Trial 输出的知识引用均通过确定性 ID 和可用集合校验，引用准确率为 100%。
但“引用正确”不等于“输出变好”。使用频率最高的知识为：

| 知识 | 引用次数 |
|---|---:|
| `manual-fallback-teaches-automation.v1` | 8 |
| `ai-generates-hypotheses-not-verdicts.v1` | 6 |
| `version-failures-and-results.v1` | 6 |
| `real-use-directs-next-version.v1` | 4 |
| `asset-survives-tomorrow.v1` | 3 |

`manual-fallback-teaches-automation` 在 10 个 Trial 输出中出现 8 次，说明当前检索容易让
宽泛的治理原则反复占据上下文，但没有形成稳定的分析质量提升。

## 评测器修正 lineage

第一版盲评过度隐藏了双方共同拥有的用户事实、证据摘要和约束，导致评审把已提供背景
误判成无证据断言。该版本的 10 个 artifact 保留为故障审计，不参与最终结果。

第二版只隐藏 A/B、Vault、知识引用和实验组身份，同时向评审提供双方完全相同的共享上下文。
20 份原始 Content Strategist 分析没有重跑，避免为了通过门槛而更换样本。最终表格只使用
第二版 10 次评审。

## 下一次修正方向

若继续改进，应修改知识检索与使用合同，然后复用同一套固定题目重新测试：

1. 增加“不得削弱或改写共享事实”的显式门禁；
2. 降低宽泛治理原则的重复召回，增加多样性与适用条件过滤；
3. 要求 Agent 说明知识带来了哪一个新增判断，不能只罗列原则；
4. 把反例和禁止条件与正文一同送入分析；
5. 仍使用同一五题、两轮和原门槛，不能换一套更容易通过的题。

## 证据位置

- 汇总：`data/acceptance/creator-vault-content-trial-suite-v1/SUMMARY.md`
- 机器结果：`data/acceptance/creator-vault-content-trial-suite-v1/summary.json`
- 完整 run：`data/acceptance/creator-vault-content-trial-suite-v1/run.json`
- 逐轮结果：`data/acceptance/creator-vault-content-trial-suite-v1/runs/`
- 20 份分析：`data/acceptance/creator-vault-content-trial-suite-v1/artifacts/content-strategy-analyses/`
- 20 份评审：`data/acceptance/creator-vault-content-trial-suite-v1/artifacts/content-training-evaluations/`

本报告及所有评测 artifact 均不授予批准、发布、生产默认或知识晋升权限。
