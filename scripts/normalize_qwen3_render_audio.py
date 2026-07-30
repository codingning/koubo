from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


PROJECTS = [
    "short-video-backwards-a-background-first",
    "short-video-backwards-b-argument-first",
    "short-video-backwards-c-thesis-only",
]


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(command)}\n{result.stdout}\n{result.stderr}")
    return result


def loudnorm_measurement(ffmpeg: str, source: Path) -> dict:
    result = run([
        ffmpeg, "-hide_banner", "-nostdin", "-i", str(source),
        "-map", "0:a:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json",
        "-f", "null", "NUL",
    ])
    matches = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", result.stderr)
    if not matches:
        raise RuntimeError(f"loudnorm JSON missing for {source}")
    return json.loads(matches[-1])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    repo = args.repo.resolve()

    for project_name in PROJECTS:
        render_dir = repo / "videos" / project_name / "renders"
        final = render_dir / "video-qwen3.mp4"
        raw = render_dir / "video-qwen3-render-raw.mp4"
        temporary = render_dir / "video-qwen3-normalizing.tmp.mp4"
        if not raw.exists():
            if not final.exists():
                raise FileNotFoundError(final)
            final.replace(raw)
        if temporary.exists():
            temporary.unlink()

        measured = loudnorm_measurement(args.ffmpeg, raw)
        loudnorm = (
            "loudnorm=I=-16:TP=-1.5:LRA=7"
            f":measured_I={measured['input_i']}"
            f":measured_TP={measured['input_tp']}"
            f":measured_LRA={measured['input_lra']}"
            f":measured_thresh={measured['input_thresh']}"
            f":offset={measured['target_offset']}"
            ":linear=true:print_format=summary"
        )
        run([
            args.ffmpeg, "-y", "-v", "error", "-nostdin", "-i", str(raw),
            "-map", "0:v:0", "-map", "0:a:0",
            "-c:v", "copy",
            "-af", loudnorm,
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
            "-movflags", "+faststart",
            str(temporary),
        ])
        temporary.replace(final)
        print(json.dumps({
            "project": project_name,
            "raw": str(raw),
            "final": str(final),
            "sourceLufs": measured["input_i"],
            "sourceTruePeak": measured["input_tp"],
        }, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
