# Koubo Controlled Multi-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a production-trial-ready controlled multi-agent creation, tutorial-ingestion, evaluation, and governed local-memory loop while retaining Visual Director v4 as the default baseline and fallback.

**Architecture:** The existing Node Visual Director remains the deterministic controller. New focused Node modules own schemas, SQLite indexing, JSON exports, memory governance, tutorial checkpoints, orchestration, and evaluation; a pinned Python bridge supplies OpenAI Agents SDK and PySceneDetect integrations behind injectable interfaces. HyperFrames and FFmpeg remain the only production render/composite engines.

**Tech Stack:** Node.js 22.20 built-ins (`node:test`, `node:sqlite`), Python 3.13.9 virtual environment, `openai-agents==0.18.3`, `scenedetect==0.7.1`, `promptfoo@0.120.0`, `hyperframes@0.7.68`, faster-whisper, FFmpeg.

## Global Constraints

- Work only on `codex/koubo-multi-agent-implementation`; do not modify `main`, push, deploy, publish, or create a PR.
- Keep `visual-director-v4` as the default path and `ffmpeg-v3` as the existing legacy fallback.
- Video, audio, transcripts, memory, and traces remain local; no secret or private raw content enters Git, trace exports, or third-party observability.
- Agents propose or evaluate; Node owns state transitions, review gates, rendering, retry, rollback, and publication authority.
- All agent and memory records use versioned JSON Schema and record code, model, prompt, memory, asset, recipe, and evaluation versions.
- Automatic extraction enters `inbox`; no automatic promotion, brand-core mutation, asset approval, final approval, or publication.
- Every new dependency is pinned, documented, isolated, and replaceable.
- Use test-first RED → GREEN → REFACTOR for every production behavior.
- Real job media remain in the existing local `video-jobs` directory and are referenced by job ID and hashes, never copied into Git.

---

## File Map

### Evaluation baseline

- `config/evaluation/baseline-v1.json`: frozen 3–5 job selection and coverage labels.
- `scripts/freeze_evaluation_baseline.mjs`: deterministic job discovery, artifact inventory, and SHA-256 builder.
- `tests/baseline/freeze_evaluation_baseline.test.mjs`: fixture-driven baseline selection and immutability tests.
- `tests/fixtures/jobs/*/job.json`: synthetic job metadata only.

### Contracts and storage

- `config/multi-agent/schemas/*.schema.json`: eight versioned record contracts.
- `config/multi-agent/agent-profiles.json`: role boundaries and allowed memory namespaces.
- `config/multi-agent/evaluation-rubric.json`: versioned scoring dimensions.
- `video/multi-agent/contracts.mjs`: schema registry, common-field validation, and stable canonical JSON.
- `video/multi-agent/store.mjs`: SQLite index, transactions, JSON export, and append-only events.
- `video/multi-agent/migrations/001_initial.sql`: initial tables and indexes.
- `video/multi-agent/memory.mjs`: lifecycle, namespaces, retrieval, promotion, demotion, expiry, rejection, and rollback.
- `tests/multi-agent/contracts.test.mjs`
- `tests/multi-agent/store.test.mjs`
- `tests/multi-agent/memory.test.mjs`

### Tutorial ingestion and recreation

- `video/multi-agent/tutorial-ingest.mjs`: resumable deterministic ingestion state machine.
- `video/multi-agent/tutorial-sandbox.mjs`: safe local reconstruction project generator and QA manifest.
- `video/multi_agent_bridge.py`: pinned Python operations for scene detection and structured agent calls.
- `scripts/ingest_tutorial.mjs`: local CLI.
- `scripts/create_legal_tutorial_fixture.ps1`: locally generated three-scene narrated tutorial fixture.
- `tests/multi-agent/tutorial-ingest.test.mjs`
- `tests/multi-agent/tutorial-sandbox.test.mjs`
- `tests/python/test_multi_agent_bridge.py`

### Controlled agents and evaluation

- `video/multi-agent/orchestrator.mjs`: bounded independent proposals, director composition, critics, fallback.
- `video/multi-agent/profiles.mjs`: Caption, Motion, Sound, Director, Blind Critic, and Retention Critic prompt/input builders.
- `video/multi-agent/evaluation.mjs`: deterministic dimensions, diversity checks, traceable scorecards, A/B bundles.
- `config/evaluation/promptfooconfig.yaml`: pinned local prompt regression suite.
- `tests/multi-agent/orchestrator.test.mjs`
- `tests/multi-agent/evaluation.test.mjs`

### Server and workbench integration

