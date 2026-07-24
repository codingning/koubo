import importlib.util
from pathlib import Path
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "video" / "ai_bridge.py"
SPEC = importlib.util.spec_from_file_location("koubo_ai_bridge_direction_test", BRIDGE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class AiBridgeDirectionLockTests(unittest.TestCase):
    def test_plan_topic_uses_strategist_context_and_rejects_topic_replacement(self):
        captured = []

        def fake_call_json(messages, **_kwargs):
            captured.extend(messages)
            return {
                "data": {
                    "topic": "模型擅自换成的方向",
                    "aiAngle": "AI实践",
                    "viewerUseCase": "普通观众完成一个具体AI动作",
                    "proofOpening": "展示真实前后对比结果",
                    "searchQueries": ["AI实践", "普通人用AI"],
                }
            }

        payload = {
            "locked_direction": "分享我训练一个Agent的真实过程",
            "locked_direction_hash": "hash-locked",
            "direction_source": "explicit_user_direction",
            "strategy_artifact": {
                "analysis": {
                    "audience": "收藏很多方法却没有行动的人",
                    "viewerBenefit": "看懂一次失败怎样变成可复用规则",
                    "testableQuestion": "观众能否完成一个训练动作",
                    "weaknesses": ["容易写成项目汇报"],
                }
            },
            "evidence": {},
            "content_style": {},
            "editorial_brief": {},
            "existing_topics": [],
        }

        with mock.patch.object(MODULE, "call_json", side_effect=fake_call_json):
            with self.assertRaisesRegex(RuntimeError, "更改了用户锁定方向"):
                MODULE.plan_topic(payload)

        prompt = "\n".join(str(item.get("content", "")) for item in captured)
        self.assertIn(payload["locked_direction"], prompt)
        self.assertIn("收藏很多方法却没有行动的人", prompt)
        self.assertIn("容易写成项目汇报", prompt)

    def test_generate_content_preserves_locked_direction_and_strategist_analysis(self):
        captured = []
        locked = "分享我训练一个Agent的真实过程"

        def fake_call_json(messages, **_kwargs):
            captured.extend(messages)
            return {"data": {"mainTopic": locked}}

        payload = {
            "locked_direction": locked,
            "locked_direction_hash": "hash-locked",
            "direction_source": "explicit_user_direction",
            "strategy_artifact": {
                "analysis": {
                    "audience": "知道很多但还没有开始的人",
                    "viewerBenefit": "得到一个今天能执行的动作",
                    "testableQuestion": "是否形成真实行动闭环",
                    "uncertainties": ["单次结果不能证明因果"],
                }
            },
            "topic_plan": {"topic": locked, "lockedDirection": locked},
            "reference_research": {},
            "evidence": {},
            "day_number": 1,
            "date": "2026-07-24",
            "existing_topics": [],
        }

        validators = [
            "structure_issues",
            "duration_issues",
            "ai_relevance_issues",
            "viewer_use_case_issues",
            "reference_issues",
            "engagement_issues",
            "factual_issues",
        ]
        patches = [mock.patch.object(MODULE, name, return_value=[]) for name in validators]
        for item in patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(patches)])

        with mock.patch.object(MODULE, "call_json", side_effect=fake_call_json):
            result = MODULE.generate_content(payload)

        self.assertEqual(result["data"]["mainTopic"], locked)
        self.assertEqual(result["data"]["lockedDirection"], locked)
        self.assertEqual(result["data"]["lockedDirectionHash"], "hash-locked")
        self.assertEqual(result["data"]["directionSource"], "explicit_user_direction")
        prompt = "\n".join(str(item.get("content", "")) for item in captured)
        self.assertIn("知道很多但还没有开始的人", prompt)
        self.assertIn("单次结果不能证明因果", prompt)


if __name__ == "__main__":
    unittest.main()
