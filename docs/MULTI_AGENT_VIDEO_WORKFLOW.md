# Koubo 受控多 Agent 视频工作流

## 当前定位

`controlled-multi-agent-v1` 是 Visual Director v4 旁边的可关闭影子实验，不是新的默认生产管线。

- v4 继续拥有任务状态、阶段门、超时、重试、渲染、版本、最终批准和发布边界。
- Caption、Motion、Sound 只提案；Director 只组合；Blind Critic 和 Retention Critic 只评审。
- Agent 不能批准成片、发布、修改品牌骨架或晋升记忆。
- 新能力失败或关闭时，v4 可独立运行。
- 当前真实媒体验收未批准扩大到生产，原因见
  `docs/acceptance/multi-agent-v1-acceptance.md`。

## 架构

```text
Visual Director v4（生产总控）
  ├─ 冻结输入、逐字稿、已批准素材、QA 与审核门
  ├─ Caption Agent ─ caption.private
  ├─ Motion Agent  ─ motion.private
  ├─ Sound Agent   ─ sound.private
  ├─ Director      ─ 最多组合两个结构候选
  ├─ Blind Critic  ─ 隐藏作者、理由、提示词和顺序
  └─ Retention Critic ─ 必须给出时间码与观看理由

SQLite（权威索引和状态）
  ↕ 原子导出
JSON（审阅、迁移、Git diff）
  ↕
本地资产目录（复刻工程、截图、短样片和 QA）
```

## 固定依赖

| 组件 | 固定版本 | 用途 | 许可证 | 退出方案 |
| --- | ---: | --- | --- | --- |
| OpenAI Agents SDK | 0.18.3 | Python Agent 运行边界 | MIT | 回退现有 v4 / 直接调用兼容模型 |
| PySceneDetect | 0.7.1 | 本地镜头检测 | BSD-3-Clause | FFmpeg scene filter |
| HyperFrames | 0.7.68 | 技法隔离复刻与短样片 | Apache-2.0 | FFmpeg/ASS 与现有 v4 |
| Promptfoo | 0.120.0 | 离线提示词/结构回归 | MIT | Node 测试与固定夹具 |
| SQLite | Node 22 内置 | 权威本地状态和事件 | Public Domain | JSON 导出后迁移 |

版本、维护状态、兼容性、安全和候选取舍记录在
`docs/research/2026-07-23-koubo-multi-agent-open-source-landscape.md`。
Python 精确依赖在 `config/multi-agent/requirements.lock`。

## 启动与关闭

默认不启用写操作：

```powershell
node video/server.mjs
```

显式开启本地影子实验：

```powershell
$env:KOUBO_MULTI_AGENT_ENABLED = "1"
$env:KOUBO_MULTI_AGENT_DATA_ROOT = "data/multi-agent"
node video/server.mjs
```

关闭时移除 `KOUBO_MULTI_AGENT_ENABLED` 或设为 `0`，重启本地服务即可。关闭不会删除记忆或历史产物。

可选的教程允许目录使用 Windows 路径分隔符连接：

```powershell
$env:KOUBO_TUTORIAL_ROOTS = "F:\approved-tutorials;D:\self-created-lessons"
```

## 教程：从视频到候选记忆

教程必须是本人所有、明确授权或许可可用的本地文件。摄取不会复制原视频。

```powershell
$env:KOUBO_MULTI_AGENT_DATA_ROOT = "data/multi-agent"
$env:KOUBO_MULTI_AGENT_PYTHON = ".runtime-multi-agent\Scripts\python.exe"

node scripts/ingest_tutorial.mjs `
  --input "F:\approved-tutorials\lesson.mp4" `
  --author "作者或来源" `
  --license "self-created" `
  --resume
```

输出检查点后，在隔离环境复刻：

```powershell
node scripts/recreate_tutorial_techniques.mjs `
  --checkpoint "data\multi-agent\runtime\tutorial-ingest\checkpoints\<source-hash>.json" `
  --output ".cache\technique-reconstructions" `
  --data-root "data\multi-agent"
