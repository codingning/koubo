import importlib.util
from pathlib import Path
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "video" / "ai_bridge.py"
SPEC = importlib.util.spec_from_file_location("koubo_ai_bridge_universal_test", BRIDGE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class UniversalProfileTests(unittest.TestCase):
    def test_plan_topic_accepts_a_non_ai_direction_in_universal_mode(self):
        captured = []
        locked = "社区咖啡店开业前应该先验证什么"

        def fake_call_json(messages, **_kwargs):
            captured.extend(messages)
            return {
                "data": {
                    "topic": locked,
                    "shortTopic": "开店前先验证",
                    "aiAngle": "社区咖啡经营假设",
                    "viewerUseCase": "第一次开店的人可以先验证客流、客单和复购假设",
                    "proofOpening": "展示试营业时段记录和真实反馈",
                    "searchQueries": ["社区咖啡店 试营业", "咖啡店 开业 验证"],
                }
            }

        payload = {
            "locked_direction": locked,
            "locked_direction_hash": "hash",
            "direction_source": "explicit_user_direction",
            "platform_profile": {"mode": "universal", "domain": "business", "audience": "第一次开咖啡店的人"},
            "strategy_artifact": {"analysis": {"audience": "第一次开咖啡店的人", "viewerBenefit": "先验证三个经营假设", "testableQuestion": "哪些假设要先验证"}},
            "evidence": {},
            "content_style": {},
            "editorial_brief": {},
            "existing_topics": [],
        }
        with mock.patch.object(MODULE, "call_json", side_effect=fake_call_json):
            result = MODULE.plan_topic(payload)
        self.assertEqual(result["data"]["topic"], locked)
        prompt = "\n".join(str(item.get("content", "")) for item in captured)
        self.assertIn("通用口播平台", prompt)
        self.assertIn("第一次开咖啡店的人", prompt)

    def test_generate_content_skips_ai_only_gates_in_universal_mode(self):
        locked = "社区咖啡店开业前应该先验证什么"
        payload = {
            "locked_direction": locked,
            "locked_direction_hash": "hash",
            "direction_source": "explicit_user_direction",
            "platform_profile": {"mode": "universal", "domain": "business", "audience": "第一次开咖啡店的人", "goal": "验证三个经营假设", "tone": "务实", "durationSeconds": 150},
            "strategy_artifact": {"analysis": {"audience": "第一次开咖啡店的人", "viewerBenefit": "验证经营假设", "testableQuestion": "先验证什么"}},
            "topic_plan": {"topic": locked, "lockedDirection": locked},
            "reference_research": {},
            "reference_distillation": {},
            "evidence": {},
            "day_number": 1,
            "date": "2026-07-28",
            "existing_topics": [],
        }
        common = ["structure_issues", "reference_issues", "engagement_issues", "factual_issues"]
        patches = [mock.patch.object(MODULE, name, return_value=[]) for name in common]
        for item in patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(patches)])
        with mock.patch.object(MODULE, "duration_issues", side_effect=AssertionError("AI duration gate called")), mock.patch.object(MODULE, "ai_relevance_issues", side_effect=AssertionError("AI relevance gate called")), mock.patch.object(MODULE, "viewer_use_case_issues", side_effect=AssertionError("AI use-case gate called")), mock.patch.object(MODULE, "call_json", return_value={"data": {"mainTopic": locked}}):
            result = MODULE.generate_content(payload)
        self.assertEqual(result["data"]["mainTopic"], locked)


if __name__ == "__main__":
    unittest.main()
