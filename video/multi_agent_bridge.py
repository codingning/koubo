#!/usr/bin/env python3
"""Narrow Python boundary for Koubo's controlled multi-agent runtime.

The bridge exposes only five allowlisted operations. It can run deterministically
with injected fixtures for tests, while real agent operations use the pinned
OpenAI Agents SDK and scene detection uses the pinned PySceneDetect package.
"""

from __future__ import annotations

import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Literal


OPERATIONS = (
    "agent_critique",
    "agent_proposals",
    "config",
    "detect_scenes",
    "extract_techniques",
)
AGENT_INSTRUCTIONS = {
    "agent_proposals": (
        "Return bounded editing proposals as JSON. Cite input evidence and memory "
        "record IDs. Do not approve, publish, or change the transcript."
    ),
    "agent_critique": (
        "Critique the anonymous candidate with the supplied fixed rubric. Return "
        "JSON with timestamped objections and uncertainty. Do not rewrite the plan."
    ),
    "extract_techniques": (
        "Extract reproducible editing techniques as JSON records with source "
        "timecodes, applicability, prohibitions, and parameters. Keep status inbox."
    ),
}
ROLE_INSTRUCTIONS = {
    "content-strategist": (
        "Analyze only the explicit user-locked content direction. Interview for audience, "
        "viewer benefit, evidence, risks, and single-versus-series potential. Treat cited "
        "creator principles as advisory candidates with source timecodes, not facts. Preserve "
        "all supplied user facts and evidence summaries exactly: never weaken a completed or "
        "quantified fact into partial, uncertain, or missing evidence. Prefer citing no principle "
        "over citing a weakly relevant one. Cite at most three, and only when each changes a "
        "concrete judgment after checking applicability and counterexamples. Never "
        "invent or replace the topic; never draft scripts, titles, hooks, shot lists, or edit "
        "plans; never approve, publish, or promote memory. Return only the supplied structured "
        "analysis contract."
    ),
    "ordinary-viewer-critic": (
        "Act as a sharp but non-insulting ordinary viewer. Review only relevance, clarity, "
        "credibility, evidence, and actionability. Cite exact script text or supplied timecoded "
        "evidence. Do not change the topic, rewrite the whole script, perform technical QA, "
        "predict retention or drop-off, rank candidates, choose a winner, approve, publish, or "
        "promote memory. Never claim visual or audio observations beyond the declared inspection "
        "mode and supplied frame evidence."
    ),
    "content-training-evaluator": (
        "Blindly compare the two supplied Content Strategist analyses using only the fixed "
        "four-dimension rubric. Do not guess which candidate used a knowledge base, trial "
        "memory, a specific Agent, or a particular experiment group. Score each dimension "
        "from 0 to 2, use only the declared hard-failure values, and explain concrete "
        "differences. Do not draft content, approve production, publish, or promote memory."
    ),
}
ROLE_OPERATIONS = {
    "content-strategist": "agent_proposals",
    "ordinary-viewer-critic": "agent_critique",
    "content-training-evaluator": "agent_critique",
}
SENSITIVE_KEYS = {
    "apikey",
    "accesstoken",
    "authorization",
    "cookie",
    "password",
    "privatekey",
    "secret",
    "token",
}


class RequestError(ValueError):
    """A safe validation error suitable for returning to the local caller."""


def instructions_for_agent(operation: str, agent_id: str) -> str:
    role = ROLE_INSTRUCTIONS.get(agent_id)
    if role:
        return f"{AGENT_INSTRUCTIONS[operation]}\n\nRole-specific boundary:\n{role}"
    return AGENT_INSTRUCTIONS[operation]


def validate_agent_operation(operation: str, agent_id: str) -> None:
    required_operation = ROLE_OPERATIONS.get(agent_id)
    if required_operation is not None and operation != required_operation:
        raise RequestError(
            f"agent {agent_id} only supports operation {required_operation}; "
            f"received {operation}"
        )


def normalized_key(value: str) -> str:
    return "".join(character for character in value.lower() if character.isalnum())