```

摄取链：

```text
来源哈希登记
→ PySceneDetect
→ 本地 sidecar / faster-whisper
→ 带时间码的技巧候选
→ inbox
→ 抽象复刻（不执行教程代码）
→ HyperFrames lint / validate / strict inspect / render
→ FFmpeg 技术 QA
→ recreated
```

允许的复刻 primitive 只有经过审计的六种；教程工程文件、字体、音效和代码不会被直接复制。

## 记忆治理

状态机：

```text
inbox → extracted → recreated → trial → approved → promoted
                    ↘ rejected / expired / disabled
```

关键约束：

- 自动提取只能进入 `inbox`。
- `trial` 前必须有复刻与媒体 QA。
- `approved` 必须有真实的人类审批证据。
- `promoted` 必须有两个不同项目的已批准试用记录。
- Agent 默认只读取 `approved` 和 `promoted`。
- `brand.core` 在 v1 完全不支持写入。
- 每次写入必须提交当前 `contentHash` 作为 `expectedHash`。
- 失败记录保留为负面记忆，不做静默删除。

本地 API 示例：

```text
GET  /api/multi-agent/memory
POST /api/multi-agent/memory/:kind/:id/extract
POST /api/multi-agent/memory/:kind/:id/recreate
POST /api/multi-agent/memory/:kind/:id/trial
POST /api/multi-agent/memory/:kind/:id/approve
POST /api/multi-agent/memory/:kind/:id/promote
POST /api/multi-agent/memory/:kind/:id/reject
POST /api/multi-agent/memory/:kind/:id/expire
POST /api/multi-agent/memory/:kind/:id/disable
POST /api/multi-agent/memory/:kind/:id/rollback
```

所有 POST 都要求 `Idempotency-Key`。人工批准/晋级还要求 `actor.type=human` 和完整证据。

## 提案、组合和评审

打开一个现有 job 后：

```text
POST /api/jobs/:id/multi-agent/proposals
POST /api/jobs/:id/multi-agent/ab
POST /api/jobs/:id/multi-agent/reviews
```

提案接口：

- 只读取 job 的逐字稿、当前计划和已批准素材元数据。
- 每个专家只拿到自己的 role input 和命名空间。
- 每个专家最多两个提案，超时重试一次。
- 引用不存在或哈希不匹配时，逐项回退 v4。
- Director 最多输出两个结构差异候选，不能带批准、发布或记忆晋升字段。

匿名评审：

- 必须有真实渲染的 SHA-256 `renderHash`。
- 隐藏候选 ID、作者、Agent、理由、提示词和提案顺序。
- Blind Critic 与 Retention Critic 都必须返回时间码。
- Retention Critic 不得执行“每秒一个效果”规则，并可标记必要停顿。

## 基线与验收

冻结样本：

```powershell
$env:KOUBO_VIDEO_JOBS_ROOT = "F:\code\koubo\video-jobs"
node --test tests/baseline/*.test.mjs
```

生成本地验收材料：

```powershell
node scripts/run_multi_agent_acceptance.mjs `
  --jobs-root "F:\code\koubo\video-jobs" `
  --run-id "YYYYMMDD-run"
```

验收器会：

1. 重算冻结清单哈希；
2. 运行合法教程摄取、复刻、试用、夹具审批、晋级、回滚和恢复；
3. 为每个冻结样本生成一个控制轨和两个结构候选；
4. 控制轨使用冻结完成成片，挑战轨从同一冻结 job 的原始母版和时间线零点重渲染；
5. 执行解码、时长、H.264/AAC、BT.709、响度、黑帧、冻结回归、实际字体宽度和覆盖几何检查；
6. 生成联络表、匿名媒体、Critic 记录和版本清单；
7. 只在媒体与人工视觉门都通过后进入最终主观盲审。

`.cache/multi-agent-acceptance/` 是本地忽略目录，不进入 Git。已完成的 run 不会被覆盖。

上面的运行用于技术基线、记忆闭环与渲染门。主观风格结论必须另行使用真实口播材料：

```powershell
node scripts/run_multi_agent_subjective_review.mjs `
  --jobs-root "F:\code\koubo\video-jobs" `
  --run-id "YYYYMMDD-real-subjective"
```

主观审核规则：

1. 只接受真实口播，不用合成 fixture 判断账号风格；
2. 每组写明一个审核重点和一个核心问题；
3. 允许选择“全组不合格”，不得强迫选出相对优胜者；
4. 至少给出一个分类原因或具体例子；
5. 字幕逐字准确性单独验收，不得把它伪装成已自动证明；
6. 匿名映射留在服务目录之外；
7. 主观结果不会自动发布或晋升长期记忆。

`.cache/multi-agent-subjective-review/` 同样是本地忽略目录，已完成的 run 不会被覆盖。

审核页用本地受控服务打开，避免要求用户手工传递 JSON：

```powershell
node scripts/serve_multi_agent_subjective_review.mjs `
  --run-root ".cache/multi-agent-subjective-review/YYYYMMDD-real-subjective" `
  --port 8766
```

服务只绑定 loopback，支持视频 Range 请求，只暴露 `review/` 下的页面和匿名媒体。`blind-map-private.json`、manifest 和最终记录不通过静态路由公开。`POST /api/subjective-review` 只记录一次经过校验的人类结果；不会批准生产、发布视频或晋升记忆。离线下载的审核 JSON 可用 `scripts/record_multi_agent_subjective_review.mjs` 导入，仍执行相同校验和不可覆盖门。

## 迁移、回滚和恢复

迁移文件位于 `video/multi-agent/migrations/`：

- 按序执行；
- 校验文件 SHA-256；
- 已应用迁移不可静默修改；
- v1 没有删除列、删除表或不可逆数据变换。

记忆回滚只允许最近且未被后续变更覆盖的 transition。回滚会恢复旧 JSON 与旧 `contentHash`，并追加 `memory_transition_rolled_back` 事件。

恢复顺序：

1. 关闭多 Agent 开关，继续使用 v4；
2. 检查 `events` 和 `transitions`；
3. 回滚最近 transition；
4. 从 `data/multi-agent/library/` 的 JSON 导出核对；
5. 必要时使用新数据库导入 JSON，不覆盖旧数据库。

不要删除 `memory.sqlite`、历史 JSON、原片或旧 job。

## 隐私和安全

- 服务只绑定 `127.0.0.1`。
- 多 Agent API 拒绝非 loopback 请求。
- 原视频不发给文本模型；确定性媒体处理保持本地。
- API 和导出会剔除 token、API key、Cookie、密码、私钥、raw media 等字段。
- 错误消息隐藏绝对本地路径和 secret-shaped 值。
- 第三方 tracing 未启用。
- 没有自动发布路由；真实任务最终批准仍由 v4 门控制。

## 当前生产决策

截至 2026-07-23：

- 数据层、记忆闭环、教程复刻、角色隔离、A/B、双 Critic、回滚和工作台影子模式均已实现并验证。
- 第一评测周期的编码技术门通过，但人工联络表发现候选字幕重复和证据卡长句溢出；该周期已按两轮上限封存。
- 第二评测周期 `20260723-cycle2-v1b` 已从冻结原始母版重渲染挑战轨，并加入实际字体测量、自动换行、动态卡片高度和几何门。
- 第二周期 9/9 技术门、6/6 挑战轨布局门及 6/6 Codex 人工视觉预检通过。
- 用户观看第二周期材料后指出九个候选均有不足，而且审核对象不清；由于其中两组是合成 fixture 且页面强制选优，第二周期只保留为技术证据，不形成主观风格结论。
- 新运行 `20260723-real-subjective-v1` 使用同一条真实口播的 S01、S04、S09 三个语义窗口，页面按钩子、方法解释和品牌可信度分别提问，并允许全组拒绝。
- 新运行 9/9 技术门、3/3 接触表预检和 9/9 浏览器媒体加载通过；在用户主观结论写入前，v4 继续作为默认和回退，多 Agent 不进入生产。

技术第二周期报告：`docs/acceptance/multi-agent-v2-blind-review.md`。

当前真实口播主观审核报告：`docs/acceptance/multi-agent-real-subjective-v1.md`。

15 条完成标准的最终逐项审计：
`docs/acceptance/multi-agent-completion-audit.md`。在真实口播主观记录写入前，持续目标保持未完成。
