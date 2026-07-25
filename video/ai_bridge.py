"""Local AI bridge for the koubo workbench.

- Loads an OpenAI-compatible text model from this project's environment.
- Runs faster-whisper locally for speech-to-text.
- Never writes or returns API keys.
"""
from __future__ import annotations

import argparse
from difflib import SequenceMatcher
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]


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
    if isinstance(content, dict):
        if "value" in content:
            return message_text(content.get("value"))
        if "text" in content:
            return message_text(content.get("text"))
        if "content" in content:
            return message_text(content.get("content"))
    if isinstance(content, list):
        return "\n".join(part for item in content if (part := message_text(item)).strip())
    return str(content or "")


def response_field(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def response_details(response: Any) -> tuple[str, Any, dict[str, Any]]:
    """Normalize OpenAI SDK objects and common compatible endpoint wrappers."""
    if isinstance(response, str):
        stripped = response.strip()
        try:
            decoded = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            return response, None, {}
        wrapper_fields = {"choices", "message", "content", "output_text", "output"}
        if isinstance(decoded, dict) and wrapper_fields.intersection(decoded):
            return response_details(decoded)
        return response, None, {}

    usage_raw = response_field(response, "usage")
    usage = {
        "prompt_tokens": response_field(usage_raw, "prompt_tokens"),
        "completion_tokens": response_field(usage_raw, "completion_tokens"),
        "total_tokens": response_field(usage_raw, "total_tokens"),
    } if usage_raw is not None else {}

    choices = response_field(response, "choices")
    if isinstance(choices, (list, tuple)) and choices:
        choice = choices[0]
        message = response_field(choice, "message")
        content = response_field(message, "content") if message is not None else response_field(choice, "text")
        return message_text(content), response_field(choice, "finish_reason"), usage

    output_text = response_field(response, "output_text")
    if output_text is not None:
        return message_text(output_text), response_field(response, "finish_reason"), usage

    output = response_field(response, "output")
    if isinstance(output, (list, tuple)):
        parts: list[str] = []
        for item in output:
            content = response_field(item, "content")
            if content is not None:
                parts.append(message_text(content))
            else:
                parts.append(message_text(response_field(item, "text")))
        return "\n".join(part for part in parts if part.strip()), response_field(response, "finish_reason"), usage

    message = response_field(response, "message")
    if message is not None:
        return message_text(response_field(message, "content", message)), response_field(response, "finish_reason"), usage

    content = response_field(response, "content")
    if content is not None:
        return message_text(content), response_field(response, "finish_reason"), usage

    return message_text(response), response_field(response, "finish_reason"), usage


def load_text_model():
    from dotenv import load_dotenv
    from openai import OpenAI

    load_dotenv(ROOT / ".env", override=False)
    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    base_url = (os.environ.get("OPENAI_BASE_URL") or "").strip()
    model = (os.environ.get("OPENAI_MODEL") or "").strip()
    if not api_key:
        raise RuntimeError("文本模型未配置：请在项目 .env 中填写 OPENAI_API_KEY")
    if not model:
        raise RuntimeError("文本模型未配置：请在项目 .env 中填写 OPENAI_MODEL")
    client_options = {"api_key": api_key}
    if base_url:
        parsed = urlsplit(base_url)
        if parsed.scheme and parsed.netloc and parsed.path.rstrip("/") == "":
            base_url = urlunsplit((parsed.scheme, parsed.netloc, "/v1", parsed.query, parsed.fragment))
        client_options["base_url"] = base_url
    client = OpenAI(**client_options)
    return client, model


def call_json(messages: list[dict[str, str]], *, temperature: float = 0.3, max_tokens: int = 12000) -> dict[str, Any]:
    client, model = load_text_model()
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
    content, finish_reason, usage = response_details(response)
    if not content.strip():
        raise RuntimeError("文本模型返回了空内容")
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
        repair_content, repair_finish, _ = response_details(repair_response)
        if repair_finish in {"length", "max_tokens"}:
            raise RuntimeError(f"JSON修复输出被截断：{repair_finish}")
        data = extract_json(repair_content)
        json_repaired = True
    return {
        "model": model,
        "json_mode": json_mode,
        "json_repaired": json_repaired,
        "finish_reason": finish_reason,
        "data": data,
        "usage": {
            "prompt_tokens": usage.get("prompt_tokens"),
            "completion_tokens": usage.get("completion_tokens"),
            "total_tokens": usage.get("total_tokens"),
        },
    }


ARCHETYPE_FRAMEWORK_RANGES = {
    "evidence-story": (2, 4),
    "saveable-map": (3, 5),
    "short-resonance": (1, 2),
}


def normalize_spoken_text(value: Any) -> str:
    return re.sub(r"[，。！？、；：,.!?;:\s]", "", str(value or ""))


def spoken_text_contains(script: str, sentence: str) -> bool:
    needle = normalize_spoken_text(sentence)
    return bool(needle) and needle in normalize_spoken_text(script)


def spoken_text_matches(script: str, sentence: str) -> bool:
    """Allow a close to be spoken naturally instead of requiring mechanical verbatim reuse."""
    haystack = normalize_spoken_text(script)
    needle = normalize_spoken_text(sentence)
    if not needle or not haystack:
        return False
    if needle in haystack:
        return True
    longest = SequenceMatcher(None, needle, haystack, autojunk=False).find_longest_match().size
    return longest >= min(10, max(6, round(len(needle) * 0.45)))


def script_texts(data: dict[str, Any]) -> tuple[str, str, str]:
    short_script = str(data.get("shortScript") or "").strip()
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    full_text = "".join(str(item.get("text") or "") for item in segments if isinstance(item, dict))
    full_close = str(segments[-1].get("text") or "").strip() if segments and isinstance(segments[-1], dict) else ""
    return short_script, full_text, full_close


def structure_issues(data: dict[str, Any]) -> list[str]:
    design = data.get("structureDesign") if isinstance(data.get("structureDesign"), dict) else {}
    archetype = str(design.get("archetype") or "").strip()
    issues: list[str] = []
    if archetype not in ARCHETYPE_FRAMEWORK_RANGES:
        issues.append("structureDesign.archetype 必须是 evidence-story、saveable-map 或 short-resonance")
        return issues

    required_text = {
        "selectionReason": (12, "没有说明为什么本题适合所选结构"),
        "coreQuestion": (10, "没有锁定本集唯一核心问题"),
        "hookConflict": (10, "缺少精准矛盾或反差钩子"),
        "personalEvidenceRole": (8, "没有说明个人证据在本集承担什么作用"),
        "personalVariation": (10, "没有加入本账号真实场景或优势形成的变化"),
        "boundary": (8, "没有说明方法的适用边界"),
        "payoff": (10, "没有写清观众看完能完成什么判断或动作"),
    }
    for field, (minimum, message) in required_text.items():
        if len(str(design.get(field) or "").strip()) < minimum:
            issues.append(f"structureDesign.{field} {message}")

    framework = design.get("saveableFramework") if isinstance(design.get("saveableFramework"), list) else []
    minimum, maximum = ARCHETYPE_FRAMEWORK_RANGES[archetype]
    if not minimum <= len(framework) <= maximum:
        issues.append(f"{archetype} 的 saveableFramework 必须有 {minimum}—{maximum} 项")
    for index, item in enumerate(framework, start=1):
        if not isinstance(item, dict):
            issues.append(f"saveableFramework 第{index}项必须是对象")
            continue
        for field, minimum_length, label in (
            ("label", 2, "名称"),
            ("action", 6, "可执行动作"),
            ("expectedSignal", 5, "完成后的可观察信号"),
        ):
            if len(str(item.get(field) or "").strip()) < minimum_length:
                issues.append(f"saveableFramework 第{index}项缺少{label}")
    return issues


def engagement_issues(data: dict[str, Any], content_style: dict[str, Any]) -> list[str]:
    engagement = data.get("engagement") if isinstance(data.get("engagement"), dict) else {}
    audience_mirror = str(engagement.get("audienceMirror") or "").strip()
    comment_prompt = str(engagement.get("commentPrompt") or "").strip()
    follow_promise = str(engagement.get("followPromise") or "").strip()
    viewer_task = str(engagement.get("viewerTask") or "").strip()
    primary_close = str(engagement.get("primaryClose") or "").strip()
    short_script, full_text, full_close = script_texts(data)
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
    if len(primary_close) < 10:
        issues.append("engagement.primaryClose 缺少自然的单一主收束")
    elif not spoken_text_matches(short_script, primary_close) or not spoken_text_matches(full_close, primary_close):
        issues.append("engagement.primaryClose 必须自然进入精简稿和完整版最后一段")
    if len(humor_beat) < 6:
        issues.append("creativeTone.humorBeat 缺少自然的轻松点")
    if humor_beat and not spoken_text_contains(combined, humor_beat):
        issues.append("creativeTone.humorBeat 必须自然进入至少一个口播版本")
    if trend_meme.get("id") and not spoken_text_contains(combined, str(trend_meme.get("adaptedLine") or "")):
        issues.append("选择热梗后 adaptedLine 必须进入口播正文")
    if short_script.startswith("我") or short_script.startswith("今天我"):
        issues.append("shortScript 仍以创作者自我汇报开场")
    if combined.count("你") + combined.count("你的") < 3:
        issues.append("正文没有持续把经历翻译成观众视角")
    planning_lines = [comment_prompt, follow_promise, viewer_task]
    for name, ending in (("精简稿", short_script), ("完整版结尾", full_close)):
        included = sum(spoken_text_contains(ending, line) for line in planning_lines if line)
        if included == 3:
            issues.append(f"{name}机械连入了评论问题、追更承诺和观众任务，请只保留一个主收束")
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


AI_TOPIC_PATTERN = re.compile(
    r"AI|人工智能|Codex|ChatGPT|Agent|智能体|大模型|模型|提示词|vibe\s*cod(?:e|ing)|自动化",
    re.IGNORECASE,
)

DEVELOPER_LOG_PATTERN = re.compile(
    r"\.py\b|server(?:-v?\d+)?\b|git\s*(?:status|log)?|commit\b|__pycache__|\.mjs\b|"
    r"版本管理|接口文件|端点|代码量|\d+\s*(?:KB|MB)\s*代码",
    re.IGNORECASE,
)


def compact_script_length(value: str) -> int:
    return len(re.sub(r"[\s，。！？、；：,.!?;:‘’“”\"'（）()《》【】\[\]—…·]", "", value))


def duration_issues(data: dict[str, Any]) -> list[str]:
    short_script, full_text, _ = script_texts(data)
    full_length = compact_script_length(full_text)
    short_length = compact_script_length(short_script)
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    issues: list[str] = []
    if not 550 <= full_length <= 950:
        issues.append(f"完整版必须适合2—3分钟口播，正文应为550—950个有效字符，当前为{full_length}")
    if not 7 <= len(segments) <= 12:
        issues.append(f"2—3分钟完整版应拆成7—12段，当前为{len(segments)}段")
    if short_script and not 180 <= short_length <= 450:
        issues.append(f"衍生短版应为180—450个有效字符，当前为{short_length}")
    duration_label = str(data.get("durationFull") or "")
    if not any(mark in duration_label for mark in ("2", "3", "120", "180")):
        issues.append("durationFull 必须明确标注约2—3分钟")
    return issues


def ai_relevance_issues(data: dict[str, Any], topic_plan: dict[str, Any]) -> list[str]:
    _, full_text, _ = script_texts(data)
    headline = "".join(str(data.get(field) or "") for field in ("mainTopic", "shortTopic", "hook", "audienceBenefit"))
    combined = headline + full_text
    issues: list[str] = []
    if not AI_TOPIC_PATTERN.search(headline):
        issues.append("主选题、短标题或开场没有明确出现AI主题")
    if len(AI_TOPIC_PATTERN.findall(combined)) < 4:
        issues.append("正文的AI主题密度不足，个人进度压过了AI知识与实践主线")
    planned_angle = str(topic_plan.get("aiAngle") or "").strip()
    if len(planned_angle) < 10:
        issues.append("topicPlan.aiAngle 没有锁定本集明确的AI角度")
    return issues


def viewer_use_case_issues(data: dict[str, Any], topic_plan: dict[str, Any]) -> list[str]:
    """Keep the story on using AI to create a visible result, not on implementing software."""
    _, full_text, _ = script_texts(data)
    segments = data.get("fullSegments") if isinstance(data.get("fullSegments"), list) else []
    opening_text = "".join(str(item.get("text") or "") for item in segments[:2] if isinstance(item, dict))
    proof = data.get("resultFirstProof") if isinstance(data.get("resultFirstProof"), dict) else {}
    shooting = data.get("shooting") if isinstance(data.get("shooting"), dict) else {}
    opening_proof = shooting.get("openingProof") if isinstance(shooting.get("openingProof"), dict) else {}
    issues: list[str] = []
    if len(str(topic_plan.get("viewerUseCase") or "").strip()) < 10:
        issues.append("topicPlan.viewerUseCase 没有写清普通观众如何使用AI解决问题")
    for field, minimum, message in (
        ("before", 8, "没有说明使用AI前的旧结果或限制"),
        ("after", 8, "没有说明使用AI后的可见变化"),
        ("proofAsset", 8, "没有指定可以展示的结果证据"),
        ("truthfulBoundary", 8, "没有说明结果仍需人工判断或真实验证的边界"),
    ):
        if len(str(proof.get(field) or "").strip()) < minimum:
            issues.append(f"resultFirstProof.{field} {message}")
    if str(topic_plan.get("productionMode") or "") == "self-demonstrating-final-video" and len(str(proof.get("publicationCondition") or "").strip()) < 16:
        issues.append("自证型成片必须在 resultFirstProof.publicationCondition 写清发布前的真实效果验收条件")
    if len(str(opening_proof.get("asset") or "").strip()) < 8 or len(str(opening_proof.get("edit") or "").strip()) < 8:
        issues.append("shooting.openingProof 必须写清开头0—8秒展示什么成片效果、如何剪出来")
    visual_beats = shooting.get("visualBeats") if isinstance(shooting.get("visualBeats"), list) else []
    if len([item for item in visual_beats if isinstance(item, dict) and str(item.get("asset") or "").strip()]) < 4:
        issues.append("shooting.visualBeats 至少需要4个与口播步骤对应的可见证据画面")
    if not re.search(r"效果|结果|前后|字幕|画面|成片|剪辑", opening_text):
        issues.append("开头两段没有先让观众看到或听懂最终AI效果")
    developer_detail_count = len(DEVELOPER_LOG_PATTERN.findall(full_text)) + full_text.count("代码") + full_text.count("编程实现")
    if developer_detail_count > 2:
        issues.append("正文出现过多文件名、Git或内部实现细节，仍像开发日志而不是AI使用分享")
    method_markers = sum(marker in full_text for marker in ("素材", "告诉AI", "自然语言", "第一版", "修改", "返修", "结果", "效果"))
    if method_markers < 3:
        issues.append("正文缺少普通创作者能复用的AI输入、生成、检查和返修方法")
    return issues


def reference_issues(data: dict[str, Any], research: dict[str, Any], topic_plan: dict[str, Any] | None = None) -> list[str]:
    synthesis = data.get("referenceResearch") if isinstance(data.get("referenceResearch"), dict) else {}
    full_sources = research.get("fullContentSources") if isinstance(research.get("fullContentSources"), list) else []
    available_ids = {str(item.get("sourceId") or "") for item in full_sources if isinstance(item, dict)}
    used_ids = {str(item) for item in synthesis.get("sourceIds", []) if str(item)} if isinstance(synthesis.get("sourceIds"), list) else set()
    issues: list[str] = []
    if not available_ids:
        issues.append("本次生成没有至少一条完成全文核验的同题参考视频")
    if not used_ids:
        issues.append("referenceResearch.sourceIds 没有记录实际使用的参考视频")
    elif not used_ids.issubset(available_ids):
        issues.append("referenceResearch.sourceIds 引用了未完成全文核验的来源")
    required_ids = {
        str(item) for item in (topic_plan or {}).get("requiredSourceIds", []) if str(item)
    } if isinstance((topic_plan or {}).get("requiredSourceIds"), list) else set()
    if required_ids and not required_ids.issubset(used_ids):
        issues.append("referenceResearch.sourceIds 没有使用用户本次明确指定且已全文核验的参考视频")
    for field, minimum, label in (
        ("borrowedKnowledge", 2, "从参考视频核验并重新组织的知识点"),
        ("structuralChoices", 2, "借鉴的结构选择"),
        ("engagementChoices", 1, "评论或收藏设计"),
    ):
        value = synthesis.get(field)
        if not isinstance(value, list) or len([item for item in value if str(item).strip()]) < minimum:
            issues.append(f"referenceResearch.{field} 缺少{label}")
    if len(str(synthesis.get("originalityNote") or "").strip()) < 12:
        issues.append("referenceResearch.originalityNote 没有说明如何避免复制")
    return issues


def plan_topic(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = payload.get("evidence", {})
    content_style = payload.get("content_style", {})
    locked_direction = str(payload.get("locked_direction") or "").strip()
    locked_direction_hash = str(payload.get("locked_direction_hash") or "").strip()
    direction_source = str(payload.get("direction_source") or "").strip()
    strategy_artifact = payload.get("strategy_artifact", {}) if isinstance(payload.get("strategy_artifact"), dict) else {}
    schema = {
        "topic": "明确包含AI对象或AI实践的主选题",
        "shortTopic": "12字以内且能看出AI话题",
        "coreQuestion": "观众看完只解决的一个问题",
        "aiAngle": "本集具体讲哪项AI能力、方法、工具、限制或实践",
        "viewerUseCase": "普通观众如何使用AI完成一个具体结果，而不是创作者如何写代码",
        "visibleTransformation": "使用AI前后可以直接展示的变化",
        "proofOpening": "开头0—8秒先展示什么结果证据",
        "methodPromise": "观众继续看能学会的2—4步方法",
        "productionMode": "normal|self-demonstrating-final-video；若成片本身承担结果证据则用后者",
        "requiredSourceIds": ["用户明确要求使用的完整参考来源sourceId"],
        "personalEvidenceRole": "个人进度只负责证明什么",
        "searchQueries": ["抖音同题搜索词1", "搜索词2", "搜索词3"],
        "keywords": ["用于匹配参考视频的关键词"],
        "whyNow": "为什么今天的真实进度适合讲这个AI题目",
        "lockedDirection": "必须逐字回显服务端锁定方向",
        "lockedDirectionHash": "必须逐字回显服务端方向哈希",
        "directionSource": "必须逐字回显方向权限来源",
    }
    lock_instruction = (
        f"用户方向已经锁定为：{locked_direction}。topic 必须逐字等于该方向，不能改写、替换或另选主题；"
        "shortTopic、aiAngle和搜索词只能服务这个方向。"
        if locked_direction
        else "只有服务端明确允许了 Agent 找题；选定一个方向后不得在后续成稿阶段更换。"
    )
    system = f"""你是AI使用案例内容编辑。{lock_instruction} 选题必须回答“普通人怎样使用AI得到一个具体结果”，而不是“创作者怎样开发了一套软件”。优先选择能展示使用前、使用后、给AI的输入、第一版问题、具体返修和最终边界的案例。个人项目只承担真实试验场和证据角色；代码、文件名、Git、接口、安装过程默认不进入主题。不要选纯生活感悟、泛成长、职业自由或项目进度汇报。Content Strategist 的分析只用于理解受众、收益、证据、弱点和风险，不能授权换题、编造事实或提前写稿。输出单个JSON对象，不要Markdown。"""
    user = f"""服务端锁定方向：\n{locked_direction or '本次由用户显式允许 Agent 找题'}\n\nContent Strategist 已确认的分析上下文：\n{json.dumps(strategy_artifact, ensure_ascii=False, indent=2)}\n\n真实证据：\n{json.dumps(evidence, ensure_ascii=False, indent=2)}\n\n用户本次明确要求：\n{json.dumps(payload.get('editorial_brief', {}), ensure_ascii=False, indent=2)}\n\n内容定位：\n{json.dumps(content_style, ensure_ascii=False, indent=2)}\n\n已有标题：\n{json.dumps(payload.get('existing_topics', []), ensure_ascii=False)}\n\n输出结构：\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n要求：{lock_instruction} viewerUseCase 必须落实 Strategist 已确认的 audience 与 viewerBenefit；coreQuestion 必须服务其 testableQuestion；同时诚实保留 weaknesses、uncertainties 和证据边界。topic、shortTopic和aiAngle都要让普通观众一眼看出在讲AI；viewerUseCase必须描述观众可复用的AI用法；visibleTransformation和proofOpening必须能拍成画面；methodPromise给2—4步人话方法。searchQueries写2—3个适合抖音检索的具体同题词；keywords写5—10个可用于匹配参考视频的短词；不要把Day编号、代码量、文件名、安装命令或Git状态当成选题。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.2, max_tokens=3000)
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    if not AI_TOPIC_PATTERN.search(str(data.get("topic") or "") + str(data.get("aiAngle") or "")):
        raise RuntimeError("选题规划偏离AI主线")
    if not 2 <= len(data.get("searchQueries") or []) <= 3:
        raise RuntimeError("选题规划没有给出2—3个同题视频搜索词")
    if len(str(data.get("viewerUseCase") or "").strip()) < 10 or len(str(data.get("proofOpening") or "").strip()) < 8:
        raise RuntimeError("选题规划没有锁定观众可复用的AI用法和结果先行开场")
    if locked_direction and str(data.get("topic") or "").strip() != locked_direction:
        raise RuntimeError("选题规划更改了用户锁定方向")
    if locked_direction:
        data["lockedDirection"] = locked_direction
        data["lockedDirectionHash"] = locked_direction_hash
        data["directionSource"] = direction_source
    requested_source = str((payload.get("editorial_brief") or {}).get("requiredReference") or "").strip()
    if requested_source:
        data["requiredSourceIds"] = [requested_source]
    if str((payload.get("editorial_brief") or {}).get("productionMode") or "").strip():
        data["productionMode"] = str(payload["editorial_brief"]["productionMode"])
    result["data"] = data
    return result


def analyze_reference(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("source", {})
    transcript = str(payload.get("transcript") or "")[:50000]
    comments = payload.get("comments", [])
    schema = {
        "sourceId": str(source.get("sourceId") or ""),
        "topic": "这条视频真正解决的问题",
        "relevance": "与本次AI选题的具体关系",
        "structure": [{"range": "时间范围", "function": "这一段承担的叙事或知识功能"}],
        "knowledge": ["可核验、可转述的知识点或方法"],
        "engagement": ["评论、收藏或继续观看是如何被内容自然触发的"],
        "discussionSignals": ["评论中真实出现的问题类型，只概括不引用用户名和原句"],
        "reusablePatterns": ["可以借鉴但必须重新表达的结构模式"],
        "limits": ["视频未证明或仍需核验的边界"],
        "copyBoundary": "不得复制的措辞、案例、人设与素材边界",
    }
    system = """你负责分析一条公开AI视频的内容结构。只能根据逐字转录、标题和公开评论概括；不得补写视频没有的知识，不得输出长段原文，不得复制创作者措辞、案例或人设。输出单个JSON对象，不要Markdown。"""
    user = f"""本次目标选题：\n{json.dumps(payload.get('topic_plan', {}), ensure_ascii=False, indent=2)}\n\n视频信息：\n{json.dumps(source, ensure_ascii=False, indent=2)}\n\n逐字转录：\n{transcript}\n\n公开评论（仅用于判断观众真实问题，不引用用户名和原句）：\n{json.dumps(comments, ensure_ascii=False, indent=2)}\n\n输出结构：\n{json.dumps(schema, ensure_ascii=False, indent=2)}"""
    return call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.1, max_tokens=6000)


def generate_content(payload: dict[str, Any]) -> dict[str, Any]:
    evidence = payload.get("evidence", {})
    topic_plan = payload.get("topic_plan", {}) if isinstance(payload.get("topic_plan"), dict) else {}
    reference_research = payload.get("reference_research", {}) if isinstance(payload.get("reference_research"), dict) else {}
    day_number = int(payload.get("day_number") or 1)
    today = str(payload.get("date") or "")
    style_path = ROOT / "config" / "content_style.json"
    meme_path = ROOT / "config" / "meme_pool.json"
    content_style = json.loads(style_path.read_text(encoding="utf-8-sig")) if style_path.exists() else {}
    meme_pool = json.loads(meme_path.read_text(encoding="utf-8-sig")) if meme_path.exists() else {"items": []}
    active_memes = [item for item in meme_pool.get("items", []) if item.get("status") == "active"]
    locked_direction = str(
        payload.get("locked_direction")
        or topic_plan.get("lockedDirection")
        or ""
    ).strip()
    locked_direction_hash = str(
        payload.get("locked_direction_hash")
        or topic_plan.get("lockedDirectionHash")
        or ""
    ).strip()
    direction_source = str(
        payload.get("direction_source")
        or topic_plan.get("directionSource")
        or ""
    ).strip()
    strategy_artifact = payload.get("strategy_artifact", {}) if isinstance(payload.get("strategy_artifact"), dict) else {}
    schema = {
        "mainTopic": "主选题",
        "shortTopic": "12字以内短标题",
        "column": f"普通人学AI第{day_number}天",
        "durationFull": "约2—3分钟",
        "durationShort": "约60—90秒衍生版",
        "hook": "0-3秒开场",
        "audienceBenefit": "观众能带走的一句话",
        "resultFirstProof": {
            "before": "使用AI前能看到的旧结果或限制",
            "after": "使用AI后能看到的具体变化",
            "proofAsset": "成片、前后对比、界面或测试结果中的哪一项承担证据",
            "truthfulBoundary": "当前结果没有证明什么、仍需什么人工判断或真实验证",
            "publicationCondition": "若成片本身承担证据，必须满足什么可验证条件后才允许发布",
        },
        "engagement": {
            "audienceMirror": "观众可能也遇到的具体场景或矛盾",
            "commentPrompt": "低门槛、具体、与下一集相关的评论问题",
            "followPromise": "观众下一次回来能看到的真实验证或结果",
            "viewerTask": "观众今天就能完成、无需完美也不强迫公开的最小动作",
            "primaryClose": "从以上互动意图中选择一个主动作，改写成自然进入两个版本结尾的一句话",
        },
        "structureDesign": {
            "archetype": "evidence-story|saveable-map",
            "selectionReason": "为什么本题适合这套结构",
            "coreQuestion": "整条视频只解决的一个问题",
            "hookConflict": "精准矛盾、反差或观众正在付出的代价",
            "saveableFramework": [
                {"label": "步骤或阶段名称", "action": "观众可以执行的动作", "expectedSignal": "完成后可以观察到的信号"}
            ],
            "personalEvidenceRole": "个人经历或结果在本集只负责证明什么",
            "personalVariation": "结合本账号真实项目、优势或限制做出的变化",
            "boundary": "方法在哪些情况下不适用或还未经验证",
            "payoff": "观众看完能做出的判断或最小行动",
        },
        "referenceResearch": {
            "sourceIds": ["只填写本次 fullContentSources 中实际使用的 sourceId"],
            "borrowedKnowledge": ["从完整视频核验后重新组织的知识点，不复制原句"],
            "structuralChoices": ["本稿借鉴了什么结构功能以及为何适合本题"],
            "engagementChoices": ["评论、收藏或追看的自然触发设计"],
            "originalityNote": "如何用本人的真实进度、证据和表达形成原创版本",
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
        "shortScript": "60—90秒衍生短版，不作为默认拍摄稿",
        "titles": [{"type": "结果型", "text": "标题"}],
        "covers": [{"id": "cover-a", "name": "方案A", "copy": "封面大字", "expression": "表情", "composition": "构图", "color": "颜色", "reason": "理由"}],
        "shooting": {
            "openingProof": {"asset": "0—8秒先展示的最终效果或前后对比", "edit": "快切、动态图卡、画面切换等具体剪法", "onScreenText": "开头大字"},
            "visualBeats": [{"segment": "对应口播段落", "asset": "真实界面、成片或前后对比", "purpose": "这张画面证明什么"}],
            "broll": ["画面"],
            "highlights": ["字幕高亮词"],
            "guide": {"机位": "正面半身", "语速": "自然"},
        },
        "platformCopy": {"douyin": "抖音文案", "xiaohongshu": "小红书文案", "weibo": "微博文案"},
        "evidence": [{"name": "证据", "proof": "能证明什么", "path": "本地相对路径", "public": True}],
        "risks": [{"text": "风险检查", "done": False}],
        "tomorrowChallenge": "下一集挑战",
        "lockedDirection": "必须逐字回显服务端锁定方向",
        "lockedDirectionHash": "必须逐字回显服务端方向哈希",
        "directionSource": "必须逐字回显方向权限来源",
    }
    lock_instruction = (
        f"本次方向已经锁定为“{locked_direction}”；mainTopic 必须逐字等于它，任何段落都不得换题。"
        if locked_direction
        else "本次方向来自服务端已锁定的 topic_plan，不得在成稿阶段重新选题。"
    )
    system = f"""你是个人AI实践账号的总编和短视频口播编导。{lock_instruction} 观众来听的是“普通人怎样使用AI得到一个具体结果”，不是创作者写代码、建接口、看Git或汇报项目进度。每条内容先用最终效果、前后对比或真实结果建立观看理由，再解释给AI什么输入、AI第一版做成什么、哪里有问题、如何用自然语言具体返修，以及什么仍需人工判断。代码和系统开发只能作为幕后证据，除非本集受众明确要学编程。只根据提供的真实证据写内容，不得虚构完成项、错误、数据、热点、粉丝反馈、评论或投票结果。Content Strategist 已确认的 audience、viewerBenefit、testableQuestion、weaknesses、uncertainties 和证据边界必须进入内容判断，但它不授权换题或杜撰。输出必须是单个JSON对象，不要Markdown。语言自然、口语化，像和一个具体的人对话，不用新闻播音腔。可以复用高表现内容的问题顺序、证据位置、视觉节奏和信息交付方式，但绝不能复刻别人的措辞、案例、标题、画面或人设。"""
    user = f"""日期：{today}
成长天数：Day {day_number}

内容风格规则：
{json.dumps(content_style, ensure_ascii=False, indent=2)}

当前已核对、可按相关性选用的热梗：
{json.dumps(active_memes, ensure_ascii=False, indent=2)}

真实证据：
{json.dumps(evidence, ensure_ascii=False, indent=2)}

Content Strategist 已确认的分析上下文：
{json.dumps(strategy_artifact, ensure_ascii=False, indent=2)}

已经锁定的AI选题规划：
{json.dumps(topic_plan, ensure_ascii=False, indent=2)}

本次同题抖音研究包：
{json.dumps(reference_research, ensure_ascii=False, indent=2)}

已有内容标题（避免重复）：
{json.dumps(payload.get('existing_topics', []), ensure_ascii=False)}

请生成完整口播拍摄包。必须严格包含以下JSON字段结构，可增加字段但不能缺字段：
{json.dumps(schema, ensure_ascii=False, indent=2)}

硬性要求：
1. {lock_instruction} 主选题必须明确属于AI工具、AI方法、AI项目、AI工作流、AI学习或AI能力边界。topic_plan 是主线，个人进度只能作为案例和证据，不能把Day编号、代码量、Git状态或泛成长感悟当成主题。
2. 选题必须从普通人的AI使用场景出发：原来做不到或效果普通 → 给AI什么素材与目标 → 第一版结果 → 具体反馈和迭代 → 可见结果与边界。不得把开发文件、代码实现、Git记录、接口或安装过程写成正文主线。
3. 完整版固定为2—3分钟、550—950个有效字符、7—12段；默认拍摄完整版。只选 evidence-story 或 saveable-map：前者写2—4个框架项，后者写3—5个框架项。shortScript 是60—90秒衍生稿，必须比完整版短且信息闭环。
4. 开头0—8秒必须先展示成片效果、前后对比或其他真实结果证据，再承诺本集会拆解如何用AI做到；不能先自我介绍、解释项目背景或罗列工具。resultFirstProof 和 shooting.openingProof 必须可实际拍摄/剪辑。若 topic_plan.productionMode 是 self-demonstrating-final-video，可以把“观众正在看的最终成片”作为证据并按成片状态说话，不要在开头插入“测试素材、尚未验证”削弱钩子；但 resultFirstProof.publicationCondition 必须规定只有实际渲染出所述效果并人工审核后才能发布。
5. shooting.visualBeats 至少4项，每个关键步骤都对应真实界面、输入、第一版结果、修改前后或最终成片，不允许整条视频只有口播和字幕。
6. saveableFramework 每项必须包含具体 action 与执行后可观察的 expectedSignal。禁止写“提升认知、保持坚持、拥抱AI”这类无法验证的口号。
7. 完整稿只使用 evidence-story 或 saveable-map：前者用个人经历证明方法，后者让观众定位当前阶段；两种结构都要写清 personalVariation 和 boundary。
8. 个人经历只作为真实案例，至少三次把经验翻译成观众可以执行的判断或动作。工具可以用“指挥、理解视频、生成动效”等角色化人话解释，不讲源码和内部文件。
9. engagement.commentPrompt、followPromise、viewerTask 都要写清策划意图。选择其中最适合本集的一个主动作，改写成 engagement.primaryClose，并让 primaryClose 自然进入 fullSegments 最后一段和 shortScript。不要把三个字段逐句原样连在结尾。
10. commentPrompt 必须是容易回答的具体问题；followPromise 只承诺已有计划支持的下一次验证；viewerTask 必须今天能做、不要求完美或公开。
11. 2—3分钟稿件自然放2—3个轻松点或反差，但只能有一个主热梗，不能连续抖包袱。
12. 热梗只在确实贴合冲突时使用，写入 creativeTone.trendMeme；不得大段照搬、不得虚构来源、不得把热度数字写入口播。
13. 不得自行增加证据中没有的拍摄遍数、耗时、播放量、结果或“明天一定发布”等承诺。self-demonstrating-final-video 模式允许使用“你现在看到的效果就是AI剪的”这类只有在最终成片中才成立的自证表达，但必须附带可执行的发布条件；如果最终成片没有真实呈现这些效果，就禁止发布或必须改稿，不能靠口头声称成功。
14. titles 3个；covers 3个；candidates 最多5个。证据不足时明确写“今天不建议发布”，不要编造。
15. 只能使用 reference_research.fullContentSources 中完成全文核验的来源来概括视频结构和知识。metadataOnlySources 只能用于发现选题和评论问题，不能假装看过完整视频。
16. referenceResearch.sourceIds 至少记录1条实际使用的完整来源，并必须包含 topic_plan.requiredSourceIds 中用户明确指定的来源；至少提炼2条知识、2个结构选择和1个互动/收藏设计。全部用自己的话重组，并用本人的真实进度、证据和限制形成原创版本。
"""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    result = call_json(messages, temperature=0.4, max_tokens=10000)
    def direction_issues(data: dict[str, Any]) -> list[str]:
        if not locked_direction:
            return []
        output = []
        if str(data.get("mainTopic") or "").strip() != locked_direction:
            output.append("mainTopic 更改了服务端锁定方向")
        if str(data.get("lockedDirection") or locked_direction).strip() != locked_direction:
            output.append("lockedDirection 与服务端锁定方向不一致")
        if str(data.get("lockedDirectionHash") or locked_direction_hash).strip() != locked_direction_hash:
            output.append("lockedDirectionHash 与服务端锁定哈希不一致")
        if str(data.get("directionSource") or direction_source).strip() != direction_source:
            output.append("directionSource 更改了方向权限来源")
        return output

    issues = (
        structure_issues(result.get("data", {}))
        + duration_issues(result.get("data", {}))
        + ai_relevance_issues(result.get("data", {}), topic_plan)
        + viewer_use_case_issues(result.get("data", {}), topic_plan)
        + reference_issues(result.get("data", {}), reference_research, topic_plan)
        + engagement_issues(result.get("data", {}), content_style)
        + factual_issues(result.get("data", {}), evidence)
        + direction_issues(result.get("data", {}))
    )
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

        请在不增加任何新事实的前提下重写完整JSON。{lock_instruction} mainTopic 必须逐字等于服务端锁定方向；Content Strategist 已确认的受众、观众收益、核心问题、弱点、不确定性和证据边界必须被保留。主线必须是普通观众如何使用AI得到具体结果，开头0—8秒先展示成片效果或前后对比，然后再解释输入、第一版、具体返修、结果和边界；删除文件名、Git、代码量和内部实现汇报。若topic_plan.productionMode为self-demonstrating-final-video，让最终Day 2成片本身承担结果证据，不要用“测试素材、真人待验证”拆掉开头钩子；改为填写严格的publicationCondition，只有最终渲染和人工审核确认画面真实具备所述效果时才允许发布。完整版必须达到2—3分钟、550—950个有效字符并拆成7—12段。证据写着尚未拍摄或发布时，不能虚构拍摄遍数、耗时或发布结果。只能把reference_research.fullContentSources中的全文核验来源写入referenceResearch.sourceIds，并包含topic_plan.requiredSourceIds；外部知识和结构全部重新组织，不复制原句或画面。resultFirstProof与shooting.openingProof必须具体，shooting.visualBeats至少4项。保持一个核心问题和一种主结构，让每个框架项都有动作与可观察信号。engagement.commentPrompt、followPromise、viewerTask 只作为策划意图，从中选一个主动作改写为 primaryClose，自然放进两个版本结尾，不要把三句逐字连念。creativeTone.humorBeat 至少自然进入一个口播版本；如选择热梗，也要让 creativeTone.trendMeme.adaptedLine 自然进入正文，并修复所有门禁问题。"""
        result = call_json(messages + [{"role": "assistant", "content": json.dumps(result.get("data", {}), ensure_ascii=False)}, {"role": "user", "content": repair}], temperature=0.15, max_tokens=10000)
        issues = (
            structure_issues(result.get("data", {}))
            + duration_issues(result.get("data", {}))
            + ai_relevance_issues(result.get("data", {}), topic_plan)
            + viewer_use_case_issues(result.get("data", {}), topic_plan)
            + reference_issues(result.get("data", {}), reference_research, topic_plan)
            + engagement_issues(result.get("data", {}), content_style)
            + factual_issues(result.get("data", {}), evidence)
            + direction_issues(result.get("data", {}))
        )
    if issues:
        raise RuntimeError("内容质量与事实一致性门禁未通过：" + "；".join(issues))
    data = result.get("data") if isinstance(result.get("data"), dict) else {}
    if locked_direction:
        data["lockedDirection"] = locked_direction
        data["lockedDirectionHash"] = locked_direction_hash
        data["directionSource"] = direction_source
        result["data"] = data
    result["quality_revision"] = {
        "repaired": repair_attempts > 0,
        "repair_attempts": repair_attempts,
        "initial_issues": initial_issues,
        "structural_fixes": [],
    }
    return result


def edit_plan(payload: dict[str, Any], feedback: str | None = None) -> dict[str, Any]:
    transcript = payload.get("transcript", {})
    base_plan = payload.get("base_plan", {})
    compact_transcript = {
        "text": transcript.get("text", ""),
        "segments": [
            {"start": item.get("start"), "end": item.get("end"), "text": item.get("text", "")}
            for item in transcript.get("segments", [])
            if isinstance(item, dict)
        ],
        "lowConfidenceWords": [
            {"word": item.get("word", ""), "start": item.get("start"), "end": item.get("end"), "probability": item.get("probability")}
            for item in transcript.get("words", [])
            if isinstance(item, dict) and float(item.get("probability") or 0) < 0.62
        ],
    }
    system = """你是短视频口播剪辑导演。根据逐字转录、停顿检测、原口播目标、内容包中的结果先行视觉设计和用户反馈，生成保守但有明确视觉节奏的剪辑JSON。不得改动事实，不得凭空添加说过的话。优先删除假启动、重复、口头禅和明显错句；保留自然情绪和必要停顿。视觉设计必须优先使用真人原片衍生画面、真实工作台或项目录屏、同一片段前后对比、局部放大、动态流程图以及必要的AI生成视觉；纯文字卡片只能承担标题、重点和转场，不能作为主要B-roll。开头0—8秒优先直接展示真实成片效果或前后对比，再用少量动态文字说明结果。正文只在关键步骤、证据、第一版问题和结论处安排视觉节点，不能把每句话都包装成特效。所有时间必须引用源视频秒数。只输出JSON。"""
    schema = {
        "keepSegments": [{"start": 0.0, "end": 5.0, "reason": "保留原因"}],
        "overlayCards": [{"start": 1.0, "end": 3.5, "text": "不超过14字", "kind": "hook|evidence|result|lesson", "items": ["最多4条短要点"], "display": "banner|side-panel"}],
        "coverDesign": {"eyebrow": "身份或场景，不超过12字", "lines": ["2到3行具体主题大字"], "highlights": ["需要黄色强调的原文片段"], "features": ["2到4个能力词"]},
        "visualStrategy": {"opening": "开头结果证明策略", "rhythm": "正文视觉节奏", "boundary": "不该过度包装的部分"},
        "subtitleStyle": "bold-clean",
        "editSummary": "剪辑策略摘要",
        "removedReasons": ["删除原因"],
        "confidence": 0.8,
    }
    user = f"""目标口播稿：\n{payload.get('script', '')}\n\n内容包中的结果证明与视觉设计：\n{json.dumps(payload.get('content_direction', {}), ensure_ascii=False, indent=2)}\n\n源视频信息：\n{json.dumps(payload.get('source', {}), ensure_ascii=False)}\n\n停顿检测与基础保留区间：\n{json.dumps(base_plan, ensure_ascii=False)}\n\n逐字转录（按句时间轴，另列低置信词）：\n{json.dumps(compact_transcript, ensure_ascii=False)}\n\n用户最终审核反馈：\n{feedback or '无，这是第一次自动剪辑'}\n\n当前任务的可编辑阶段提示词：\n{str(payload.get('custom_prompt') or '')[:24000]}\n\n输出结构：\n{json.dumps(schema, ensure_ascii=False, indent=2)}\n\n约束：keepSegments 按时间升序、不重叠，每段至少0.35秒；除非存在大量重复，不得删除超过原片55%；overlayCards 使用3—6个，只放最重要的结果钩子、工具分工、关键步骤、第一版问题和最终经验，优先保证开头8秒内有一张 hook 或 result 卡。视觉节点中至少80%必须可实现为真实原片衍生画面、工作台或项目画面、前后对比、局部放大、动态流程或AI生成视觉；纯文字卡不得成为正文主体。只有出现步骤、清单或并列结构时才填写2—4条 items并使用side-panel，其余卡片使用banner且items为空；每条item不超过14字。不要照抄参考博主的画面，应根据当前口播和content_direction重新设计。coverDesign 必须让用户在主页缩略图上一眼看懂视频讲什么：lines 只写具体主题，不写“快来看”“太强了”等空泛钩子，共2到3行、单行尽量不超过9个汉字；highlights 必须是 lines 中的原文；features 只列视频明确展示的能力。结尾出现导演交流、现场提示或重复补录时，应只保留完整且自然的一版。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.2, max_tokens=10000)
    plan = result.get("data")
    if not isinstance(plan, dict) or not isinstance(plan.get("keepSegments"), list):
        raise RuntimeError("文本模型返回的内容不是剪辑计划，请检查 OPENAI_BASE_URL 是否指向 OpenAI 兼容 API（通常以 /v1 结尾）")
    return result


def analyze_visual_style(payload: dict[str, Any]) -> dict[str, Any]:
    schema = {
        "summary": "目标视频视觉风格的一句话总结",
        "selectedReferences": [
            {
                "sourceId": "来源ID",
                "creatorName": "创作者公开名称",
                "workTitle": "作品标题",
                "sourceUrl": "原链接",
                "evidenceLevel": "完整视频/关键帧/仅元数据",
                "selectionReason": "为什么适合本条口播",
            }
        ],
        "analysis": {
            "aspectRatioAndComposition": "比例与构图",
            "subjectPosition": "人物主体位置",
            "captionsAndCards": "字幕与信息卡位置",
            "motionOrder": ["动效先后顺序"],
            "hierarchy": "标题、摘要、事实卡和图表层级",
            "colorSystem": "颜色系统",
            "pacing": "节奏快慢",
            "copyAndAvoid": "值得借鉴与不应照搬的边界",
        },
        "packagingRules": {
            "layout": "可复用画布规则",
            "title": "主标题规则",
            "summary": "摘要条规则",
            "facts": "事实卡规则",
            "rightVisual": "人物与右侧视觉规则",
            "captions": "字幕独立轨规则",
            "motion": ["可复用动效语法"],
            "copy": ["值得吸收的元素"],
            "avoid": ["不适合照搬的元素"],
        },
        "palette": {
            "background": "#07090F",
            "surface": "#111621",
            "primary": "#FF6A3D",
            "secondary": "#55D6FF",
            "warning": "#FFD166",
            "text": "#F7F9FC",
            "muted": "#9FA9B8",
        },
    }
    system = """你是短视频视觉导演。你只能根据提供的完整视频研究、可见关键帧、转录和公开元数据判断，不得把仅有标题或播放数据的候选伪装成看过完整视频。提炼的是构图、信息层级、动效语法和节奏，不复制创作者文案、标题、人设、案例和标志性画面。输出单个JSON对象，不要Markdown。"""
    user = f"""本条口播主题和个人内容背景：
{json.dumps(payload.get('topic', {}), ensure_ascii=False, indent=2)}

候选与已核验参考视频：
{json.dumps(payload.get('references', []), ensure_ascii=False, indent=2)[:50000]}

用户可编辑阶段提示词：
{str(payload.get('custom_prompt') or '')[:24000]}

默认视觉约束：
{json.dumps(payload.get('visual_defaults', {}), ensure_ascii=False, indent=2)}

请严格按以下结构输出：
{json.dumps(schema, ensure_ascii=False, indent=2)}

至少选择1条证据级别足以支撑视觉分析的参考；若实时搜索只有元数据，必须明确降级并优先使用已核验参考库。分析必须覆盖比例构图、人物位置、字幕和信息卡、动效顺序、信息层级、颜色、节奏以及借鉴/禁抄边界。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.15, max_tokens=8000)
    if not isinstance(result.get("data"), dict):
        raise RuntimeError("视觉风格分析没有返回JSON对象")
    return result


def content_breakdown(payload: dict[str, Any]) -> dict[str, Any]:
    transcript = payload.get("transcript", {}) if isinstance(payload.get("transcript"), dict) else {}
    compact_transcript = {
        "text": str(transcript.get("text") or "")[:50000],
        "segments": [
            {"start": item.get("start"), "end": item.get("end"), "text": item.get("text", "")}
            for item in transcript.get("segments", [])[:300]
            if isinstance(item, dict)
        ],
    }
    schema = {
        "summary": "整条口播内容结构摘要",
        "segments": [
            {
                "id": "S01",
                "sourceTime": {"start": 0.0, "end": 18.0},
                "editedTime": {"start": 0.0, "end": 16.5},
                "gist": "这一段口播的大意",
                "upperLeftTitle": "左上大标题",
                "subtitleOrKeyLine": "副标题或重点句",
                "oneSentenceSummary": "本段真正想表达的一句摘要",
                "factCards": [
                    {"label": "事实卡标签1", "value": "短值1"},
                    {"label": "事实卡标签2", "value": "短值2"},
                    {"label": "事实卡标签3", "value": "短值3"},
                ],
                "rightVisual": {
                    "type": "图表、二维动效或真实证据类型",
                    "description": "具体画面设计",
                    "data": ["真实可用的数据或节点"],
                    "motionOrder": ["本段视觉出现顺序"],
                },
                "referencePackaging": {"pattern": "参考风格报告中的包装方式", "reason": "为什么适合本段"},
            }
        ],
    }
    system = """你是口播内容导演和剪辑导演。只能拆解转录中真实说过的内容，不得补写新事实。字幕呈现说了什么，信息卡提炼这段真正想表达什么，两者绝不能混为一谈。输出单个JSON对象，不要Markdown。"""
    user = f"""原口播目标：
{payload.get('script', '')}

逐字转录：
{json.dumps(compact_transcript, ensure_ascii=False, indent=2)}

已经验证的保留片段与成片时间映射：
{json.dumps(payload.get('timeline', {}), ensure_ascii=False, indent=2)}

视觉风格报告：
{json.dumps(payload.get('style_report', {}), ensure_ascii=False, indent=2)[:30000]}

用户可编辑阶段提示词：
{str(payload.get('custom_prompt') or '')[:24000]}

段数范围：{int(payload.get('minimum_segments') or 5)}—{int(payload.get('maximum_segments') or 12)}。
请严格按以下结构输出：
{json.dumps(schema, ensure_ascii=False, indent=2)}

每段必须有且只有3张事实卡；标题、摘要、重点句和事实卡各司其职，不能机械复述同一句话。sourceTime引用原视频秒数，editedTime引用删减后的成片秒数，并与提供的时间线一致。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.15, max_tokens=14000)
    data = result.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("segments"), list):
        raise RuntimeError("内容拆解没有返回segments数组")
    return result


def keyframe_direction(payload: dict[str, Any]) -> dict[str, Any]:
    count = max(3, min(5, int(payload.get("count") or 4)))
    schema = {
        "rationale": "为什么选择这些信息段",
        "presentation": {
            "showInternalLabels": False,
            "showSafeGuides": False,
        },
        "selectedSegmentIds": ["S01"],
        "frames": [
            {
                "segmentId": "S01",
                "sourceTime": 1.8,
                "purpose": "该帧承担的审核目的",
                "composition": "构图说明",
                "motionBefore": "到达该帧前的动效",
                "motionAfter": "该帧后的动效",
                "validationFocus": "用户应重点检查什么",
                "visualIntent": {
                    "title": "观众实际看到的主标题",
                    "keyLine": "观众实际看到的重点句",
                    "summary": "观众实际看到的一句摘要；允许为空字符串",
                    "factCards": [
                        {"label": "可选辅助标签", "value": "可选辅助信息"}
                    ],
                    "primaryVisual": {
                        "kind": "inherit | hook-contrast | memo-action | copy-prompt",
                        "lines": ["按顺序展示的观众可见短句"],
                        "text": "需要完整展示的可复制正文；不需要时为空字符串",
                        "highlights": ["正文中需要依次强调的原文短语"],
                    },
                },
            }
        ],
        "revisionSummary": "如为返修，说明相对上一版的变化",
    }
    system = """你是短视频关键帧设计师。关键帧必须是未来动态成片的真实落地状态，而不是与时间线无关的海报。保持真人可见，严格保护脸部中轴；使用内容拆解中的信息，不得发明新事实。每帧必须同时输出人类可读的composition说明和机器可执行的visualIntent；composition不能代替visualIntent。用户用引号给出的精确标题、提示词、操作句或其他观众可见文案必须逐字保留，不得同义改写。输出单个JSON对象，不要Markdown。"""
    user = f"""视觉风格报告：
{json.dumps(payload.get('style_report', {}), ensure_ascii=False, indent=2)[:30000]}

内容拆解：
{json.dumps(payload.get('breakdown', {}), ensure_ascii=False, indent=2)[:50000]}

上一版与用户反馈：
{json.dumps(payload.get('previous', {}), ensure_ascii=False, indent=2)[:20000]}
{str(payload.get('feedback') or '')[:8000]}

用户可编辑阶段提示词：
{str(payload.get('custom_prompt') or '')[:24000]}

生成{count}张关键帧，严格按以下结构输出：
{json.dumps(schema, ensure_ascii=False, indent=2)}

presentation控制所有关键帧的观众可见边界。除非用户明确要求制作调试图，否则showInternalLabels和showSafeGuides都必须为false，不得把引擎名、阶段ID、内部状态、人物安全框或制作说明当作成片内容。

visualIntent.factCards是本帧实际显示的辅助事实卡，允许0—3张；空数组表示明确不显示事实卡，不能为了凑格式强行补足三张。内容拆解中的三张事实卡仍可作为语义依据，但主视觉已经表达同一组步骤、对比或完整提示词时，visualIntent.factCards必须减少或置空，禁止左右区域重复同义信息。

primaryVisual.kind只能从inherit、hook-contrast、memo-action、copy-prompt中选择。memo-action的lines必须给出具体操作顺序；copy-prompt的text必须包含完整可复制正文，不能拆成只剩关键词的摘要。上一版已经获得认可且用户没有点名修改的visualIntent必须保留；用户反馈中的精确引用优先级高于上一版改写文案。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.2, max_tokens=9000)
    if not isinstance(result.get("data"), dict):
        raise RuntimeError("关键帧导演方案没有返回JSON对象")
    return result


