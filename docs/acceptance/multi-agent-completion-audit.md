# 受控多 Agent 最终完成审计

日期：2026-07-23
分支：`codex/koubo-multi-agent-implementation`
审计对象：用户持续目标中的 15 条完成标准
当前结论：**15 条均已有可复核证据。真实口播主观审核的结果是 3/3 全组不合格，因此本目标以“受控基础设施完成、创意渲染不批准扩大、v4 保持默认”的负向生产决策收口，而不是伪造多 Agent 质量提升。**

## 判定边界

- 自动化技术门只能证明媒体可用、流程可复现和权限边界有效，不能证明多 Agent 成片主观上优于 v4。
- 结构差异成立不等于风格值得保留。
- 用户可以对每组三个候选选择“全组不合格”；系统不得为了完成目标强迫选出优胜者。
- 主观结果写入后仍保持 `productionApproval=false`、`autoPublish=false`、`memoryPromotion=false`。
- 第二评测周期 `20260723-cycle2-v1b` 含两个合成样本且协议强制选优，已废弃其主观结论，只保留技术证据。

## 15 条完成标准逐项审计

| # | 完成标准 | 状态 | 权威证据与边界 |
| ---: | --- | --- | --- |
| 1 | Visual Director v4 仍能运行并通过原有验证 | 已证明 | `tests/baseline/freeze_evaluation_baseline.test.mjs`、工作台回归、API 的 v4 默认与故障回退测试均通过；多 Agent 保持 opt-in。 |
| 2 | 固定 3–5 个代表性评测样本 | 已证明 | `config/evaluation/baseline-v1.json` 固定 3 个历史 job、权威文件和 SHA-256；测试拒绝来源变化后静默覆盖。 |
| 3 | 领域库、版本化 schema、事件、迁移和回滚 | 已证明 | 8 类 schema、SQLite + canonical JSON、校验和迁移、append-only events、乐观哈希和 transition rollback 均有单元/集成测试。 |
| 4 | 专业 Agent 有独立、可导出、可审计的记忆视图 | 已证明 | Caption、Motion、Sound 使用隔离 namespace；确定性导出会剔除秘密字段和原始媒体；跨 namespace 检索被测试拒绝。 |
| 5 | 教程完成摄取、提取、复刻、QA、试用和晋升/淘汰闭环 | 已证明（合法夹具） | 本人生成的合法教程夹具完成 source hash、分镜、转录检查点、3 种 primitive 复刻、HyperFrames/媒体 QA、两个不同项目试用、明确夹具人工批准、晋升、回滚与恢复；夹具身份没有冒充用户批准。 |
| 6 | 六个角色完成最小 A/B 管线 | 已证明（影子模式） | Caption、Motion、Sound、Director、Blind Critic、Retention Critic 均有结构化契约、调用上限、隔离、超时/重试和 v4 回退测试；提案、组合、匿名 bundle 和双 Critic 链路可运行。真实渲染仍是固定验收适配器，因此本项只批准影子实验，不代表生产接管。 |
| 7 | 同一输入稳定生成至少两种有意义候选，不是随机换色 | 已证明（结构层，不批准质量） | diversity gate 会拒绝仅换色方案；两个挑战轨在布局、字幕节奏、卡片和声音结构上有确定性差异。用户确认这些差异的实际呈现过弱，故它们满足“不是随机换色”的实验门，但不满足生产质量门。 |
| 8 | 所有样片通过现有媒体技术 QA，且不削弱人工审核门 | 已证明（技术层） | 当前真实口播审核 9/9 完整解码、9/9 QA JSON 通过，原始母版与控制片哈希一致；人工门实际阻止了 3/3 不合格组进入生产。 |
| 9 | 记忆晋升影响后续提案，降级/回滚恢复旧行为 | 已证明（合法夹具） | before / promoted / rollback proposal snapshots 与 `rollbackRestored=true` 证明检索和提案发生可解释变化并可恢复。 |
| 10 | Agent、模型、提示词、记忆、素材、配方、评测和代码版本可追溯 | 已证明 | proposal/event/manifest 记录版本、内容哈希、引用和时间码；冻结清单与 blind map 将匿名候选映射回具体配方，同时不向评审页泄露身份。 |
| 11 | 第三方依赖有许可证、安全、维护、兼容和退出方案 | 已证明 | `docs/research/2026-07-23-multi-agent-dependency-lock.md` 固定 OpenAI Agents SDK、PySceneDetect、Promptfoo、HyperFrames 的版本、许可证、用途、边界和退出路径；本地领域库保持权威。 |
| 12 | 工作台、单元、集成、回归和真实媒体检查全部通过 | 已证明 | 本次审计新鲜运行：Node 90/90、Python 5/5、Promptfoo 2/2、工作台 159 个控件引用、真实审核视频 9/9 解码及 9/9 QA 全部通过。 |
| 13 | 生成集中式最终验收材料，清楚展示差异、收益、失败和剩余风险 | 已证明（负向结论） | `20260723-real-subjective-v1` 提供 3 组真实口播、每组 3 个匿名候选、单一审核问题和“全组不合格”。用户提交 3/3 全组拒绝；解盲、实帧和代码复核确认两个挑战轨动效过弱、字幕非实时、固定验收配方未达到 v4 完成度。收益是验证了审核门能阻止退化方案；剩余风险和禁止扩大结论已记录。 |
| 14 | 无自动发布、泄密或覆盖历史产物 | 已证明 | API、评审结果和测试明确禁止自动批准/发布/晋升；loopback 服务不暴露 private blind map；redaction 测试通过；每次运行使用不可覆盖目录。 |
| 15 | 工作树干净、必要更改分阶段提交、文档可接续 | 已证明 | 实现位于独立 `codex/` 分支和 worktree；功能按可回滚阶段提交；本工作流、三份验收报告、依赖决策、设计和实施计划形成接续文档。 |

