# Sound Agent 首批隔离复刻报告

日期：2026-07-24
状态：`sandbox_recreation_complete / candidate_only / awaiting_real_clip_trial_admission_review`
知识边界：`candidate-recreation-only / no-formal-knowledge-promotion`

## 结论

用户确认首批三条声音研究后，本轮没有把教程观点直接晋升为长期知识，也没有修改生产配置。已完成一个原创、离线、可重复构建的 Sound 复刻沙盒，用同一组程序化 voice-like/BGM stems 验证：

1. A：不避让；
2. B：全带 speech-aware ducking；
3. C：同一 ducking，再按当前 stems 的实测冲突频带做频谱让位；
4. S：在 C 的基础上加入三个有明确语义锚点的程序化 cue。

四个版本均输出可播放 WAV 和 MP4，并保留 reject-all，当前不代表用户听感通过。

## 本地交付

- 生成器：video/multi-agent/sound-sandbox.mjs
- 运行入口：scripts/recreate_sound_training_batch_1.mjs
- 测试：tests/multi-agent/sound-sandbox.test.mjs
- 固定产物目录：.cache/agent-training-batch-1/sound
- 复刻清单：.cache/agent-training-batch-1/sound/recreation-manifest.json
- QA：.cache/agent-training-batch-1/sound/qa.json
- 完整哈希表：.cache/agent-training-batch-1/sound/hashes.json
- 人工审核模板：.cache/agent-training-batch-1/sound/subjective-review-template.json

hashes.json 覆盖除自身之外的 27 个文件，包括请求合同、资产账本、全部 stems、中间处理轨、WAV 和 MP4。

## 确定性与授权边界

- voice-like、BGM 和三类 SFX 均为 Node 程序化生成，没有教程音频、第三方素材、网络 URL 或外部 TTS。
- audio_request.json、audio_meta.json 和 asset-ledger.json 均记录 programmatic-local、文件哈希、时长、采样率、用途和使用边界。
- A/B/C 的实际来源标识一致：
  - voice SHA-256：67c91579735c00c2c19ef253fa23240e235c96ef4fe343739d388d5ecc59b4d2
  - BGM SHA-256：fe86cbefdc9510a7932461056fb19b345081e4d18f27103033a5c3670101bb40
  - timeline SHA-256：d71554626cd9d74df58c3e28af38f2a30415bafad899aaa91d52f5b4082ea81e
- 两次完整构建的 27 项文件路径、字节数和 SHA-256 完全一致。
- CLI 只允许写入仓库 .cache/agent-training-batch-1/ 的子目录；越界路径在创建文件前拒绝。

## 测量结果

| 版本 | WAV LUFS | WAV TP | MP4 LUFS | MP4 TP | 完整解码 |
|---|---:|---:|---:|---:|---|
| A 无避让 | -16.19 | -2.50 dBTP | -16.19 | -2.50 dBTP | 通过 |
| B 全带 duck | -16.19 | -2.50 dBTP | -16.19 | -2.50 dBTP | 通过 |
| C duck + 频谱让位 | -16.23 | -2.50 dBTP | -16.23 | -2.50 dBTP | 通过 |
| S 语义 cue | -16.22 | -2.50 dBTP | -16.22 | -2.50 dBTP | 通过 |

- A/B/C 的 WAV 最大响度差：0.04 LU。
- A/B/C 的 MP4 最大响度差：0.04 LU。
- B 在人声活动窗口的 BGM RMS 估算衰减：7.668 dB。
- 频带不是套用教程的 300 Hz；在 8 个候选频带中，当前 stems 的最大重叠点实测为 760 Hz。
- C 在 760 Hz 的额外频谱削减实测为 4.217 dB。
- 三个 cue 的语义类型为 semantic-turn、visual-impact、transition-cut；最小净间隔 3400 ms，最大并发 1，最长持续 280 ms。

上述 reduction 是同一 stems、同一时间窗的 RMS 差值估算，不冒充压缩器内部逐采样增益表。C 的总 BGM 变化还包含频谱让位，不能把它全部解释为 ducking。

## 实际门禁

- 每个版本只有自身完整解码、编码、色彩、时长、LUFS 和 TP 检查全部通过时，状态才是 recreated；失败版本写为 qa-failed。
- A/B/C 的一致性由每个版本记录的 sourceVoiceSha256、sourceBgmSha256、timelineHash 和 ffprobe 实际起点/时长计算，未硬编码为通过。
- 测试会分别篡改 BGM 哈希、timeline 哈希和 MP4 起点，三种情况均必须失败。
- 未调用 memory transition，未写入共享知识库，未修改 Agent profile、生产 prompt、生产默认或发布状态。

## 尚未完成

- 没有真人口播，因此当前只证明工程和声学对照成立，不能证明真实说话者的可懂度收益。
- 没有用户主观试听；B 的 7.668 dB 避让接近首轮搜索上沿，是否出现抽吸感必须由人耳判断。
- 760 Hz 只属于本轮程序化 stems，不应成为固定参数。换真人声音和实际 BGM 时必须重新测量。
- A/B/C/S 只作为 S1–S3 的试听证据。只有第二级候选审核明确保留的条目才取得真人片段试用准入；试听或技术通过都不是正式知识晋升。

## 验证

    node scripts/recreate_sound_training_batch_1.mjs
    node --test tests/multi-agent/sound-sandbox.test.mjs tests/multi-agent/contracts.test.mjs
    git diff --check

结果：9/9 测试通过；git diff --check 通过。
