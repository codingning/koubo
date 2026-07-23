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
from typing import Any


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


def run_agent_operation(operation: str, request: dict[str, Any]) -> dict[str, Any]:
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

    from agents import Agent, Runner

    agent_id = str(request.get("agent_id") or operation)
    kwargs: dict[str, Any] = {
        "name": agent_id,
        "instructions": AGENT_INSTRUCTIONS[operation],
    }
    model = str(os.environ.get("OPENAI_MODEL") or "").strip()
    if model:
        kwargs["model"] = model
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
