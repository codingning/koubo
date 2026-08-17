import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrdinaryViewerCriticRequest,
  createOrdinaryViewerCritic,
  validateOrdinaryViewerCriticOutput,
} from "../../video/multi-agent/ordinary-viewer-critic.mjs";

const approvedDirection = {
  audience: "收藏了很多 AI 方法、但还没有开始行动的普通人",
  viewerBenefit: "看完能判断并完成一个今天可执行的动作",
  coreQuestion: "这条内容是否把真实行动和证据翻译成观众价值",
};

function classifications(overrides = {}) {
  return {
    fact: [],
    subjective: [],
    uncertain: [],
    ...overrides,
  };
}

function validScriptOutput({ quote, decision = "听懂但无用", conclusion = "这段话只有正确口号，没有观众能验证或带走的东西" } = {}) {
  return {
    sharpConclusion: conclusion,
    blockers: quote ? [{
      issue: "关键承诺没有落到真实行动或结果",
      quote,
      classification: "fact",
    }] : [],
    viewerValueGap: "观众不知道这和自己今天的处境有什么关系",
    evidenceGap: "没有原始输入、执行过程或结果证据",
    minimalFix: "保留当前方向，只补一个真实动作、对应证据和普通人可复用的一步",
    viewerDecision: decision,
    classifications: classifications({
      fact: quote ? ["稿件没有提供可核验结果"] : [],
      subjective: ["我不会因为抽象口号而收藏"],
      uncertain: ["补充真实案例后可能成立"],
    }),
  };
}

async function reviewScript(script, output) {
  let captured;
  const critic = createOrdinaryViewerCritic({
    invokeAgent: async request => {
      captured = request;
      return { success: true, result: output };
    },
  });
  const result = await critic.review({
    stage: "script",
    approvedDirection,
    script,
    facts: [],
    author: "hidden-author",
    agentId: "script-agent",
    rationale: "hidden-rationale",
  });
  return { captured, result };
}

test("generic AI copy can be rejected with an exact script quote", async () => {
  const script = "AI 正在改变世界，普通人一定要抓住机会。现在开始学习，你就能获得未来。";
  const quote = "AI 正在改变世界";
  const { captured, result } = await reviewScript(script, validScriptOutput({ quote }));

  assert.equal(captured.stage, "script");
  assert.equal(captured.script, script);
  assert.equal(result.viewerDecision, "听懂但无用");
  assert.equal(captured.operation, "agent_critique");
  assert.equal(captured.agentId, "ordinary-viewer-critic");
  assert.equal(captured.critiqueKind, "ordinary_viewer");
  assert.equal(captured.inspectionMode, "script_text");
  assert.equal(result.blockers[0].quote, quote);
  assert.equal(JSON.stringify(captured).includes("hidden-author"), false);
  assert.equal(JSON.stringify(captured).includes("script-agent"), false);
  assert.equal(JSON.stringify(captured).includes("hidden-rationale"), false);
});

test("project status report is judged from viewer value rather than implementation effort", async () => {
  const script = "我们完成了三个模块、十二个接口和一百项测试，整个工作流已经跑通。";
  const output = validScriptOutput({
    quote: "我们完成了三个模块、十二个接口和一百项测试",
    decision: "整体不接受",
    conclusion: "这是一份项目周报，不是一条普通观众值得看的内容",
  });
  const { result } = await reviewScript(script, output);

  assert.equal(result.viewerDecision, "整体不接受");
  assert.match(result.sharpConclusion, /项目周报/);
});

test("unsupported full-automation claim must expose its evidence gap", async () => {
  const script = "我已经让 AI 全自动无人值守地完成选题、剪辑和发布。";
  const output = validScriptOutput({ quote: "全自动无人值守地完成选题、剪辑和发布" });
  output.evidenceGap = "没有运行记录、人工门禁、失败处理或真实发布证据";
  output.classifications = classifications({
    fact: ["稿件声称系统无人值守"],
    subjective: ["绝对化表述降低可信度"],
    uncertain: ["系统是否存在人工审核无法从稿件确认"],
  });

  const { result } = await reviewScript(script, output);
  assert.match(result.evidenceGap, /人工门禁/);
  assert.equal(result.classifications.uncertain.length, 1);
});

