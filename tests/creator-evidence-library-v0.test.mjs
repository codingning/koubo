import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildCreatorEvidenceLibrary } from "../scripts/product-v0/build-creator-evidence-library-v0.mjs";
import { validateCreatorEvidenceLibrary } from "../scripts/product-v0/validate-creator-evidence-library-v0.mjs";

test("builds and validates a private traceable evidence library", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "creator-evidence-v0-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  const output = path.join(directory, ".runtime", "product-v0", "result");
  fs.mkdirSync(path.join(source, "var", "knowledge"), { recursive: true });
  const database = new DatabaseSync(path.join(source, "var", "state.sqlite3"));
  database.exec(`
    CREATE TABLE items (
      aweme_id TEXT PRIMARY KEY, source_url TEXT, title TEXT, author TEXT, status TEXT,
      knowledge_path TEXT, knowledge_sha256 TEXT, media_sha256 TEXT, transcript_sha256 TEXT,
      likes INTEGER, collects INTEGER, comments INTEGER, shares INTEGER, discovered_at TEXT
    )
  `);
  const insert = database.prepare(`
    INSERT INTO items VALUES (?, ?, ?, ?, 'written', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (let index = 0; index < 50; index += 1) {
    const id = String(7600000000000000000n + BigInt(index));
    const knowledgeDir = path.join(source, "var", "knowledge", id);
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const knowledgePath = path.join(knowledgeDir, "knowledge.json");
    const knowledge = {
      schemaVersion: 1,
      thesis: `来源观点 ${index}`,
      summary: `关于内容选题与AI工作流的摘要 ${index}`,
      keyIdeas: [{ timestampSeconds: 3, timestamp: "00:03", title: `要点 ${index}`, detail: "可追溯细节", sourceExcerpt: "来源片段" }],
      actions: [], limitations: ["单一来源"], verificationNeeds: [],
      tags: ["内容", "选题"], relatedConcepts: ["工作流"],
      provenance: { canonicalUrl: `https://www.douyin.com/video/${id}`, mediaSha256: `media-${index}`, transcriptSha256: `transcript-${index}` },
    };
    fs.writeFileSync(knowledgePath, JSON.stringify(knowledge), "utf8");
    insert.run(id, `https://www.douyin.com/video/${id}`, `标题 ${index}`, `作者 ${index}`,
      knowledgePath, `knowledge-${index}`, `media-${index}`, `transcript-${index}`,
      index, index, index, index, new Date(2026, 7, 1, 0, 0, index).toISOString());
  }
  database.close();

  const result = buildCreatorEvidenceLibrary({ source, output, limit: 50 });
  assert.equal(result.manifest.reconciliation.success, 50);
  assert.equal(result.manifest.reconciliation.balanced, true);
  const validation = validateCreatorEvidenceLibrary(output);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(validation.summary.sourceCards, 50);
  const card = fs.readFileSync(path.join(output, "library", "sources", "7600000000000000000.md"), "utf8");
  assert.match(card, /## 来源主张/u);
  assert.match(card, /## 用户判断/u);
  assert.doesNotMatch(card, /sec_uid/u);

  fs.writeFileSync(path.join(output, "library", "sources", "stale.md"), "stale", "utf8");
  const sourceIds = Array.from({ length: 6 }, (_, index) => String(7600000000000000000n + BigInt(index)));
  fs.writeFileSync(path.join(output, "TOPIC_PACKS.md"), [
    "# 选题包",
    ...[0, 1, 2].flatMap(topicIndex => [
      `## TOPIC-0${topicIndex + 1} 测试选题`,
      `- SRC-DOUYIN-${sourceIds[topicIndex * 2]}`,
      `- SRC-DOUYIN-${sourceIds[topicIndex * 2 + 1]}`,
    ]),
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(output, "CONTENT_OUTLINE.md"), [
    "selected_topic: TOPIC-01",
    "来源观点：测试",
    "用户判断：测试",
    "AI 推断：测试",
  ].join("\n"), "utf8");

  buildCreatorEvidenceLibrary({ source, output, limit: 50 });
  assert.equal(fs.existsSync(path.join(output, "library", "sources", "stale.md")), false);
  const finalValidation = validateCreatorEvidenceLibrary(output, { requireFinal: true });
  assert.equal(finalValidation.ok, true, finalValidation.errors.join("\n"));
  const receipt = JSON.parse(fs.readFileSync(path.join(output, "DELIVERY_RECEIPT.json"), "utf8"));
  assert.deepEqual(receipt.finalArtifactsPending, ["user-result-approval"]);
});
