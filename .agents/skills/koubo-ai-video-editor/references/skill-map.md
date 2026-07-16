# 六项能力映射

来源：用户指定的 Codex 对话 `019f68f7-d245-7810-a863-ceb22c3646a4` 中查看的抖音视频《Codex最强玩法：6个Skill做一整条视频》。2026-07-16 复核视频画面得到六项名称。

| 视频中的能力 | 本工作流继承方式 | 当前状态 |
|---|---|---|
| HyperFrames | 使用 `heygen-com/hyperframes` 的 HTML→MP4、本地转写、embedded-captions、talking-head-recut | 可选增强；CLI 可用 |
| Video Use | 采用文字时间轴、停顿/错句删除、30ms 音频淡化、字幕最后烧录、切点自检、项目记忆 | 工作流规则已继承；完整语义转写需 ElevenLabs |
| Promotion | 从一份批准主成片派生 9:16、1:1、原比例版本和平台包装 | 基础版已支持比例选择 |
| Generative Media | 为证据卡片、动态标题、B-roll、音频提供本地/可选生成接口 | 仅在用户确认素材与云上传后启用 |
| Video Cut | 自然语言任务→`edit-plan.json`/EDL→FFmpeg 渲染 | 已支持本地 edit-plan |
| AI Video Workflow | 上传→分析→人工确认→渲染→QA→交付的闭环 | 已接入网页工作台 |

## 权威上游

- HyperFrames：`https://github.com/heygen-com/hyperframes`，Apache-2.0。
- video-use：`https://github.com/browser-use/video-use`，MIT。
- video-spec-builder：`https://github.com/feicaiclub/video-spec-builder`，MIT；用于把模糊需求固化为逐秒分镜。
- video-orchestrator：`https://github.com/kivimedia/videographer-skill`，MIT；用于按素材类型选择工具并执行 QA 门禁。

本项目不复制上游实现代码，只继承公开工作流原则并通过适配器调用；如后续 vendoring 上游代码，必须保留其许可证与归属。