- `video/multi-agent/api.mjs`: isolated API handler for memory, ingestion, proposals, A/B, and review actions.
- `video/server.mjs`: mount the handler and expose capability status; retain all existing routes and review guards.
- `web/index.html`: add multi-agent proposal, comparison, tutorial, and memory panels.
- `web/app.js`: load, compare, approve/reject, and render audit data.
- `web/styles.css`: panel and comparison presentation.
- `scripts/verify_workbench.mjs`: syntax, route, schema, UI, privacy, and fallback assertions.
- `tests/multi-agent/api.test.mjs`
- `docs/MULTI_AGENT_VIDEO_WORKFLOW.md`
- `docs/research/2026-07-23-multi-agent-dependency-lock.md`
- `docs/acceptance/multi-agent-v1-acceptance.md`

---

### Task 1: Freeze the v4 evaluation baseline

**Files:**
- Create: `tests/baseline/freeze_evaluation_baseline.test.mjs`
- Create: `tests/fixtures/jobs/legacy-approved/job.json`
- Create: `tests/fixtures/jobs/day2-review/job.json`
- Create: `tests/fixtures/jobs/v4-sample/job.json`
- Create: `scripts/freeze_evaluation_baseline.mjs`
- Create: `config/evaluation/baseline-v1.json`

**Interfaces:**
- Produces: `discoverJobCandidates(jobsRoot)`, `selectRepresentativeJobs(candidates, { min: 3, max: 5 })`, `freezeBaseline({ jobsRoot, outputFile })`.
- Baseline entry: `{ jobId, pipeline, status, source, coverage, artifacts, hashes, frozenAt, sourceRootPolicy }`.

- [x] **Step 1: Write the failing selector and immutability tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { selectRepresentativeJobs, freezeBaseline } from "../../scripts/freeze_evaluation_baseline.mjs";

test("selects three to five jobs and covers legacy, rich review, and v4 sample", () => {
  const selected = selectRepresentativeJobs([
    { jobId: "legacy", pipeline: "ffmpeg-v3", status: "approved", traits: ["method"] },
    { jobId: "day2", pipeline: "ffmpeg-v3", status: "awaiting_review", traits: ["evidence", "captions", "motion"] },
    { jobId: "v4", pipeline: "visual-director-v4", status: "awaiting_sample_review", traits: ["v4", "captions"] },
  ], { min: 3, max: 5 });
  assert.equal(selected.length, 3);
  assert.deepEqual(new Set(selected.flatMap(item => item.traits)), new Set(["method", "evidence", "captions", "motion", "v4"]));
});

test("refuses to overwrite a frozen manifest with different hashes", async () => {
  await assert.rejects(
    () => freezeBaseline({ jobsRoot: "tests/fixtures/jobs", outputFile: process.env.TEST_BASELINE, now: "2026-07-23T00:00:00.000Z" }),
    /frozen baseline differs/
  );
});
```

- [x] **Step 2: Run RED**

Run: `node --test tests/baseline/freeze_evaluation_baseline.test.mjs`
Expected: FAIL because the module and exports do not exist.

- [x] **Step 3: Implement deterministic discovery, coverage ranking, artifact hashing, and no-overwrite guard**

The CLI must accept:

```text
node scripts/freeze_evaluation_baseline.mjs --jobs-root F:\code\koubo\video-jobs --output config/evaluation/baseline-v1.json
```

It must hash `job.json`, the selected edit/timeline/caption/QA manifests, and available review/sample MP4 files without copying them.

- [x] **Step 4: Run GREEN and freeze the real manifest**

Run:

```text
node --test tests/baseline/freeze_evaluation_baseline.test.mjs
node scripts/freeze_evaluation_baseline.mjs --jobs-root F:\code\koubo\video-jobs --output config/evaluation/baseline-v1.json
node scripts/verify_workbench.mjs
```

Expected: all tests pass; manifest contains 3–5 entries; v4 verification remains 141 controls.

- [x] **Step 5: Commit**

```text
git add config/evaluation scripts/freeze_evaluation_baseline.mjs tests/baseline tests/fixtures/jobs
git commit -m "test: freeze v4 multi-agent evaluation baseline"
```

### Task 2: Add versioned contracts and role profiles

**Files:**
- Create: `config/multi-agent/schemas/{technique-card,asset-record,combination-recipe,agent-proposal,review-score,memory-promotion,production-event,agent-profile}.schema.json`
- Create: `config/multi-agent/agent-profiles.json`
- Create: `config/multi-agent/evaluation-rubric.json`
- Create: `video/multi-agent/contracts.mjs`
- Create: `tests/multi-agent/contracts.test.mjs`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 1`, `validateRecord(kind, value)`, `canonicalJson(value)`, `contentHash(value)`, `loadAgentProfiles(root)`.
- Common record fields: `id`, `schemaVersion`, `createdAt`, `createdBy`, `status`, `source`, `evidence`, `applicability`, `prohibitions`, `versions`, `contentHash`.

