# Koubo 通用口播平台 P0–P3 验收报告

日期：2026-07-28
基线：`codex/koubo-multi-agent-research@6a29b98`
实施分支：`codex/koubo-universal-platform`
隔离仓库：`F:\code\koubo-universal-platform`

## 结论

代码、自动化测试、真实媒体夹具、在线本地安全、真实文本模型和浏览器 UI 验收均通过。分支未合并、未推送、未部署。

剪映 11.1.0.14287 已安装。真实草稿已写入剪映用户草稿根目录，并被剪映自身的 `root_meta_info.json` 与 `draft_acion_watch.json` 索引，日志记录 `copy_draft_external`、`suc:true`。桌面控制组件连续返回 `GetCursorPos 拒绝访问`，因此没有伪称已在 GUI 内打开草稿并拖动片段；这仍是唯一需要人工补点的应用内验收。

## 实施范围

- 通用内容入口：领域、受众、目标、语气、语言、时长、任意合法方向和真实证据。
- 工作区配置、内容草稿、任务列表和静态产物按 `workspaceId` 隔离。
- P0：可信 Origin、随机写会话令牌、运行时锁、漂移验证、Skill 路由修正。
- P1：剪映导出、证据化拉片、三类素材锚点、PageCam。
- P2：Storyboard、6 种受治理镜头、每期复盘、本地语义 SFX/ducking。
- P3：Collage、WhisperX、Manim 插件接口，全部默认关闭。

## 自动化验证

| 检查 | 结果 |
|---|---:|
| Node 全量测试 | `302/302` |
| Python 全量测试（`.runtime-multi-agent`） | `18/18` |
| 工作台静态控件检查 | `202` 个引用有效 |
| 运行时锁检查 | Node、Python、包版本、FFmpeg 版本/哈希、HyperFrames、Skill 路由、P3 默认关闭全部通过 |
| `git diff --check` | 通过 |

## 真实媒体与产物

### 剪映导出

- 使用真实 H.264/AAC、640×360、30fps、4 秒夹具。
- 输出两个独立可编辑视频片段。
- 每段 30ms 淡入/淡出。
- 精确验证源范围：
  - 片段 1：`0–1.5s`
  - 片段 2：`2.0–3.5s`
- 验证 `draft_content.json`、`draft_meta_info.json`、源路径、目标时间线连续性和总时长。
- 安全 HTTP 路由只接受当前人工批准版本，且不修改原 `timeline-vN.json`。

真实剪映目录验收：

- 剪映版本：`11.1.0.14287`。
- 草稿名：`koubo-acceptance-20260728110835`。
- 真实草稿根：`C:\Users\fangtianhao\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft`。
- 真实 H.264/AAC、1280×720、30fps、6 秒动态夹具。
- 两个独立片段的源范围：`0–2s`、`3–5s`；输出总时长 4 秒。
- 导出器全部检查通过：单视频轨、2 段、连续时间线、源范围、总时长、元数据时长、30ms 淡入淡出、源路径和草稿名。
- 剪映索引日志：`copy_draft_external`、`suc:true`；根索引中 `draft_is_invisible:false`。
- 未完成：因桌面控制权限错误，尚未在剪映 GUI 内双击打开并手动拖动两段。

### PageCam

- 本地页面：`http://127.0.0.1:8791/`
- 视口：1440×900。
- 全页截图：1440×3461。
- 元素切片：brand、topic、strategy 共 3 张。
- 生成 `layout.json`，隐私标记为 `local-capture`。

### 声音设计

- 真实 H.264 视频 + AAC 音频夹具通过。
- 语义 SFX/ducking 渲染后保持视频码流不重编码。
- 生产开关未开启时失败关闭；不默认加入 BGM。

## 在线本地安全

服务：`http://127.0.0.1:8791/`，本轮验收服务结束后已关闭。

| 探针 | HTTP 状态 |
|---|---:|
| `/api/session` | `200` |
| 写请求缺少会话令牌 | `403` |
| 恶意 Origin 即使携带令牌 | `403` |
| 可信 Origin + 正确进程令牌 | `201` |

额外集成测试验证：

- 其他工作区访问 `/video-jobs/{id}/...` 返回 404。
- 其他工作区访问 `/content-items/{id}/...` 返回 404。
- 上传任务引用其他工作区内容时返回 404，不再吞掉异常并降级为 `null`。

## 浏览器验收

- 页面标题：`Koubo 通用口播工作台`。
- 默认文案为通用平台，不再把个人 AI 成长路径作为唯一入口。
- 实测“社区咖啡店开业前应该先验证什么”业务场景：领域、受众、目标、语气、150 秒时长、方向和证据刷新后全部保留。
- 切换至 `team-b`：使用独立受众/目标，方向和证据草稿为空。
- 切回 `local-default`：咖啡店方向和证据完整恢复。
- 1280×720：无水平溢出。
- 390×844：侧栏过渡完成后主体全宽、无水平溢出；菜单按钮可用。
- 浏览器控制台：0 warning / 0 error。

### 真实文本模型与通用非 AI 内容

- `.env` 由用户配置且保持 Git 忽略；未打印或提交密钥。
- 健康检查：文本模型已配置，模型为 `gpt-5.6-sol`；转录模型为 `faster-whisper/small`。
- 新增“工作区证据文件”输入：服务器读取相对路径、计算 SHA-256、生成不可变证据快照；客户端提交的 `provenance` 无法伪造 `workspace_verified`。
- 证据 artifact、分析 artifact、确认 artifact 和幂等缓存均绑定 `workspaceId`；跨工作区读取返回 404。
- 真实非 AI 方向：`我用 4 种请求条件验证一个本地写接口的 Origin 与写令牌门禁`。
- 模型在证据不足时多轮保持写稿门关闭；补齐脱敏原始探针后返回“证据已就绪”，人工确认框才可用。
- 真实生成内容 ID：`growth-day-2-20260728110205-f5f8f3`，模型 `gpt-5.6-sol`，状态 `待审核`。
- 普通观众点评完整执行并返回 `听懂但无用`，指出应补白话术语解释、四行请求矩阵和证据定位；系统没有把该点评伪装成发布批准。

## 依赖与许可证

- `touge1618/touge-spoken-cut@22cedc01f32a435ac69ff2fe6fd33eaa97cdb954`：Apache-2.0，仅借鉴窄导出/API 模式。
- `GuanYixuan/pyJianYingDraft==0.3.0`：Apache-2.0，固定在隔离 exporter 运行时。
- 未引入 TouGe 的 Qwen ASR、控制器或第二套剪辑决策。
- 归属说明见 `THIRD_PARTY_NOTICES.md`。

## 合并边界

- 当前分支只允许继续本地评审、补充环境验收或按用户反馈修改。
- 未经用户明确同意，不合并到主干，不推送，不部署。
- 合并前只剩一项人工补点：在剪映草稿列表中打开 `koubo-acceptance-20260728110835`，确认时间线显示两个可独立选中的片段。完成后仍需用户明确同意才能合并。