## 本次新鲜验证证据

```text
node --test tests/baseline/*.test.mjs tests/multi-agent/*.test.mjs
结果：90 passed, 0 failed

.\.runtime-multi-agent\Scripts\python.exe -m unittest discover -s tests/python -v
结果：5 passed

node scripts/verify_workbench.mjs
结果：159 个页面控件引用有效

npx -y promptfoo@0.120.0 eval -c config/evaluation/promptfooconfig.yaml
结果：2 successes, 0 failures, 100%

真实审核媒体独立复核
结果：9/9 完整解码；9/9 technicalPass；source/control SHA-256 均与 manifest 一致

本地评审服务
结果：index.html = HTTP 200；blind-map-private.json = HTTP 404
```

## 最终主观结果

权威运行：

```text
.cache/multi-agent-subjective-review/20260723-real-subjective-v1/
```

权威状态：

```text
manifest.status = subjective-review-recorded
subjective-review-record.json = 已写入且不可覆盖
outcome = subjective-rejection-recorded
rejectedSamples = 3
selectedSamples = 0
recordHash = 2391641cfec37bcc7ca370514e912c5ac06456fd560f29d28c29c99a16ec2fb6
```

用户反馈指出，v4 可从成熟视觉系统中被识别，两个挑战轨没有足够可感知的动效，字幕也不是实时跟随。解盲和接触表支持该判断；渲染代码进一步暴露出固定验收配方没有接入 Director 的实际提案，也没有达到 v4 等价包装层级。

这次失败没有被删除或平均掉，而是写入：

```text
data/multi-agent/library/production-event/
  production.subjective-review.20260723-real-subjective-v1.json
contentHash = 78fb6396aaf645440621303855ca27e4a3f81027d64faf2fc5db0cc526e51f0e
```

最终决策：

1. 不批准 `caption-pulse`、`evidence-rail` 或 `controlled-multi-agent-v1` 创意渲染进入生产；
2. 不执行第三轮风格粉饰，遵守两轮有证据迭代上限；
3. Visual Director v4 保持默认和唯一故障回退；
4. 保留领域库、教程闭环、角色隔离、提案、Critic、评测、工作台和回滚基础设施；
5. 未来若重启实验，先接通 Director 提案到 v4 等价渲染和逐字字幕时间轴，再建立新的冻结评测周期。
