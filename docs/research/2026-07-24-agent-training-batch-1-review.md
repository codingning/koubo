# Koubo Agent 知识训练首批第二级候选审核包

> 历史说明：本页记录首批 12 项曾使用的技术规则审核过程。2026-07-25 起不再把此类页面交给用户；未来由 Codex 完成技术准入，用户只审核真实口播片段和成片效果。

日期：2026-07-24
状态：`ready_for_second_level_candidate_review / real_clip_trial_admission_only / no_knowledge_promotion`
来源批准：用户明确回复“首批全部确认”
用途：保存首批 12 条候选知识、原创复刻证据和当时已发生的用户决定，作为历史审计；不再作为未来用户操作入口。

## 审核边界

- 首批来源批准只授权完整取证、蒸馏和原创沙盒复刻，不等于接受作者观点。
- 当前所有条目仍为 `Candidate`；通过沙盒后最高只进入 `Recreated`。
- 本批历史上曾经过用户第二级审核；未来批次改由 Codex 完成内部技术准入。即使进入 `trial`，也不修改 Agent 提示词、默认引擎、品牌骨架或长期知识状态。
- 原作者的原句、案例、人设、画面、教程代码、模板、字体、音效和素材均不进入 Koubo。
- HyperFrames、Remotion、FFmpeg 或组合路径由 Director 按当前镜头的同步、可复用组件、确定性、性能、兼容性和回滚成本选择，不设历史默认胜者。

## 四组候选总览

| 审核号 | `candidateId` | `candidateContentHash` | 解决的问题 | 验证方式 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| C1 | `content-principle.one-primary-audience-payoff.v1` | `b30bc2b9dcafc663c116fcaa042978bce53b10ee7022f167023d4136e5baf015` | 只讲创作者做了什么，观众收益不清楚 | 场景 3/3 通过 | Candidate |
| C2 | `content-principle.opening-creates-audience-contract.v1` | `eebac515f23b42f7478a629f5542478d656798fac0a58dbac87b858ff69cb3bf` | 开头承诺与后文错配 | 场景 3/3 通过 | Candidate |
| C3 | `content-principle.voice-source-before-verbatim-draft.v1` | `3d7fc71d9d573bdb9527c86a97c1f90c5424b897f80b99994201fb3df3baa003` | AI 标准稿覆盖创作者本人语言 | 场景 3/3 通过 | Candidate |
| M1 | `caption-technique.pause-aware-follow-caption.v1` | `ed96ac4905231091e9d58b883bb47db982b7edbf3c10550d27265ef7c9c830b9` | 停顿时字幕高亮仍机械前进 | 原创离线样片与暂停帧哈希通过 | Candidate；技术上可 Recreated，未迁移 |
| M2 | `motion-technique.semantic-layout-router.v1` | `1e4f8e71a12ad32111c0f46f4a2e3468094c2097590f6d639dd64107bc1dd07c` | 先套模板再硬塞内容 | 三种语义结构样片与无剧透检查通过 | Candidate；技术上可 Recreated，未迁移 |
| M3 | `director-technique.plan-preview-promote-gates.v1` | `0e474ec4e86f18b12ee47f21c3d19b3e9c5507990d63cc6638f165c8422b4ce6` | 一句需求直接全片并自动固化经验 | 场景 3/3 通过 | Candidate |
| S1 | `sound-technique.mix-gain-guardrail.v1` | `e96b89b5bd626a5894c8df7ca785f03fd305315b6f086b24aa803f1655c0c451` | 固定滑块比例与总线真峰值失控 | 程序化三 stem 混音 QA 通过 | Recreated candidate；未迁移 |
| S2 | `sound-technique.speech-aware-ducking.v1` | `6584b3b614250341ef999386c7fc85924d3543f1080fc07f47c8aeb7ad3729dc` | 人声与音乐争抢可懂度 | 同 stem、时间对齐、等响度 A/B/C 通过 | Recreated candidate；未迁移 |
| S3 | `sound-technique.semantic-sfx-cue.v1` | `b3abaf8937d279213408998e8df28e618e693988bc2ba87864914c57142bcf42` | 音效按模板或固定间隔堆叠 | 三个程序化语义 cue 与峰值门通过 | Recreated candidate；未迁移 |
| D1 | `director-principle.freeze-structure-before-packaging.v1` | `fddc8e950e7accd93ff8895e36574a6b383e4c3f887aec8c595c57be8e7d716d` | 内容未稳定就投入昂贵包装 | 场景 3/3 通过 | Candidate |
| D2 | `director-principle.semantic-role-before-effect.v1` | `de09efba9fa3df8bf347adae4ec92d4ddb62bd65dcb649efc24a15580d0f999a` | 剪辑由效果名而非表达功能驱动 | 场景 3/3 通过 | Candidate |
| D3 | `director-principle.offer-choices-then-freeze-after-evidence.v1` | `e070692df0de70aa3d891c7ef99d42abae3d142637c0670c27846947bd64b4ed` | Agent 猜审美并在首版固化 | 场景 3/3 通过 | Candidate |

