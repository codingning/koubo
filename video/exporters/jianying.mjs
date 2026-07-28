import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "jianying_exporter.py");

export function runJianyingExporter(request, options = {}) {
  const python = options.python || process.env.KOUBO_EXPORTER_PYTHON || path.resolve(here, "..", "..", ".runtime-exporters", "Scripts", "python.exe");
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { cwd: options.cwd || path.resolve(here, "..", ".."), windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `剪映导出器退出码 ${code}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`剪映导出器返回无效 JSON：${stdout.slice(0, 500)}`)); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
