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
    elif not spoken_text_contains(short_script, primary_close) or not spoken_text_contains(full_close, primary_close):
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
            "primaryClose": "从以上互动意图中选择一个主动作，改写成自然进入两个版本结尾的一句话",
        },
        "structureDesign": {
            "archetype": "evidence-story|saveable-map|short-resonance",
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
    system = """你是个人AI实践成长账号的总编和短视频口播编导。你的首要任务不是汇报创作者今天做了什么，而是把真实经历改写成观众能代入、能执行、愿意收藏或继续验证的内容。只根据提供的真实证据写内容，不得虚构完成项、错误、数据、热点、粉丝反馈、评论或投票结果。输出必须是单个JSON对象，不要Markdown。语言自然、口语化，像和一个具体的人对话，不用新闻播音腔。个人经历只能作为证明观众问题的案例，不能让整篇稿件变成“我做了什么”的流水账。可以复用高表现内容的问题顺序、证据位置和信息交付方式，但绝不能复刻别人的措辞、案例、标题或人设。"""
    user = f"""日期：{today}
成长天数：Day {day_number}

内容风格规则：
{json.dumps(content_style, ensure_ascii=False, indent=2)}

当前已核对、可按相关性选用的热梗：
{json.dumps(active_memes, ensure_ascii=False, indent=2)}

真实证据：
{json.dumps(evidence, ensure_ascii=False, indent=2)}

已有内容标题（避免重复）：
{json.dumps(payload.get('existing_topics', []), ensure_ascii=False)}

请生成完整口播拍摄包。必须严格包含以下JSON字段结构，可增加字段但不能缺字段：
{json.dumps(schema, ensure_ascii=False, indent=2)}

硬性要求：
1. 先锁定一个 coreQuestion，再只选一种结构。有失败、干预和结果证据用 evidence-story；需要梳理先后顺序或阶段判断用 saveable-map；只有一个强共鸣和一个最小动作时用 short-resonance。不要为了显得完整强行写成长稿。
2. evidence-story 的 saveableFramework 写2—4项，完整版5—7段、45—90秒；saveable-map 写3—5项，完整版5—8段、45—120秒；short-resonance 写1—2项，完整版3—5段、20—45秒。shortScript 必须比完整版更短且信息闭环。
3. saveableFramework 每项必须包含具体 action 与执行后可观察的 expectedSignal。禁止写“提升认知、保持坚持、拥抱AI”这类无法验证的口号。
4. 开头优先从观众的困境、选择、损失或反常识切入；身份信息并非必要时，前20字不要以“我”开头。
5. evidence-story 用个人经历证明方法；saveable-map 让观众定位当前阶段；short-resonance 用一句判断完成自我识别。三种结构都要写清 personalVariation 和 boundary。
6. 个人经历只作为真实案例，至少三次把经验翻译成观众可以执行的判断或动作。
7. engagement.commentPrompt、followPromise、viewerTask 都要写清策划意图。选择其中最适合本集的一个主动作，改写成 engagement.primaryClose，并让 primaryClose 自然进入 fullSegments 最后一段和 shortScript。不要把三个字段逐句原样连在结尾。
8. commentPrompt 必须是容易回答的具体问题；followPromise 只承诺已有计划支持的下一次验证；viewerTask 必须今天能做、不要求完美或公开。
9. 45秒以上稿件自然放1—2个轻松点。短共鸣结构不必为了幽默破坏节奏，但仍需给出自然的 humorBeat 备选。
10. 热梗只在确实贴合冲突时使用，写入 creativeTone.trendMeme；不得大段照搬、不得虚构来源、不得把热度数字写入口播。
11. 不得自行增加证据中没有的拍摄遍数、耗时、播放量、结果或“明天一定发布”等承诺。证据写着尚未拍摄/发布时，只能把本条视频描述为准备执行的行动或使用条件句，不能声称已经录了几条、重拍几次或已经发出。
12. titles 3个；covers 3个；candidates 最多5个。证据不足时明确写“今天不建议发布”，不要编造。
"""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    result = call_json(messages, temperature=0.4, max_tokens=10000)
    issues = structure_issues(result.get("data", {})) + engagement_issues(result.get("data", {}), content_style) + factual_issues(result.get("data", {}), evidence)
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

请在不增加任何新事实的前提下重写完整JSON。证据写着尚未拍摄或发布时，绝对不能改写成已经拍完、录了几条、重录几次或已经发布。保持一个核心问题和一种主结构，让每个框架项都有动作与可观察信号。engagement.commentPrompt、followPromise、viewerTask 只作为策划意图，从中选一个主动作改写为 primaryClose，自然放进两个版本结尾，不要把三句逐字连念。creativeTone.humorBeat 至少自然进入一个口播版本；如选择热梗，也要让 creativeTone.trendMeme.adaptedLine 自然进入正文，并修复所有门禁问题。"""
        result = call_json(messages + [{"role": "assistant", "content": json.dumps(result.get("data", {}), ensure_ascii=False)}, {"role": "user", "content": repair}], temperature=0.15, max_tokens=10000)
        issues = structure_issues(result.get("data", {})) + engagement_issues(result.get("data", {}), content_style) + factual_issues(result.get("data", {}), evidence)
    if issues:
        raise RuntimeError("内容质量与事实一致性门禁未通过：" + "；".join(issues))
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
