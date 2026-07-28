import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function safePart(value, fallback = "element") {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
}

export function normalizeCaptureUrl(value, { allowRemote = false } = {}) {
  const url = new URL(String(value || ""));
  const localHttp = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol === "file:" || ((url.protocol === "http:" || url.protocol === "https:") && (localHttp || allowRemote))) return url.href;
  throw new Error("PageCam 默认只允许捕获本机页面；远程页面必须显式 allowRemote");
}

export function normalizeCaptureSpec(value = {}) {
  const width = Math.max(320, Math.min(3840, Math.round(Number(value.width || 1440))));
  const height = Math.max(240, Math.min(2160, Math.round(Number(value.height || 900))));
  const selectors = (Array.isArray(value.selectors) ? value.selectors : []).slice(0, 30).map((item, index) => ({
    id: safePart(item.id, `element-${index + 1}`),
    selector: String(item.selector || "").trim(),
  })).filter(item => item.selector);
  return {
    url: normalizeCaptureUrl(value.url, { allowRemote: value.allowRemote === true }),
    outputDir: path.resolve(String(value.outputDir || "outputs/pagecam")),
    width,
    height,
    deviceScaleFactor: Math.max(1, Math.min(2, Number(value.deviceScaleFactor || 1))),
    selectors,
    waitMs: Math.max(0, Math.min(15000, Number(value.waitMs || 800))),
  };
}

export function findChromeExecutable(env = process.env) {
  const candidates = [
    env.KOUBO_CHROME_PATH,
    path.join(env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(env.PROGRAMFILES || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter(Boolean);
  const executable = candidates.find(candidate => fs.existsSync(candidate));
  if (!executable) throw new Error("未找到 Chrome/Edge；可通过 KOUBO_CHROME_PATH 指定");
  return executable;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function pollJson(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome DevTools 启动超时：${lastError?.message || url}`);
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  const waiters = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result || {});
      return;
    }
    const queue = waiters.get(message.method);
    if (queue?.length) queue.shift()(message.params || {});
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    wait(method, timeoutMs = 10000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
        const wrapped = value => { clearTimeout(timer); resolve(value); };
        const queue = waiters.get(method) || [];
        queue.push(wrapped);
        waiters.set(method, queue);
      });
    },
    close() { socket.close(); },
  };
}

export async function capturePageCam(input, options = {}) {
  const spec = normalizeCaptureSpec(input);
  const chrome = options.chrome || findChromeExecutable();
  const port = await freePort();
  const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "koubo-pagecam-"));
  await fsp.mkdir(path.join(spec.outputDir, "elements"), { recursive: true });
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  let cdp = null;
  try {
    const targets = await pollJson(`http://127.0.0.1:${port}/json/list`);
    const target = targets.find(item => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target) throw new Error("Chrome 没有返回可捕获页面");
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await Promise.all([
      cdp.send("Page.enable"),
      cdp.send("Runtime.enable"),
      cdp.send("Emulation.setDeviceMetricsOverride", { width: spec.width, height: spec.height, deviceScaleFactor: spec.deviceScaleFactor, mobile: false }),
    ]);
    const loaded = cdp.wait("Page.loadEventFired", 15000).catch(() => null);
    await cdp.send("Page.navigate", { url: spec.url });
    await loaded;
    await cdp.send("Runtime.evaluate", { expression: "document.fonts && document.fonts.ready", awaitPromise: true, returnByValue: true });
    if (spec.waitMs) await new Promise(resolve => setTimeout(resolve, spec.waitMs));
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const contentSize = metrics.cssContentSize || metrics.contentSize;
    const full = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
      clip: { x: 0, y: 0, width: Math.max(1, contentSize.width), height: Math.max(1, contentSize.height), scale: 1 },
    });
    const fullPath = path.join(spec.outputDir, "page.png");
    await fsp.writeFile(fullPath, Buffer.from(full.data, "base64"));
    const expression = `(() => {
      const specs = ${JSON.stringify(spec.selectors)};
      return specs.map(spec => {
        const element = document.querySelector(spec.selector);
        if (!element) return { ...spec, found: false };
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { ...spec, found: rect.width > 0 && rect.height > 0, rect: { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height }, text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 500), tag: element.tagName.toLowerCase(), role: element.getAttribute('role') || null, zIndex: style.zIndex, background: style.backgroundColor };
      });
    })()`;
    const evaluated = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    const elements = [];
    for (const item of evaluated.result?.value || []) {
      if (!item.found || !item.rect) { elements.push(item); continue; }
      const clip = {
        x: Math.max(0, item.rect.x),
        y: Math.max(0, item.rect.y),
        width: Math.max(1, item.rect.width),
        height: Math.max(1, item.rect.height),
        scale: 1,
      };
      const captured = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip });
      const relative = path.join("elements", `${safePart(item.id)}.png`);
      await fsp.writeFile(path.join(spec.outputDir, relative), Buffer.from(captured.data, "base64"));
      elements.push({ ...item, image: relative.replaceAll("\\", "/") });
    }
    const layout = {
      schemaVersion: 1,
      sourceUrl: spec.url,
      viewport: { width: spec.width, height: spec.height, deviceScaleFactor: spec.deviceScaleFactor },
      page: { width: contentSize.width, height: contentSize.height, image: "page.png" },
      elements,
      generatedAt: new Date().toISOString(),
      privacy: "local-capture",
    };
    const layoutPath = path.join(spec.outputDir, "layout.json");
    await fsp.writeFile(layoutPath, JSON.stringify(layout, null, 2), "utf8");
    return { ok: true, outputDir: spec.outputDir, pagePath: fullPath, layoutPath, layout };
  } finally {
    try { await cdp?.send("Browser.close"); } catch {}
    cdp?.close();
    if (!child.killed) child.kill();
    try { await fsp.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); } catch {}
  }
}
