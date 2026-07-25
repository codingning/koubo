import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "video" / "ai_bridge.py"
WORKFLOW_CONFIG = ROOT / "config" / "video_workflow_v4.json"
SPEC = importlib.util.spec_from_file_location("koubo_ai_bridge_motion_contract_test", BRIDGE)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


CANONICAL_TARGETS = (
    "title",
    "key-line",
    "summary",
    "facts",
    "fact-1",
    "fact-2",
    "fact-3",
    "visual",
    "speaker",
)

ACTION_PRESETS = (
    "fade",
    "fade-up",
    "slide-left",
    "slide-right",
    "pop",
    "push-in",
    "reveal-right",
)


class MotionSampleDirectionContractTests(unittest.TestCase):
    def test_ai_prompt_exposes_executable_choreography_contract(self):
        captured = []

        def fake_call_json(messages, **_kwargs):
            captured.extend(messages)
            return {
                "data": {
                    "sampleStart": 0,
                    "sampleEnd": 20,
                    "sampleDuration": 20,
                    "strongestSegmentId": "S01",
                    "rhythm": "标题、摘要、事实卡和主视觉依次进入",
                    "choreography": [],
                }
            }

        payload = {
            "keyframes": {
                "presentation": {
                    "showInternalLabels": False,
                    "showSafeGuides": False,
                },
                "frames": [
                    {
                        "segmentId": "S01",
                        "visualIntent": {
                            "title": "只展示批准内容",
                            "summary": "一张事实卡",
                            "factCards": [{"label": "唯一", "value": "真实存在"}],
                            "primaryVisual": {"kind": "inherit"},
                        },
                    }
                ],
            },
            "breakdown": {
                "segments": [
                    {
                        "id": "S01",
                        "editedTime": {"start": 0, "end": 20},
                    }
                ]
            },
            "style_report": {},
            "settings": {"durationSeconds": 20},
        }

        with mock.patch.object(MODULE, "call_json", side_effect=fake_call_json):
            result = MODULE.motion_sample_direction(payload)

        self.assertEqual(result["data"]["sampleDuration"], 20)
        prompt = "\n".join(str(item.get("content", "")) for item in captured)
        for field in ("segmentId", "target", "factIndex", "actionPreset", "easing"):
            self.assertIn(field, prompt)
        for target in CANONICAL_TARGETS:
            self.assertIn(target, prompt)
        for preset in ACTION_PRESETS:
            self.assertIn(preset, prompt)
        self.assertIn("at一律表示相对sampleStart的样片内秒数", prompt)
        self.assertIn("0张事实卡时禁止输出facts或fact-N", prompt)
        self.assertIn("同一segmentId内禁止重复target", prompt)
        self.assertIn("facts与fact-N不能混用", prompt)
        self.assertIn("speaker全样片只能出现一次", prompt)
        self.assertIn("用户反馈或自定义提示词不能授权", prompt)
        self.assertIn("不得输出自定义函数、CSS选择器或可执行代码", prompt)
        self.assertIn("back.out(N)", prompt)

    def test_workflow_config_keeps_fact_count_and_review_gates_truthful(self):
        config = json.loads(WORKFLOW_CONFIG.read_text(encoding="utf-8-sig"))
        motion_order = "\n".join(config["visualDefaults"]["motionOrder"])
        sample_stage = config["stages"]["motion_sample"]
        prompt = sample_stage["prompt"]

        self.assertNotIn("三张事实卡", motion_order)
        self.assertIn("已批准且实际存在的0—3张事实卡", motion_order)
        self.assertIn("已批准且实际存在的0—3张visualIntent.factCards", prompt)
        self.assertIn("相对sampleStart的样片内秒数", prompt)
        for field in ("segmentId", "target", "factIndex", "actionPreset", "easing"):
            self.assertIn(field, prompt)
        for target in CANONICAL_TARGETS:
            self.assertIn(target, prompt)
        for preset in ACTION_PRESETS:
            self.assertIn(preset, prompt)
        self.assertIn("0张事实卡时禁止输出facts或fact-N", prompt)
        self.assertIn("同一segmentId内禁止重复target", prompt)
        self.assertIn("禁止自定义函数、CSS选择器或可执行代码", prompt)

        self.assertEqual(config["execution"]["firstHardGate"], "keyframe_review")
        self.assertEqual(config["execution"]["secondHardGate"], "motion_sample")
        self.assertFalse(config["execution"]["autoPublish"])
        self.assertTrue(config["stages"]["keyframe_review"]["reviewGate"])
        self.assertTrue(sample_stage["reviewGate"])
        self.assertTrue(config["stages"]["full_render"]["reviewGate"])
        self.assertFalse(config["stages"]["full_render"]["settings"]["autoPublish"])


if __name__ == "__main__":
    unittest.main()
