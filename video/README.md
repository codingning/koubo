# 本地 AI 口播服务

`server.mjs` 是 v4 自动化服务，只监听 `127.0.0.1:8787`。新任务默认使用 HyperFrames `visual-director-v4`；历史任务继续使用 FFmpeg v3。

## 能力

- `POST /api/contents/generate`：根据最近真实进展生成新口播；
- `GET /api/contents`：读取所有 AI 生成拍摄包；
- `GET /api/video-workflow/defaults`：读取六阶段默认参数、网页字段和提示词；
- `POST /api/video-workflow/drafts`：在大文件上传前暂存完整网页配置，避免把长提示词塞进HTTP头；
- `POST /api/jobs`：上传原片并启动“风格分析→内容拆解→关键帧”自动链；
- `GET /api/jobs/:id`：读取转录、计划、进度、版本和 QA；
- `POST /api/jobs/:id/workflow/stages/:stage/config`：只保存当前阶段配置，不重跑；
- `POST /api/jobs/:id/workflow/stages/:stage/run`：从当前阶段生成新版本，并作废下游旧审核状态；
- `POST /api/jobs/:id/workflow/stages/keyframe_review/approve`：批准关键帧并启动15—25秒动态样片；
- `POST /api/jobs/:id/workflow/stages/motion_sample/approve`：批准动态样片并启动2K全片；
- `POST /api/jobs/:id/revise`：按自然语言反馈生成新版本；
- `POST /api/jobs/:id/cover`：复用原片和当前计划，只重做 9:16、3:4、16:9、4:3 四张文字封面；
- `POST /api/jobs/:id/approve`：最终审核通过；
- `POST /api/jobs/:id/retry`：失败后重试。

关键帧和动态样片是硬审核门。完整视频默认输出2560×1440、30fps母版，并创建1920×1080审核预览；所有提示词和版本决策都写入任务目录，不覆盖旧产物。

## 数据边界

- 原视频、音频、字幕和成片只写入 `video-jobs/`；
- 新口播和证据包写入 `content-items/`；
- 两个目录均被 Git 忽略；
- 原视频不上传模型服务；文本模型只读取脱敏文字和技术参数。

## 启动

普通用户双击根目录 `打开AI口播工作台.vbs`。开发调试：

```powershell
node .\video\server.mjs
```
