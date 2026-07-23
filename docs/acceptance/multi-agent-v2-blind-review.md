# 受控多 Agent v2 盲审前验收

日期：2026-07-23

分支：`codex/koubo-multi-agent-implementation`

权威本地运行：`.cache/multi-agent-acceptance/20260723-cycle2-v1b/`

当前结论：**自动媒体门和 Codex 人工视觉预检均已通过，可以请求一次集中式用户盲审；在盲审结论被记录前，Visual Director v4 仍是生产默认和唯一回退。**

## 为什么启动新周期

上一周期 `20260723-v4` 的 9 条视频通过编码技术门，但人工联络表发现：

1. 挑战轨在已烧录字幕的控制轨上再次画字幕；
2. Evidence rail 使用固定卡片和单行文本，长句越界。

上一周期已经达到两轮修正上限，因此结果被封存。本周期不是继续改写旧结果，而是针对已证实根因建立新的独立 run 和新的版本号。

## 根因与修复

### 挑战轨输入

旧数据流：

```text
冻结完成成片
→ 统一控制轨
→ 再叠加挑战字幕/卡片
```

新数据流：

```text
同一冻结 job
├─ 控制轨：冻结完成成片
└─ 挑战轨：baseline 中已记录 SHA-256 的原始母版，从时间线 0 开始重渲染
```

三个原始母版均已抽帧复核，不含烧录字幕。Day 2 和 v4 样片的现有构图清单也证明控制样片从 `data-media-start=0` / `sampleStart=0` 开始。

### 文本布局

渲染前使用 FFmpeg `drawtext` 加 `bbox`，以实际 `C:\Windows\Fonts\msyh.ttc` 和目标字号测量每个候选行：

- Caption pulse：最大 1040 px、最多 2 行；
- Evidence rail：最大 292 px、最多 3 行；
- 不截断原文；
- 超出行数预算直接失败；
- 卡片高度随实测行数增长；
- 文本右边界必须小于信息轨与画面分隔线；
- Caption pulse 的最高边界必须留在底部安全区。

这些值写入每条候选的 QA，不再使用恒为 `true` 的占位安全区判断。

## 验收结果

运行命令：

```powershell
node scripts/run_multi_agent_acceptance.mjs `
  --jobs-root F:\code\koubo\video-jobs `
  --run-id 20260723-cycle2-v1b
```

结果：

| 检查 | 结果 |
| --- | --- |
| 冻结基线哈希 | 通过 |
| 教程摄取、晋升、回滚 | 通过 |
| 3 个样本 × 3 个候选 | 9/9 生成 |
| 解码、时长、尺寸、帧率、编码、BT.709 | 9/9 通过 |
| 音频峰值、黑帧、冻结回归 | 9/9 通过 |
| 冻结原始母版来源门 | 6/6 挑战轨通过 |
| 实测文本宽度门 | 6/6 挑战轨通过 |
| 卡片/字幕几何门 | 6/6 挑战轨通过 |
| 结构多样性 | 每个样本 3/3 pair meaningful |
| Codex 人工联络表预检 | 6/6 挑战轨通过 |
| 用户主观盲审 | 待执行 |

人工视觉预检确认：

- 不再出现两层字幕；
- 三组 Evidence rail 长句均已换行，没有越界；
- 左侧证据卡没有压到右侧源画面；
- Caption pulse 保持在底部安全区；
- 代表帧中的文字均完整可见。

本地证据：

```text
.cache/multi-agent-acceptance/20260723-cycle2-v1b/
  acceptance-manifest.json
  visual-inspection.json
  memory-lifecycle-evidence.json
  blind-map-private.json
  samples/
  blind-review/
```

`blind-map-private.json` 不在盲审服务目录中。用户页面只包含匿名标签、媒体哈希和视频。

## 剩余完成门

现在只剩必须由用户完成的主观盲审：

1. 完整观看每个样本的三个匿名候选；
2. 每个样本选择一个最佳候选；
3. 至少写一个带时间码的理由；
4. 导出审核 JSON；
5. Codex 将结果写入验收清单，再判断多 Agent 是否真正改善，不能仅因新方案通过技术门就批准生产扩展。

盲审前不得改变：

- v4 生产默认；
- 自动发布禁令；
- 人工批准门；
- 长期记忆晋升门；
- 品牌骨架。
