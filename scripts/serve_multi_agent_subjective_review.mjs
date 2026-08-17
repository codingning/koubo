#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  createSubjectiveReviewServer,
  refreshSubjectiveReviewPage,
} from "../video/multi-agent/subjective-server.mjs";

function parseArguments(argv) {
  const values = { host: "127.0.0.1", port: 8766 };
  const names = new Map([
    ["--run-root", "runRoot"],
    ["--port", "port"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const field = names.get(argv[index]);
    if (!field || !argv[index + 1]) throw new Error(`invalid argument: ${argv[index]}`);
    values[field] = argv[++index];
  }
  if (!values.runRoot) throw new Error("--run-root is required");
  values.runRoot = path.resolve(values.runRoot);
  values.port = Number(values.port);
  if (!Number.isInteger(values.port) || values.port < 1024 || values.port > 65535) {
    throw new Error("--port must be between 1024 and 65535");
  }
  if (!fs.existsSync(path.join(values.runRoot, "subjective-manifest.json"))
    || !fs.existsSync(path.join(values.runRoot, "review", "index.html"))) {
    throw new Error("subjective review run is incomplete");
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await refreshSubjectiveReviewPage({ runRoot: args.runRoot });
  const server = createSubjectiveReviewServer({ runRoot: args.runRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, resolve);
  });
  process.stdout.write(`${JSON.stringify({
    success: true,
    host: args.host,
    port: args.port,
    url: `http://${args.host}:${args.port}/index.html`,
    runRoot: args.runRoot,
    localOnly: true,
    productionApproval: false,
    autoPublish: false,
    memoryPromotion: false,
  })}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch(error => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
