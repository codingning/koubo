# 受控多 Agent v1 验收报告

日期：2026-07-23
分支：`codex/koubo-multi-agent-implementation`
生产结论：**不批准多 Agent 视觉候选进入生产；Visual Director v4 继续作为默认和回退。**

> 后续状态：本报告封存第一评测周期，不会改写。第二评测周期已修复这里记录的两项视觉阻断并通过盲审前预检，详见 `docs/acceptance/multi-agent-v2-blind-review.md`。用户盲审完成前，生产结论仍不变。

## 执行摘要

本轮完成了可长期积累的底层闭环，但没有伪造“多 Agent 已经比 v4 更好”：

- 冻结并复核 3 个真实历史样本；
- 完成 8 种 schema、SQLite/JSON、事件、迁移和回滚；
- 完成 Caption、Motion、Sound、Director、Blind Critic、Retention Critic 六个受控角色；
- 一条本人生成的合法教程夹具完成摄取、三种技法复刻、QA、试用、夹具人工批准、两项目晋级、回滚和再次晋级；
- 为 3 个样本各生成 1 个控制轨与 2 个结构候选，共 9 条验收视频、9 张联络表；
- 9 条视频全部通过解码、时长、尺寸、帧率、H.264、AAC、yuv420p、BT.709、音频峰值、黑帧和相对冻结回归；
- 人工联络表检查发现系统性可读性问题，因此阻止最终主观盲审和生产接入。

本地权威证据位于忽略目录：

```text
.cache/multi-agent-acceptance/20260723-v4/
  acceptance-manifest.json
  visual-inspection.json
  memory-lifecycle-evidence.json
  blind-map-private.json
  blind-review/
  samples/
  tutorial-recreations/
```

这些文件含视频和本地运行证据，不提交 Git；本报告只保留可维护摘要和哈希化结论。

## 基线

冻结清单：`config/evaluation/baseline-v1.json`

| Job | 原管线 | 覆盖 | 冻结状态 |
| --- | --- | --- | --- |
| `20260716100244-18cd59` | legacy FFmpeg v3 | 方法、字幕、旧任务兼容 | 3 个权威文件哈希复核通过 |
| `20260721132116-0831f6` | legacy FFmpeg v3 + 富媒体审核 | 真实证据、字幕、动效、方法 | 12 个权威文件哈希复核通过 |
| `20260722102313-1dbfa9` | Visual Director v4 | 真实证据、动效、v4 阶段门 | 8 个权威文件哈希复核通过 |

冻结清单没有因验收得分被改写。

## 教程与记忆闭环

合法夹具：

- 内容哈希：`f8252fd28a5e75821c03c12e38e0cfb1d4b58c3c4ac1e93f8858de153da22799`
- 9 秒、3 个镜头、本人生成、sidecar 转录和技巧数据；
- 原视频未复制进记忆库。

复刻结果：

| 命名空间 | Primitive | 结果 |
| --- | --- | --- |
| `caption.private` | `caption-pop` | HyperFrames lint/validate/inspect/render 与媒体 QA 通过 |
| `motion.private` | `element-slide` | HyperFrames lint/validate/inspect/render 与媒体 QA 通过 |
| `sound.private` | `sfx-cue` | HyperFrames lint/validate/inspect/render 与媒体 QA 通过 |

治理证明：

```text
recreated
→ trial
→ fixture human approval（明确标注，不冒充用户）
→ 两个不同 fixture project trial
→ promoted
→ 专家检索与提案引用发生变化
→ 回滚 promotion 和 approval
→ 检索与提案恢复到学习前
→ 再次 approved / promoted
```

3 个技巧最终均为 `promoted`。共记录 15 次受治理 transition；`rollbackRestored=true`。

## A/B 媒体结果

每个样本使用：

- 同一个冻结源片段；
- 同一 1280×720、30 fps；
- 同一 FFmpeg H.264/AAC 编码路径；
- 同一语音轨；
- 同一技术 QA；
- 结构候选而非换色候选。

候选结构：

1. Frozen control；
2. Caption pulse：底部三拍字幕、关键词强调、进度轨和语义音效；
3. Evidence rail：左信息轨、右侧原画面、逐步证据卡和低频语义音效。

自动技术结果：

| 指标 | 结果 |
| --- | --- |
| 视频数 | 9 |
| 完整解码 | 9/9 |
| 时长、尺寸、30 fps | 9/9 |
| H.264 + AAC + yuv420p | 9/9 |
| BT.709 VUI | 9/9 |
| 音频峰值 | 9/9 |
| 无新增长黑帧 | 9/9 |
| 不劣于控制轨的最长冻结 | 9/9 |
| 结构多样性 | 每个样本 3/3 pair meaningful |

