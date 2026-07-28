import { capturePageCam } from "../video/shots/pagecam.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const url = argument("--url");
const outputDir = argument("--output", "outputs/pagecam");
if (!url) {
  console.error("Usage: node scripts/capture_pagecam.mjs --url http://127.0.0.1:8787 --output outputs/pagecam --selector hero=#hero-topic");
  process.exit(2);
}
const selectors = process.argv.filter(value => value.startsWith("--selector=")).map((value, index) => {
  const pair = value.slice("--selector=".length);
  const split = pair.indexOf("=");
  return split > 0 ? { id: pair.slice(0, split), selector: pair.slice(split + 1) } : { id: `element-${index + 1}`, selector: pair };
});

try {
  const result = await capturePageCam({ url, outputDir, selectors });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