- [x] **Step 1: Write failing contract tests**

```js
test("rejects a technique card without timestamped evidence", () => {
  assert.throws(() => validateRecord("technique-card", {
    id: "caption.pop.v1", schemaVersion: 1, status: "inbox", evidence: []
  }), /evidence/);
});

test("canonical hashes ignore object key order but not record content", () => {
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});
```

- [x] **Step 2: Run RED**

Run: `node --test tests/multi-agent/contracts.test.mjs`
Expected: FAIL because `contracts.mjs` does not exist.

- [x] **Step 3: Implement the eight schemas and minimal schema registry**

Use repository-owned JSON Schema files for auditability. Implement only the JSON Schema keywords used by these contracts (`type`, `required`, `properties`, `items`, `enum`, `minimum`, `maximum`, `additionalProperties`) so the first version adds no generic validation dependency.

- [x] **Step 4: Run GREEN and validate every shipped config**

Run:

```text
node --test tests/multi-agent/contracts.test.mjs
node -e "import('./video/multi-agent/contracts.mjs').then(async m => m.validateRepositoryContracts(process.cwd()))"
```

Expected: PASS with all eight schemas and six profiles valid.

- [x] **Step 5: Commit**

```text
git add config/multi-agent video/multi-agent/contracts.mjs tests/multi-agent/contracts.test.mjs
git commit -m "feat: add versioned multi-agent contracts"
```

### Task 3: Implement SQLite index, JSON exports, events, and migrations

**Files:**
- Create: `video/multi-agent/migrations/001_initial.sql`
- Create: `video/multi-agent/store.mjs`
- Create: `tests/multi-agent/store.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `openDomainStore({ dbPath, exportRoot, clock })`.
- Store methods: `migrate()`, `put(kind, record, expectedHash?)`, `get(kind, id)`, `list(kind, filter)`, `appendEvent(event)`, `eventsFor(subjectId)`, `exportRecord(kind, id)`, `close()`.
- Runtime data path: `data/multi-agent/runtime/`; reviewable exports: `data/multi-agent/library/`.

- [x] **Step 1: Write failing transaction, append-only, export, and migration tests**

```js
test("writes a record and atomically exports canonical JSON", () => {
  const store = fixtureStore();
  store.put("technique-card", validTechnique());
  assert.equal(store.get("technique-card", "caption.pop.v1").status, "inbox");
  assert.deepEqual(JSON.parse(readFileSync(exportPath, "utf8")), store.get("technique-card", "caption.pop.v1"));
});

test("events cannot be updated or deleted", () => {
  const store = fixtureStore();
  store.appendEvent(validEvent());
  assert.throws(() => store.db.exec("UPDATE events SET action='changed'"), /append-only/);
});
```

- [x] **Step 2: Run RED**

Run: `node --test tests/multi-agent/store.test.mjs`
Expected: FAIL because the store does not exist.

- [x] **Step 3: Implement migration checksum, WAL, foreign keys, optimistic hash checks, atomic temp-file rename, and append-only triggers**

The database must contain `records`, `events`, `transitions`, `agent_namespaces`, `schema_migrations`, and `evaluation_runs`.

- [x] **Step 4: Run GREEN and migration replay**

Run:

```text
node --test tests/multi-agent/store.test.mjs
node --test tests/multi-agent/contracts.test.mjs tests/multi-agent/store.test.mjs
```

Expected: PASS; reopening a migrated fixture does not change schema or exported hashes.

- [x] **Step 5: Commit**

```text
git add .gitignore video/multi-agent/migrations video/multi-agent/store.mjs tests/multi-agent/store.test.mjs
git commit -m "feat: add auditable local domain store"
```

### Task 4: Implement governed specialist memory

**Files:**
- Create: `video/multi-agent/memory.mjs`
- Create: `tests/multi-agent/memory.test.mjs`

**Interfaces:**
- Produces: `createMemoryService(store, profiles)`.
- Methods: `ingest(record)`, `transition({ kind, id, to, actor, evidence, expectedHash })`, `retrieve({ agentId, query, includeCandidate })`, `reject(...)`, `expire(...)`, `rollback(transitionId)`, `exportNamespace(agentId)`.
- Lifecycle: `inbox → extracted → recreated → trial → approved → promoted`; `rejected`, `expired`, and `disabled` are terminal until explicit rollback.

- [x] **Step 1: Write failing lifecycle and namespace isolation tests**

```js
test("automatic extraction cannot skip to approved", () => {
  assert.throws(() => memory.transition({
    kind: "technique-card", id: "caption.pop.v1", to: "approved",
    actor: { type: "agent", id: "caption-agent" }, evidence: []
  }), /transition inbox -> approved is forbidden/);
});

