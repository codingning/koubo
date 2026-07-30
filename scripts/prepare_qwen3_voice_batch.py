from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


PROJECTS = {
    "a": "short-video-backwards-a-background-first",
    "b": "short-video-backwards-b-argument-first",
    "c": "short-video-backwards-c-thesis-only",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare local Qwen3-TTS cloned narration for the Koubo A/B/C review videos."
    )
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser.parse_args()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed ({result.returncode}): {' '.join(command)}\n{result.stdout}\n{result.stderr}"
        )
    return result


def parse_loudnorm(stderr: str) -> dict:
    matches = re.findall(r"\{\s*\"input_i\"[\s\S]*?\}", stderr)
    if not matches:
        raise RuntimeError(f"ffmpeg loudnorm JSON was not found:\n{stderr[-4000:]}")
    return json.loads(matches[-1])


def probe_audio(ffprobe: str, path: Path) -> dict:
    result = run([
        ffprobe,
        "-v", "error",
        "-show_entries", "stream=sample_rate,channels,channel_layout,codec_name:format=duration",
        "-of", "json",
        str(path),
    ])
    payload = json.loads(result.stdout)
    stream = payload["streams"][0]
    return {
        "duration": float(payload["format"]["duration"]),
        "sampleRate": int(stream["sample_rate"]),
        "channels": int(stream["channels"]),
        "channelLayout": stream.get("channel_layout"),
        "codec": stream.get("codec_name"),
    }