def motion_sample_direction(payload: dict[str, Any]) -> dict[str, Any]:
    schema = {
        "sampleStart": 0.0,
        "sampleEnd": 20.0,
        "sampleDuration": 20.0,
        "strongestSegmentId": "S01",
        "rhythm": "整体节奏说明",
        "choreography": [
            {"order": 1, "at": 0.15, "element": "主标题", "action": "从左上进入", "easing": "power4.out", "purpose": "先建立主题"}
        ],
    }
    system = """你是HyperFrames动效导演。所有动效必须可寻址、可复现，并服务于口播信息层级。已批准关键帧结果的顶层presentation和每帧visualIntent是观众可见内容的绑定合同，不得重新解释、补写或改写；你只负责增加时间、缓动、镜头运动和转场。禁止所有元素同时出现；禁止为了炫技遮挡人物或打断语义。输出单个JSON对象，不要Markdown。"""
    user = f"""已批准关键帧：
{json.dumps(payload.get('keyframes', {}), ensure_ascii=False, indent=2)[:30000]}

内容拆解：
{json.dumps(payload.get('breakdown', {}), ensure_ascii=False, indent=2)[:45000]}

风格报告：
{json.dumps(payload.get('style_report', {}), ensure_ascii=False, indent=2)[:25000]}

样片设置：
{json.dumps(payload.get('settings', {}), ensure_ascii=False, indent=2)}

用户反馈：
{str(payload.get('feedback') or '')[:8000]}

用户可编辑阶段提示词：
{str(payload.get('custom_prompt') or '')[:24000]}

严格按以下结构输出：
{json.dumps(schema, ensure_ascii=False, indent=2)}

样片必须为15—25秒。全局原样继承已批准关键帧结果的presentation，并按segmentId逐项继承frames中的visualIntent：不得恢复内部标签、安全框或已经删除的事实卡；visualIntent.factCards允许0—3张，样片事实卡数量必须与对应数组长度完全一致，空数组就保持不显示。用户标为精确引用的观众可见文案必须逐字保留；copy-prompt的完整text不得压缩成关键词，memo-action的lines不得改写或打乱。只为已批准元素增加出现时间、缓动、镜头运动和转场；保持lines、factCards和highlights各自的数组内部顺序，字段为空时不得新增占位元素。可以吸收推拉、弹出、淡入和数字变化的节奏，但不能复制参考视频画面。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.2, max_tokens=9000)
    if not isinstance(result.get("data"), dict):
        raise RuntimeError("动态样片导演方案没有返回JSON对象")
    return result


def full_video_direction(payload: dict[str, Any]) -> dict[str, Any]:
    schema = {
        "globalRules": ["全片统一规则"],
        "segmentMotion": [
            {
                "segmentId": "S01",
                "visualMode": "本段视觉类型",
                "titleAt": 0.08,
                "summaryAt": 0.85,
                "factsAt": [],
                "visualAt": 4.2,
                "transition": "进入下一段的方式",
                "reason": "为什么这样安排",
            }
        ],
        "qaExpectations": ["最终QA检查项"],
    }
    system = """你是完整口播视频总导演。把已批准风格、关键帧和动态样片扩展到全片，但不能把一个模板机械重复到每段。已批准关键帧结果的顶层presentation是全局绑定合同，每帧visualIntent是对应segmentId的绑定合同；全片只能继承并安排其时间、运动和转场，不得恢复被隐藏或删除的观众可见元素，也不得改写精确引用。字幕与信息卡分轨，只使用真实口播和已批准素材；不得伪造效果、数据或来源。输出单个JSON对象，不要Markdown。"""
    user = f"""视觉风格报告：
{json.dumps(payload.get('style_report', {}), ensure_ascii=False, indent=2)[:25000]}