test("motion agent cannot retrieve caption-only private memory", () => {
  const results = memory.retrieve({ agentId: "motion-agent", query: { tags: ["caption"] } });
  assert.equal(results.some(item => item.namespaces.includes("caption.private")), false);
});

test("rollback restores prior retrieval behavior", () => {
  const before = proposalInputs(memory, "caption-agent");
  const transition = promoteFixture(memory);
  assert.notDeepEqual(proposalInputs(memory, "caption-agent"), before);
  memory.rollback(transition.id);
  assert.deepEqual(proposalInputs(memory, "caption-agent"), before);
});
```

- [x] **Step 2: Run RED**

Run: `node --test tests/multi-agent/memory.test.mjs`
Expected: FAIL because the memory service does not exist.

- [x] **Step 3: Implement explicit transition table, evidence gates, negative memory, role filters, score ordering, and rollback events**

Promotion to `approved` requires a human review record; promotion to `promoted` requires at least two distinct approved project trials. Brand-core changes remain unsupported in v1.

- [x] **Step 4: Run GREEN and full foundation suite**

Run:

```text
node --test tests/multi-agent/contracts.test.mjs tests/multi-agent/store.test.mjs tests/multi-agent/memory.test.mjs
```

Expected: PASS with namespace export containing no raw media bytes or secrets.

- [x] **Step 5: Commit**

```text
git add video/multi-agent/memory.mjs tests/multi-agent/memory.test.mjs
git commit -m "feat: govern specialist editing memory"
```

### Task 5: Pin and isolate Python integrations

**Files:**
- Create: `requirements-multi-agent.lock.txt`
- Create: `video/multi_agent_bridge.py`
- Create: `tests/python/test_multi_agent_bridge.py`
- Create: `docs/research/2026-07-23-multi-agent-dependency-lock.md`
- Modify: `.env.example`

**Interfaces:**
- CLI: `python video/multi_agent_bridge.py --request request.json --response response.json`.
- Operations: `config`, `detect_scenes`, `agent_proposals`, `agent_critique`, `extract_techniques`.
- The bridge accepts injected/offline fixture responses for tests and never reads `.env` into output.

- [ ] **Step 1: Write failing Python contract and redaction tests**

```py
def test_config_reports_pinned_components_without_secrets(tmp_path):
    result = run_bridge(tmp_path, {"operation": "config", "api_key": "must-not-survive"})
    assert result["success"] is True
    assert result["agents_sdk"] == "0.18.3"
    assert "must-not-survive" not in json.dumps(result)

def test_unknown_operation_is_a_structured_failure(tmp_path):
    result = run_bridge(tmp_path, {"operation": "publish_video"})
    assert result == {"success": False, "error": "unsupported operation: publish_video"}
```

- [ ] **Step 2: Run RED with the explicit Python 3 runtime**

Run: `D:\util\Python\3.13.9\python.exe -m unittest tests.python.test_multi_agent_bridge -v`
Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Add exact pins and minimal bridge**

Lock:

```text
openai-agents==0.18.3
scenedetect==0.7.1
```

Document MIT/BSD-3-Clause licenses, Python ≥3.10 requirements, local-data behavior, replacement interfaces, and the Promptfoo `0.120.0` Node compatibility decision.

- [ ] **Step 4: Create isolated venv, install pins, audit, and run GREEN**

Run:

```text
D:\util\Python\3.13.9\python.exe -m venv .runtime-multi-agent
.\.runtime-multi-agent\Scripts\python.exe -m pip install --requirement requirements-multi-agent.lock.txt
.\.runtime-multi-agent\Scripts\python.exe -m pip check
.\.runtime-multi-agent\Scripts\python.exe -m unittest tests.python.test_multi_agent_bridge -v
```

Expected: `pip check` and tests PASS. Add `.runtime-multi-agent/` to `.gitignore`; never commit the environment.

- [ ] **Step 5: Commit**

```text
git add .gitignore .env.example requirements-multi-agent.lock.txt video/multi_agent_bridge.py tests/python docs/research/2026-07-23-multi-agent-dependency-lock.md
git commit -m "feat: add pinned multi-agent python bridge"
```

### Task 6: Build resumable tutorial ingestion

**Files:**
- Create: `video/multi-agent/tutorial-ingest.mjs`
- Create: `scripts/ingest_tutorial.mjs`
- Create: `scripts/create_legal_tutorial_fixture.ps1`
- Create: `tests/multi-agent/tutorial-ingest.test.mjs`

**Interfaces:**
- Produces: `createTutorialIngestor({ runTool, invokeBridge, memory, clock })`.
- Methods: `registerSource`, `preprocess`, `extract`, `route`, `resume`.
- Checkpoint stages: `registered`, `probed`, `scenes`, `transcribed`, `extracted`, `routed`, `awaiting_recreation`.

- [ ] **Step 1: Write failing resume, provenance, and inbox-only tests**

```js
test("resumes after transcription without repeating scene detection", async () => {
  const calls = [];
  const result = await ingestor.resume(checkpointAt("transcribed"), call => calls.push(call));
  assert.equal(calls.includes("detect_scenes"), false);
  assert.equal(result.stage, "awaiting_recreation");
});

