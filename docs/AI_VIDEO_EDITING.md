# AI口播剪辑实现与验证

## 继承能力

2026-07-16 复核用户指定对话 `019f68f7-d245-7810-a863-ceb22c3646a4` 中的视频，确认六项能力：

1. HyperFrames；
2. Video Use；
3. Promotion；
4. Generative Media；
5. Video Cut；
6. AI Video Workflow。

本项目通过 `.agents/skills/koubo-ai-video-editor/` 将它们映射为本地口播后期流程。Codex 全局已安装 `hyperframes`、`media-use`、`embedded-captions`、`talking-head-recut` 和 `video-use`。Video Use 的 Python 依赖已安装；由于尚未配置 ElevenLabs API Key，高级云端逐字转写默认不启用。

## 本地架构

```text
打开AI口播工作台.vbs
  → node video/server.mjs（仅 127.0.0.1:8787）
  → 网页选择原片
  → ffprobe 读取规格
  → FFmpeg silencedetect 识别长停顿
  → edit-plan.json
  → 用户确认
  → FFmpeg 切段、30ms 音频淡化、响度、比例、字幕
  → final.mp4 + thumbnail.jpg + job.json QA
```

原片和生成任务只写入 `video-jobs/`，该目录内容被 Git 忽略。任何云端视频上传必须再次取得明确确认。

## 端到端验证

验证日期：2026-07-16。

输入为本地生成的 10.2 秒、1280×720、H.264/AAC 合成视频，音轨包含两段人工长停顿。

分析结果：

- 检测到停顿 `2.999979—4.000042s`；
- 检测到停顿 `6.999979—8.200042s`；
- 保留三个说话区间；
- 预计删除约 `1.720126s`；
- 预计成片约 `8.479874s`。

实际输出：

- 时长：`8.5s`；
- 分辨率：`1080×1920`；
- 帧率：`30fps`；
- 视频：H.264 / yuv420p；
- 音频：AAC；
- H.264、AAC、yuv420p、时长匹配四项 QA 全部通过；
- 字幕成功烧录；
- 竖屏采用模糊背景加完整前景，不直接裁剪主体。

项目 Skill 另以 2 秒合成视频验证 `inspect_job.mjs`，成功生成 `ai-brief.md` 和 5 张关键帧。

## 日常验收

真实口播上线前仍需用用户实际拍摄视频验证：

- 中文字幕断句；
- 真人脸部安全区；
- 停顿灵敏度；
- 错句/假启动的语义识别；
- 手机端观看与抖音上传兼容性。