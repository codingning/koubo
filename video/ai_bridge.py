"""Local AI bridge for the koubo workbench.

- Loads the already configured company OpenAI-compatible model from OpenMontage.
- Runs faster-whisper locally for speech-to-text.
- Never writes or returns API keys.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
OPENMONTAGE_ROOT = Path(os.environ.get("OPENMONTAGE_ROOT", r"F:\code\OpenMontage")).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--response", required=True)
    return parser.parse_args()


def extract_json(text: str) -> Any:
    stripped = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", stripped, re.S)
    if fenced:
        stripped = fenced.group(1)
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        left = stripped.find("{")
        right = stripped.rfind("}")
        if left >= 0 and right > left:
            return json.loads(stripped[left : right + 1])
        raise


def message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(item.get("text", "")) for item in content if isinstance(item, dict) and item.get("text"))
    return str(content or "")


def load_company_runtime():
    sys.path.insert(0, str(OPENMONTAGE_ROOT))
    from dotenv import load_dotenv
    from tools.company_openai import first_env, openai_client_from_env

    load_dotenv(OPENMONTAGE_ROOT / ".env", override=False)
    model = first_env("COMPANY_OPENAI_CHAT_MODEL", "OPENAI_MODEL")
    if not model:
        raise RuntimeError("公司聊天模型未配置")
    client = openai_client_from_env(
        api_key_names=("COMPANY_OPENAI_API_KEY", "OPENAI_API_KEY"),
        base_url_names=("COMPANY_OPENAI_BASE_URL", "OPENAI_BASE_URL"),
    )
    return client, model


def call_json(messages: list[dict[str, str]], *, temperature: float = 0.3, max_tokens: int = 12000) -> dict[str, Any]:
    client, model = load_company_runtime()
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    json_mode = True
    try:
        response = client.chat.completions.create(**kwargs, response_format={"type": "json_object"})
    except Exception:
        json_mode = False
        response = client.chat.completions.create(**kwargs)
    choice = response.choices[0]
    content = message_text(choice.message.content)
    finish_reason = getattr(choice, "finish_reason", None)
    if finish_reason in {"length", "max_tokens"}:
        raise RuntimeError(f"模型输出被截断：{finish_reason}")
    return {
        "model": model,
        "json_mode": json_mode,
        "finish_reason": finish_reason,
        "data": extract_json(content),
        "usage": {
            "prompt_tokens": getattr(getattr(response, "usage", None), "prompt_tokens", None),
            "completion_tokens": getattr(getattr(response, "usage", None), "completion_tokens", None),
            "total_tokens": getattr(getattr(response, "usage", None), "total_tokens", None),
        },
    }


def generate_content(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = payload.get("evidence", {})
    day_number = int(payload.get("day_number") or 1)
    today = str(payload.get("date") or "")
    schema = {
        "mainTopic": "主选题",
        "shortTopic": "12字以内短标题",
        "column": f"普通人学AI第{day_number}天",
        "durationFull": "约75秒",
        "durationShort": "约40秒",
        "hook": "0-3秒开场",
        "audienceBenefit": "观众能带走的一句话",
        "storyPosition": {"yesterday": "昨天", "today": "今天", "tomorrow": "明天"},
        "progress": ["真实完成项"],
        "candidates": [{"type": "今日进度型", "topic": "候选", "score": 90, "result": "主选题"}],
        "fullSegments": [{"time": "0—3秒", "label": "直接给冲突", "tone": "自然", "text": "口播"}],
        "shortScript": "30—45秒精简稿",
        "titles": [{"type": "结果型", "text": "标题"}],
        "covers": [{"id": "cover-a", "name": "方案A", "copy": "封面大字", "expression": "表情", "composition": "构图", "color": "颜色", "reason": "理由"}],
        "shooting": {"broll": ["画面"], "highlights": ["字幕高亮词"], "guide": {"机位": "正面半身", "语速": "自然"}},
        "platformCopy": {"douyin": "抖音文案", "xiaohongshu": "小红书文案", "weibo": "微博文案"},
        "evidence": [{"name": "证据", "proof": "能证明什么", "path": "本地相对路径", "public": True}],
        "risks": [{"text": "风险检查", "done": False}],
        "tomorrowChallenge": "下一集挑战",
    }
    system = """你是个人AI实践成长账号的总编和口播编导。只根据提供的真实证据写内容，不得虚构完成项、错误、数据、热点或粉丝反馈。输出必须是单个JSON对象，不要Markdown。语言自然、口语化，不用新闻播音腔，不以‘大家好’开头。先给结果/冲突，再讲过程，最后给普通观众可复用经验和明日挑战。"""
    user = f"""日期：{today}\n成长天数：Day {day_number}\n\n真实证据：\n{json.dumps(evidence, ensure_ascii=False, indent=2)}\n\n已有内容标题（避免重复）：\n{json.dumps(payload.get('existing_topics', []), ensure_ascii=False)}\n\n请生成完整口播拍摄包。必须严格包含以下JSON字段结构，可增加字段但不能缺字段：\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n要求：fullSegments 5-7段，总时长45-90秒；shortScript 30-45秒；titles 3个；covers 3个；candidates 最多5个。证据不足时明确写‘今天不建议发布’，不要编造。"""
    return call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.45, max_tokens=16000)


def edit_plan(payload: dict[str, Any], feedback: str | None = None) -> dict[str, Any]:
    transcript = payload.get("transcript", {})
    base_plan = payload.get("base_plan", {})
    system = """你是短视频口播剪辑导演。根据逐字转录、停顿检测、原口播目标和用户反馈生成保守、可执行的剪辑JSON。不得改动事实，不得凭空添加说过的话。优先删除假启动、重复、口头禅和明显错句；保留自然情绪和必要停顿。所有时间必须引用源视频秒数。只输出JSON。"""
    schema = {
        "keepSegments": [{"start": 0.0, "end": 5.0, "reason": "保留原因"}],
        "overlayCards": [{"start": 1.0, "end": 3.5, "text": "不超过14字", "kind": "hook|evidence|result|lesson"}],
        "subtitleStyle": "bold-clean",
        "editSummary": "剪辑策略摘要",
        "removedReasons": ["删除原因"],
        "confidence": 0.8,
    }
    user = f"""目标口播稿：\n{payload.get('script', '')}\n\n源视频信息：\n{json.dumps(payload.get('source', {}), ensure_ascii=False)}\n\n停顿检测与基础保留区间：\n{json.dumps(base_plan, ensure_ascii=False)}\n\n逐字转录：\n{json.dumps(transcript, ensure_ascii=False)}\n\n用户最终审核反馈：\n{feedback or '无，这是第一次自动剪辑'}\n\n输出结构：\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n约束：keepSegments 按时间升序、不重叠，每段至少0.35秒；除非存在大量重复，不得删除超过原片55%；overlayCards 0-5个，只放最重要的钩子/证据/结果/经验。"""
    return call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.2, max_tokens=10000)


def transcribe(payload: dict[str, Any]) -> dict[str, Any]:
    # Direct Hugging Face access is unreliable on this workstation. Keep any user-provided
    # endpoint, otherwise use the mirror that the local installation has verified.
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    from faster_whisper import WhisperModel

    input_path = Path(payload["input_path"]).resolve()
    output_dir = Path(payload.get("output_dir") or input_path.parent).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    model_size = str(payload.get("model_size") or "small")
    language = payload.get("language") or "zh"
    cache_dir = ROOT / ".runtime" / "models"
    cache_dir.mkdir(parents=True, exist_ok=True)
    model = WhisperModel(model_size, device="cpu", compute_type="int8", download_root=str(cache_dir))
    segments_iter, info = model.transcribe(
        str(input_path),
        language=language,
        beam_size=5,
        vad_filter=True,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    for seg in segments_iter:
        entry = {"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "words": []}
        for word in seg.words or []:
            item = {"word": word.word, "start": round(word.start, 3), "end": round(word.end, 3), "probability": round(word.probability, 3)}
            entry["words"].append(item)
            words.append(item)
        segments.append(entry)
    data = {
        "segments": segments,
        "words": words,
        "text": "".join(segment["text"] for segment in segments),
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "duration": round(info.duration, 3),
        "model": model_size,
        "device": "cpu",
    }
    output = output_dir / "transcript.json"
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"model": f"faster-whisper/{model_size}", "data": data, "artifact": str(output)}


def main() -> int:
    args = parse_args()
    request_path = Path(args.request).resolve()
    response_path = Path(args.response).resolve()
    response_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        payload = json.loads(request_path.read_text(encoding="utf-8-sig"))
        operation = payload.get("operation")
        if operation == "config":
            _, model = load_company_runtime()
            result = {"success": True, "model": model, "transcription_model": "faster-whisper/small"}
        elif operation == "generate_content":
            result = {"success": True, **generate_content(payload)}
        elif operation == "edit_plan":
            result = {"success": True, **edit_plan(payload)}
        elif operation == "revise_plan":
            result = {"success": True, **edit_plan(payload, str(payload.get("feedback") or ""))}
        elif operation == "transcribe":
            result = {"success": True, **transcribe(payload)}
        else:
            raise RuntimeError(f"不支持的操作：{operation}")
    except Exception as exc:
        result = {"success": False, "error": f"{type(exc).__name__}: {exc}"[:3000]}
    response_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
