import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_SOURCE = "F:/code/douyin-obsidian-knowledge";
const DEFAULT_OUTPUT = path.resolve(".runtime/product-v0/creator-evidence-library-20260817");

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, output: DEFAULT_OUTPUT, limit: 100 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--source") args.source = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--limit") args.limit = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  args.source = path.resolve(args.source);
  args.output = path.resolve(args.output);
  return args;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function cleanText(value, maxLength = 4000) {
  return String(value ?? "")
    .replace(/\u0000/gu, "")
    .replace(/\r\n/gu, "\n")
    .trim()
    .slice(0, maxLength);
}

function yamlString(value) {
  return JSON.stringify(cleanText(value, 1000));
}

function timestampUrl(baseUrl, seconds) {
  const second = Number(seconds);
  if (!Number.isFinite(second) || second < 1) return baseUrl;
  return `${baseUrl}?modal_id=${baseUrl.split("/").at(-1)}&timestamp=${Math.floor(second)}`;
}

const CLUSTERS = [
  {
    id: "creator_topic_system",
    title: "选题与内容系统",
    keywords: ["选题", "内容", "创作", "自媒体", "个人ip", "账号", "流量", "运营"],
  },
  {
    id: "ai_workflow",
    title: "AI、Agent 与工作流",
    keywords: ["ai", "agent", "skill", "codex", "工作流", "提示词", "开源", "自动化"],
  },
  {
    id: "product_business",
    title: "产品、客户与商业验证",
    keywords: ["产品", "客户", "商业", "成交", "付费", "赚钱", "变现", "创业"],
  },
  {
    id: "video_production",
    title: "视频制作与剪辑",
    keywords: ["视频", "口播", "剪辑", "字幕", "动效", "镜头", "成片"],
  },
  {
    id: "learning_knowledge",
    title: "学习、阅读与知识管理",
    keywords: ["学习", "读书", "知识", "认知", "教程", "笔记", "复盘"],
  },
];

function classifySource(source) {
  const text = [
    source.title,
    source.knowledge.thesis,
    source.knowledge.summary,
    ...(source.knowledge.tags || []),
    ...(source.knowledge.relatedConcepts || []),
  ].join(" ").toLowerCase();
  return CLUSTERS.map(cluster => {
    const matchedKeywords = cluster.keywords.filter(keyword => text.includes(keyword));
    return { ...cluster, matchedKeywords, relevance: matchedKeywords.length };
  }).filter(value => value.relevance > 0);
}