def sanitize(value: Any) -> Any:
    """Remove secret-shaped fields and values unsupported by JSON."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return None
    if isinstance(value, (list, tuple)):
        return [item for item in (sanitize(entry) for entry in value) if item is not None]
    if hasattr(value, "model_dump"):
        return sanitize(value.model_dump())
    if isinstance(value, dict):
        output = {}
        for key in sorted(value, key=str):
            if normalized_key(str(key)) in SENSITIVE_KEYS:
                continue
            item = sanitize(value[key])
            if item is not None:
                output[str(key)] = item
        return output
    return str(value)


def package_version(distribution: str) -> str:
    try:
        return metadata.version(distribution)
    except metadata.PackageNotFoundError as error:
        raise RequestError(f"required package is not installed: {distribution}") from error


def config_result() -> dict[str, Any]:
    return {
        "success": True,
        "agents_sdk": package_version("openai-agents"),
        "scenedetect": package_version("scenedetect"),
        "operations": list(OPERATIONS),
        "network_policy": "agent operations only; fixture mode is offline",
        "media_policy": "local paths only; source video is not sent to the model",
    }


def normalize_scenes(items: Any) -> list[dict[str, float | int]]:
    if not isinstance(items, list):
        raise RequestError("scenes must be an array")
    output = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise RequestError(f"scene {index} must be an object")
        try:
            start = float(item["start"])
            end = float(item["end"])
        except (KeyError, TypeError, ValueError) as error:
            raise RequestError(f"scene {index} must contain numeric start and end") from error
        if start < 0 or end <= start:
            raise RequestError(f"scene {index} must have 0 <= start < end")
        output.append(
            {
                "index": index,
                "start": round(start, 6),
                "end": round(end, 6),
                "duration": round(end - start, 6),
            }
        )
    return output


def detect_scenes(request: dict[str, Any]) -> dict[str, Any]:
    if "fixture_scenes" in request:
        scenes = normalize_scenes(request["fixture_scenes"])
        return {
            "success": True,
            "operation": "detect_scenes",
            "mode": "fixture",
            "scene_count": len(scenes),
            "scenes": scenes,
        }

    media_value = str(request.get("media_path") or "").strip()
    if not media_value:
        raise RequestError("media_path is required")
    media_path = Path(media_value).expanduser().resolve()
    if not media_path.is_file():
        raise RequestError(f"media file does not exist: {media_path}")

    from scenedetect import ContentDetector, SceneManager, open_video

    threshold = float(request.get("threshold", 27.0))
    minimum_length = int(request.get("min_scene_len_frames", 15))
    video = open_video(str(media_path))
    manager = SceneManager()
    manager.add_detector(
        ContentDetector(threshold=threshold, min_scene_len=minimum_length)
    )
    manager.detect_scenes(video, show_progress=False)
    scenes = normalize_scenes(
        [
            {
                "start": start.get_seconds(),
                "end": end.get_seconds(),
            }
            for start, end in manager.get_scene_list(start_in_scene=True)
        ]
    )
    return {
        "success": True,
        "operation": "detect_scenes",
        "mode": "local",
        "media_path": str(media_path),
        "scene_count": len(scenes),
        "scenes": scenes,
    }


def parse_agent_output(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return {"text": value}


def advisory_output_type(agent_id: str) -> type[Any] | None:
    """Return strict structured-output contracts for the two advisory roles.

    The generic creative agents intentionally keep their historical free-form JSON
    behavior.  These two roles sit on authority boundaries, so a merely suggestive
    prompt is not sufficient: the Agents SDK must ask the model for the exact shape
    that the deterministic JavaScript validators consume.
    """
    if agent_id not in ROLE_OPERATIONS:
        return None

    from pydantic import BaseModel, ConfigDict, Field

    class StrictOutput(BaseModel):
        model_config = ConfigDict(extra="forbid")

    if agent_id == "content-strategist":
        class EvidenceReference(StrictOutput):
            id: str = Field(description="Exact id from minimalInput.evidence")
            relevance: str = Field(description="What this evidence supports")

        class EvidenceAssessment(StrictOutput):
            available: list[EvidenceReference]
            missing: list[str]

        class PrincipleCitation(StrictOutput):
            principleId: str = Field(description="Exact id from candidatePrinciples")
            contentHash: str = Field(description="Exact contentHash from that candidate principle")
            relevance: str = Field(description="Why this advisory candidate is relevant")
            appliedJudgment: str = Field(description="The concrete analysis judgment changed by this principle")
            applicabilityCheck: str = Field(description="Why the principle applicability conditions match this direction")
            counterexampleCheck: str = Field(description="Whether a supplied counterexample limits or blocks use")

        class ContentStrategistOutput(StrictOutput):
            lockedDirection: str
            directionRestatement: str
            audience: str = Field(description="One concise audience description, not an object")
            viewerBenefit: str = Field(description="One concise viewer benefit, not an object")
            strengths: list[str]
            weaknesses: list[str]
            evidence: EvidenceAssessment
            testableQuestion: str
            principleCitations: list[PrincipleCitation] = Field(max_length=3)
            recommendation: Literal["single_piece", "series", "defer"]
            nextQuestions: list[str] = Field(max_length=3)
            status: Literal[
                "ready_for_script",
                "needs_evidence",
                "needs_restructure",
                "recommend_abandon",
            ]
            uncertainties: list[str]

        EvidenceAssessment.model_rebuild(
            _types_namespace={"EvidenceReference": EvidenceReference}
        )
        ContentStrategistOutput.model_rebuild(
            _types_namespace={
                "EvidenceAssessment": EvidenceAssessment,
                "PrincipleCitation": PrincipleCitation,
                "Literal": Literal,
            }
        )
        return ContentStrategistOutput

    if agent_id == "content-training-evaluator":
        class TrainingCandidateScore(StrictOutput):
            directionUnderstanding: int = Field(ge=0, le=2)
            evidenceDiscipline: int = Field(ge=0, le=2)
            actionability: int = Field(ge=0, le=2)
            boundaryAwareness: int = Field(ge=0, le=2)
            hardFailures: list[Literal[
                "direction_drift",
                "unsupported_claim",
                "authority_overreach",
                "generic_non_actionable",
            ]]
            summary: str

        class ContentTrainingEvaluationOutput(StrictOutput):
            first: TrainingCandidateScore
            second: TrainingCandidateScore
            comparativeFindings: list[str] = Field(min_length=2, max_length=6)
            uncertainties: list[str] = Field(max_length=5)

        ContentTrainingEvaluationOutput.model_rebuild(
            _types_namespace={
                "TrainingCandidateScore": TrainingCandidateScore,
                "Literal": Literal,
            }
        )
        return ContentTrainingEvaluationOutput

    class OrdinaryViewerBlocker(StrictOutput):
        issue: str
        classification: Literal["fact", "subjective", "uncertain"]
        quote: str | None = Field(
            description="Exact script quote for script review; null for render review when not needed"
        )
        start: float | None = Field(
            description="Render timestamp start in seconds; null for script review"
        )
        end: float | None = Field(
            description="Render timestamp end in seconds; null for script review"
        )

    class OrdinaryViewerClassifications(StrictOutput):
        fact: list[str]
        subjective: list[str]
        uncertain: list[str]

    class OrdinaryViewerOutput(StrictOutput):
        sharpConclusion: str
        blockers: list[OrdinaryViewerBlocker] = Field(max_length=3)
        viewerValueGap: str
        evidenceGap: str
        minimalFix: str
        viewerDecision: Literal[
            "清楚且有用",
            "听懂但无用",
            "证据不足",
            "无法理解",
            "整体不接受",
        ]
        classifications: OrdinaryViewerClassifications

    OrdinaryViewerOutput.model_rebuild(
        _types_namespace={
            "OrdinaryViewerBlocker": OrdinaryViewerBlocker,
            "OrdinaryViewerClassifications": OrdinaryViewerClassifications,
            "Literal": Literal,
        }
    )
    return OrdinaryViewerOutput


def agent_tracing_enabled() -> bool:
    """Tracing is opt-in because advisory prompts contain user evidence."""
    return str(os.environ.get("KOUBO_AGENT_TRACING_ENABLED") or "").strip() == "1"


def run_agent_operation(operation: str, request: dict[str, Any]) -> dict[str, Any]:
    agent_id = str(request.get("agent_id") or operation).strip()
    validate_agent_operation(operation, agent_id)

    if "fixture_response" in request:
        return {
            "success": True,
            "operation": operation,
            "mode": "fixture",
            "agent_id": str(request.get("agent_id") or "fixture-agent"),
            "result": sanitize(request["fixture_response"]),
        }

    prompt = str(request.get("prompt") or "").strip()
    if not prompt:
        raise RequestError("prompt is required")

    from agents import Agent, Runner, set_tracing_disabled

    set_tracing_disabled(not agent_tracing_enabled())

    kwargs: dict[str, Any] = {
        "name": agent_id,
        "instructions": instructions_for_agent(operation, agent_id),
    }
    model = str(os.environ.get("OPENAI_MODEL") or "").strip()
    if model:
        kwargs["model"] = model
    output_type = advisory_output_type(agent_id)
    if output_type is not None:
        kwargs["output_type"] = output_type
    agent = Agent(**kwargs)
    result = Runner.run_sync(agent, prompt)
    return {
        "success": True,
        "operation": operation,
        "mode": "agents-sdk",
        "agent_id": agent_id,
        "result": sanitize(parse_agent_output(result.final_output)),
    }


def dispatch(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise RequestError("request must be a JSON object")
    operation = str(request.get("operation") or "").strip()
    if operation not in OPERATIONS:
        raise RequestError(f"unsupported operation: {operation}")
    if operation == "config":
        return config_result()
    if operation == "detect_scenes":
        return detect_scenes(request)
    return run_agent_operation(operation, request)


def write_json_atomic(target: Path, value: dict[str, Any]) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary_name = tempfile.mkstemp(
        prefix=f"{target.name}.",
        suffix=".tmp",
        dir=target.parent,
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(sanitize(value), stream, ensure_ascii=False, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--response", required=True, type=Path)
    arguments = parser.parse_args(argv)

    exit_code = 0
    try:
        request = json.loads(arguments.request.read_text(encoding="utf-8-sig"))
        response = dispatch(request)
    except RequestError as error:
        response = {"success": False, "error": str(error)}
        exit_code = 2
    except (OSError, json.JSONDecodeError, ValueError) as error:
        response = {"success": False, "error": f"invalid local input: {type(error).__name__}"}
        exit_code = 2
    except Exception as error:  # Never expose SDK internals, credentials, or tracebacks.
        response = {"success": False, "error": f"operation failed: {type(error).__name__}"}
        exit_code = 2

    write_json_atomic(arguments.response, response)
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
