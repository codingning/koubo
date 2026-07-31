import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCreatorVaultKnowledgeAdapter,
  selectDiversePrinciples,
} from "../../video/multi-agent/creator-vault-knowledge.mjs";

test("Creator Vault adapter requires explicit trial opt-in and returns auditable principles", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "koubo-creator-vault-adapter-"));
  const root = path.join(directory, "vault");
  const cli = path.join(directory, "cli.mjs");
  fs.mkdirSync(root);
  fs.writeFileSync(cli, "fixture");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const record = {
    id: "content-principle.real-use.v1",
    status: "trial",
    namespace: "shared.content-principles",
    contentHash: "a".repeat(64),
    title: "真实使用决定下一版",
    problem: "先寻找真实使用和具体缺口",
    applicability: ["短视频"],
    parameters: {
      sourceVideoId: "video-1",
      sourceTitle: "真实实验",
      timecodes: [{ startSeconds: 10, endSeconds: 20, startLabel: "00:10", endLabel: "00:20" }],
      claim: "真实使用决定下一版",
      abstraction: "先寻找真实使用和具体缺口，再讨论扩展。",
      counterexamples: ["安全问题需要提前预防。"],
    },
  };
  const adapter = createCreatorVaultKnowledgeAdapter({
    vaultRoot: root,
    cliPath: cli,
    run: async (nodePath, args) => {
      calls.push({ nodePath, args });
      return { stdout: JSON.stringify([record]) };
    },
  });

  await assert.rejects(
    () => adapter.retrieve({ agentId: "content-strategist", query: "真实短视频", topK: 3 }),
    /includeTrial=true/
  );
  const result = await adapter.retrieve({
    agentId: "content-strategist",
    query: "真实短视频",
    includeTrial: true,
    topK: 3,
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--trial"));
  assert.deepEqual(calls[0].args.slice(-2), ["--limit", "12"]);
  assert.equal(result.principles[0].id, record.id);
  assert.equal(result.principles[0].status, "trial");
  assert.equal(result.audit.records[0].rank, 1);
  assert.equal(result.audit.records[0].retrievalRank, 1);
  assert.equal(result.audit.records[0].id, record.id);
  assert.equal(result.audit.records[0].status, "trial");
  assert.equal(result.audit.records[0].namespace, "shared.content-principles");
  assert.equal(result.audit.records[0].contentHash, "a".repeat(64));
  assert.ok(result.audit.records[0].contextualScore > 0);
  assert.equal(result.audit.mode, "trial-opt-in-contextual-diversity-v2");
  assert.equal(result.audit.candidateLimit, 12);
  assert.equal(result.audit.selectionPolicy, "contextual-diversity-v2");
  assert.equal("vaultRoot" in result.audit, false);
  assert.equal("cliPath" in result.audit, false);
});

test("Creator Vault selection prefers contextual applicability and source diversity", () => {
  const principles = [
    {
      id: "generic-one",
      sourceVideoId: "source-a",
      claim: "工作流需要人工兜底",
      abstraction: "通用治理原则",
      applicability: ["工作流治理"],
      counterexamples: ["高风险例外"],
    },
    {
      id: "asset-specific",
      sourceVideoId: "source-a",
      claim: "素材库要通过真实复用形成资产",
      abstraction: "检查素材检索和复用结果",
      applicability: ["素材库", "跨项目复用"],
      counterexamples: ["一次性素材不必资产化"],
    },
    {
      id: "skill-specific",
      sourceVideoId: "source-b",
      claim: "开源Skill需要真实试用",
      abstraction: "检查许可证和本地结果",
      applicability: ["开源Skill", "工具测评"],
      counterexamples: ["未运行不能声称可用"],
    },
    {
      id: "experiment-specific",
      sourceVideoId: "source-c",
      claim: "失败版本需要保留",
      abstraction: "用失败和返修解释Agent训练",
      applicability: ["Agent训练", "版本复盘"],
      counterexamples: ["不能据此自动晋升"],
    },
  ];
  const selected = selectDiversePrinciples(principles, {
    query: "素材库 开源Skill Agent训练 失败版本 跨项目复用",
    topK: 3,
  });
  assert.deepEqual(selected.map(item => item.principle.id), [
    "asset-specific",
    "experiment-specific",
    "skill-specific",
  ]);
  assert.equal(new Set(selected.map(item => item.principle.sourceVideoId)).size, 3);
  assert.equal(selected.some(item => item.principle.id === "generic-one"), false);
});