人工联络表结果：

| 严重性 | 发现 | 影响 |
| --- | --- | --- |
| 阻断 | Evidence rail 的长句在 3/3 样本中溢出固定卡宽 | 可读性与信息层级失败 |
| 阻断 | Caption pulse 在已烧录字幕的冻结样本上叠加第二层字幕 | 字幕重复，不能公平代表替换方案 |
| 已披露 | 第一个历史夹具源长 14.2 秒，验收轨补到 15 秒 | 只适合兼容性，不适合主观质量胜负 |

因此没有请求用户做最终主观盲评，也没有把 `automatedPass` 当作最终视觉通过。

## 两轮证据修正

预运行兼容失败（不计质量迭代）：

- `20260723-v1`：当前 FFmpeg 不支持 `-filter_complex_script`；改为同一滤镜图直接传参。

初始媒体运行：

- `20260723-v2`：发现 BT.709 VUI 缺失、AAC 峰值和冻结比较方法错误。

第 1 轮：

- `20260723-v3`：加入 x264 BT.709 VUI；冻结从事件数改为最长时长相对控制；降低音频。
- 仍失败：`alimiter` 默认自动补偿，AAC 输出峰值为 −0.9 dB。

第 2 轮：

- `20260723-v4`：关闭 limiter 自动补偿；9/9 技术门通过。
- 手工联络表发现系统性字幕重复和长句溢出。

达到两轮上限后停止修改候选，不增加 Agent，不降低可读性门，不请求用户为已知失败材料背书。

## 15 条完成标准审计

| # | 标准 | 状态 | 权威证据 |
| ---: | --- | --- | --- |
| 1 | v4 基线仍运行 | 通过 | 原 verifier、60+ Node 测试、工作台在线/离线检查 |
| 2 | 固定 3–5 个样本 | 通过 | `baseline-v1.json`，3 个样本哈希复核 |
| 3 | 领域库、schema、事件、迁移、回滚 | 通过 | contracts/store/memory 测试 |
| 4 | 专家独立可导出记忆视图 | 通过 | namespace 检索和确定性导出测试 |
| 5 | 教程完成摄取到晋升闭环 | 通过（夹具） | `memory-lifecycle-evidence.json`；夹具审批明确披露 |
| 6 | 六角色完成最小 A/B | 通过（受控夹具 Critic） | orchestrator 测试、9 条候选和 Critic 记录 |
| 7 | 至少两种有意义候选 | 通过 | 3 个样本的结构签名和 pairwise diversity |
| 8 | 样片通过媒体 QA且不弱化门 | **未通过** | 技术 9/9；人工视觉 QA 发现阻断问题 |
| 9 | 晋升影响提案，回滚恢复 | 通过（夹具） | before/after/rollback proposal snapshots |
| 10 | 全版本追溯 | 通过 | candidate versions、事件、哈希和清单 |
| 11 | 依赖治理 | 通过 | research 文档、lock、许可证与退出方案 |
| 12 | 所有测试和真实媒体检查 | **未通过** | 自动测试通过；真实联络表检查失败 |
| 13 | 集中式最终材料 | 通过但不进入用户盲审 | 本地 manifest、9 个匿名媒体和本报告 |
| 14 | 无自动发布/泄密/覆盖历史 | 通过 | API 边界、redaction 测试、独立 run 目录 |
| 15 | 工作树干净并可继续维护 | 提交后复核 | 本文档、运维文档和分阶段提交 |

最终目标不能标记为完成，因为第 8、12 条未满足，最终用户盲审也未触发。

## 保留成果

即使视觉候选暂不进生产，下列成果可以安全长期使用：

- 冻结基线；
- 版本化领域库、事件、迁移与回滚；
- 专家私有命名空间；
- 教程摄取、复刻和授权边界；
- 受控提案与 v4 逐项回退；
- 匿名 A/B、Critic 契约与评分门；
- 工作台影子实验和人工记忆治理。

## 下一评测周期的唯一推荐方向

不要增加更多 Agent。下一周期先解决渲染和排版两件事：

1. 从原始时间线/无烧录字幕母版重新渲染候选，不能把新字幕叠加在已有字幕上；
2. 在渲染前增加真实字体测量、自动换行、卡片高度扩展和遮挡检测。

这应作为新的评测周期和新的两轮上限，而不是继续修改本轮已经封存的结果。
