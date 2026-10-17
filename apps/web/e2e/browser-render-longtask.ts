/**
 * Cross-origin iframe long-task check for the browser render adapter.
 *
 * Starts the real Vite dev server, renders a short 1080p text timeline twice:
 * inline on the page's main thread (baseline), then in a cross-site iframe
 * (localhost parent -> 127.0.0.1 frame: different sites, so Chrome site
 * isolation puts the frame in its own renderer process; ports alone do not). The parent observes
 * long tasks only for the render window. A main-thread render must produce
 * some; the iframe path must produce none on the parent.
 *
 * Run: CHROME_BIN=/usr/bin/google-chrome pnpm --filter @clash/web test:e2e:render-longtask
 */
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  assert,
  findFreePort,
  startViteDevServer,
  stopProcess,
  waitForHttp,
} from "../../../scripts/e2e/harness.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");

const TIMELINE = {
  tracks: [
    {
      id: "titles",
      items: [
        {
          id: "title",
          type: "text",
          text: "Long task probe",
          color: "#ffffff",
          fontSize: 120,
          from: 0,
          durationInFrames: 150,
          properties: { x: 0, y: 0, width: 1, height: 1, opacity: 1 },
        },
      ],
    },
  ],
};

const request = {
  tracks: TIMELINE.tracks,
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 150,
  licenseKey: null,
  allowHtmlInCanvas: false,
};

function hostHtml(frameOrigin: string): string {
  return `<!doctype html><html><body><div id="status">idle</div><script>
window.__lt = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) window.__lt.push(entry.duration);
}).observe({ type: "longtask", buffered: true });
window.startRender = (request) => new Promise((resolve, reject) => {
  window.__lt.length = 0;
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1920px;height:1080px;border:0";
  frame.src = ${JSON.stringify(frameOrigin)} + "/render-frame.html";
  window.addEventListener("message", (event) => {
    if (event.origin !== ${JSON.stringify(frameOrigin)}) return;
    if (event.data.type === "ready")
      frame.contentWindow.postMessage({
        protocol: "clash.timeline-render.v1",
        type: "render",
        parentOrigin: location.origin,
        request,
      }, ${JSON.stringify(frameOrigin)});
    if (event.data.type === "done") resolve(window.__lt.slice());
    if (event.data.type === "error" || event.data.type === "unsupported")
      reject(new Error(event.data.error || event.data.reason));
  });
  document.body.appendChild(frame);
});
</script></body></html>`;
}

async function main() {
  const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
  const vitePort = await findFreePort(5181);
  const vite = startViteDevServer({ webDir, repoRoot, port: vitePort });
  const frameOrigin = `http://127.0.0.1:${vitePort}`;
  const hostPort = await findFreePort(5191);
  const host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(hostHtml(frameOrigin));
  });
  await new Promise<void>((resolve, reject) => {
    host.once("error", reject);
    host.listen(hostPort, "127.0.0.1", resolve);
  });
  try {
    await waitForHttp(`${frameOrigin}/render-frame.html`, "Vite render frame");
    const browser = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: [
        "--enable-unsafe-swiftshader",
        "--use-angle=swiftshader",
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    try {
      const baseline = await browser.newPage();
      await baseline.addInitScript(() => {
        (window as unknown as { __lt: number[] }).__lt = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            (window as unknown as { __lt: number[] }).__lt.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      await baseline.goto(`${frameOrigin}/render-frame.html`);
      await baseline.waitForFunction(
        () => typeof (window as unknown as { __renderTimelineInline?: unknown }).__renderTimelineInline === "function",
      );
      const mainThread = await baseline.evaluate(async (input) => {
        const scope = window as unknown as {
          __lt: number[];
          __renderTimelineInline: (value: unknown) => Promise<Blob>;
        };
        scope.__lt.length = 0;
        await scope.__renderTimelineInline(input);
        return scope.__lt.slice();
      }, request);
      await baseline.close();

      const hosted = await browser.newPage();
      // `localhost` and `127.0.0.1` are different sites. Two ports on one host
      // are the same site and would share the parent's renderer process.
      await hosted.goto(`http://localhost:${hostPort}/`);
      const iframe = await hosted.evaluate(
        (input) =>
          (
            window as unknown as {
              startRender: (value: unknown) => Promise<number[]>;
            }
          ).startRender(input),
        request,
      );
      // Self-check that the frame really is out-of-process (an OOPIF has its
      // own CDP target of type "iframe"); otherwise the numbers prove nothing.
      const cdp = await browser.newBrowserCDPSession();
      const { targetInfos } = (await cdp.send("Target.getTargets")) as {
        targetInfos: { type: string; url: string }[];
      };
      const outOfProcess = targetInfos.some(
        (target) =>
          target.type === "iframe" && target.url.startsWith(frameOrigin),
      );
      await cdp.detach();
      await hosted.close();

      const sum = (values: number[]) =>
        Math.round(values.reduce((total, value) => total + value, 0));
      console.log(
        JSON.stringify(
          {
            timeline: "1920x1080, 150 frames, text only",
            mainThread: {
              longtasks: mainThread.length,
              totalMs: sum(mainThread),
            },
            crossSiteIframe: {
              outOfProcess,
              parentLongtasks: iframe.length,
              totalMs: sum(iframe),
            },
          },
          null,
          2,
        ),
      );
      assert(
        mainThread.length > 0,
        "expected the main-thread baseline to produce a long task",
      );
      assert(outOfProcess, "expected the render frame to be an out-of-process iframe");
      assert(
        iframe.length === 0,
        `expected zero parent long tasks, saw ${iframe.length}`,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await stopProcess(vite.child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
