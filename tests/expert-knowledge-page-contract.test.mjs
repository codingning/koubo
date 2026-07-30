import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => fs.readFileSync(path.join(root, relativePath), "utf8");

test("workbench exposes a read-only expert knowledge page with filters and provenance details", () => {
  const html = read("web/index.html");
  const app = read("web/app.js");
  const css = read("web/styles.css");

  for (const marker of [
    'data-view="expert-library"',
    'id="view-expert-library"',
    'id="expert-library-search"',
    'id="expert-library-domain"',
    'id="expert-library-status"',
    'id="expert-library-usage"',
    'id="expert-library-records"',
  ]) assert.equal(html.includes(marker), true, marker);

  assert.equal(app.includes("/api/multi-agent/knowledge-library"), true);
  assert.equal(app.includes("查看本页不会改变任何状态"), true);
  assert.equal(app.includes("record.defaultCallable"), false, "client must display server authority instead of recalculating it");
  assert.equal(css.includes(".expert-library-layout"), true);
  assert.equal(css.includes(".expert-knowledge-card.status-trial"), true);
});
