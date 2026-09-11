import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CdpClient,
  capture,
  chromeBinary,
  evaluate,
  findFreePort,
  startViteDevServer,
  stopProcess,
  tail,
  waitFor,
  waitForHttp,
  waitForTarget,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");
const chromeDataDir = path.join(repoRoot, ".tmp", "web-canvas-perf-chrome");
const captureDir = path.join(repoRoot, ".tmp", "web-canvas-perf-captures");
const latestScreenshot = path.join(captureDir, "latest-canvas-perf.png");

function countParam(name: string, fallback: number) {
  const value = Number(process.env[`CANVAS_PERF_${name.toUpperCase()}`]);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

async function startWeb({ webPort }: { webPort: number }) {
  return startViteDevServer({ webDir, repoRoot, port: webPort });
}

async function main() {
  await rm(chromeDataDir, { recursive: true, force: true });
  await mkdir(captureDir, { recursive: true });

  const webPort = await findFreePort(50050);
  const cdpPort = await findFreePort(50100);
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const params = new URLSearchParams({
    groups: String(countParam("groups", 90)),
    images: String(countParam("images", 1100)),
    texts: String(countParam("texts", 520)),
    actions: String(countParam("actions", 320)),
  });
  if (process.env.CANVAS_PERF_LEGACY_MEDIA === "1") {
    params.set("legacyMedia", "1");
  }
  if (process.env.CANVAS_PERF_LEGACY_ACTION_EDGES === "1") {
    params.set("legacyActionEdges", "1");
  }
  if (process.env.CANVAS_PERF_ONLY_VISIBLE === "1") {
    params.set("onlyVisible", "1");
  }
  if (process.env.CANVAS_PERF_FIT === "0") {
    params.set("fit", "0");
  }

  const { child: web, logs: webLogs } = await startWeb({ webPort });
  const chromeLogs: string[] = [];
  let chrome;
  let cdp;

  try {
    await waitForHttp(webOrigin, "Vite web server");
    chrome = spawn(chromeBinary(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${chromeDataDir}`,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-renderer-backgrounding",
      "--window-size=1600,1100",
      "about:blank",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    chrome.stdout.on("data", (buf) => chromeLogs.push(String(buf)));
    chrome.stderr.on("data", (buf) => chromeLogs.push(String(buf)));

    cdp = new CdpClient(await waitForTarget(cdpPort));
    await cdp.ready();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${webOrigin}/__canvas-perf?${params}` });

    await waitFor(
      cdp,
      `window.__canvasPerf?.ready === true`,
      "canvas perf metrics",
      120000,
    );

    const metrics = await evaluate(cdp, "window.__canvasPerf", { timeoutMs: 5000 });
    await capture(cdp, latestScreenshot);
    console.log("[canvas-perf] metrics", JSON.stringify(metrics));
    console.log(`[canvas-perf] screenshot ${latestScreenshot}`);
  } catch (error) {
    process.exitCode = 1;
    console.error("[canvas-perf] caught", error instanceof Error ? error.stack ?? error.message : error);
    if (cdp) {
      try {
        await capture(cdp, latestScreenshot);
        console.error(`[canvas-perf] failure screenshot ${latestScreenshot}`);
      } catch {
        // Ignore capture failure while unwinding.
      }
    }
    console.error("[canvas-perf] web logs\n", tail(webLogs));
    console.error("[canvas-perf] chrome logs\n", tail(chromeLogs));
  } finally {
    cdp?.close();
    await stopProcess(chrome);
    await stopProcess(web);
  }
}

await main();
