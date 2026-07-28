"""Narrow Jianying draft adapter for Koubo.

The public pyJianYingDraft API usage and independent verification approach are
adapted from touge1618/touge-spoken-cut@22cedc0 (Apache-2.0). Koubo keeps this
adapter isolated: it reads an approved timeline request and only creates a new
draft directory.
"""

from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any

MICROSECONDS = 1_000_000
AUDIO_FADE_US = 30_000


def _all_strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _all_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _all_strings(item)


def _verify(
    root: Path,
    request: dict[str, Any],
    segment_count: int,
    duration_us: int,
    expected_source_ranges: list[dict[str, int]],
) -> dict[str, Any]:
    content_path = root / "draft_content.json"
    meta_path = root / "draft_meta_info.json"
    if not content_path.is_file() or not meta_path.is_file():
        raise RuntimeError("剪映草稿缺少 draft_content.json 或 draft_meta_info.json")
    content = json.loads(content_path.read_text(encoding="utf-8-sig"))
    meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    video_tracks = [item for item in content.get("tracks", []) if item.get("type") == "video"]
    segments = list(video_tracks[0].get("segments", [])) if len(video_tracks) == 1 else []
    fades = list(content.get("materials", {}).get("audio_fades", []))
    starts = [int(item.get("target_timerange", {}).get("start", -1)) for item in segments]
    durations = [int(item.get("target_timerange", {}).get("duration", 0)) for item in segments]
    actual_source_ranges = [
        {
            "start": int(item.get("source_timerange", {}).get("start", -1)),
            "duration": int(item.get("source_timerange", {}).get("duration", 0)),
        }
        for item in segments
    ]
    contiguous = bool(starts) and starts[0] == 0 and all(starts[i] == starts[i - 1] + durations[i - 1] for i in range(1, len(starts)))
    source_paths = {str(Path(value).resolve()).casefold() for value in request["timeline"]["sources"].values()}
    serialized_paths = {str(Path(value).resolve()).casefold() for value in _all_strings(content) if Path(value).suffix.lower() in {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm"}}
    checks = {
        "one_video_track": len(video_tracks) == 1,
        "segment_count": len(segments) == segment_count,
        "segments_contiguous": contiguous,
        "source_ranges": actual_source_ranges == expected_source_ranges,
        "duration": abs(int(content.get("duration", 0)) - duration_us) <= max(2, segment_count),
        "meta_duration": abs(int(meta.get("tm_duration", 0)) - duration_us) <= max(2, segment_count),
        "audio_fades_30ms": len(fades) == segment_count and all(int(item.get("fade_in_duration", 0)) == AUDIO_FADE_US and int(item.get("fade_out_duration", 0)) == AUDIO_FADE_US for item in fades),
        "source_paths": source_paths.issubset(serialized_paths),
        "draft_name": meta.get("draft_name") == request["draft_name"],
    }
    errors = [name for name, ok in checks.items() if not ok]
    if errors:
        raise RuntimeError("剪映草稿验证失败：" + ", ".join(errors))
    return {
        "ok": True,
        "checks": checks,
        "segment_count": len(segments),
        "duration_us": duration_us,
        "expected_source_ranges": expected_source_ranges,
        "actual_source_ranges": actual_source_ranges,
    }


def export_draft(request: dict[str, Any]) -> dict[str, Any]:
    import pyJianYingDraft as draft

    output_root = Path(request["output_root"]).resolve()
    draft_name = str(request["draft_name"])
    destination = output_root / draft_name
    if destination.exists():
        raise FileExistsError(f"不会覆盖现有剪映草稿：{destination}")
    ranges = list(request["timeline"].get("ranges", []))
    sources = dict(request["timeline"].get("sources", {}))
    if not ranges or not sources:
        raise ValueError("批准时间线没有可导出的片段")
    output_root.mkdir(parents=True, exist_ok=True)
    materials = {source_id: draft.VideoMaterial(str(Path(source_path).resolve())) for source_id, source_path in sources.items()}
    first = next(iter(materials.values()))
    width = int(first.width or 1920)
    height = int(first.height or 1080)
    folder = draft.DraftFolder(str(output_root))
    script = folder.create_draft(draft_name, width, height, fps=max(1, int(request.get("fps", 30))), allow_replace=False)
    track = script.append_track(draft.TrackSpec(draft.TrackType.video, "主视频"))
    cursor = 0
    expected_source_ranges: list[dict[str, int]] = []
    for item in ranges:
        material = materials[str(item["source"])]
        source_start = max(0, round(float(item["source_start"]) * MICROSECONDS))
        source_end = min(int(material.duration), round(float(item["source_end"]) * MICROSECONDS))
        duration = source_end - source_start
        if duration < 60_000:
            raise ValueError(f"片段 {item.get('id')} 短于安全淡化长度")
        segment = draft.VideoSegment(material, draft.Timerange(cursor, duration), source_timerange=draft.Timerange(source_start, duration))
        segment.add_fade(AUDIO_FADE_US, AUDIO_FADE_US)
        script.add_segment(segment, track)
        expected_source_ranges.append({"start": source_start, "duration": duration})
        cursor += duration
    script.save()
    meta_path = destination / "draft_meta_info.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8-sig"))
    now = time.time_ns() // 1000
    meta.update({
        "draft_fold_path": destination.as_posix(),
        "draft_id": str(uuid.uuid4()).upper(),
        "draft_name": draft_name,
        "draft_root_path": str(output_root),
        "tm_draft_create": int(meta.get("tm_draft_create") or now),
        "tm_draft_modified": now,
        "tm_duration": cursor,
    })
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    verification = _verify(destination, request, len(ranges), cursor, expected_source_ranges)
    return {"ok": True, "draft_path": str(destination), "draft_name": draft_name, "width": width, "height": height, "duration_us": cursor, "segment_count": len(ranges), "verification": verification}


def main() -> int:
    try:
        request = json.loads(sys.stdin.read())
        print(json.dumps(export_draft(request), ensure_ascii=False))
        return 0
    except Exception as error:  # noqa: BLE001 - CLI returns a concise failure to Node.
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
