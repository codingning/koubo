# 本地 AI 口播服务

`server.mjs` 是 v2 自动化服务，只监听 `127.0.0.1:8787`。

## 能力

- `POST /api/contents/generate`：根据最近真实进展生成新口播；
- `GET /api/contents`：读取所有 AI 生成拍摄包；
- `POST /api/jobs`：上传原片并立即启动全自动处理；
- `GET /api/jobs/:id`：读取转录、计划、进度、版本和 QA；
- `POST /api/jobs/:id/revise`：按自然语言反馈生成新版本；
- `POST /api/jobs/:id/approve`：最终审核通过；
- `POST /api/jobs/:id/retry`：失败后重试。

## 数据边界

- 原视频、音频、字幕和成片只写入 `video-jobs/`；
- 新口播和证据包写入 `content-items/`；
- 两个目录均被 Git 忽略；
- 原视频不上传模型服务；公司模型只读取脱敏文字和技术参数。

## 启动

普通用户双击根目录 `打开AI口播工作台.vbs`。开发调试：

```powershell
node .\video\server.mjs
```