内容拆解：
{json.dumps(payload.get('breakdown', {}), ensure_ascii=False, indent=2)[:60000]}

已批准关键帧：
{json.dumps(payload.get('keyframes', {}), ensure_ascii=False, indent=2)[:25000]}

已批准动态样片方案：
{json.dumps(payload.get('sample_direction', {}), ensure_ascii=False, indent=2)[:20000]}

最终渲染设置：
{json.dumps(payload.get('settings', {}), ensure_ascii=False, indent=2)}

用户可编辑阶段提示词：
{str(payload.get('custom_prompt') or '')[:24000]}

严格按以下结构输出：
{json.dumps(schema, ensure_ascii=False, indent=2)}

每个内容段都必须有一条segmentMotion。全局原样继承已批准关键帧结果的presentation；凡segmentId对应已批准关键帧，必须原样继承对应frame的visualIntent，并延续已批准样片的时间与运动语法。factsAt的项目数必须与对应visualIntent.factCards的项目数完全一致（0—3），不得把0、1或2张事实卡补足到3张。用户标为精确引用的文案必须逐字保留；copy-prompt必须继续展示完整可复制text，不能压缩成关键词，memo-action的lines不得改写或打乱。没有对应关键帧的内容段可以按内容选择对比、流程、提示词窗口、QA扫描、图表或真实证据，但仍须遵守同一presentation边界和观众可见内容原则。全片保持同一颜色、字体、构图和安全区。最终目标为2K母版，必须列出技术QA、信息层级、人物遮挡、素材实际合成与来源署名检查。"""
    result = call_json([{"role": "system", "content": system}, {"role": "user", "content": user}], temperature=0.18, max_tokens=14000)
    if not isinstance(result.get("data"), dict):
        raise RuntimeError("完整视频导演方案没有返回JSON对象")
    return result


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
            _, model = load_text_model()
            result = {"success": True, "model": model, "transcription_model": "faster-whisper/small"}
        elif operation == "plan_topic":
            result = {"success": True, **plan_topic(payload)}
        elif operation == "analyze_reference":
            result = {"success": True, **analyze_reference(payload)}
        elif operation == "generate_content":
            result = {"success": True, **generate_content(payload)}
        elif operation == "edit_plan":
            result = {"success": True, **edit_plan(payload)}
        elif operation == "revise_plan":
            result = {"success": True, **edit_plan(payload, str(payload.get("feedback") or ""))}
        elif operation == "analyze_visual_style":
            result = {"success": True, **analyze_visual_style(payload)}
        elif operation == "content_breakdown":
            result = {"success": True, **content_breakdown(payload)}
        elif operation == "keyframe_direction":
            result = {"success": True, **keyframe_direction(payload)}
        elif operation == "motion_sample_direction":
            result = {"success": True, **motion_sample_direction(payload)}
        elif operation == "full_video_direction":
            result = {"success": True, **full_video_direction(payload)}
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
