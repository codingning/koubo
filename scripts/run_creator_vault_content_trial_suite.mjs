import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptFile), "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function safeId(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
}

function requireArtifactId(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{8,160}$/u.test(normalized)) throw new Error(`${label} is missing or invalid`);
  return normalized;
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, file);
}

function validateSuite(suite) {
  if (!suite || typeof suite !== "object" || !Array.isArray(suite.cases) || suite.cases.length !== 5) {
    throw new Error("evaluation suite must contain exactly five cases");
  }
  const ids = new Set();
  for (const item of suite.cases) {
    if (!String(item.id || "").trim() || ids.has(item.id)) throw new Error("suite case ids must be unique");
    ids.add(item.id);
    if (!String(item.direction || "").trim()) throw new Error(`${item.id} requires direction`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) throw new Error(`${item.id} requires evidence`);
  }
  return suite;
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => consume()));
  return results;
}

function totalFor(evaluation, variant) {
  return Number(evaluation.blindEvaluation.scoresByVariant[variant].total);
}

export function aggregateContentTrialSuite({ suite, runs }) {
  validateSuite(suite);
  const thresholds = suite.thresholds;
  const byCase = suite.cases.map(item => {
    const caseRuns = runs.filter(run => run.caseId === item.id).sort((a, b) => a.repeat - b.repeat);
    if (caseRuns.length === 0) throw new Error(`missing runs for ${item.id}`);
    const deltas = caseRuns.map(run => run.trialTotal - run.controlTotal);
    const winners = caseRuns.map(run => run.winnerVariant);
    const trialHardFailures = caseRuns.flatMap(run => run.trialHardFailures || []);
    const averageDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const consistent = new Set(winners).size === 1;
    const regression = deltas.some(value => value < -1) || trialHardFailures.length > 0;
    const verdict = !regression && averageDelta >= 1 && winners.every(value => value === "trial")
      ? "trial_win"
      : regression
        ? "regression"
        : "inconclusive";
    return {
      caseId: item.id,
      direction: item.direction,
      repeats: caseRuns.length,
      winners,
      averageControlScore: Number((caseRuns.reduce((sum, run) => sum + run.controlTotal, 0) / caseRuns.length).toFixed(2)),
      averageTrialScore: Number((caseRuns.reduce((sum, run) => sum + run.trialTotal, 0) / caseRuns.length).toFixed(2)),
      averageDelta: Number(averageDelta.toFixed(2)),
      consistent,
      regression,
      trialHardFailures: [...new Set(trialHardFailures)].sort(),
      verdict,
    };
  });
  const allRuns = runs.length;
  const averageDelta = runs.reduce((sum, run) => sum + run.trialTotal - run.controlTotal, 0) / allRuns;
  const cited = runs.reduce((sum, run) => sum + run.citationAudit.citedCount, 0);
  const correct = runs.reduce((sum, run) => sum + run.citationAudit.correctCitations, 0);
  const citationAccuracy = cited > 0 ? correct / cited : 0;
  const trialDirectionWins = byCase.filter(item => item.verdict === "trial_win").length;
  const consistentDirections = byCase.filter(item => item.consistent).length;
  const regressions = byCase.filter(item => item.regression).length;
  const passed = trialDirectionWins >= thresholds.minimumTrialDirectionWins
    && averageDelta >= thresholds.minimumAverageScoreDelta
    && citationAccuracy >= thresholds.minimumCitationAccuracy
    && consistentDirections >= thresholds.minimumConsistentDirections
    && regressions <= thresholds.maximumRegressions;
  return {
    schemaVersion: 1,
    suiteId: suite.id,
    caseCount: byCase.length,
    runCount: allRuns,
    thresholds,
    results: {
      trialDirectionWins,
      averageScoreDelta: Number(averageDelta.toFixed(2)),
      citationAccuracy: Number(citationAccuracy.toFixed(4)),
      consistentDirections,
      regressions,
    },
    byCase,
    passed,
    recommendation: passed ? "continue_to_real_script_trial" : "keep_trial_and_do_not_advance",
    authority: {
      grantsApproval: false,
      promotesMemory: false,
      changesProductionDefault: false,
    },
  };
}