12 项内容哈希共同绑定为 `evidenceSetHash`：`06a6c7844bc5befca665a972b4dee4264c8724c22f6ef03e42b4a027860adbe5`。标题、摘要、边界、建议、场景或媒体证据任一变化都会改变对应内容哈希，并使旧的浏览器本地选择失效。

## 重叠关系，避免重复训练

- C2 负责“内容承诺”，D2 负责“剪辑动作的表达职责”；二者相邻但权限不同。
- M2 是 D2 在画面结构层的具体实现，不应各自演化成两套冲突路由。
- M3 提供生产门禁证据，D1/D3 分别约束“何时冻结结构”和“何时允许固化”；M3 不单独拥有批准或晋升权限。
- S1 是 S2/S3 的安全底座；ducking 或 cue 通过主观试听前，也必须先通过整片响度和真峰值门。

## 已完成来源研究

- 内容策略：`docs/research/2026-07-24-content-strategy-training-batch-1.md`
- 字幕与动效：`docs/research/2026-07-24-motion-caption-training-batch-1.md`
- 声音：`docs/research/2026-07-24-sound-training-batch-1.md`
- Director：`docs/research/2026-07-24-director-training-batch-1.md`

四组均完成完整媒体冻结、转录和哈希记录；原媒体与完整转录只保留在系统临时研究目录，不进入 Git。

## 原创复刻与 QA 结果

### 内容与 Director 场景沙盒

- 7 条原则，每条含适用、阻断、反例/退化三类场景，共 21 个。
- 实际分类：`applicable 7 / blocked 7 / degraded 7`，全部与 fixture 预期一致。
- 场景集合 SHA-256：`1d62e3c36902a1fd325fe955fbcbe3d1dd1486fef6135448be121966c3716759`。
- 整组拒绝 SHA-256：`0722d5783a936d3540d85628eec6a35cd8088b3c57622650df3eaa399a636fb3`。
- 场景沙盒不读取模型、数据库、生产配置或 Agent prompt；输出不含批准、发布、晋升或优胜者字段。

### Motion M1：暂停感知字幕

- 视频：[render.mp4](F:/code/koubo/.cache/technique-reconstructions/2026-07-24-motion-batch-1/pause-aware-follow-caption/render.mp4)
- SHA-256：`0bba6104daef0a572feafc49c5321ea92854e3ded46b2068d4a9356fa021d781`
- 6.300 秒，1080×1920，30 fps，H.264/yuv420p/BT.709，完整解码通过。
- `2.12` 与 `2.62` 秒位于同一暂停区间，两张可寻址源 PNG 的 SHA-256 完全相同：`e972791ebd57f6b74e07973b10e5165847529543db0f297860f23bfa304a9716`。
- HyperFrames `0.7.70` strict check：runtime/layout/motion/contrast 全通过；63/63 对比度检查通过。

### Motion M2：语义布局路由

- 视频：[render.mp4](F:/code/koubo/.cache/technique-reconstructions/2026-07-24-motion-batch-1/semantic-layout-router/render.mp4)
- SHA-256：`8fcef2cb838e829a47d9ef137ca95da9dd0f822c3bbddea390939e27aa0d7c0a`
- 7.400 秒，1080×1920，30 fps，H.264/yuv420p/BT.709，完整解码通过。
- 单重点、步骤、真实证据依次出现；三张快照只显示当前结构，后续内容和标签不提前出现。
- HyperFrames `0.7.70` strict check：runtime/layout/motion/contrast 全通过；38/38 对比度检查通过。