test("qualified evidence-led script may pass with no blockers", async () => {
  const script = "我先写下一件真实麻烦，AI 只给了一个动作；这是原始回复，这是我做完后的结果。";
  const output = {
    sharpConclusion: "真实输入、行动和结果已经形成完整闭环",
    blockers: [],
    viewerValueGap: "无明显缺口",
    evidenceGap: "仍需在发布前核对截图脱敏和原始时间顺序",
    minimalFix: "只核对证据连续性，不扩写新的成功结论",
    viewerDecision: "清楚且有用",
    classifications: classifications({
      fact: ["稿件同时包含输入、动作和结果"],
      subjective: ["这个闭环具有收藏价值"],
      uncertain: ["截图真实性需在成片阶段复核"],
    }),
  };

  const { result } = await reviewScript(script, output);
  assert.equal(result.blockers.length, 0);
  assert.equal(result.viewerDecision, "清楚且有用");
});

test("a malformed model citation gets one bounded validation-repair attempt", async () => {
  const script = "我展示了真实输入和结果。";
  const requests = [];
  const critic = createOrdinaryViewerCritic({
    invokeAgent: async request => {
      requests.push(request);
      return {
        success: true,
        result: requests.length === 1
          ? validScriptOutput({ quote: "稿件里不存在的句子" })
          : validScriptOutput({ quote: "真实输入和结果" }),
      };
    },
  });

  const result = await critic.review({
    stage: "script",
    approvedDirection,
    script,
    facts: [],
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].validationRepair.attempt, 2);
  assert.match(requests[1].validationRepair.previousError, /quote must exist/i);
  assert.equal(result.blockers[0].quote, "真实输入和结果");
});

test("render stage sends an anonymous minimum and requires timestamped blockers", async () => {
  let captured;
  const critic = createOrdinaryViewerCritic({
    invokeAgent: async request => {
      captured = request;
      return {
        sharpConclusion: "成片先讲系统名称，八秒后才出现观众能用的结果",
        blockers: [{
          issue: "开头被项目汇报占满",
          start: 0,
          end: 7.8,
          classification: "subjective",
        }],
        viewerValueGap: "普通观众在前八秒不知道能获得什么",
        evidenceGap: "转录直到后段才说出普通观众可用的结果",
        minimalFix: "保留主题，把真实结果提前到首屏并压缩项目背景",
        viewerDecision: "听懂但无用",
        classifications: classifications({
          fact: ["转录在7.8秒后才提到普通观众可用的结果"],
          subjective: ["我不会等待项目背景讲完"],
          uncertain: ["目标观众是否已熟悉项目无法确认"],
        }),
      };
    },
  });

  const result = await critic.review({
    stage: "render",
    approvedDirection,
    media: {
      attachment: "media://candidate-a",
      durationSeconds: 31.2,
      width: 1080,
      height: 1920,
      author: "hidden-render-author",
    },
    transcript: [
      { start: 0, end: 7.8, text: "我们搭建了一套多 Agent 系统" },
      { start: 7.8, end: 12.4, text: "这是普通人可以直接复制的结果" },
    ],
    frameEvidence: [{
      artifactId: "frame:contact-sheet-a",
      sourceId: "render.candidate-a",
      start: 0,
      end: 12.4,
      observation: "前7.8秒只有人物口播和系统名称，7.8秒后才展示结果卡",
      provenance: "vision_verified",
    }],
    directorRationale: "hidden-director-reason",
    proposalOrder: 2,
  });

  const serialized = JSON.stringify(captured);
  assert.match(captured.candidateLabel, /^anonymous-[a-f0-9]{12}$/);
  assert.equal(serialized.includes("hidden-render-author"), false);
  assert.equal(serialized.includes("hidden-director-reason"), false);
  assert.equal(serialized.includes("proposalOrder"), false);
  assert.equal(captured.inspectionMode, "sampled_frames_and_transcript");
  assert.deepEqual(Object.keys(captured.media).sort(), ["attachment", "durationSeconds", "height", "width"]);
  assert.equal(result.blockers[0].start, 0);
  assert.equal(result.blockers[0].end, 7.8);
});

