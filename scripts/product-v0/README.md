# 创作者内容证据库内部 V0

这组脚本把已经在 `douyin-obsidian-knowledge` 中完成本地转录与知识提取的本人收藏，只读转换成私有、可追溯的 Markdown 证据库。

它证明标准交付链路能够运行，不证明市场需求成立，也不会读取登录状态、修改收藏或联系外部用户。

## 构建

```powershell
node .\scripts\product-v0\build-creator-evidence-library-v0.mjs `
  --source F:\code\douyin-obsidian-knowledge `
  --output F:\code\koubo\.runtime\product-v0\creator-evidence-library-20260817 `
  --limit 100
```

输出必须位于 `.runtime`，真实收藏不会进入 Git。构建器会重建机器生成的索引和证据卡，同时保留已经人工生成的 `TOPIC_PACKS.md` 与 `CONTENT_OUTLINE.md`。

## 验证

基础证据库：

```powershell
node .\scripts\product-v0\validate-creator-evidence-library-v0.mjs `
  F:\code\koubo\.runtime\product-v0\creator-evidence-library-20260817
```

加入 3 个选题包和 1 个内容大纲后：

```powershell
node .\scripts\product-v0\validate-creator-evidence-library-v0.mjs `
  F:\code\koubo\.runtime\product-v0\creator-evidence-library-20260817 `
  --require-final
```

验证器检查：50 条以上有效来源、输入对账、来源卡边界、真实来源引用、过期卡片、当前文件哈希、常见密钥、敏感账号字段，以及最终选题和大纲结构。

## 测试

```powershell
node --test .\tests\creator-evidence-library-v0.test.mjs
```

测试使用临时 SQLite 和虚构条目，不包含真实收藏数据；它同时验证重复构建会清理旧卡、保留有界人工交付物，并刷新完整交付回执。

## 私有与公开边界

可以提交：本目录脚本、测试、产品合同、空白或经用户批准的脱敏演示。
禁止提交：`.runtime`、真实收藏清单、媒体、转录、账号标识、Cookie、Token、登录状态和未经批准的截图。
