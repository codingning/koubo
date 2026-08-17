# Agent 训练首批 Trial 准入完成报告

日期：2026-07-25

状态：`12_trial / 0_approved / 0_promoted / awaiting_real_clip_outcome_test`

## 结果

首批 Content、Caption/Motion、Sound、Director 共 12 项知识已完成第二级审核与本地试用登记。

- 9 项按原候选版本进入 `trial`：C1、C2、C3、M1、M2、S1、D1、D2、D3。
- 3 项依据用户“按建议改”的明确指令，以 v2 进入 `trial`：M3、S2、S3。
- 旧 M3/S2/S3 v1 只保留在审核 lineage 中，没有进入运行试用库。
- 用户不再审核难以理解的技术规则文本；以后只审核真实口播片段中的可感知效果。

## 权威绑定

- 审核号：`koubo-agent-training-batch-1-second-level-candidate-review-v2`
- 证据集合：`06a6c7844bc5befca665a972b4dee4264c8724c22f6ef03e42b4a027860adbe5`
- 决策哈希：`2631d1e130643b65e62d71e8c04724e51426447a1a8c0c411a85f86333d00a89`
- 版本化 catalog：`config/multi-agent/trials/agent-training-batch-1/trial-catalog.v3.json`
- catalog ID：`agent-training-batch-1-trial-catalog.v3`
- 技术语义哈希：`d7a632c4e0ffa5dc1dbd5e383e42c97c6f3d4a66a835076cc59e1b218ad4ba1d`
- catalog 哈希：`8ac77e0c6d89cab16d7df28aa1e6244fffe653f996c62a392d195dbed3d3aa65`
- catalog 文件 SHA-256：`c29c0e59f6ea8668f789a2f5189b9a0c5b6e69438082d102792ce34103f7189c`
- 稳定修改决议哈希：`b0df2da07851ef64ee737afb4b438e1cef0f34b31bd755af0b2a8782cefdba5b`
- 隔离运行库：`data/multi-agent/training-batches/agent-training-batch-1-trial-v3/`
- 首轮审核记录：`7deb9b8585ec09161604bd5d2ad1725065819ceb0b9d703344c08d4f12dd8804`
- 修改决议记录：`39bef0a1b2687d439ce32559f81486f9ce2539d924e31482057f7a4324f2a8ab`
- trial manifest：`88531c7935d0072b97c3e747cdc995384f29a180644da2eed383afb8dcccb5cd`

两份人类决策记录和 trial manifest 均采用不可覆盖写入；相同输出目录再次登记会直接失败，不覆盖旧结果。

本机较早生成的 `agent-training-batch-1-trial-v1` 与 `agent-training-batch-1-trial-v2` 已被 v3 取代，不得用于后续实验；二者保留为不可覆盖的故障审计，不删除、不晋升。v3 额外冻结 exact catalog snapshot，并把稳定人类决议哈希与技术规则语义哈希分开。

## 生命周期与可见性

每项均真实执行：

```text
inbox → extracted → recreated → trial
```

本批运行事实：

- technique-card：12 条；
- transitions：36 条；
- append-only events：48 条；
- library JSON：12 份；
- `approved`：0；
- `promoted`：0。

生产默认检索只读取 `approved/promoted`，因此当前默认返回 0 条。当前生产 orchestrator 尚未提供候选试验入口；下一阶段必须新增显式绑定 v3 batch/catalog 的隔离适配层，不能仅通过切换数据根把 `trial` 带入生产。

## 新增门禁

- 首批历史记录保留已发生的人审 lineage；未来 `trial` 可由 controller 在用户授权下提交 `technical-trial-admission`，不再要求用户审核规则页；
- 技术准入必须绑定 source/trial candidate、单条技术内容哈希、完整 technical catalog、来源、许可、沙盒 QA 和回滚；
- `approved` 只接受用户对真实口播片段的结果审核，并绑定输出版本、媒体 SHA-256 与转录 SHA-256；
- 修订候选的 resolution hash 必须等于 catalog 固定的稳定修改决议哈希，任意格式正确但内容不匹配的哈希会被拒绝；
- Content 与 Director 通过扩展后的 `technique-card.domain` 进入现有状态机，不新增第二套记忆框架；
- trial batch 先在临时目录完整生成，关闭 SQLite 后一次性改名，失败不会留下最终半成品目录；
- 所有记录保留 CAS、事件、transition 和最近一步回滚能力。

## 验证

- 新增 trial 专项与原审核、合同、memory、store 合跑：37/37 通过；
- acceptance 与 API 回归：39/39 通过；
- 全部 `tests/multi-agent/*.test.mjs` 加审核页回归：179/179 通过；
- Python 多 Agent bridge 与方向锁：13/13 通过；
- 真实运行库核对：`trial=12 / approved=0 / promoted=0 / transitions=36 / events=48 / libraryFiles=12`；
- 默认 Content Strategist 检索：0；显式候选检索：C1/C2/C3；
- Director 显式候选检索：D1/D2/D3/M3 v2；
- 重复执行记录器：拒绝覆盖；
- manifest canonical hash：通过。

## 未授予的权限

- 不修改生产 Agent 提示词；
- 不修改 v4 默认或故障回退；
- 不批准任何成片；
- 不晋升长期知识；
- 不改变品牌骨架；
- 不发布视频或操作抖音账号。

## 下一门

用户提供下一条真实视频方向后，仍按以下顺序：

```text
用户方向
→ Content Strategist 深入访谈与方向分析
→ 用户确认内容方向
→ 成稿与普通观众批评
→ 选择少量 trial 知识制作全新真实片段
→ 技术 QA
→ 用户只审核实际成片效果
```

只有具体技巧在真实片段中获得用户明确认可，才允许申请 `approved`。本批不得整体打包晋升。
