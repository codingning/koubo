# 真实口播主观验收 v1

日期：2026-07-23

分支：`codex/koubo-multi-agent-implementation`

权威本地运行：`.cache/multi-agent-subjective-review/20260723-real-subjective-v1/`

当前结论：**九个候选已经通过现有媒体技术门和页面预检，等待用户按三个明确问题进行主观审核。允许每组三个候选全部不合格；在主观结果记录前，Visual Director v4 仍是生产默认和唯一回退。**

## 为什么废弃上一版主观审核

用户对 `20260723-cycle2-v1b` 的反馈是：

1. 九个候选都能看到不足；
2. 页面没有说清每组究竟比较整体剪辑、字幕匹配还是其他内容；
3. “必须选一个最好版本”会把三个都不满意误记成相对偏好；
4. 三组材料中只有一组来自真实历史口播，其余两组是技术 fixture，不能支撑账号风格结论。

因此，上一运行继续保留其编码、布局、冻结源和记忆治理证据，但不再用于证明多 Agent 获得了主观提升。用户没有选择优胜者不是“审核失败”，而是验收协议暴露了混杂变量。

## 新协议

### 材料门

- 主观风格审核只接受 `real-talking-head`；
- 当前只有一个真实历史 job，故从同一条 178.7 秒真实口播中冻结三个不重叠语义窗口；
- 控制轨和挑战轨使用同一编辑时间线的相同起点与时长；
- 原始说话人母版和完成版控制轨都固定 SHA-256；
- 合成 fixture 仍可做技术测试，但不得进入主观风格结论。

### 三组只各问一个问题

| 样本 | 时间线 | 审核重点 | 核心问题 |
| --- | --- | --- | --- |
| S01 | 0.000–18.386 秒 | 钩子与结果证明 | 前三秒是否建立继续观看的理由，并让后面的结果证明可信？ |
| S04 | 51.716–71.716 秒 | 方法解释与步骤结构 | 输入规则是否被讲清楚、可执行，而且容易跟上？ |
| S09 | 146.099–165.547 秒 | 人工审核与品牌可信度 | 人工审核边界是否具体、可信，而且不像过度包装？ |

每组仍呈现三个匿名候选，但用户可以：

- 选择一个值得继续的候选；
- 选择“全组不合格”；
- 勾选信息、字幕表现、动效/卡片、声音节奏、模板感或账号匹配等原因；
- 写一处具体时间点，或直接写“全程”。

## 字幕验收边界

本轮不要求用户逐字校对字幕，也不声称字幕文本准确性已经被自动证明。

现有自动门覆盖：

- 解码、时长、尺寸、帧率与编码；
- 黑帧、冻结回归和音频峰值；
- 文本实际宽度与布局几何；
- 同一时间线片段和冻结源哈希。

字幕转写与实际口播是否逐字一致是另一道内容验收。页面对此明确披露；发现明显错字仍可在主观反馈中指出，但不会与本轮的整体剪辑偏好混为一个分数。

## 运行与结果

```powershell
node scripts/run_multi_agent_subjective_review.mjs `
  --jobs-root F:\code\koubo\video-jobs `
  --run-id 20260723-real-subjective-v1
```

结果：

| 检查 | 结果 |
| --- | --- |
| 冻结真实源和控制轨哈希 | 2/2 通过 |
| 真实语义样本 | 3/3 |
| 候选生成 | 9/9 |
| 每条候选技术 QA | 9/9 通过 |
| 接触表视觉预检 | 3 组通过，无文字越界 |
| 页面文本和控件检查 | 通过 |
| 浏览器媒体加载 | 9/9，`readyState=4`、无媒体错误 |
| 浏览器控制台 | 无 warning/error |
| 用户主观审核 | 待执行 |

本地审核页：

```text
http://127.0.0.1:8766/index.html
```

本地一键审核服务：

```powershell
node scripts/serve_multi_agent_subjective_review.mjs `
  --run-root ".cache/multi-agent-subjective-review/20260723-real-subjective-v1" `
  --port 8766
```

服务只绑定 `127.0.0.1`。页面提交时会重新校验 run ID、真实样本、匿名标签、媒体哈希、决定和理由，然后生成不可覆盖的 `subjective-review-record.json` 并更新 manifest。重复提交返回 `409`。提交结果明确保持：

- `productionApproval: false`
- `autoPublish: false`
- `memoryPromotion: false`

如果本地服务不可用，页面才会下载 JSON 作为兜底。也可以在恢复服务后显式导入：

```powershell
node scripts/record_multi_agent_subjective_review.mjs `
  --run-root ".cache/multi-agent-subjective-review/20260723-real-subjective-v1" `
  --review "C:\path\to\koubo-subjective-review-20260723-real-subjective-v1.json"
```

本地证据：

```text
.cache/multi-agent-subjective-review/20260723-real-subjective-v1/
  subjective-manifest.json
  blind-map-private.json
  subjective-review-record.json  # 用户提交后才出现
  samples/
  review/
```

`blind-map-private.json` 位于服务目录之外。用户页面只包含匿名标签、媒体哈希、明确审核问题和可拒绝选项。

## 仍然不能声称的结论

- 技术门通过不等于多 Agent 的成片更好；
- 三个样本来自同一条真实 job，不能代表全部未来题材；
- 新候选是受控风格原型，不是经过用户批准的长期模板；
- 未获得用户主观结果前不得批准生产扩展、晋升记忆或自动发布；
- 即使某个候选胜出，也只能晋升通过审核的具体做法，不能把整个配方自动固化。

15 条完成标准的最新逐项证据见
`docs/acceptance/multi-agent-completion-audit.md`。当前唯一未闭合项是本页所述的用户主观盲审。
