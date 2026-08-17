import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("acceptance runner exposes reusable media helpers and only runs as a CLI", async () => {
  const source = await readFile(
    new URL("../../scripts/run_multi_agent_acceptance.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /export\s*\{[\s\S]*renderControl[\s\S]*renderChallenger[\s\S]*qaMedia[\s\S]*createContactSheet[\s\S]*finalizeQa[\s\S]*\}/);
  assert.match(source, /if\s*\(isMainModule\(\)\)\s*\{\s*main\(\)\.catch/);
});