### Sound S1/S2/S3：同 stem 对照

固定目录：`F:\code\koubo\.cache\agent-training-batch-1\sound\variants`

| 版本 | 文件 | MP4 SHA-256 | LUFS | 真峰值 |
| --- | --- | --- | ---: | ---: |
| A 无避让 | `A-no-duck.mp4` / `A-no-duck.wav` | `e79b33b6d0bfcf498c0d2ccc17588d6ac39f284a8e966196dfa21bbaed413ec2` | -16.19 | -2.50 dBTP |
| B 全带 duck | `B-fullband-duck.mp4` / `B-fullband-duck.wav` | `29c8e09abf34070f27f4dd53eaba0fe5d7c020efc5bd7f5f463160d246978cb3` | -16.19 | -2.50 dBTP |
| C duck + 实测频谱让位 | `C-duck-spectral-slot.mp4` / `C-duck-spectral-slot.wav` | `2ecde1f398c1cc5712332a07f0de144982d093391205d3e0a9dd7d4ca160595e` | -16.23 | -2.50 dBTP |
| S C + 三个语义 cue | `semantic-sfx-cue.mp4` / `semantic-sfx-cue.wav` | `c03b8d61554d73ffbe8402cab3ac5321354760441db2a403cb47ccb22c9beaf8` | -16.22 | -2.50 dBTP |

- A/B/C 使用相同 voice、BGM 和时间线哈希；最大等响度差为 0.04 LU。
- B 的人声活动窗口 BGM 衰减估算为 7.668 dB。
- 本轮实测冲突频带为 760 Hz，不是照抄教程的 300 Hz；C 额外削减 4.217 dB。
- S 的三个 cue 分别绑定语义转折、视觉落点和章节转场；最大并发 1，最小净间隔 3400 ms。
- 四个 MP4/WAV 均完整解码，允许用户选择任何版本或整组拒绝。

## Codex 逐项建议

这里的“保留”只表示进入下一步真实口播片段试用，不表示生产晋升。

| 审核号 | 建议 | 理由或修改边界 |
| --- | --- | --- |
| C1 | 保留进入试用 | 能直接阻止“只汇报我做了什么”；保留娱乐、陪伴、审美等非工具收益例外。 |
| C2 | 保留进入试用 | 对应此前“钩子没有因果桥”的真实失败；不把它误解为每秒塞信息。 |
| C3 | 保留进入试用 | 符合用户先深聊方向再成稿的要求；高风险事实和无障碍场景仍可使用逐字稿。 |
| M1 | 保留进入试用 | 暂停保持已真实复刻；真人语音中逐字、短语或句级粒度仍需按 ASR 置信度选择。 |
| M2 | 保留进入试用 | 单重点、步骤、证据三类结构已复刻；以后由语义选择结构，不能固化本次视觉样式。 |
| M3 | 修改后保留 | 并入 Director 的流程门，与 D1/D3 组合维护，不单独形成重复规则。 |
| S1 | 保留进入试用 | 作为 S2/S3 的强制安全底座，用节目 LUFS/真峰值替代固定软件百分比。 |
| S2 | 修改后保留 | 全带 duck 作为基础；频谱让位只有在同 stem 测量、等响度对照有额外证据时启用。 |
| S3 | 修改后保留 | 保留语义锚点、授权、密度和峰值门；禁止建立“某个词固定配某个音效”的字典。 |
| D1 | 保留进入试用 | 能减少内容未定就投入包装的返工；确定性技术修复仍可提前。 |
| D2 | 保留进入试用 | 是 M2 和跨专家提案的上位约束；技术修复不必虚构叙事职责。 |
| D3 | 保留进入试用 | 保留少量差异候选、整组拒绝和证据后固化；确定性规格无需每次做审美选择。 |

## 第二级候选审核与真实片段试用准入

页面：`F:\code\koubo\.cache\agent-training-batch-1\review\index.html`

页面初始保持 12 项全未选择。用户可以：

- 对每项选择“保留进入真实片段试用”“修改后再审”或“删除”；
- 按审核号保留，例如 `C1 C2 C3 M1 M2 M3 S1 S2 S3 D1 D2 D3`；
- 按审核号要求修改，例如“修改 M1、S2，其余保留”；
- 按审核号删除，例如“删除 M3、S3”；
- 回复“这一组全部不接受”。