def normalize_to_target(ffmpeg: str, ffprobe: str, source: Path, output: Path, target_duration: float) -> dict:
    raw = probe_audio(ffprobe, source)
    tempo = raw["duration"] / target_duration
    if not 0.5 <= tempo <= 2.0:
        raise RuntimeError(f"unsupported atempo ratio {tempo:.4f} for {source}")

    tempo_filter = f"atempo={tempo:.10f}"
    analysis_filter = f"{tempo_filter},loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json"
    analysis = run([
        ffmpeg, "-hide_banner", "-nostdin", "-i", str(source),
        "-af", analysis_filter, "-f", "null", "NUL",
    ])
    measured = parse_loudnorm(analysis.stderr)
    loudnorm = (
        "loudnorm=I=-16:TP=-1.5:LRA=7"
        f":measured_I={measured['input_i']}"
        f":measured_TP={measured['input_tp']}"
        f":measured_LRA={measured['input_lra']}"
        f":measured_thresh={measured['input_thresh']}"
        f":offset={measured['target_offset']}"
        ":linear=true:print_format=summary"
    )
    final_filter = (
        f"{tempo_filter},{loudnorm},"
        f"aresample=48000:first_pts=0,asetpts=N/SR/TB,"
        f"apad=whole_dur={target_duration:.6f},atrim=duration={target_duration:.6f}"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp.wav")
    if temporary.exists():
        temporary.unlink()
    run([
        ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(source),
        "-af", final_filter,
        "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le",
        str(temporary),
    ])
    temporary.replace(output)

    final_probe = probe_audio(ffprobe, output)
    if abs(final_probe["duration"] - target_duration) > 0.003:
        raise RuntimeError(
            f"duration mismatch for {output}: {final_probe['duration']:.6f} vs {target_duration:.6f}"
        )
    if final_probe["sampleRate"] != 48000 or final_probe["channels"] != 1:
        raise RuntimeError(f"unexpected audio format for {output}: {final_probe}")

    verification = run([
        ffmpeg, "-hide_banner", "-nostdin", "-i", str(output),
        "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json",
        "-f", "null", "NUL",
    ])
    verified_loudness = parse_loudnorm(verification.stderr)
    return {
        "source": str(source.resolve()),
        "output": str(output.resolve()),
        "sourceDuration": raw["duration"],
        "targetDuration": target_duration,
        "tempo": tempo,
        "probe": final_probe,
        "loudness": verified_loudness,
        "sha256": sha256(output),
    }


def is_script_character(character: str) -> bool:
    return bool(re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9]", character))


def script_characters(text: str) -> list[str]:
    return [character for character in text if is_script_character(character)]


def token_characters(text: str) -> list[str]:
    return script_characters(text)


def corrected_words(transcript: dict, target_duration: float, source_duration: float) -> list[dict]:
    expected = script_characters(transcript["expected"])
    slots: list[tuple[float, float]] = []
    for item in transcript["words"]:
        characters = token_characters(str(item.get("text", "")))
        if not characters:
            continue
        start = float(item["start"])
        end = float(item["end"])
        width = max(0.001, end - start) / len(characters)
        for index in range(len(characters)):
            slots.append((start + width * index, start + width * (index + 1)))
    if len(slots) != len(expected):
        raise RuntimeError(
            f"character alignment mismatch for {transcript['group']}/{transcript['index']}: "
            f"expected {len(expected)}, ASR slots {len(slots)}"
        )
    scale = target_duration / source_duration
    corrected = []
    for index, (character, (start, end)) in enumerate(zip(expected, slots)):
        corrected.append({
            "id": f"w{index}",
            "text": character,
            "start": round(min(target_duration, start * scale), 3),
            "end": round(min(target_duration, end * scale), 3),
        })
    return corrected


def caption_groups(lines: list[str], voices: list[dict], total_duration: float) -> dict:
    groups = []
    group_number = 0
    scene_start = 0.0
    break_punctuation = set("，、：；。！？?!;:—")

    for frame_index, (line, voice) in enumerate(zip(lines, voices), start=1):
        words = voice["words"]
        word_index = 0
        current: list[dict] = []

        def flush() -> None:
            nonlocal group_number, current
            if not current:
                return
            absolute_words = [{
                "id": f"caption-word-{group_number}-{index}",
                "text": word["text"],
                "start": round(scene_start + word["start"], 3),
                "end": round(scene_start + word["end"], 3),
            } for index, word in enumerate(current)]
            start = absolute_words[0]["start"]
            end = min(
                round(scene_start + float(voice["duration_s"]), 3),
                round(absolute_words[-1]["end"] + 0.14, 3),
            )
            groups.append({
                "id": f"caption-group-{group_number}",
                "frame": frame_index,
                "start": start,
                "end": max(start + 0.01, end),
                "text": " ".join(item["text"] for item in current),
                "words": absolute_words,
            })
            group_number += 1
            current = []

        for character in line:
            if is_script_character(character):
                word = words[word_index]
                word_index += 1
                if current and float(word["start"]) - float(current[-1]["end"]) > 0.27:
                    flush()
                current.append(word)
                if len(current) >= 3:
                    flush()
            elif character in break_punctuation:
                flush()
        flush()
        if word_index != len(words):
            raise RuntimeError(f"caption mapping did not consume all words for frame {frame_index}")
        scene_start += float(voice["duration_s"])

    return {
        "total_duration_s": round(total_duration, 3),
        "width": 1080,
        "height": 1920,
        "groups": groups,
    }


def backup_project(project: Path) -> None:
    voice = project / "assets" / "voice"
    voice_backup = project / "assets" / "voice-before-qwen3-backup"
    if not voice_backup.exists():
        shutil.copytree(voice, voice_backup)
    backup_root = project / "backups" / "before-qwen3"
    for filename in ["audio_meta.json", "audio_engine_meta.json", "caption_groups.json", "compositions/captions.html"]:
        source = project / filename
        backup = backup_root / filename
        if source.exists() and not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, backup)


def replace_caption_data(path: Path, groups: list[dict], duration: float) -> None:
    source = path.read_text(encoding="utf-8")
    payload = json.dumps(groups, ensure_ascii=False, separators=(",", ":"))
    pattern = re.compile(r"var GROUPS = \[[\s\S]*?\];\s*var DURATION = [^;]+;")
    replacement = f"var GROUPS = {payload};\n  var DURATION = {duration:.3f};"
    updated, count = pattern.subn(replacement, source, count=1)
    if count != 1:
        raise RuntimeError(f"caption data block not found in {path}")
    path.write_text(updated, encoding="utf-8")


