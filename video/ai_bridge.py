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
    json_repaired = False
    try:
        data = extract_json(content)
    except (json.JSONDecodeError, ValueError):
        repair_messages = [
            {"role": "system", "content": "你只负责把输入修复成语义不变的合法JSON对象。不要解释、不要Markdown、不要删除字段、不要增加新事实。"},
            {"role": "user", "content": content},
        ]
        repair_response = client.chat.completions.create(
            model=model,
            messages=repair_messages,
            temperature=0,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        repair_choice = repair_response.choices[0]
        repair_finish = getattr(repair_choice, "finish_reason", None)
        if repair_finish in {"length", "max_tokens"}:
            raise RuntimeError(f"JSON修复输出被截断：{repair_finish}")
        data = extract_json(message_text(repair_choice.message.content))
        json_repaired = True
    return {
        "model": model,
        "json_mode": json_mode,
        "json_repaired": json_repaired,
        "finish_reason": finish_reason,
        "data": data,
        "usage": {
            "prompt_tokens": getattr(getattr(response, "usage", None), "prompt_tokens", None),
            "completion_tokens": getattr(getattr(response, "usage", None), "completion_tokens", None),
            "total_tokens": getattr(getattr(response, "usage", None), "total_tokens", None),
        },
    }


def append_sentence(text: str, sentence: str) -> str:
    base = str(text or "").strip()
    addition = str(sentence or "").strip()
    if not addition or addition in base:
        return base
    if base and base[-1] not in "。！？!?":
        base += "。"
    return base + addition


def enforce_script_contract(data: dict[str, Any]) -> list[str]:
    engagement = data.get("engagement") if isinstance(data.get("engagement"), dict) else {}
    creative_tone = data.get("creativeTone") if isinstance(data.get("creativeTone"), dict) else {}
    trend_meme = creative_tone.get("trendMeme") if isinstance(creative_tone.get("trendMeme"), dict) else {}
    required_end = [engagement.get("viewerTask"), engagement.get("commentPrompt"), engagement.get("followPromise")]
    fixes: list[str] = []
    short_script = str(data.get("shortScript") or "")
    for sentence in required_end:
        updated = append_sentence(short_script, str(sentence or ""))
        if updated != short_script:
            fixes.append("shortScript 补齐行动/互动契约")
            short_script = updated
    data["shortScript"] = short_script
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    if segments and isinstance(segments[-1], dict):
        last_text = str(segments[-1].get("text") or "")
        for sentence in required_end:
            updated = append_sentence(last_text, str(sentence or ""))
            if updated != last_text:
                fixes.append("完整版结尾补齐行动/互动契约")
                last_text = updated
        segments[-1]["text"] = last_text
    humor_beat = str(creative_tone.get("humorBeat") or "").strip()
    full_text = "".join(str(item.get("text") or "") for item in segments if isinstance(item, dict))
    if humor_beat and humor_beat not in short_script + full_text and segments:
        target = segments[1] if len(segments) > 1 and isinstance(segments[1], dict) else segments[0]
        target["text"] = append_sentence(str(target.get("text") or ""), humor_beat)
        fixes.append("完整版补入轻松点")
    adapted_line = str(trend_meme.get("adaptedLine") or "").strip()
    full_text = "".join(str(item.get("text") or "") for item in segments if isinstance(item, dict))
    if trend_meme.get("id") and adapted_line and adapted_line not in short_script + full_text and segments:
        first = segments[0] if isinstance(segments[0], dict) else None
        if first is not None:
            first["text"] = append_sentence(str(first.get("text") or ""), adapted_line)
            fixes.append("完整版补入已选热梗")
    return sorted(set(fixes))


def engagement_issues(data: dict[str, Any], content_style: dict[str, Any]) -> list[str]:
    engagement = data.get("engagement") if isinstance(data.get("engagement"), dict) else {}
    audience_mirror = str(engagement.get("audienceMirror") or "").strip()
    comment_prompt = str(engagement.get("commentPrompt") or "").strip()
    follow_promise = str(engagement.get("followPromise") or "").strip()
    viewer_task = str(engagement.get("viewerTask") or "").strip()
    short_script = str(data.get("shortScript") or "").strip()
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    full_text = "".join(str(item.get("text") or "") for item in segments if isinstance(item, dict))
    combined = short_script + full_text
    creative_tone = data.get("creativeTone") if isinstance(data.get("creativeTone"), dict) else {}
    humor_beat = str(creative_tone.get("humorBeat") or "").strip()
    trend_meme = creative_tone.get("trendMeme") if isinstance(creative_tone.get("trendMeme"), dict) else {}
    issues: list[str] = []
    if len(audience_mirror) < 12:
        issues.append("engagement.audienceMirror 缺少具体观众场景")
    if len(comment_prompt) < 10 or not any(mark in comment_prompt for mark in ("？", "?")):
        issues.append("engagement.commentPrompt 必须是具体可回答的问题")
    if len(follow_promise) < 12:
        issues.append("engagement.followPromise 没有说明下次回来能看到什么")
    if len(viewer_task) < 10:
        issues.append("engagement.viewerTask 缺少观众今天可执行的最小动作")
    if len(humor_beat) < 6:
        issues.append("creativeTone.humorBeat 缺少自然的轻松点")
    if humor_beat and humor_beat not in combined:
        issues.append("creativeTone.humorBeat 必须自然进入至少一个口播版本")
    if trend_meme.get("id") and str(trend_meme.get("adaptedLine") or "") not in combined:
        issues.append("选择热梗后 adaptedLine 必须进入口播正文")
    if short_script.startswith("我") or short_script.startswith("今天我"):
        issues.append("shortScript 仍以创作者自我汇报开场")
    if combined.count("你") + combined.count("你的") < 3:
        issues.append("正文没有持续把经历翻译成观众视角")
    if comment_prompt and (comment_prompt not in short_script or comment_prompt not in full_text):
        issues.append("commentPrompt 必须原样自然进入完整版和精简版")
    if follow_promise and (follow_promise not in short_script or follow_promise not in full_text):
        issues.append("followPromise 必须原样自然进入完整版和精简版")
    if viewer_task and (viewer_task not in short_script or viewer_task not in full_text):
        issues.append("viewerTask 必须原样自然进入完整版和精简版")
    for banned in content_style.get("bannedCallsToAction", []):
        if str(banned) and str(banned) in combined:
            issues.append(f"口播包含禁用空泛话术：{banned}")
    return issues


def factual_issues(data: dict[str, Any], evidence: dict[str, Any]) -> list[str]:
    evidence_text = json.dumps(evidence, ensure_ascii=False)
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    content_text = str(data.get("shortScript") or "") + "".join(
        str(item.get("text") or "") for item in segments if isinstance(item, dict)
    )
    issues: list[str] = []
    not_filmed = bool(re.search(r"尚未.{0,20}(拍摄|拍|录制|真人视频)|没有.{0,20}(拍摄|拍|录制|真人视频)", evidence_text))
    not_published = bool(re.search(r"尚未.{0,20}(发布|公开视频)|没有.{0,20}(发布|公开视频)", evidence_text))
    if not_filmed:
        completed_film_patterns = [
            r"(?:已经|终于|今天)?(?:录了|拍了|录完了|拍完了|重录了)[^，。！？]{0,20}",
            r"相册里(?:终于)?有了[^，。！？]{0,20}(?:素材|视频)",
            r"第一条(?:真人)?视频(?:已经)?(?:拍完|录完|完成)",
        ]
        for pattern in completed_film_patterns:
            match = re.search(pattern, content_text)
            if match:
                issues.append(f"证据显示尚未拍摄，但稿件声称已完成：{match.group(0)}")
    if not_published:
        match = re.search(r"(?:已经|终于|今天)?(?:发布了|(?<!开)发了|上线了)[^，。！？]{0,20}", content_text)
        if match:
            issues.append(f"证据显示尚未发布，但稿件声称已发布：{match.group(0)}")
    for match in re.finditer(r"(?:花了|用了|重录|拍了|录了|超过|持续|坚持)(?:[0-9]+|[一二三四五六七八九十两]+)(?:秒|分钟|小时|天|周|个月|年|次|遍|条)", content_text):
        claim = match.group(0)
        if claim not in evidence_text:
            issues.append(f"稿件包含证据中没有的数量或耗时：{claim}")
    for match in re.finditer(r"明天[^。！？]{0,40}(?:发布|发给|公开|上线)", content_text):
        promise = match.group(0)
        if not re.search(r"明天[^。！？]{0,40}(?:发布|发给|公开|上线)", evidence_text):
            issues.append(f"稿件自行增加了未确认的明日承诺：{promise}")
    return sorted(set(issues))


def generate_content(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = payload.get("evidence", {})
    day_number = int(payload.get("day_number") or 1)
    today = str(payload.get("date") or "")
    style_path = ROOT / "config" / "content_style.json"
    meme_path = ROOT / "config" / "meme_pool.json"
    content_style = json.loads(style_path.read_text(encoding="utf-8-sig")) if style_path.exists() else {}
    meme_pool = json.loads(meme_path.read_text(encoding="utf-8-sig")) if meme_path.exists() else {"items": []}
    active_memes = [item for item in meme_pool.get("items", []) if item.get("status") == "active"]
    schema = {
        "mainTopic": "主选题",
        "shortTopic": "12字以内短标题",
        "column": f"普通人学AI第{day_number}天",
        "durationFull": "约75秒",
        "durationShort": "约40秒",
        "hook": "0-3秒开场",
        "audienceBenefit": "观众能带走的一句话",
        "engagement": {
            "audienceMirror": "观众可能也遇到的具体场景或矛盾",
            "commentPrompt": "低门槛、具体、与下一集相关的评论问题",
            "followPromise": "观众下一次回来能看到的真实验证或结果",
            "viewerTask": "观众今天就能完成、无需完美也不强迫公开的最小动作",
        },
        "creativeTone": {
            "humorBeat": "自然进入稿件的一句轻松自嘲或反差表达",
            "trendMeme": {"id": "相关时选用已核对热梗ID，否则为空", "adaptedLine": "改写成当前真实行动语境的一句话", "placement": "出现位置", "sourceUrl": "来源链接"},
        },
        "actionExperiment": {
            "oldState": "过去反复出现的状态",
            "currentConflict": "继续原样会产生的冲突",
            "realAction": "今天实际完成的最小动作",
            "resultEvidence": "可以展示的真实证据",
            "insight": "行动后得出的认识",
            "viewerTask": "给观众的最小任务",
        },
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
    system = """你是个人AI实践成长账号的总编和短视频口播编导。你的首要任务不是汇报创作者今天做了什么，而是把真实经历改写成观众能代入、能参与、愿意继续追看的公开实验。只根据提供的真实证据写内容，不得虚构完成项、错误、数据、热点、粉丝反馈、评论或投票结果。输出必须是单个JSON对象，不要Markdown。语言自然、口语化，像和一个具体的人对话，不用新闻播音腔。个人经历只能作为证明观众问题的案例，不能让整篇稿件变成“我做了什么”的流水账。"""
    user = f"""日期：{today}\n成长天数：Day {day_number}\n\n内容风格规则：\n{json.dumps(content_style, ensure_ascii=False, indent=2)}\n\n当前已核对、可按相关性选用的热梗：\n{json.dumps(active_memes, ensure_ascii=False, indent=2)}\n\n真实证据：\n{json.dumps(evidence, ensure_ascii=False, indent=2)}\n\n已有内容标题（避免重复）：\n{json.dumps(payload.get('existing_topics', []), ensure_ascii=False)}\n\n请生成完整口播拍摄包。必须严格包含以下JSON字段结构，可增加字段但不能缺字段：\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n硬性要求：\n1. fullSegments 5-7段，总时长45-90秒；shortScript 30-45秒；titles 3个；covers 3个；candidates 最多5个。\n2. 开头优先从观众的困境、选择、损失或反常识切入；除非必要，前20字不要以“我”开头。\n3. 核心转变统一为“从知道到做到”，正文按旧状态、当前冲突、真实行动、结果证据、得出的认识、观众最小任务推进。\n4. 个人经历只作为真实案例，整篇至少三次把经验翻译成“你可以怎么判断/怎么做”。\n5. fullSegments 最后一段和 shortScript 都必须自然包含 engagement.commentPrompt、engagement.followPromise 与 engagement.viewerTask。\n6. commentPrompt 必须是具体的A/B选择、真实经历或下一步实验选择，不能只问“你怎么看”，不能虚构已有观众反馈。\n7. followPromise 要说明下一集能看到的真实测试、结果或翻车，不使用“记得点赞关注”等空泛口号。\n8. viewerTask 必须是观众今天就能完成的最小动作，不要求完美，也不强迫发布。\n9. 语气不能像项目汇报或课程讲解；45—90秒稿件自然放1—2个轻松点，优先自嘲、反差或一个与主题高度相关的已核对热梗。\n10. 热梗只在确实贴合冲突时使用，写入 creativeTone.trendMeme；不得大段照搬、不得虚构来源、不得把热度数字写入口播。\n11. 不得自行增加证据中没有的拍摄遍数、耗时、播放量、结果或“明天一定发布”等承诺。证据写着尚未拍摄/发布时，只能把本条视频描述为准备执行的行动或使用条件句，不能声称已经录了几条、重拍几次或已经发出。
12. 证据不足时明确写“今天不建议发布”，不要编造。"""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    result = call_json(messages, temperature=0.4, max_tokens=10000)
    structural_fixes = enforce_script_contract(result.get("data", {}))
    issues = engagement_issues(result.get("data", {}), content_style) + factual_issues(result.get("data", {}), evidence)
    initial_issues = list(issues)
    repair_attempts = 0
    while issues and repair_attempts < 2:
        repair_attempts += 1
        repair = f"""上一版没有通过内容质量与事实一致性门禁：
- {chr(10).join(issues)}

真实证据再次提醒：
{json.dumps(evidence, ensure_ascii=False, indent=2)}

上一版JSON：
{json.dumps(result.get('data', {}), ensure_ascii=False, indent=2)}

请在不增加任何新事实的前提下重写完整JSON。证据写着尚未拍摄或发布时，绝对不能改写成已经拍完、录了几条、重录几次或已经发布。把观众问题放在主线，严格让 engagement.commentPrompt、engagement.followPromise 和 engagement.viewerTask 原样自然出现在完整版最后一段与 shortScript 中；creativeTone.humorBeat 至少自然进入一个口播版本；如选择热梗，也要让 creativeTone.trendMeme.adaptedLine 自然进入正文，并修复所有门禁问题。"""
        result = call_json(messages + [{"role": "assistant", "content": json.dumps(result.get("data", {}), ensure_ascii=False)}, {"role": "user", "content": repair}], temperature=0.15, max_tokens=10000)
        structural_fixes.extend(enforce_script_contract(result.get("data", {})))
        issues = engagement_issues(result.get("data", {}), content_style) + factual_issues(result.get("data", {}), evidence)
    if issues:
        raise RuntimeError("内容质量与事实一致性门禁未通过：" + "；".join(issues))
    result["quality_revision"] = {
        "repaired": repair_attempts > 0,
        "repair_attempts": repair_attempts,
        "initial_issues": initial_issues,
        "structural_fixes": sorted(set(structural_fixes)),
    }
    return result


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
