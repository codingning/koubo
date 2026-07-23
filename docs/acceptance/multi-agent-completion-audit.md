# 受控多 Agent 最终完成审计

日期：2026-07-23
分支：`codex/koubo-multi-agent-implementation`
审计对象：用户持续目标中的 15 条完成标准
当前结论：**14 条已有可复核证据；第 13 条仍等待用户完成真实口播主观盲审，因此整个目标不能标记为完成。**

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
| 6 | 六个角色完成最小 A/B 管线 | 已证明 | Caption、Motion、Sound、Director、Blind Critic、Retention Critic 均有结构化契约、调用上限、隔离、超时/重试和 v4 回退测试；真实审核运行生成控制轨与两个挑战轨。 |
| 7 | 同一输入稳定生成至少两种有意义候选，不是随机换色 | 已证明（结构层） | diversity gate 会拒绝仅换色方案；当前候选在字幕节奏、布局/证据卡、动效和声音结构上有确定性差异。此项不代表用户已经认可其审美质量。 |
| 8 | 所有样片通过现有媒体技术 QA，且不削弱人工审核门 | 已证明（技术层） | 当前真实口播审核 9/9 完整解码、9/9 QA JSON 通过，原始母版与控制片哈希一致；页面允许全组拒绝，未提交主观结论时不能批准生产。 |
| 9 | 记忆晋升影响后续提案，降级/回滚恢复旧行为 | 已证明（合法夹具） | before / promoted / rollback proposal snapshots 与 `rollbackRestored=true` 证明检索和提案发生可解释变化并可恢复。 |
| 10 | Agent、模型、提示词、记忆、素材、配方、评测和代码版本可追溯 | 已证明 | proposal/event/manifest 记录版本、内容哈希、引用和时间码；冻结清单与 blind map 将匿名候选映射回具体配方，同时不向评审页泄露身份。 |
| 11 | 第三方依赖有许可证、安全、维护、兼容和退出方案 | 已证明 | `docs/research/2026-07-23-multi-agent-dependency-lock.md` 固定 OpenAI Agents SDK、PySceneDetect、Promptfoo、HyperFrames 的版本、许可证、用途、边界和退出路径；本地领域库保持权威。 |
| 12 | 工作台、单元、集成、回归和真实媒体检查全部通过 | 已证明 | 本次审计新鲜运行：Node 90/90、Python 5/5、Promptfoo 2/2、工作台 159 个控件引用、真实审核视频 9/9 解码及 9/9 QA 全部通过。 |
| 13 | 生成集中式最终验收材料，清楚展示差异、收益、失败和剩余风险 | **等待用户主观盲审** | `20260723-real-subjective-v1` 已提供 3 组真实口播、每组 3 个匿名候选、单一审核问题、分类原因和“全组不合格”。技术差异、既有失败及剩余风险已展示，但“哪些变化有收益、哪些全部失败”只能由用户观看后决定；当前没有 `subjective-review-record.json`。 |
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

## 唯一剩余门

权威运行：

```text
.cache/multi-agent-subjective-review/20260723-real-subjective-v1/
```

当前状态：

```text
manifest.status = awaiting-user-subjective-review
subjective-review-record.json = 不存在
```

用户只需在本地评审页观看三组样片，为每组选择 A、B、C 或“全组不合格”，给出至少一个具体原因，然后点击提交。提交后系统还需要：

1. 校验并写入不可覆盖的主观记录；
2. 根据盲映射汇总实际配方的收益、失败和剩余风险；
3. 再跑一次完整回归；
4. 更新本审计和生产结论；
5. 只有 15 条全部满足时，才把持续目标标记为完成。
