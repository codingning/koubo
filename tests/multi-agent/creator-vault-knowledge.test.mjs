import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCreatorVaultKnowledgeAdapter } from "../../video/multi-agent/creator-vault-knowledge.mjs";

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
  assert.deepEqual(calls[0].args.slice(-2), ["--limit", "3"]);
  assert.equal(result.principles[0].id, record.id);
  assert.equal(result.principles[0].status, "trial");
  assert.deepEqual(result.audit.records[0], {
    rank: 1,
    id: record.id,
    status: "trial",
    namespace: "shared.content-principles",
    contentHash: "a".repeat(64),
  });
  assert.equal("vaultRoot" in result.audit, false);
  assert.equal("cliPath" in result.audit, false);
});
