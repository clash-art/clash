/**
 * Cross-site iframe long-task check for the Remotion preview host (#435).
 *
 * Renders the same preview the editor renders - an `@remotion/player` `<Player>`
 * driving `VideoComposition` over a Timeline - twice:
 *
 * 1. inline on the page's own main thread (baseline), then
 * 2. in a cross-site iframe (localhost parent -> 127.0.0.1 frame: different
 *    sites, so Chrome site isolation puts the frame in its own renderer
 *    process; ports alone do not).
 *
 * The parent observes long tasks only for the render window. A main-thread
 * preview must produce some; the iframe path must produce far fewer on the
 * parent, and the frame reports its own long tasks back so the report shows
 * the work moved rather than disappeared.
 *
 * This measures *preview* latency. It is not the browser-export measurement:
 * export encodes a finished file with a minutes-long budget, preview has to
 * stay interactive frame by frame.
 *
 * Run: CHROME_BIN=/usr/bin/google-chrome pnpm --filter @clash/web test:e2e:preview-longtask
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
import {
  summarizeLongTasks,
  type PreviewMainThreadMetric,
} from "../../../packages/remotion-ui/src/preview-host/metrics.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(webDir, "..", "..");

/** How long the preview plays before the window closes. */
const MEASUREMENT_WINDOW_MS = 4000;

function hostHtml(frameOrigin: string): string {
  return `<!doctype html><html><body><div id="status">idle</div><script>
window.__lt = [];
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) window.__lt.push(entry.duration);
}).observe({ type: "longtask" });
window.__report = null;
window.__ready = false;
window.addEventListener("message", (event) => {
  if (event.origin !== ${JSON.stringify(frameOrigin)}) return;
  if (!event.data) return;
  if (event.data.type === "clash.preview-probe.ready") {
    window.__ready = true;
    return;
  }
  if (event.data.type === "clash.preview-probe.report") {
    window.__report = event.data;
  }
});
window.startPreview = () => new Promise((resolve, reject) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:0;top:0;width:960px;height:540px;border:0";
  frame.src = ${JSON.stringify(frameOrigin)} + "/e2e/preview-probe.html";
  const send = (type) => frame.contentWindow.postMessage({ type }, ${JSON.stringify(frameOrigin)});
  const wait = (predicate, label, timeoutMs) => new Promise((ok, fail) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) { ok(); return; }
      if (Date.now() > deadline) { fail(new Error("timed out waiting for " + label)); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
  document.body.appendChild(frame);
  // The frame announces itself once the Player is mounted. Waiting for that
  // handshake avoids the iframe's initial about:blank load event, which fires
  // before the frame document exists.
  wait(() => window.__ready, "the preview frame to become ready", 20000).then(() => {
    send("clash.preview-probe.reset-long-tasks");
    send("clash.preview-probe.play");
    window.__lt.length = 0;
    setTimeout(() => {
      send("clash.preview-probe.request-report");
      setTimeout(() => resolve({ parentLongTasks: window.__lt.slice(), report: window.__report }), 500);
    }, ${MEASUREMENT_WINDOW_MS});
  }).catch(reject);
});
</script></body></html>`;
}

async function main() {
  const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
  const vitePort = await findFreePort(5182);
  const vite = startViteDevServer({ webDir, repoRoot, port: vitePort });
  const frameOrigin = `http://127.0.0.1:${vitePort}`;
  const hostPort = await findFreePort(5192);
  const host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(hostHtml(frameOrigin));
  });
  await new Promise<void>((resolve, reject) => {
    host.once("error", reject);
    host.listen(hostPort, "127.0.0.1", resolve);
  });
  try {
    await waitForHttp(
      `${frameOrigin}/e2e/preview-probe.html`,
      "Vite preview probe",
    );
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
      // Baseline: the preview runs on the page's own main thread.
      const baseline = await browser.newPage();
      await baseline.goto(`${frameOrigin}/e2e/preview-probe.html`);
      await baseline.waitForFunction(
        () => typeof (window as unknown as { __previewProbe?: unknown }).__previewProbe === "object",
      );
      const baselineResult = (await baseline.evaluate(async (windowMs) => {
        const scope = window as unknown as {
          __previewProbe: {
            play(): void;
            longTasks(): number[];
            resetLongTasks(): void;
            currentFrame(): number;
          };
        };
        scope.__previewProbe.resetLongTasks();
        scope.__previewProbe.play();
        await new Promise((resolve) => setTimeout(resolve, windowMs));
        return {
          longTasks: scope.__previewProbe.longTasks(),
          currentFrame: scope.__previewProbe.currentFrame(),
        };
      }, MEASUREMENT_WINDOW_MS)) as { longTasks: number[]; currentFrame: number };
      await baseline.close();

      // Isolated: the same preview runs in a cross-site frame.
      const hosted = await browser.newPage();
      // `localhost` and `127.0.0.1` are different sites. Two ports on one host
      // are the same site and would share the parent's renderer process.
      await hosted.goto(`http://localhost:${hostPort}/`);
      const isolated = await hosted.evaluate(async () => {
        const scope = window as unknown as {
          startPreview(): Promise<{
            parentLongTasks: number[];
            report: { longTasks: number[] } | null;
          }>;
        };
        return scope.startPreview();
      });
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

      const baselineMetric: PreviewMainThreadMetric = summarizeLongTasks({
        scenario: "remotion-timeline-preview-1080p",
        hostMode: "main-thread",
        windowMs: MEASUREMENT_WINDOW_MS,
        durations: baselineResult.longTasks,
      });
      const isolatedMetric: PreviewMainThreadMetric = summarizeLongTasks({
        scenario: "remotion-timeline-preview-1080p",
        hostMode: "iframe",
        windowMs: MEASUREMENT_WINDOW_MS,
        durations: isolated.parentLongTasks,
      });
      const frameMetric: PreviewMainThreadMetric = summarizeLongTasks({
        scenario: "remotion-timeline-preview-1080p",
        hostMode: "iframe",
        windowMs: MEASUREMENT_WINDOW_MS,
        durations: isolated.report?.longTasks ?? [],
      });

      console.log(
        JSON.stringify(
          {
            scenario: "1920x1080 timeline preview, 120 text items, 4 s window",
            framesAdvanced: {
              mainThread: baselineResult.currentFrame,
              crossSiteIframe: isolated.report?.currentFrame ?? 0,
            },
            mainThread: baselineMetric,
            crossSiteIframe: {
              outOfProcess,
              parent: isolatedMetric,
              frame: frameMetric,
            },
          },
          null,
          2,
        ),
      );
      assert(
        baselineResult.currentFrame > 0,
        "expected the main-thread preview to advance frames",
      );
      assert(
        (isolated.report?.currentFrame ?? 0) > 0,
        "expected the isolated frame to advance frames",
      );
      assert(
        baselineMetric.longTasks > 0,
        "expected the main-thread baseline to produce a long task",
      );
      assert(outOfProcess, "expected the preview frame to be an out-of-process iframe");
      assert(
        isolatedMetric.totalLongTaskMs < baselineMetric.totalLongTaskMs,
        `expected the isolated parent to block less than the baseline (${isolatedMetric.totalLongTaskMs} ms vs ${baselineMetric.totalLongTaskMs} ms)`,
      );
      assert(
        frameMetric.longTasks > 0,
        "expected the isolated frame to do the preview work on its own thread",
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
