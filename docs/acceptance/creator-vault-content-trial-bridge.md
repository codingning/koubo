# Creator Vault → Content Strategist 显式 Trial 检索桥验收

日期：2026-07-31

## 结论

首个跨仓库知识闭环已经跑通：`F:\CreatorVault` 中的 Content Strategist
知识可以在单次方向分析中通过显式 `includeTrial=true` 读取，检索结果的稳定
知识 ID、状态、命名空间与 Vault 内容哈希会写入不可变分析 artifact。

本实现没有改变默认生产行为：

- 未提供 `knowledgeContext` 时，继续使用 Koubo 仓库内现有原则；
- `knowledgeContext.mode=none` 才是无知识 A 组；
- `knowledgeContext.mode=creator-vault` 必须同时提供 `includeTrial=true`；
- `topK` 只允许 3–5；
- trial 仍是建议性候选，不获得批准、发布或长期知识晋升权限。

## Vault 导入结果

- 来源库：`koubo-content-principles-v1`
- 导入：16 条
- 状态：16 条均为 `trial`
- 命名空间：`shared.content-principles`
- 正式 Vault doctor：`ok=true`，26 条记录，1 个 blob
- 导入前快照：`G:\CreatorVault-Backups\vault-snapshots\20260731-150532-before-koubo-knowledge-import`
- 默认 `knowledge-retrieve` 不带 `--trial` 时仍返回 0 条 trial 原则。

每条记录保留来源视频 ID、标题、访问时间、时间码、转录模型、转录 SHA-256、
适用条件、反例与使用边界。原目录没有提供三条来源视频的媒体 SHA-256，因此
Vault 明确记录 `mediaSha256=null` 与
`mediaHashStatus=not_present_in_source_catalog`，没有伪造媒体哈希。

## 真实 A/B

两组使用相同方向、受众、事实、证据、约束和模型调用路径，唯一有意差异是知识上下文。

方向：

> 我如何把从抖音博主蒸馏出的观点、框架和思考方式训练给短视频Agent，并验证它是否真的更懂内容

| 项目 | A：无知识 | B：Creator Vault trial |
|---|---|---|
| artifact ID | `content-strategy.2ade51c1df3a` | `content-strategy.ef5735235a6b` |
| knowledge source | `none` | `creator-vault` |
| 检索数 | 0 | 5 |
| 实际引用数 | 0 | 4 |
| 状态 | `needs_evidence` | `needs_evidence` |
| 进入写稿 | 否 | 否 |
| 批准/发布/晋升 | 否 | 否 |

B 组引用了：

1. `content-principle.ai-generates-hypotheses-not-verdicts.v1`
2. `content-principle.start-with-low-variable-baseline.v1`
3. `content-principle.change-one-main-variable.v1`
4. `content-principle.manual-fallback-teaches-automation.v1`

可观察差异：B 组把评测维度进一步具体化为证据引用、适用边界、不确定性、
可执行性与错误率，并明确要求只改变“是否读取 Vault”这一主要变量。A 组也正确
提出了基线、盲评和控制随机性的要求。因此当前只能确认“Vault 知识被真实检索和引用”，
不能由系统自行宣布 B 更好，更不能据此晋升任何单条知识。

原始 artifact：

- `data/acceptance/creator-vault-content-trial-ab/a-no-knowledge.json`
  - 文件 SHA-256：`8396bf30ce8533f700e8072b7da6102198d6cc6268c957772e5b3ded0ac55c0b`
  - record contentHash：`9deec2d5bff46a0c1a8d6a3c273c82c1a940bf0827884e1fca19bff6e88a7da4`
- `data/acceptance/creator-vault-content-trial-ab/b-creator-vault-trial-top5.json`
  - 文件 SHA-256：`023f1d2d10eb546f16ff55d316b6f5263608d96be295034ff0948b71e03c92ff`
  - record contentHash：`bd7e40bcffc9741f1ecd4ae1298a6a32f0043b71c496dadaa71d3758d81ca25a`

## 人工审核问题

用户只需要审核真实输出，而不需要阅读技术规则：

1. B 是否比 A 更能帮助你决定下一步？
2. B 引用的四条原则中，哪些确实有用，哪些只是看起来相关？
3. B 是否出现套原则、空话、改变方向或把候选说成事实？
4. 结论选择：`A 更好 / B 更好 / 差不多 / 两个都不要`。

这次反馈只形成真实使用证据，不自动把知识转为 `approved`。

## 配置与调用合同

隔离服务需要显式配置：

```powershell
$env:KOUBO_CREATOR_VAULT_ROOT = 'F:\CreatorVault'
$env:KOUBO_CREATOR_VAULT_CLI = 'F:\code\creator-vault\src\cli.mjs'
```

B 组请求字段：

```json
{
  "knowledgeContext": {
    "mode": "creator-vault",
    "includeTrial": true,
    "topK": 5
  }
}
```

A 组请求字段：

```json
{
  "knowledgeContext": {
    "mode": "none"
  }
}
```

## 本期明确不实现

- 不把 Creator Vault 设为生产默认知识源；
- 不接入 Script、Sound、Motion、Director 或 Critic Agent；
- 不提供工作台 UI 开关；
- 不自动批准或晋升任何知识；
- 不自动评价 A/B 胜负；
- 不微调基础模型；
- 不迁移音效或其他资产；
- 不补造缺失的来源媒体 SHA-256。

## 回滚

- 运行时回滚：不发送 `knowledgeContext.mode=creator-vault`，默认路径不受影响；
- 配置回滚：移除两个 `KOUBO_CREATOR_VAULT_*` 环境变量；
- 数据回滚：导入前完整 Vault 快照位于上述 G 盘路径；
- 代码回滚：两个仓库均在独立 `codex/` 分支中，未修改用户当前脏工作树。