test("routes extracted techniques to inbox with source timecodes", async () => {
  const result = await ingestor.extract(legalTutorialFixture());
  assert.ok(result.techniques.every(item => item.status === "inbox"));
  assert.ok(result.techniques.every(item => item.evidence[0].start < item.evidence[0].end));
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-agent/tutorial-ingest.test.mjs`
Expected: FAIL because the ingestor does not exist.

- [ ] **Step 3: Implement content-addressed registration, checkpoint files, PySceneDetect/faster-whisper adapters, technique deduplication, and role routing**

The CLI must support:

```text
node scripts/ingest_tutorial.mjs --input <local-video> --author "local fixture" --license "self-created" --resume
```

- [ ] **Step 4: Run GREEN and create the legal three-scene fixture**

Run:

```text
powershell -ExecutionPolicy Bypass -File scripts/create_legal_tutorial_fixture.ps1 -Output .cache/legal-tutorial-fixture
node --test tests/multi-agent/tutorial-ingest.test.mjs
node scripts/ingest_tutorial.mjs --input .cache/legal-tutorial-fixture/tutorial.mp4 --author "Koubo local fixture" --license "self-created" --resume
```

Expected: source hash, scenes, transcript, candidate cards, and checkpoint exist locally; every card remains `inbox`.

- [ ] **Step 5: Commit**

```text
git add video/multi-agent/tutorial-ingest.mjs scripts/ingest_tutorial.mjs scripts/create_legal_tutorial_fixture.ps1 tests/multi-agent/tutorial-ingest.test.mjs
git commit -m "feat: ingest tutorial techniques with checkpoints"
```

### Task 7: Recreate techniques in a safe HyperFrames sandbox

**Files:**
- Create: `video/multi-agent/tutorial-sandbox.mjs`
- Create: `tests/multi-agent/tutorial-sandbox.test.mjs`

**Interfaces:**
- Produces: `buildTechniqueSandbox({ technique, outputDir, fixtureMedia })`, `qaTechniqueSandbox({ projectDir, renderFile })`.
- Supported v1 recipe primitives: `caption-pop`, `keyword-emphasis`, `element-slide`, `element-bounce`, `sfx-cue`, `voice-pause`.

- [ ] **Step 1: Write failing allowlist and QA-gated transition tests**

```js
test("rejects arbitrary tutorial code and unknown primitives", async () => {
  await assert.rejects(
    () => buildTechniqueSandbox({ technique: { primitive: "eval-external-js" } }),
    /primitive is not allowed/
  );
});

test("only successful render QA permits recreated transition", async () => {
  const result = await qaTechniqueSandbox({ decodeOk: true, readable: true, syncErrorMs: 41, peakDb: -8 });
  assert.equal(result.eligibleTransition, "recreated");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-agent/tutorial-sandbox.test.mjs`
Expected: FAIL because the sandbox does not exist.

- [ ] **Step 3: Implement deterministic HTML generation, manifest, no-network asset policy, and QA thresholds**

Use HyperFrames `0.7.68`; require full decode, safe area, contrast, sync error ≤100 ms, and true peak ≤-1.5 dBTP for mixed audio.

- [ ] **Step 4: Render and inspect one caption, motion, and sound reconstruction**

Run:

```text
node --test tests/multi-agent/tutorial-sandbox.test.mjs
npx -y hyperframes@0.7.68 lint <sandbox-project>
npx -y hyperframes@0.7.68 render <sandbox-project> --output <sandbox.mp4> --workers 1 --quiet --sdr
ffmpeg -v error -i <sandbox.mp4> -f null -
```

Expected: three technique records reach `recreated`; no candidate is promoted.

- [ ] **Step 5: Commit**

```text
git add video/multi-agent/tutorial-sandbox.mjs tests/multi-agent/tutorial-sandbox.test.mjs
git commit -m "feat: recreate editing techniques in sandbox"
```

### Task 8: Implement bounded specialist orchestration

**Files:**
- Create: `video/multi-agent/profiles.mjs`
- Create: `video/multi-agent/orchestrator.mjs`
- Create: `tests/multi-agent/orchestrator.test.mjs`

**Interfaces:**
- Produces: `createOrchestrator({ invokeAgent, memory, clock, limits })`.
- Methods: `propose(input)`, `direct(proposals)`, `criticize(candidate, { blind })`, `retentionAudit(candidate)`.
- Defaults: one call per specialist, two candidates per specialist, 90-second timeout, one retry, deterministic v4 fallback.

- [ ] **Step 1: Write failing independence, authority, timeout, and fallback tests**

```js
test("specialists receive only shared evidence and their own promoted namespace", async () => {
  await orchestrator.propose(input);
  assert.deepEqual(calls.caption.memoryNamespaces, ["shared.evidence", "caption.private"]);
  assert.equal(calls.caption.otherAgentProposals, undefined);
});

test("director output cannot approve, promote, or publish", async () => {
  const result = await orchestrator.direct(validProposals());
  assert.equal("approvedAt" in result, false);
  assert.equal("memoryPromotion" in result, false);
  assert.equal("publish" in result, false);
});

test("timeout falls back to a traceable v4 proposal", async () => {
  const result = await timedOutOrchestrator.propose(input);
  assert.equal(result.fallback.engine, "visual-director-v4");
  assert.equal(result.events.at(-1).action, "agent_timeout_fallback");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-agent/orchestrator.test.mjs`
Expected: FAIL because profiles and orchestrator do not exist.

- [ ] **Step 3: Implement role-minimal inputs, memory citations, structured proposal validation, concurrency limits, cancellation, retries, and v4 fallback**

Blind Critic input must omit agent IDs, prompts, rationales, and proposal order. Retention Critic must emit timestamped viewing reasons and may explicitly label necessary pauses.

- [ ] **Step 4: Run GREEN and bridge fixture integration**

Run:

```text
node --test tests/multi-agent/orchestrator.test.mjs
.\.runtime-multi-agent\Scripts\python.exe -m unittest tests.python.test_multi_agent_bridge -v
```

Expected: PASS; at least two candidates differ in layout/motion/sound structure, not only color.

- [ ] **Step 5: Commit**

```text
git add video/multi-agent/profiles.mjs video/multi-agent/orchestrator.mjs tests/multi-agent/orchestrator.test.mjs
git commit -m "feat: orchestrate bounded editing specialists"
```

### Task 9: Add A/B evaluation and prompt regression

**Files:**
- Create: `video/multi-agent/evaluation.mjs`
- Create: `tests/multi-agent/evaluation.test.mjs`
- Create: `config/evaluation/promptfooconfig.yaml`

**Interfaces:**
- Produces: `evaluateCandidate`, `compareCandidates`, `candidateDiversity`, `buildBlindReviewBundle`.
- Score dimensions: technical, content, diversity, brand, human effort, explainability, reproducibility, blind review.

- [ ] **Step 1: Write failing diversity, traceability, and no-fake-improvement tests**

```js
test("color-only variants fail meaningful diversity", () => {
  assert.equal(candidateDiversity(base, { ...base, palette: "orange" }).meaningful, false);
});

test("a candidate with missing provenance cannot outrank v4", () => {
  const comparison = compareCandidates(v4Score(), { ...multiScore(), provenanceCoverage: 0.4 });
  assert.equal(comparison.winner, "v4");
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-agent/evaluation.test.mjs`
Expected: FAIL because evaluation does not exist.

- [ ] **Step 3: Implement versioned scorecards, confounder fields, blind labels, diversity signatures, and two-iteration ceiling**

Promptfoo stays local and pinned:

```text
npx -y promptfoo@0.120.0 eval -c config/evaluation/promptfooconfig.yaml
```

The config must use fixture providers unless an existing configured model is explicitly enabled.

- [ ] **Step 4: Run GREEN and prompt regression**

Run:

```text
node --test tests/multi-agent/evaluation.test.mjs
npx -y promptfoo@0.120.0 eval -c config/evaluation/promptfooconfig.yaml
```

Expected: PASS; reports contain no transcript bodies, API keys, absolute private media paths, or proposal authors.

- [ ] **Step 5: Commit**

```text
git add video/multi-agent/evaluation.mjs tests/multi-agent/evaluation.test.mjs config/evaluation/promptfooconfig.yaml
git commit -m "feat: evaluate multi-agent video proposals"
```

### Task 10: Mount local APIs without weakening v4 gates

**Files:**
- Create: `video/multi-agent/api.mjs`
- Create: `tests/multi-agent/api.test.mjs`
- Modify: `video/server.mjs`

**Interfaces:**
- Produces: `createMultiAgentApi(dependencies).handle(req, res, url) -> Promise<boolean>`.
- Routes:
  - `GET /api/multi-agent/status`
  - `GET /api/multi-agent/memory`
  - `POST /api/multi-agent/memory/:kind/:id/:action`
  - `POST /api/multi-agent/tutorials`
  - `GET /api/multi-agent/tutorials/:id`
  - `POST /api/jobs/:id/multi-agent/proposals`
  - `POST /api/jobs/:id/multi-agent/ab`
  - `POST /api/jobs/:id/multi-agent/reviews`

- [ ] **Step 1: Write failing authorization-boundary and v4-gate tests**

```js
test("proposal route cannot mutate job approval or output", async () => {
  const before = fixtureJob();
  await request("POST", `/api/jobs/${before.id}/multi-agent/proposals`);
  assert.deepEqual(readJob(before.id).output, before.output);
  assert.equal(readJob(before.id).approvedAt, undefined);
});

test("memory promotion rejects non-human approval", async () => {
  const response = await request("POST", "/api/multi-agent/memory/technique-card/x/promote", {
    actor: { type: "agent", id: "director" }
  });
  assert.equal(response.status, 409);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/multi-agent/api.test.mjs`
Expected: FAIL because API handler does not exist.

- [ ] **Step 3: Implement confined paths, request limits, redaction, idempotency keys, local-only bind, and handler mount before static fallback**

Add health capabilities without making multi-agent the default pipeline.

- [ ] **Step 4: Run GREEN and existing regression**

Run:

```text
node --test tests/multi-agent/api.test.mjs
node scripts/verify_workbench.mjs
```

Expected: API tests PASS; v4 remains default; 141 existing controls remain valid before UI additions.

- [ ] **Step 5: Commit**

```text
git add video/multi-agent/api.mjs video/server.mjs tests/multi-agent/api.test.mjs
git commit -m "feat: expose controlled multi-agent APIs"
```

### Task 11: Add proposal, comparison, tutorial, and memory governance UI

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/styles.css`
- Modify: `scripts/verify_workbench.mjs`

**Interfaces:**
- UI state: `multiAgentStatus`, `proposalBundle`, `blindReviewBundle`, `tutorialCheckpoint`, `memoryRecords`.
- User actions never call final publish; promotion and review actions display evidence and expected hash.

- [ ] **Step 1: Add failing workbench source assertions**

Add assertions for:

```js
for (const id of [
  "multi-agent-panel", "multi-agent-proposals", "multi-agent-ab-review",
  "tutorial-ingest-panel", "memory-governance-panel"
]) assert(indexSource.includes(`id="${id}"`), `Missing multi-agent UI: ${id}`);

for (const route of [
  "/api/multi-agent/status", "/multi-agent/proposals", "/multi-agent/ab",
  "/api/multi-agent/tutorials", "/api/multi-agent/memory"
]) assert(appSource.includes(route), `Missing multi-agent client route: ${route}`);
```

- [ ] **Step 2: Run RED**

Run: `node scripts/verify_workbench.mjs`
Expected: FAIL with missing multi-agent UI assertions.

- [ ] **Step 3: Implement progressive panels and consolidated blind review**

The default v4 workflow remains visually primary. The multi-agent panel must show experimental/影子模式 status, candidate differences, citations, critic timestamps, memory transitions, and rollback actions. Do not expose candidate authors in blind review.

- [ ] **Step 4: Run GREEN and inspect at desktop and narrow widths**

Run:

```text
node scripts/verify_workbench.mjs
node video/server.mjs
node scripts/verify_workbench.mjs --url=http://127.0.0.1:8787
```

Expected: offline and online verification pass; no console errors; existing v4 jobs open; multi-agent failure leaves v4 usable.

- [ ] **Step 5: Commit**

```text
git add web/index.html web/app.js web/styles.css scripts/verify_workbench.mjs
git commit -m "feat: review multi-agent proposals in workbench"
```

### Task 12: Run real baseline A/B, prove learning and rollback, and package acceptance

**Files:**
- Create: `docs/MULTI_AGENT_VIDEO_WORKFLOW.md`
- Create: `docs/acceptance/multi-agent-v1-acceptance.md`
- Create locally only: `data/multi-agent/runtime/*`, `.cache/multi-agent-acceptance/*`
- Modify as evidence requires: `config/evaluation/baseline-v1.json`

**Interfaces:**
- Acceptance runner produces `acceptance-manifest.json`, technical QA, blind labels, scorecards, memory-before/after/rollback snapshots, hashes, and residual risks.

- [ ] **Step 1: Run all unit and integration suites**

Run:

```text
node --test tests/baseline/*.test.mjs tests/multi-agent/*.test.mjs
.\.runtime-multi-agent\Scripts\python.exe -m unittest discover -s tests/python -v
npx -y promptfoo@0.120.0 eval -c config/evaluation/promptfooconfig.yaml
node scripts/verify_workbench.mjs
```

Expected: 0 failures and no warnings other than the documented Node 22 `node:sqlite` experimental warning.

- [ ] **Step 2: Run one legal tutorial through the complete governed lifecycle**

Verify:

```text
registered → scenes → transcribed → extracted/inbox
→ recreated with render QA → trial
→ explicit fixture human approval → approved
→ second distinct approved project trial → promoted
→ retrieval behavior changes
→ rollback restores the prior result
```

No scripted test actor may be represented as the real user; acceptance documentation must label fixture approvals.

- [ ] **Step 3: Produce v4 and multi-agent 15–25 second samples for every frozen baseline entry**

Use the same source segment, transcript, approved local media, dimensions, frame rate, renderer, and technical QA. Produce at least two meaningfully different multi-agent candidates per entry. Decode every output and inspect representative frames/contact sheets.

- [ ] **Step 4: Perform two evidence-led iterations at most**

If the first multi-agent run does not improve diversity, critic coverage, or repair effort without regressions, locate the failing subsystem and make one focused TDD change per iteration. After two unsuccessful iterations, retain v4 as production and document the evidence without fabricating a win.

- [ ] **Step 5: Build one consolidated blind-review bundle**

The bundle must hide A/B authors, preserve hashes, include synchronized samples, and ask the user for one final consolidated subjective review only after automated checks pass.

- [ ] **Step 6: Update operations, migration, rollback, privacy, dependency, and residual-risk documentation**

Document exact start, test, ingest, recreate, propose, evaluate, review, promote, rollback, and disable commands.

- [ ] **Step 7: Run completion audit**

Map each of the 15 goal completion criteria to authoritative evidence. Any missing, indirect, or unverified row remains incomplete.

- [ ] **Step 8: Final verification and commit**

Run:

```text
git diff --check
node --test tests/baseline/*.test.mjs tests/multi-agent/*.test.mjs
.\.runtime-multi-agent\Scripts\python.exe -m unittest discover -s tests/python -v
node scripts/verify_workbench.mjs
git status --short
```

Then commit:

```text
git add docs config/evaluation/baseline-v1.json
git commit -m "docs: package controlled multi-agent acceptance"
```

Do not mark the goal complete until the consolidated user blind review is recorded and every completion-audit row has direct evidence.

---

## Requirement-to-Evidence Matrix

| Goal requirement | Primary evidence |
| --- | --- |
| v4 remains baseline/fallback | original verifier, health response, legacy/v4 job regression |
| 3–5 fixed samples | `baseline-v1.json` plus source/artifact hashes |
| versioned local domain store | schemas, migration checksums, SQLite/JSON parity tests |
| specialist private memory | namespace tests and exports |
| tutorial closed loop | checkpoint, source hash, technique cards, reconstruction render/QA, transitions |
| six controlled roles | role profiles, isolated inputs, proposal/critic artifacts |
| meaningful alternatives | diversity signatures and synchronized samples |
| no weakened QA/review gates | API tests, server assertions, media QA |
| learning and rollback | before/after/rollback retrieval snapshots |
| full provenance | acceptance manifest version graph |
| dependency governance | dependency lock report and isolated environment |
| workbench integration | offline/online verifier and visual inspection |
| no publish/secrets/history overwrite | route scan, redaction tests, Git/history audit |
| clean committed state | final `git status`, commit log, diff check |
| user subjective acceptance | one consolidated blind-review record |

## Plan Self-Review

- Spec coverage: all roles except Visual Language and Brand Archivist are deliberately outside v1 production control; visual layout remains v4-fixed during the first experiment, and brand-core mutation remains unsupported. Both are consistent with the approved “字幕 + 动效 + 声音 first” boundary.
- Placeholder scan: no unresolved placeholder, deferred implementation marker, or unbounded testing step remains.
- Type consistency: lifecycle names, schema kinds, API routes, store methods, and agent IDs are consistent across tasks.
- Stop conditions: each task has observable RED/GREEN commands and an independent commit; final completion remains gated on real artifacts and consolidated user blind review.