function sourceCard(source) {
  const knowledge = source.knowledge;
  const provenance = knowledge.provenance || {};
  const url = cleanText(provenance.canonicalUrl || source.source_url, 1000);
  const lines = [
    "---",
    `id: ${yamlString(`SRC-DOUYIN-${source.aweme_id}`)}`,
    `source_id: ${yamlString(source.aweme_id)}`,
    `title: ${yamlString(source.title)}`,
    `author: ${yamlString(source.author)}`,
    `canonical_url: ${yamlString(url)}`,
    `source_type: "douyin_saved_video"`,
    `knowledge_sha256: ${yamlString(source.knowledge_sha256)}`,
    `media_sha256: ${yamlString(provenance.mediaSha256 || source.media_sha256)}`,
    `transcript_sha256: ${yamlString(provenance.transcriptSha256 || source.transcript_sha256)}`,
    "---",
    "",
    `# ${cleanText(source.title, 500) || source.aweme_id}`,
    "",
    "## 来源主张",
    "",
    cleanText(knowledge.thesis || knowledge.summary, 3000) || "—",
    "",
    "## AI 提取摘要（待用户判断）",
    "",
    cleanText(knowledge.summary, 4000) || "—",
    "",
    "## 可追溯要点",
    "",
  ];
  const ideas = Array.isArray(knowledge.keyIdeas) ? knowledge.keyIdeas : [];
  ideas.forEach((idea, index) => {
    const seconds = Number(idea.timestampSeconds || 0);
    const label = cleanText(idea.timestamp || "") || `${Math.floor(seconds)}s`;
    lines.push(`### ${index + 1}. ${cleanText(idea.title, 300) || "未命名要点"}`);
    lines.push("");
    lines.push(`- 时间：${label}`);
    lines.push(`- 原视频定位：[打开来源](${timestampUrl(url, seconds)})`);
    lines.push(`- AI 提取：${cleanText(idea.detail, 1200) || "—"}`);
    lines.push(`- 来源片段：> ${cleanText(idea.sourceExcerpt, 800) || "—"}`);
    lines.push("");
  });
  lines.push("## 用户判断");
  lines.push("");
  lines.push("- 当前状态：`pending_user_judgment`");
  lines.push("- 该来源对账号选题的适用条件、反例和个人判断尚待用户确认。");
  lines.push("");
  lines.push("## AI 推断与待核实项");
  lines.push("");
  const limitations = Array.isArray(knowledge.limitations) ? knowledge.limitations : [];
  const verification = Array.isArray(knowledge.verificationNeeds) ? knowledge.verificationNeeds : [];
  if (!limitations.length && !verification.length) lines.push("- 暂无自动识别项；不代表来源主张已经外部验证。");
  limitations.forEach(item => lines.push(`- 局限：${cleanText(item, 800)}`));
  verification.forEach(item => lines.push(`- 待核实：${cleanText(item.claim, 800)}（${cleanText(item.reason, 500)}）`));
  lines.push("");
  lines.push(`标签：${(knowledge.tags || []).map(tag => `#${cleanText(tag, 80).replace(/\s+/gu, "-")}`).join(" ") || "—"}`);
  return lines.join("\n");
}

function buildIndex(sources, clusterMap) {
  const lines = [
    "# 创作者内容证据库 V0",
    "",
    `有效来源：${sources.length} 条`,
    "",
    "本库将来源主张、AI提取和用户判断分开。AI提取不等于事实，正式内容仍需回到原视频和关键出处核对。",
    "",
    "## 按主题浏览",
    "",
  ];
  for (const cluster of CLUSTERS) {
    const members = clusterMap.get(cluster.id) || [];
    lines.push(`### ${cluster.title}（${members.length}）`);
    lines.push("");
    members.slice(0, 20).forEach(source => {
      lines.push(`- [${cleanText(source.title, 160)}](sources/${source.aweme_id}.md) · ${cleanText(source.author, 80)}`);
    });
    if (members.length > 20) lines.push(`- 另有 ${members.length - 20} 条，请使用全文搜索。`);
    lines.push("");
  }
  lines.push("## 全部来源");
  lines.push("");
  sources.forEach(source => {
    lines.push(`- [${cleanText(source.title, 160)}](sources/${source.aweme_id}.md) · ${cleanText(source.author, 80)} · [原视频](${source.source_url})`);
  });
  return lines.join("\n");
}

function secretHits(directory) {
  const patterns = [
    /sk-[A-Za-z0-9_-]{20,}/gu,
    /ghp_[A-Za-z0-9]{20,}/gu,
    /AKIA[0-9A-Z]{16}/gu,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  ];
  const hits = [];
  for (const filePath of walkFiles(directory)) {
    const text = fs.readFileSync(filePath, "utf8");
    patterns.forEach(pattern => {
      if (pattern.test(text)) hits.push(path.relative(directory, filePath));
      pattern.lastIndex = 0;
    });
  }
  return [...new Set(hits)];
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

export function buildCreatorEvidenceLibrary(options) {
  const startedAt = new Date();
  const sourceRoot = path.resolve(options.source);
  const outputRoot = path.resolve(options.output);
  const databaseFile = path.join(sourceRoot, "var", "state.sqlite3");
  if (!fs.existsSync(databaseFile)) throw new Error(`Source database missing: ${databaseFile}`);
  if (outputRoot.startsWith(sourceRoot + path.sep)) {
    throw new Error("Output must not be inside the source repository");
  }
  if (!outputRoot.includes(`${path.sep}.runtime${path.sep}`)) {
    throw new Error("Output must be inside a private .runtime directory");
  }

  // Rebuild generated artifacts from scratch while preserving the two bounded
  // human-authored final deliverables when a reviewer has already added them.
  fs.rmSync(path.join(outputRoot, "library"), { recursive: true, force: true });
  fs.rmSync(path.join(outputRoot, "DEMO"), { recursive: true, force: true });
  ["INPUT_MANIFEST.json", "TOPIC_CANDIDATES.json", "DELIVERY_RECEIPT.json", "README.md"]
    .forEach(fileName => fs.rmSync(path.join(outputRoot, fileName), { force: true }));
  fs.mkdirSync(path.join(outputRoot, "library", "sources"), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, "DEMO"), { recursive: true });

  const database = new DatabaseSync(databaseFile, { readOnly: true });
  const rows = database.prepare(`
    SELECT aweme_id, source_url, title, author, status, knowledge_path, knowledge_sha256,
           media_sha256, transcript_sha256, likes, collects, comments, shares, discovered_at
    FROM items
    WHERE status = 'written' AND knowledge_path IS NOT NULL
    ORDER BY discovered_at DESC, aweme_id DESC
    LIMIT ?
  `).all(options.limit);
  database.close();

  const successes = [];
  const duplicates = [];
  const unavailable = [];
  const seenIds = new Set();
  const seenKnowledgeHashes = new Set();

  for (const row of rows) {
    const id = String(row.aweme_id);
    if (seenIds.has(id) || (row.knowledge_sha256 && seenKnowledgeHashes.has(String(row.knowledge_sha256)))) {
      duplicates.push({ sourceId: id, reason: "duplicate-id-or-knowledge-hash" });
      continue;
    }
    seenIds.add(id);
    if (row.knowledge_sha256) seenKnowledgeHashes.add(String(row.knowledge_sha256));
    try {
      if (!fs.existsSync(row.knowledge_path)) throw new Error("knowledge artifact missing");
      const knowledge = JSON.parse(fs.readFileSync(row.knowledge_path, "utf8"));
      const canonicalUrl = cleanText(knowledge?.provenance?.canonicalUrl || row.source_url, 1000);
      if (!canonicalUrl.startsWith("https://www.douyin.com/video/")) throw new Error("canonical source URL missing");
      if (!Array.isArray(knowledge.keyIdeas) || !knowledge.keyIdeas.length) throw new Error("traceable key ideas missing");
      const source = {
        ...row,
        aweme_id: id,
        source_url: canonicalUrl,
        knowledge,
        clusterMatches: [],
      };
      source.clusterMatches = classifySource(source);
      const relativeCard = `library/sources/${id}.md`;
      writeText(path.join(outputRoot, relativeCard), sourceCard(source));
      successes.push({ ...source, relativeCard });
    } catch (error) {
      unavailable.push({ sourceId: id, reason: cleanText(error?.message || error, 500) });
    }
  }

  const clusterMap = new Map(CLUSTERS.map(cluster => [cluster.id, []]));
  successes.forEach(source => {
    source.clusterMatches.forEach(cluster => clusterMap.get(cluster.id).push(source));
  });
  clusterMap.forEach(members => {
    members.sort((a, b) => Number(b.collects || 0) - Number(a.collects || 0));
  });

  const manifest = {
    schemaVersion: 1,
    product: "creator-evidence-library-v0",
    createdAt: new Date().toISOString(),
    input: {
      sourceSystem: "douyin-obsidian-knowledge",
      requestedLimit: options.limit,
      selectedRows: rows.length,
    },
    reconciliation: {
      selected: rows.length,
      success: successes.length,
      duplicate: duplicates.length,
      unavailable: unavailable.length,
      balanced: rows.length === successes.length + duplicates.length + unavailable.length,
    },
    duplicates,
    unavailable,
    sources: successes.map(source => ({
      sourceId: source.aweme_id,
      title: source.title,
      author: source.author,
      canonicalUrl: source.source_url,
      knowledgeSha256: source.knowledge_sha256,
      card: source.relativeCard,
      clusters: source.clusterMatches.map(cluster => cluster.id),
      sourceClaimStatus: "source-claim",
      userJudgmentStatus: "pending_user_judgment",
      aiInferenceStatus: "candidate",
    })),
  };
  writeJson(path.join(outputRoot, "INPUT_MANIFEST.json"), manifest);
  writeText(path.join(outputRoot, "library", "INDEX.md"), buildIndex(successes, clusterMap));

  const candidates = {
    schemaVersion: 1,
    warning: "Candidate generator only. Popularity and keyword relevance do not prove a topic should be selected.",
    clusters: CLUSTERS.map(cluster => ({
      id: cluster.id,
      title: cluster.title,
      sourceCount: clusterMap.get(cluster.id).length,
      candidates: clusterMap.get(cluster.id).slice(0, 12).map(source => ({
        sourceId: source.aweme_id,
        title: source.title,
        author: source.author,
        canonicalUrl: source.source_url,
        matchedKeywords: source.clusterMatches.find(value => value.id === cluster.id)?.matchedKeywords || [],
        popularitySignal: {
          likes: Number(source.likes || 0),
          collects: Number(source.collects || 0),
          comments: Number(source.comments || 0),
          shares: Number(source.shares || 0),
        },
      })),
    })),
  };
  writeJson(path.join(outputRoot, "TOPIC_CANDIDATES.json"), candidates);
  writeText(path.join(outputRoot, "DEMO", "README.md"), [
    "# 脱敏演示待办",
    "",
    "只有用户批准内部 V0 后，才从私有证据库中选择已授权来源制作脱敏截图或演示。",
    "",
    "禁止包含账号信息、私人收藏清单、登录状态、Cookie、Token、二维码或本机私有路径。",
  ].join("\n"));

  writeText(path.join(outputRoot, "README.md"), [
    "# 创作者内容证据库内部 V0",
    "",
    `- 有效来源：${successes.length}`,
    `- 重复：${duplicates.length}`,
    `- 不可用：${unavailable.length}`,
    `- 对账：${manifest.reconciliation.balanced ? "通过" : "失败"}`,
    `- 私密输出目录：${outputRoot}`,
    `- 选题包：${fs.existsSync(path.join(outputRoot, "TOPIC_PACKS.md")) ? "已生成" : "待人工生成"}`,
    `- 内容大纲：${fs.existsSync(path.join(outputRoot, "CONTENT_OUTLINE.md")) ? "已生成" : "待人工生成"}`,
    "",
    "从 `library/INDEX.md` 开始浏览。不要把本目录提交到 Git。",
  ].join("\n"));

  const hits = secretHits(outputRoot);
  const completedAt = new Date();
  const receipt = {
    schemaVersion: 1,
    product: "creator-evidence-library-v0",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    elapsedSeconds: Number(((completedAt - startedAt) / 1000).toFixed(3)),
    reconciliation: manifest.reconciliation,
    privacy: {
      authorSecUidOmitted: true,
      credentialsRead: false,
      secretScanPassed: hits.length === 0,
      secretScanHits: hits,
      outputIsPrivateRuntime: outputRoot.includes(`${path.sep}.runtime${path.sep}`),
    },
    finalArtifactsPending: [
      ...(!fs.existsSync(path.join(outputRoot, "TOPIC_PACKS.md")) ? ["TOPIC_PACKS.md"] : []),
      ...(!fs.existsSync(path.join(outputRoot, "CONTENT_OUTLINE.md")) ? ["CONTENT_OUTLINE.md"] : []),
      "user-result-approval",
    ],
    fileHashes: Object.fromEntries(
      walkFiles(outputRoot)
        .filter(filePath => !filePath.endsWith("DELIVERY_RECEIPT.json"))
        .map(filePath => [path.relative(outputRoot, filePath).replaceAll("\\", "/"), sha256File(filePath)]),
    ),
  };
  writeJson(path.join(outputRoot, "DELIVERY_RECEIPT.json"), receipt);

  if (!manifest.reconciliation.balanced) throw new Error("Input reconciliation failed");
  if (successes.length < Math.min(50, rows.length)) throw new Error(`Only ${successes.length} valid sources were produced`);
  if (hits.length) throw new Error(`Secret scan failed: ${hits.join(", ")}`);
  return { outputRoot, manifest, receipt };
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = buildCreatorEvidenceLibrary(options);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputRoot: result.outputRoot,
      reconciliation: result.manifest.reconciliation,
      elapsedSeconds: result.receipt.elapsedSeconds,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