test("insulting critic output is rejected", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "这是一个真实测试。",
  });
  const output = validScriptOutput({ quote: "这是一个真实测试" });
  output.sharpConclusion = "作者就是个傻逼，内容没有价值";

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /insult/i
  );
});

test("render blocker without a timecode is rejected", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "media://candidate-b", durationSeconds: 20 },
    transcript: [{ start: 0, end: 20, text: "完整转录" }],
  });
  const output = validScriptOutput();
  output.blockers = [{ issue: "问题没有定位", classification: "fact" }];

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /timestamp/i
  );
});

test("script blocker must quote text that actually exists", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我展示了真实输入和结果。",
  });
  const output = validScriptOutput({ quote: "稿件里不存在的句子" });

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /quote must exist/i
  );
});

test("critic cannot return publication authority", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我展示了真实输入和结果。",
  });
  const output = validScriptOutput({ quote: "真实输入和结果" });
  output.publish = true;

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /authority field/i
  );
});

test("critic cannot expand beyond three blockers", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "第一句。第二句。第三句。第四句。",
  });
  const output = validScriptOutput();
  output.blockers = ["第一句", "第二句", "第三句", "第四句"].map(quote => ({
    issue: "阻断问题",
    quote,
    classification: "fact",
  }));

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /at most three blockers/i
  );
});

test("topic switching or whole-script rewrites are rejected", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我完成了第一次真实测试。",
  });
  const output = validScriptOutput({ quote: "第一次真实测试" });
  output.minimalFix = "换个主题，并把整篇从头重写成 AI 工具排行榜。";

  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /change topic|whole rewrite/i
  );
});

test("topic switching is rejected in every text field, not only minimalFix", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我完成了第一次真实测试。",
  });
  for (const patch of [
    { sharpConclusion: "建议换个主题，这个不值得做" },
    { viewerValueGap: "应该另选主题，当前方向与普通人无关" },
    { evidenceGap: "整篇从头重写才能解决" },
  ]) {
    assert.throws(
      () => validateOrdinaryViewerCriticOutput({
        ...validScriptOutput({ quote: "第一次真实测试" }),
        ...patch,
      }, request),
      /change topic|whole rewrite/i
    );
  }
});

test("aggregate retention predictions and textual scope bypasses are rejected", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我完成了第一次真实测试。",
  });
  for (const sharpConclusion of [
    "这段会让百分之八十的人在三秒内划走",
    "这个版本胜出，是三个候选里最好的一版",
    "H.264编码和完整解码都通过了",
    "这段节奏太慢，停顿过多",
  ]) {
    assert.throws(
      () => validateOrdinaryViewerCriticOutput({
        ...validScriptOutput({ quote: "第一次真实测试" }),
        sharpConclusion,
      }, request),
      /retention|winner|technical QA|pacing analysis/i,
      sharpConclusion
    );
  }
});

test("facts preserve source provenance and reject untraceable strings", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "这是一次真实测试。",
    facts: [{
      sourceId: "evidence.real-run.v1",
      provenance: "workspace_verified",
      claim: "真实运行完成",
      start: 2.4,
      end: 4.8,
    }],
  });
  assert.deepEqual(request.facts[0], {
    sourceId: "evidence.real-run.v1",
    provenance: "workspace_verified",
    claim: "真实运行完成",
    start: 2.4,
    end: 4.8,
  });
  assert.throws(() => buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "这是一次真实测试。",
    facts: ["无法追溯的事实"],
  }), /sourceId/);
});

test("all ordinary-viewer model fields reject embedded local paths", () => {
  assert.throws(() => buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "这是一次真实测试。",
    facts: [{
      sourceId: "evidence.real-run.v1",
      provenance: "workspace_verified",
      claim: "证据保存在 C:\\private\\secret.json",
    }],
  }), /local path/i);

  assert.throws(() => buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "media://candidate-safe", durationSeconds: 10 },
    transcript: [{ start: 0, end: 10, text: "请打开 /Users/private/secret.txt" }],
  }), /local path/i);
});

