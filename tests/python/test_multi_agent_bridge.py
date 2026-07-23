import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "video" / "multi_agent_bridge.py"


def run_bridge(request):
    with tempfile.TemporaryDirectory(prefix="koubo-bridge-") as directory:
        root = Path(directory)
        request_file = root / "request.json"
        response_file = root / "response.json"
        request_file.write_text(json.dumps(request), encoding="utf-8")
        environment = os.environ.copy()
        environment["OPENAI_API_KEY"] = "environment-secret-must-not-survive"
        completed = subprocess.run(
            [
                sys.executable,
                str(BRIDGE),
                "--request",
                str(request_file),
                "--response",
                str(response_file),
            ],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if not response_file.exists():
            raise AssertionError(
                f"bridge did not create a response; exit={completed.returncode}, "
                f"stderr={completed.stderr}"
            )
        return completed, json.loads(response_file.read_text(encoding="utf-8"))


class MultiAgentBridgeTests(unittest.TestCase):
    def test_config_reports_pinned_components_without_secrets(self):
        completed, result = run_bridge(
            {"operation": "config", "api_key": "request-secret-must-not-survive"}
        )

        self.assertEqual(completed.returncode, 0)
        self.assertTrue(result["success"])
        self.assertEqual(result["agents_sdk"], "0.18.3")
        self.assertEqual(result["scenedetect"], "0.7.1")
        self.assertEqual(
            result["operations"],
            [
                "agent_critique",
                "agent_proposals",
                "config",
                "detect_scenes",
                "extract_techniques",
            ],
        )
        serialized = json.dumps(result)
        self.assertNotIn("request-secret-must-not-survive", serialized)
        self.assertNotIn("environment-secret-must-not-survive", serialized)

    def test_unknown_operation_is_a_structured_failure(self):
        completed, result = run_bridge({"operation": "publish_video"})

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(
            result,
            {"success": False, "error": "unsupported operation: publish_video"},
        )

    def test_offline_fixture_agent_result_is_structured_and_redacted(self):
        completed, result = run_bridge(
            {
                "operation": "agent_proposals",
                "agent_id": "caption-agent",
                "fixture_response": {
                    "proposals": [{"primitive": "caption-pop", "score": 0.81}],
                    "access_token": "nested-secret",
                },
            }
        )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(result["success"], True)
        self.assertEqual(result["operation"], "agent_proposals")
        self.assertEqual(
            result["result"]["proposals"],
            [{"primitive": "caption-pop", "score": 0.81}],
        )
        self.assertNotIn("nested-secret", json.dumps(result))

    def test_fixture_scene_detection_is_normalized_without_media_access(self):
        completed, result = run_bridge(
            {
                "operation": "detect_scenes",
                "fixture_scenes": [
                    {"start": 0, "end": 1.25},
                    {"start": 1.25, "end": 3.0},
                ],
            }
        )

        self.assertEqual(completed.returncode, 0)
        self.assertEqual(result["scene_count"], 2)
        self.assertEqual(result["scenes"][1]["duration"], 1.75)

    def test_agent_operation_requires_prompt_when_no_fixture_is_injected(self):
        completed, result = run_bridge(
            {"operation": "extract_techniques", "agent_id": "tutorial-ingestor"}
        )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(result["success"], False)
        self.assertEqual(result["error"], "prompt is required")
        self.assertNotIn("Traceback", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
