import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest import mock
import unittest


ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / "video" / "multi_agent_bridge.py"
BRIDGE_SPEC = importlib.util.spec_from_file_location("koubo_multi_agent_bridge", BRIDGE)
BRIDGE_MODULE = importlib.util.module_from_spec(BRIDGE_SPEC)
assert BRIDGE_SPEC.loader is not None
BRIDGE_SPEC.loader.exec_module(BRIDGE_MODULE)


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

    def test_advisory_roles_receive_specific_non_authoritative_boundaries(self):
        strategist = BRIDGE_MODULE.instructions_for_agent(
            "agent_proposals", "content-strategist"
        )
        self.assertIn("explicit user-locked content direction", strategist)
        self.assertIn("Never invent or replace the topic", strategist)
        self.assertIn("never draft scripts", strategist)
        self.assertIn("never approve, publish, or promote memory", strategist)

        ordinary = BRIDGE_MODULE.instructions_for_agent(
            "agent_critique", "ordinary-viewer-critic"
        )
        self.assertIn("sharp but non-insulting ordinary viewer", ordinary)
        self.assertIn("Do not change the topic", ordinary)
        self.assertIn("perform technical QA", ordinary)
        self.assertIn("predict retention", ordinary)
        self.assertIn("Never claim visual or audio observations", ordinary)

        generic = BRIDGE_MODULE.instructions_for_agent("agent_critique", "blind-critic")
        self.assertEqual(generic, BRIDGE_MODULE.AGENT_INSTRUCTIONS["agent_critique"])

    def test_advisory_roles_reject_out_of_scope_operations_before_fixture_execution(self):
        cases = (
            (
                "content-strategist",
                "agent_critique",
                "agent_proposals",
            ),
            (
                "ordinary-viewer-critic",
                "agent_proposals",
                "agent_critique",
            ),
            (
                "ordinary-viewer-critic",
                "extract_techniques",
                "agent_critique",
            ),
        )
        for agent_id, operation, required_operation in cases:
            with self.subTest(agent_id=agent_id, operation=operation):
                completed, result = run_bridge(
                    {
                        "operation": operation,
                        "agent_id": agent_id,
                        "fixture_response": {"must_not": "execute"},
                    }
                )

                self.assertEqual(completed.returncode, 2)
                self.assertEqual(
                    result,
                    {
                        "success": False,
                        "error": (
                            f"agent {agent_id} only supports operation "
                            f"{required_operation}; received {operation}"
                        ),
                    },
                )
                self.assertNotIn("must_not", json.dumps(result))

    def test_advisory_role_mismatch_does_not_import_or_call_agents_sdk(self):
        original_import = __import__

        def guarded_import(name, *args, **kwargs):
            if name == "agents":
                raise AssertionError("agents SDK must not be imported")
            return original_import(name, *args, **kwargs)

        request = {
            "operation": "agent_critique",
            "agent_id": "content-strategist",
            "prompt": "This prompt must never reach a model.",
        }
        with mock.patch("builtins.__import__", side_effect=guarded_import):
            with self.assertRaisesRegex(
                BRIDGE_MODULE.RequestError,
                "content-strategist only supports operation agent_proposals",
            ):
                BRIDGE_MODULE.dispatch(request)

    def test_existing_generic_roles_keep_proposal_and_critique_compatibility(self):
        cases = (
            ("caption-agent", "agent_proposals"),
            ("blind-critic", "agent_critique"),
        )
        for agent_id, operation in cases:
            with self.subTest(agent_id=agent_id, operation=operation):
                completed, result = run_bridge(
                    {
                        "operation": operation,
                        "agent_id": agent_id,
                        "fixture_response": {"compatible": True},
                    }
                )

                self.assertEqual(completed.returncode, 0)
                self.assertTrue(result["success"])
                self.assertEqual(result["agent_id"], agent_id)
                self.assertEqual(result["result"], {"compatible": True})

        completed, result = run_bridge(
            {
                "operation": "agent_proposals",
                "fixture_response": {"compatible": True},
            }
        )
        self.assertEqual(completed.returncode, 0)
        self.assertEqual(result["agent_id"], "fixture-agent")

    def test_advisory_roles_expose_strict_structured_output_contracts(self):
        strategist_type = BRIDGE_MODULE.advisory_output_type("content-strategist")
        critic_type = BRIDGE_MODULE.advisory_output_type("ordinary-viewer-critic")

        strategist_schema = strategist_type.model_json_schema()
        critic_schema = critic_type.model_json_schema()

        self.assertFalse(strategist_schema["additionalProperties"])
        self.assertFalse(critic_schema["additionalProperties"])
        self.assertEqual(
            set(strategist_schema["properties"]),
            {
                "lockedDirection",
                "directionRestatement",
                "audience",
                "viewerBenefit",
                "strengths",
                "weaknesses",
                "evidence",
                "testableQuestion",
                "principleCitations",
                "recommendation",
                "nextQuestions",
                "status",
                "uncertainties",
            },
        )
        self.assertEqual(
            set(critic_schema["properties"]),
            {
                "sharpConclusion",
                "blockers",
                "viewerValueGap",
                "evidenceGap",
                "minimalFix",
                "viewerDecision",
                "classifications",
            },
        )
        self.assertIsNone(BRIDGE_MODULE.advisory_output_type("caption-agent"))

    def test_agent_tracing_is_disabled_unless_explicitly_opted_in(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(BRIDGE_MODULE.agent_tracing_enabled())
        with mock.patch.dict(
            os.environ, {"KOUBO_AGENT_TRACING_ENABLED": "1"}, clear=True
        ):
            self.assertTrue(BRIDGE_MODULE.agent_tracing_enabled())
        with mock.patch.dict(
            os.environ, {"KOUBO_AGENT_TRACING_ENABLED": "true"}, clear=True
        ):
            self.assertFalse(BRIDGE_MODULE.agent_tracing_enabled())


if __name__ == "__main__":
    unittest.main()