def main() -> None:
    args = parse_args()
    repo = args.repo.resolve()
    runtime = args.runtime.resolve()
    videos = repo / "videos"
    segments = read_json(runtime / "segments.json")
    audio_root = runtime / "outputs" / "full-xvector"

    project_paths = {key: videos / name for key, name in PROJECTS.items()}
    target_a = [float(item["duration_s"]) for item in read_json(project_paths["a"] / "audio_meta.json")["voices"]]
    target_bc = [float(item["duration_s"]) for item in read_json(project_paths["b"] / "audio_meta.json")["voices"]]
    targets = {"a": target_a, "bc": target_bc}

    normalized: dict[str, list[dict]] = {"a": [], "bc": []}
    for group in ["a", "bc"]:
        for index, target in enumerate(targets[group], start=1):
            source = audio_root / group / f"{index:02d}-raw.wav"
            output = audio_root / group / f"{index:02d}-normalized.wav"
            normalized[group].append(
                normalize_to_target(args.ffmpeg, args.ffprobe, source, output, target)
            )
            print(json.dumps({
                "stage": "normalized",
                "group": group,
                "index": index,
                "targetDuration": target,
                "output": str(output),
            }, ensure_ascii=False), flush=True)

    group_metadata = {}
    for group in ["a", "bc"]:
        voices = []
        for index, (target, normalization) in enumerate(zip(targets[group], normalized[group]), start=1):
            transcript = read_json(audio_root / group / f"{index:02d}-transcript.json")
            words = corrected_words(transcript, target, normalization["sourceDuration"])
            voices.append({
                "frame": index,
                "path": f"assets/voice/{index:02d}.wav",
                "duration_s": target,
                "words": words,
            })
        group_metadata[group] = {
            "bgm": None,
            "voices": voices,
            "sfx": [],
        }

    for variant, group in [("a", "a"), ("b", "bc"), ("c", "bc")]:
        project = project_paths[variant]
        backup_project(project)
        for index, source_record in enumerate(normalized[group], start=1):
            shutil.copy2(Path(source_record["output"]), project / "assets" / "voice" / f"{index:02d}.wav")

        metadata = group_metadata[group]
        write_json(project / "audio_meta.json", metadata)
        total_duration = sum(float(item["duration_s"]) for item in metadata["voices"])
        groups = caption_groups(segments[group], metadata["voices"], total_duration)
        write_json(project / "caption_groups.json", groups)
        replace_caption_data(project / "compositions" / "captions.html", groups["groups"], total_duration)
        write_json(project / "audio_engine_meta.json", {
            "tts_provider": "qwen3-tts-local",
            "model": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
            "voice_clone_mode": "x_vector_only",
            "local_only": True,
            "sample_rate": 48000,
            "channels": 1,
            "target_lufs": -16,
            "true_peak_limit_dbtp": -1.5,
            "bgm": None,
            "bgm_pending": False,
            "voices": [{
                "id": f"{index:02d}",
                "path": item["path"],
                "duration_s": item["duration_s"],
                "sha256": normalized[group][index - 1]["sha256"],
            } for index, item in enumerate(metadata["voices"], start=1)],
            "sfx": [],
            "total_duration_s": round(total_duration, 3),
        })
        (project / "VOICE_PROVENANCE.md").write_text(
            "# Voice provenance\n\n"
            "- Provider: local Qwen3-TTS 0.6B Base (`x_vector_only`)\n"
            "- Model license: Apache-2.0\n"
            "- Reference: user-authorized local recording; no audio uploaded to a cloud service\n"
            "- Processing: sentence-level duration match without pitch shift, two-pass loudness normalization, "
            "48 kHz mono PCM\n"
            "- Target: approximately -16 LUFS, true peak no higher than -1.5 dBTP\n"
            "- Previous narration: preserved under `assets/voice-before-qwen3-backup/`\n",
            encoding="utf-8",
        )

    bc_b = [sha256(project_paths["b"] / "assets" / "voice" / f"{index:02d}.wav") for index in range(1, 8)]
    bc_c = [sha256(project_paths["c"] / "assets" / "voice" / f"{index:02d}.wav") for index in range(1, 8)]
    if bc_b != bc_c:
        raise RuntimeError("B/C narration bytes differ")
    if read_json(project_paths["b"] / "audio_meta.json") != read_json(project_paths["c"] / "audio_meta.json"):
        raise RuntimeError("B/C audio metadata differs")

    report = {
        "provider": "Qwen3-TTS local",
        "model": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
        "voiceCloneMode": "x_vector_only",
        "localOnly": True,
        "normalized": normalized,
        "bcIdenticalAudio": True,
        "bcIdenticalMetadata": True,
        "projects": {key: str(path.resolve()) for key, path in project_paths.items()},
    }
    report_path = repo / "outputs" / "acceptance" / "qwen3-voice-integration-report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(report_path, report)
    print(json.dumps({"success": True, "report": str(report_path)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