test("render input rejects local paths and transcript-only output cannot invent visual observations", () => {
  assert.throws(() => buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "C:\\private\\video.mp4", durationSeconds: 10 },
    transcript: [{ start: 0, end: 10, text: "这是完整转录" }],
  }), /opaque media/);

  const request = buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "media://candidate-transcript-only", durationSeconds: 10 },
    transcript: [{ start: 0, end: 10, text: "这是完整转录" }],
  });
  assert.equal(request.inspectionMode, "transcript_and_metadata_only");
  assert.deepEqual(request.evidenceBoundary.notSeen, [
    "frames",
    "visuals",
    "captions_as_rendered",
    "audio",
    "bgm",
    "noise",
    "voice_delivery",
  ]);
  const output = validScriptOutput();
  output.sharpConclusion = "画面里的字幕太小，普通人无法看清";
  assert.throws(
    () => validateOrdinaryViewerCriticOutput(output, request),
    /cannot claim visual or audio observations/
  );
});

test("transcript-only output cannot invent audio, BGM, noise, or voice-masking observations", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "media://candidate-audio-transcript-only", durationSeconds: 10 },
    transcript: [{ start: 0, end: 10, text: "这是完整转录" }],
  });

  for (const claim of [
    "我听到背景音乐很吵",
    "这段音频有噪声",
    "背景音乐太吵",
    "BGM太吵",
    "噪声盖过人声",
    "人声被背景音乐压过",
  ]) {
    const output = validScriptOutput();
    output.sharpConclusion = claim;
    assert.throws(
      () => validateOrdinaryViewerCriticOutput(output, request),
      /cannot claim audio observations/,
      claim
    );
  }
});

test("sampled-frame visual claims must stay inside reviewed frame ranges and audio claims remain forbidden", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "render",
    approvedDirection,
    media: { attachment: "media://candidate-sampled", durationSeconds: 12 },
    transcript: [
      { start: 0, end: 1, text: "开头" },
      { start: 10, end: 11, text: "后段" },
    ],
    frameEvidence: [{
      artifactId: "frame:sampled-opening",
      sourceId: "render.sampled",
      start: 0,
      end: 1,
      observation: "开头字幕占据主要区域",
      provenance: "vision_verified",
    }],
  });

  const outside = validScriptOutput();
  outside.blockers = [{
    issue: "后段字幕无法看清",
    start: 10,
    end: 11,
    classification: "fact",
  }];
  assert.throws(
    () => validateOrdinaryViewerCriticOutput(outside, request),
    /outside reviewed frame evidence/
  );

  const unscoped = validScriptOutput();
  unscoped.evidenceGap = "画面没有展示结果";
  assert.throws(
    () => validateOrdinaryViewerCriticOutput(unscoped, request),
    /timestamped blocker/
  );

  const audio = validScriptOutput();
  audio.blockers = [{
    issue: "声音太小，听不清重点",
    start: 0,
    end: 1,
    classification: "subjective",
  }];
  assert.throws(
    () => validateOrdinaryViewerCriticOutput(audio, request),
    /cannot claim audio observations/
  );

  const covered = validScriptOutput();
  covered.blockers = [{
    issue: "开头字幕占据主要区域",
    start: 0,
    end: 1,
    classification: "fact",
  }];
  const result = validateOrdinaryViewerCriticOutput(covered, request);
  assert.equal(result.blockers[0].start, 0);
});

test("critic cannot perform retention, technical QA, or winner selection", () => {
  const request = buildOrdinaryViewerCriticRequest({
    stage: "script",
    approvedDirection,
    script: "我展示了真实输入和结果。",
  });
  for (const forbidden of [
    { retentionScore: 0.8 },
    { technicalQa: { pass: true } },
    { winner: "candidate-a" },
  ]) {
    assert.throws(
      () => validateOrdinaryViewerCriticOutput({
        ...validScriptOutput({ quote: "真实输入和结果" }),
        ...forbidden,
      }, request),
      /out-of-scope field/
    );
  }
});