“首批全部确认”只批准 12 条来源进入完整取证、蒸馏和原创复刻，不会预填或代替本页选择。只有在本轮第二级候选审核中明确保留的具体条目，才取得真实口播片段试用准入；沙盒通过和试用准入都不是正式知识晋升。

页面以 `evidenceSetHash` 为本地状态恢复门：只有 12 项内容哈希集合完全一致时才恢复 localStorage。导出 JSON 包含每项 `candidateId`、`contentHash`、决定与备注；整组拒绝和未完成导出都要求再次确认。页面不会直接写入 Agent、配置、数据库或外部系统。

## 验证状态

- 本页相关自动测试：`5/5`，覆盖确定性构建、12 项哈希链、标题/边界变更导致哈希变化、sound 路径越界拒绝、初始 12 项全未选择、错误证据集合不恢复 localStorage、6 个媒体的 HTTP Range 加载和 CLI 输出边界。
- 本轮新鲜回归：`tests/multi-agent/*.test.mjs` 为 `160/160`，集中审核页与抓取安全专项合计 `23/23`，Python 多 Agent bridge 为 `13/13`。自动通过只证明合同、边界和技术路径成立，不替代用户对 12 项候选的第二级判断。

## 2026-07-25 第二级审核结果与试用登记

- 用户导出的审核记录完整覆盖 `12/12`，绑定审核号 `koubo-agent-training-batch-1-second-level-candidate-review-v2`、证据集合哈希 `06a6c7844bc5befca665a972b4dee4264c8724c22f6ef03e42b4a027860adbe5` 和 12 个候选内容哈希。
- 原版直接进入试用：`C1 C2 C3 M1 M2 S1 D1 D2 D3`。
- 用户明确回复“按建议改”，因此 M3/S2/S3 使用新版进入试用：
  - `director-technique.plan-preview-promote-gates.v2`：只组合 D1 的结构门和 D3 的证据后冻结门，不再复制两条规则；
  - `sound-technique.speech-aware-ducking.v2`：全带 duck 为基础，频谱让位必须由同 stem 测量和等响度对照触发；
  - `sound-technique.semantic-sfx-cue.v2`：保留语义、授权、密度和峰值门，禁止固定词到固定音效的字典。
- 用户进一步指出页面中的技术规则大多难以理解，不希望继续承担此类规则审核。后续固定为：Codex 负责来源、合同、参数、版权、测试和回滚；用户只审核真实口播片段中是否更清楚、更自然、更可信，以及字幕、动效和声音是否真正帮助理解。
- 权威隔离试用库已升级为 `data/multi-agent/training-batches/agent-training-batch-1-trial-v3/`；状态精确为 `trial=12 / approved=0 / promoted=0`，旧 v1/v2 仅保留为不可覆盖故障审计。默认 Agent 检索返回 0 条；生产编排尚未开放候选入口，后续真实片段试验必须新增绑定 batch/catalog 的隔离适配层。
- v3 把每条运行规则的技术语义哈希与完整 catalog 哈希分开固定，同时保持用户“按建议改”的决议哈希稳定为 `b0df2da07851ef64ee737afb4b438e1cef0f34b31bd755af0b2a8782cefdba5b`。catalog `agent-training-batch-1-trial-catalog.v3` 的技术哈希为 `d7a632c4e0ffa5dc1dbd5e383e42c97c6f3d4a66a835076cc59e1b218ad4ba1d`，完整哈希为 `8ac77e0c6d89cab16d7df28aa1e6244fffe653f996c62a392d195dbed3d3aa65`；运行目录同时冻结 exact catalog snapshot。
- v3 不可覆盖记录哈希：首轮审核 `7deb9b8585ec09161604bd5d2ad1725065819ceb0b9d703344c08d4f12dd8804`；三项修改决议记录 `39bef0a1b2687d439ce32559f81486f9ce2539d924e31482057f7a4324f2a8ab`；试用 manifest `88531c7935d0072b97c3e747cdc995384f29a180644da2eed383afb8dcccb5cd`。
- 本次登记没有修改生产 Agent 提示词、v4 默认、品牌骨架、成片批准或发布状态。下一门是用户先提供下一条真实视频方向，再按既定内容访谈流程制作一个全新真实片段测试。
