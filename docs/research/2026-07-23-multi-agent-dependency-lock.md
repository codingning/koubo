# Koubo Multi-Agent Dependency Decision

Date: 2026-07-23

Status: accepted for isolated implementation

Scope: local orchestration bridge, evaluation tooling, scene detection, and technique reconstruction

## Decision

Koubo will reuse narrow, replaceable open-source components instead of adopting an
external framework as the product architecture:

| Component | Pinned version | License | Use | Boundary |
| --- | ---: | --- | --- | --- |
| [OpenAI Agents SDK for Python](https://github.com/openai/openai-agents-python) | 0.18.3 | MIT | Bounded specialist calls, tracing-compatible orchestration | Only behind `video/multi_agent_bridge.py`; local SQLite memory remains authoritative |
| [PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | 0.7.1 | BSD-3-Clause | Local tutorial and output scene boundaries | Reads local media; produces time ranges only |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 0.120.0 | MIT | Prompt/contract regression checks | Development-only; pinned below latest because Node 22.20.0 does not satisfy the latest package engine floor |
| [HyperFrames](https://github.com/openai/hyperframes) | 0.7.68 | Apache-2.0 | Sandboxed reconstruction and deterministic rendering | No-network generated project; imported tutorial code is forbidden |

The OpenAI Agents SDK and PySceneDetect top-level pins live in
`requirements-multi-agent.lock.txt`. After installation, the exact resolved
environment is captured in `requirements-multi-agent.resolved.txt`. The runtime is
isolated in `.runtime-multi-agent/` and is never committed.

## GitHub-first review

The review also examined complete editing products such as
[FableCut](https://github.com/linzichun/fablecut). They are useful references for
timeline and caption interaction, but are not adopted as Koubo's memory or
orchestration core because that would replace the validated v4 pipeline and weaken
the required evidence/promotion boundaries.

No reviewed project provides Koubo's required combination of:

- specialist-private local memory;
- inbox-to-promoted evidence gates and explicit rollback;
- blind comparison against frozen v4 outputs;
- a stable brand skeleton with experimentation only in the expression layer.

Those controls therefore remain small project-owned modules. External components
are used only where they are mature and replaceable.

## Compatibility and safety

- Python requirement: 3.10 or newer; the project uses Python 3.13.9.
- Node requirement for the chosen Promptfoo release: Node 20 or newer; the project
  uses Node 22.20.0.
- The bridge allowlists only `config`, `detect_scenes`, `agent_proposals`,
  `agent_critique`, and `extract_techniques`.
- API keys are read only by the SDK from process environment. Request and response
  JSON never contains credentials, and secret-shaped fixture fields are removed.
- Source video is never sent to the model. Scene detection is local; agent calls
  receive only the explicitly prepared text/metadata prompt.
- All versions are replaceable behind the JSON bridge or command wrapper. A future
  upgrade must rerun bridge tests, frozen-baseline evaluation, and license review.