function markdownSummary(summary) {
  const lines = [
    "# Creator Vault Content Strategist Trial Suite",
    "",
    `- 套件：\`${summary.suiteId}\``,
    `- 方向：${summary.caseCount}`,
    `- A/B 评测次数：${summary.runCount}`,
    `- Trial 胜出方向：${summary.results.trialDirectionWins}/${summary.caseCount}`,
    `- 平均分差：${summary.results.averageScoreDelta >= 0 ? "+" : ""}${summary.results.averageScoreDelta}`,
    `- 引用准确率：${(summary.results.citationAccuracy * 100).toFixed(1)}%`,
    `- 重复一致方向：${summary.results.consistentDirections}/${summary.caseCount}`,
    `- 明显退化：${summary.results.regressions}`,
    `- 门槛结果：${summary.passed ? "通过" : "未通过"}`,
    `- 建议：\`${summary.recommendation}\``,
    "",
    "| 方向 | Control | Trial | 差值 | 两轮结论 | 结果 |",
    "|---|---:|---:|---:|---|---|",
  ];
  for (const item of summary.byCase) {
    lines.push(`| ${item.caseId} | ${item.averageControlScore} | ${item.averageTrialScore} | ${item.averageDelta >= 0 ? "+" : ""}${item.averageDelta} | ${item.winners.join(" / ")} | ${item.verdict} |`);
  }
  lines.push("", "本报告不授予 approved、promoted、生产默认或发布权限。", "");
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const server = String(options.server || "http://127.0.0.1:8791").replace(/\/$/u, "");
  const suiteFile = path.resolve(options.suite || path.join(repositoryRoot, "config", "multi-agent", "evaluation", "content-strategist-vault-trial-suite.v1.json"));
  const outputRoot = path.resolve(options.output || path.join(repositoryRoot, "data", "acceptance", `creator-vault-content-trial-suite-${Date.now()}`));
  const acceptanceRoot = path.resolve(repositoryRoot, "data", "acceptance");
  if (outputRoot !== acceptanceRoot && !outputRoot.startsWith(`${acceptanceRoot}${path.sep}`)) {
    throw new Error("output must stay under data/acceptance");
  }
  const suite = validateSuite(JSON.parse(await fs.readFile(suiteFile, "utf8")));
  const repeats = Number(options.repeats || suite.repeats || 2);
  const concurrency = Number(options.concurrency || 2);
  const reuseAnalyses = options["reuse-analyses"] === true;
  const evaluationRevision = safeId(options["evaluation-revision"] || "v1");
  if (!Number.isInteger(repeats) || repeats !== 2) throw new Error("this trial suite requires exactly two repeats");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("concurrency must be between 1 and 3");
  const sessionResponse = await fetch(`${server}/api/session`);
  if (!sessionResponse.ok) throw new Error(`session request failed: ${sessionResponse.status}`);
  const session = await sessionResponse.json();
  const token = session.session?.token;
  if (!token) throw new Error("session token missing");
  const runId = safeId(options["run-id"] || `creator-vault-content-trial-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  async function post(pathname, body, idempotencyKey) {
    const response = await fetch(`${server}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Idempotency-Key": idempotencyKey,
        "X-Koubo-Session": token,
      },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    if (!response.ok) throw new Error(`${pathname} failed ${response.status}: ${value.error || "unknown error"}`);
    return value;
  }

  const jobs = suite.cases.flatMap(item => Array.from({ length: repeats }, (_, index) => ({ item, repeat: index + 1 })));
  const runs = await mapConcurrent(jobs, concurrency, async ({ item, repeat }) => {
    const common = {
      direction: item.direction,
      audienceContext: item.audienceContext,
      userFacts: item.userFacts,
      evidence: item.evidence,
      constraints: item.constraints,
    };
    const prefix = `${runId}-${safeId(item.id)}-r${repeat}`;
    const runFile = path.join(outputRoot, "runs", `${safeId(item.id)}-r${repeat}.json`);
    let controlAnalysisArtifactId;
    let trialAnalysisArtifactId;
    let priorEvaluationArtifactId = null;
    if (reuseAnalyses) {
      const prior = JSON.parse(await fs.readFile(runFile, "utf8"));
      controlAnalysisArtifactId = requireArtifactId(prior.controlAnalysisArtifactId, "controlAnalysisArtifactId");
      trialAnalysisArtifactId = requireArtifactId(prior.trialAnalysisArtifactId, "trialAnalysisArtifactId");
      priorEvaluationArtifactId = prior.evaluationArtifactId || null;
    } else {
      const [control, trial] = await Promise.all([
        post("/api/multi-agent/content-strategy/analyze", { ...common, knowledgeContext: { mode: "none" } }, `${prefix}-control`),
        post("/api/multi-agent/content-strategy/analyze", { ...common, knowledgeContext: { mode: "creator-vault", includeTrial: true, topK: 5 } }, `${prefix}-trial`),
      ]);
      controlAnalysisArtifactId = requireArtifactId(control.analysisArtifactId, "control.analysisArtifactId");
      trialAnalysisArtifactId = requireArtifactId(trial.analysisArtifactId, "trial.analysisArtifactId");
    }
    const evaluation = await post("/api/multi-agent/content-strategy/evaluate-ab", {
      leftAnalysisArtifactId: controlAnalysisArtifactId,
      rightAnalysisArtifactId: trialAnalysisArtifactId,
    }, `${prefix}-evaluate-${evaluationRevision}`);
    const record = evaluation.evaluation;
    const result = {
      caseId: item.id,
      repeat,
      controlAnalysisArtifactId,
      trialAnalysisArtifactId,
      evaluationArtifactId: evaluation.evaluationArtifactId,
      priorEvaluationArtifactId,
      evaluationRevision,
      winnerVariant: record.blindEvaluation.winnerVariant,
      controlTotal: totalFor(record, "control"),
      trialTotal: totalFor(record, "trial"),
      controlHardFailures: record.blindEvaluation.scoresByVariant.control.hardFailures,
      trialHardFailures: record.blindEvaluation.scoresByVariant.trial.hardFailures,
      citationAudit: record.citationAudit,
      comparativeFindings: record.blindEvaluation.comparativeFindings,
      uncertainties: record.blindEvaluation.uncertainties,
    };
    await writeJsonAtomic(runFile, result);
    return result;
  });
  const summary = aggregateContentTrialSuite({ suite, runs });
  const manifest = {
    schemaVersion: 1,
    runId,
    suiteId: suite.id,
    suiteHash: sha256(suite),
    server,
    startedWithRepeats: repeats,
    concurrency,
    reuseAnalyses,
    evaluationRevision,
    runs,
    summary,
    authority: summary.authority,
  };
  await writeJsonAtomic(path.join(outputRoot, "run.json"), manifest);
  await writeJsonAtomic(path.join(outputRoot, "summary.json"), summary);
  await fs.writeFile(path.join(outputRoot, "SUMMARY.md"), markdownSummary(summary), "utf8");
  process.stdout.write(`${JSON.stringify({ outputRoot, runId, summary }, null, 2)}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === scriptFile;
if (isCli) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ error: String(error?.message || error) }, null, 2)}\n`);
  process.exitCode = 1;
});
