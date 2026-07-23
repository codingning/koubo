# 真实口播主观验收 v1

日期：2026-07-23

分支：`codex/koubo-multi-agent-implementation`

权威本地运行：`.cache/multi-agent-subjective-review/20260723-real-subjective-v1/`

当前结论：**用户已将三组候选全部判为不合格。两个挑战轨没有达到 v4 的可感知动效、实时字幕和整体包装完成度，因此不批准多 Agent 创意渲染进入生产；Visual Director v4 继续作为生产默认和唯一回退。**

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
| 用户主观审核 | 3/3 全组不合格 |

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

## 用户结果与解盲

用户在 2026-07-23 提交了不可覆盖记录：

```text
outcome = subjective-rejection-recorded
rejectedSamples = 3
selectedSamples = 0
recordHash = 2391641cfec37bcc7ca370514e912c5ac06456fd560f29d28c29c99a16ec2fb6
productionApproval = false
autoPublish = false
memoryPromotion = false
```

三组反馈一致：

> v4 很容易被识别；另外两个候选没有看到足够的动效，字幕也不是实时跟随。

解盲后，每组都包含 `frozen-control`、`caption-pulse` 和 `evidence-rail`，只是 A/B/C 顺序不同。因此拒绝不是固定标签造成的；同时，v4 的成熟视觉身份让用户能够从画面反推出控制轨，匿名协议只能隐藏元数据，不能消除这种风格识别。

接触表和渲染代码复核支持用户判断：

- `caption-pulse` 只有进度条、三个固定时间点的短字幕和轻微上移动画，不是逐字实时字幕；
- `evidence-rail` 只有静态分栏、三个分段卡片显隐和进度线，不具备 v4 的标题、摘要、事实卡、真实证据和多阶段动效；
- 两个挑战轨来自固定 FFmpeg 验收配方，而不是以 v4 等价完成度渲染 Director 组合后的实际提案；
- 技术 QA 只证明文件可解码、布局未越界和音视频参数合格，不能证明动效丰富度或剪辑完成度。

该拒绝已写入本地权威领域库：

```text
production-event/production.subjective-review.20260723-real-subjective-v1
contentHash = 78fb6396aaf645440621303855ca27e4a3f81027d64faf2fc5db0cc526e51f0e
```

事件只适用于本次真实 job 的三个窗口。它禁止 `caption-pulse` 和 `evidence-rail` 进入生产，但不会把本次窗口的拒绝夸大为 v4 全局失败，也不会自动禁用通用技巧或晋升长期记忆。

## 最终生产结论

- 不批准 `controlled-multi-agent-v1` 创意渲染进入真实生产；
- 不进行第三轮风格粉饰，遵守两轮有证据迭代上限；
- Visual Director v4 继续作为默认生产与故障回退路径；
- 保留已验证的领域库、教程摄取、记忆治理、角色隔离、提案、Critic、评测、工作台影子模式和回滚能力；
- 下一次若重启创意渲染实验，必须先解决“Director 提案到 v4 等价渲染”的集成缺口，并建立逐字字幕时间轴；不能继续沿用本轮两个固定验收配方。

## 仍然不能声称的结论

- 技术门通过不等于多 Agent 的成片更好；
- 三个样本来自同一条真实 job，不能代表全部未来题材；
- 本轮没有任何候选胜出，不能声称多 Agent 改善了成片质量、风格多样性或留存；
- 已验证的是受控基础设施和失败时安全回退，不是多 Agent 创意渲染的生产可用性；
- 用户拒绝不得触发自动发布、自动晋升或品牌骨架变化。

15 条完成标准的最新逐项证据见
`docs/acceptance/multi-agent-completion-audit.md`。
