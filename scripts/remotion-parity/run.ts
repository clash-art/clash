/**
 * Remotion composition parity check.
 *
 * Renders the same fixture timeline through:
 *   1. @remotion/renderer (`renderStill`) against a fresh bundle of
 *      packages/remotion-components/src/Root.tsx — the same entry point and
 *      bundle approach as apps/render-server; and
 *   2. @remotion/web-renderer (`renderStillOnWeb`) in headless Chromium,
 *      driven by Playwright.
 *
 * The resulting PNGs are compared per frame with ffmpeg's `ssim` filter, or a
 * small sharp-based SSIM implementation when ffmpeg is unavailable. The job
 * fails if any sample frame is below SSIM 0.95.
 *
 * Fixtures are generated locally with ffmpeg at test time (no network).
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  renderStill,
  selectComposition,
} from "@remotion/renderer";
import { chromium } from "playwright";
import { build } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import {
  createParityTimeline,
  PARITY_HEIGHT,
  PARITY_SAMPLE_FRAMES,
  PARITY_WIDTH,
} from "./fixture.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
// Measured on the fixture below: fixed composition 0.9911-0.9925, legacy
// z-index stacking 0.8692-0.8731. The gate sits between those populations.
const SSIM_THRESHOLD = Number(process.env.PARITY_SSIM_THRESHOLD ?? "0.95");
const SSIM_ENGINE = process.env.PARITY_SSIM_ENGINE ?? "auto";
const KEEP_TEMP = process.env.PARITY_KEEP_TEMP === "1";
const require = createRequire(import.meta.url);

type SsimResult = { frame: number; ssim: number | null; error?: string };

function log(message: string): void {
  console.log(`[remotion-parity] ${message}`);
}

function resolveFfmpeg(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const probe = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  if (probe.status === 0) return "ffmpeg";
  try {
    const staticPath = require("ffmpeg-static") as string | null;
    if (staticPath && fs.existsSync(staticPath)) return staticPath;
  } catch {
    // Handled below.
  }
  throw new Error(
    "ffmpeg is required to generate fixtures; install it or set FFMPEG_PATH",
  );
}

function runFfmpeg(ffmpeg: string, args: string[], label: string): void {
  const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status}):\n${result.stderr ?? ""}`,
    );
  }
}

function generateFixtures(ffmpeg: string, fixtureDir: string): void {
  fs.mkdirSync(fixtureDir, { recursive: true });
  log("generating local ffmpeg fixtures (still, clip, audio)");

  runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-frames:v",
      "1",
      path.join(fixtureDir, "still.png"),
    ],
    "still.png",
  );

  runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=1280x720:rate=30",
      "-t",
      "6",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-movflags",
      "+faststart",
      path.join(fixtureDir, "clip.mp4"),
    ],
    "clip.mp4",
  );

  runFfmpeg(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
      "-c:a",
      "pcm_s16le",
      path.join(fixtureDir, "music.wav"),
    ],
    "music.wav",
  );
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".wasm":
      return "application/wasm";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    default:
      return "application/octet-stream";
  }
}

async function startStaticServer(rootDir: string): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const root = path.resolve(rootDir);
  const server = http.createServer((request, response) => {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Accept-Ranges",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders);
      response.end();
      return;
    }

    try {
      const pathname = decodeURIComponent(
        new URL(request.url ?? "/", "http://localhost").pathname,
      );
      const relative = pathname === "/" ? "/index.html" : pathname;
      const filePath = path.resolve(root, `.${relative}`);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403, corsHeaders);
        response.end("forbidden");
        return;
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        response.writeHead(404, corsHeaders);
        response.end("not found");
        return;
      }

      const size = fs.statSync(filePath).size;
      const range = request.headers.range;
      const headers = {
        ...corsHeaders,
        "Content-Type": mimeType(filePath),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      };
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) {
          response.writeHead(416, {
            ...headers,
            "Content-Range": `bytes */${size}`,
          });
          response.end();
          return;
        }
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : size - 1;
        if (start >= size || end < start) {
          response.writeHead(416, {
            ...headers,
            "Content-Range": `bytes */${size}`,
          });
          response.end();
          return;
        }
        const boundedEnd = Math.min(end, size - 1);
        response.writeHead(206, {
          ...headers,
          "Content-Length": String(boundedEnd - start + 1),
          "Content-Range": `bytes ${start}-${boundedEnd}/${size}`,
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        fs.createReadStream(filePath, { start, end: boundedEnd }).pipe(response);
        return;
      }

      response.writeHead(200, { ...headers, "Content-Length": String(size) });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      fs.createReadStream(filePath).pipe(response);
    } catch (error) {
      response.writeHead(500, corsHeaders);
      response.end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("static server did not expose a TCP port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function buildBrowserHarness(webDir: string): Promise<void> {
  const browserDir = path.join(scriptDir, "browser");
  log("building browser renderer harness with Vite");
  await build({
    configFile: false,
    root: browserDir,
    base: "./",
    publicDir: false,
    logLevel: "error",
    plugins: [wasm(), topLevelAwait()],
    esbuild: { jsx: "automatic", target: "es2022" },
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "remotion",
        "@remotion/media",
        "@remotion/web-renderer",
        "mediabunny",
        "zod",
      ],
    },
    build: {
      outDir: webDir,
      emptyOutDir: true,
      target: "es2022",
      sourcemap: false,
      minify: false,
      rollupOptions: { input: path.join(browserDir, "index.html") },
    },
  });
}

async function resolveBrowserExecutable(): Promise<string> {
  const explicit =
    process.env.PARITY_BROWSER_EXECUTABLE ??
    process.env.REMOTION_BROWSER_EXECUTABLE;
  if (explicit) return explicit;

  log("ensuring Remotion's pinned Chromium via ensureBrowser()");
  const status = await ensureBrowser({
    chromeMode: "chrome-for-testing",
    logLevel: "warn",
  });
  if (status.type === "no-browser" || status.type === "version-mismatch") {
    throw new Error("ensureBrowser() did not find or download a usable browser");
  }
  return status.path;
}

async function renderServerFrames(input: {
  bundleDir: string;
  inputProps: ReturnType<typeof createParityTimeline>;
  browserExecutable: string;
  outputDir: string;
}): Promise<Map<number, string>> {
  log("selecting VideoComposition from the fresh server bundle");
  const composition = await selectComposition({
    serveUrl: input.bundleDir,
    id: "VideoComposition",
    inputProps: input.inputProps,
    browserExecutable: input.browserExecutable,
    chromeMode: "chrome-for-testing",
    logLevel: "error",
  });

  const outputs = new Map<number, string>();
  for (const frame of PARITY_SAMPLE_FRAMES) {
    const output = path.join(input.outputDir, `server-frame-${frame}.png`);
    log(`server renderStill frame ${frame}`);
    await renderStill({
      composition,
      serveUrl: input.bundleDir,
      output,
      frame,
      imageFormat: "png",
      inputProps: input.inputProps,
      browserExecutable: input.browserExecutable,
      chromeMode: "chrome-for-testing",
      logLevel: "error",
    });
    outputs.set(frame, output);
  }
  return outputs;
}

async function renderBrowserFrames(input: {
  origin: string;
  inputProps: ReturnType<typeof createParityTimeline>;
  browserExecutable: string;
  outputDir: string;
}): Promise<Map<number, string>> {
  const browser = await chromium.launch({
    executablePath: input.browserExecutable,
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--disable-dev-shm-usage",
    ],
  });
  const outputs = new Map<number, string>();
  try {
    const page = await browser.newPage({
      viewport: { width: PARITY_WIDTH, height: PARITY_HEIGHT },
      deviceScaleFactor: 1,
    });
    const messages: string[] = [];
    page.on("console", (message) => {
      messages.push(`[${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      messages.push(`[pageerror] ${String(error)}`);
    });

    log(`opening browser harness at ${input.origin}/`);
    await page.goto(`${input.origin}/`, {
      waitUntil: "load",
      timeout: 120_000,
    });
    await page.waitForFunction(
      () => document.getElementById("status")?.textContent === "ready",
      null,
      { timeout: 120_000 },
    );
    await page.evaluate((props) => {
      (
        window as unknown as { __PARITY_INPUT_PROPS__?: unknown }
      ).__PARITY_INPUT_PROPS__ = props;
    }, {
      width: input.inputProps.compositionWidth,
      height: input.inputProps.compositionHeight,
      fps: input.inputProps.fps,
      durationInFrames: input.inputProps.durationInFrames,
      tracks: input.inputProps.tracks,
    });

    for (const frame of PARITY_SAMPLE_FRAMES) {
      log(`browser renderStillOnWeb frame ${frame}`);
      const result = (await page.evaluate(
        (targetFrame) => window.renderParityFrame(targetFrame),
        frame,
      )) as
        | { ok: true; base64: string }
        | { ok: false; error: string };
      if (!result.ok) {
        throw new Error(
          `browser frame ${frame} failed: ${result.error}\n${messages.slice(-20).join("\n")}`,
        );
      }
      const output = path.join(input.outputDir, `browser-frame-${frame}.png`);
      fs.writeFileSync(output, Buffer.from(result.base64, "base64"));
      outputs.set(frame, output);
    }
  } catch (error) {
    const details = error instanceof Error ? error.stack : String(error);
    throw new Error(`browser renderer failed: ${details}`);
  } finally {
    await browser.close();
  }
  return outputs;
}

function ssimWithFfmpeg(
  ffmpeg: string,
  serverPng: string,
  browserPng: string,
): number {
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner",
      "-nostats",
      "-i",
      serverPng,
      "-i",
      browserPng,
      "-lavfi",
      // Compare full-chroma RGB-derived frames. The ssim filter's default
      // yuv420p path subsamples chroma and under-reports PNG-vs-PNG parity.
      "[0:v]format=yuv444p[a];[1:v]format=yuv444p[b];[a][b]ssim",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = output.match(/All:([0-9.]+)/);
  if (result.status !== 0 || !match) {
    throw new Error(`ffmpeg ssim failed:\n${output}`);
  }
  return Number(match[1]);
}

async function ssimWithSharp(
  serverPng: string,
  browserPng: string,
): Promise<number> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const [left, right] = await Promise.all([
    sharp(serverPng).removeAlpha().greyscale().raw().toBuffer({
      resolveWithObject: true,
    }),
    sharp(browserPng).removeAlpha().greyscale().raw().toBuffer({
      resolveWithObject: true,
    }),
  ]);
  if (
    left.info.width !== right.info.width ||
    left.info.height !== right.info.height
  ) {
    throw new Error("SSIM inputs have different dimensions");
  }
  const width = left.info.width;
  const height = left.info.height;
  const blockSize = 8;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let weightedSum = 0;
  let totalWeight = 0;

  for (let blockY = 0; blockY < height; blockY += blockSize) {
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      let count = 0;
      let sumLeft = 0;
      let sumRight = 0;
      let sumLeftSq = 0;
      let sumRightSq = 0;
      let sumProduct = 0;
      for (
        let y = blockY;
        y < Math.min(height, blockY + blockSize);
        y += 1
      ) {
        for (
          let x = blockX;
          x < Math.min(width, blockX + blockSize);
          x += 1
        ) {
          const index = y * width + x;
          const a = left.data[index];
          const b = right.data[index];
          count += 1;
          sumLeft += a;
          sumRight += b;
          sumLeftSq += a * a;
          sumRightSq += b * b;
          sumProduct += a * b;
        }
      }
      if (count === 0) continue;
      const meanLeft = sumLeft / count;
      const meanRight = sumRight / count;
      const varianceLeft = sumLeftSq / count - meanLeft * meanLeft;
      const varianceRight = sumRightSq / count - meanRight * meanRight;
      const covariance = sumProduct / count - meanLeft * meanRight;
      const numerator =
        (2 * meanLeft * meanRight + c1) * (2 * covariance + c2);
      const denominator =
        (meanLeft * meanLeft + meanRight * meanRight + c1) *
        (varianceLeft + varianceRight + c2);
      weightedSum += (numerator / denominator) * count;
      totalWeight += count;
    }
  }
  return totalWeight === 0 ? 0 : weightedSum / totalWeight;
}

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  const tempRoot = process.env.PARITY_TEMP_DIR ?? os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(
    path.join(tempRoot, "clash-remotion-parity-"),
  );
  const fixtureDir = path.join(tempDir, "fixtures");
  const webDir = path.join(tempDir, "web");
  const outputDir = path.join(tempDir, "frames");
  const remotionBundleDir = path.join(tempDir, "remotion-bundle");
  let server: Awaited<ReturnType<typeof startStaticServer>> | undefined;

  try {
    generateFixtures(ffmpeg, fixtureDir);
    await buildBrowserHarness(webDir);
    fs.cpSync(fixtureDir, path.join(webDir, "fixtures"), { recursive: true });

    log("bundling packages/remotion-components/src/Root.tsx for the server renderer");
    await bundle({
      entryPoint: path.resolve(
        repoRoot,
        "packages/remotion-components/src/Root.tsx",
      ),
      outDir: remotionBundleDir,
      onProgress: (percent) => {
        if (percent > 0 && percent % 25 === 0) {
          log(`server bundle ${percent}%`);
        }
      },
    });

    server = await startStaticServer(webDir);
    fs.mkdirSync(outputDir, { recursive: true });
    const media = {
      still: `${server.origin}/fixtures/still.png`,
      clip: `${server.origin}/fixtures/clip.mp4`,
      music: `${server.origin}/fixtures/music.wav`,
    };
    const inputProps = createParityTimeline(media);
    const browserExecutable = await resolveBrowserExecutable();

    const [serverFrames, browserFrames] = await Promise.all([
      renderServerFrames({
        bundleDir: remotionBundleDir,
        inputProps,
        browserExecutable,
        outputDir,
      }),
      renderBrowserFrames({
        origin: server.origin,
        inputProps,
        browserExecutable,
        outputDir,
      }),
    ]);

    const results: SsimResult[] = [];
    for (const frame of PARITY_SAMPLE_FRAMES) {
      const serverPng = serverFrames.get(frame);
      const browserPng = browserFrames.get(frame);
      if (!serverPng || !browserPng) {
        results.push({ frame, ssim: null, error: "missing frame output" });
        continue;
      }
      try {
        let ssim: number | null = null;
        if (SSIM_ENGINE !== "js") {
          try {
            ssim = ssimWithFfmpeg(ffmpeg, serverPng, browserPng);
          } catch (error) {
            if (SSIM_ENGINE === "ffmpeg") throw error;
          }
        }
        if (ssim === null) {
          ssim = await ssimWithSharp(serverPng, browserPng);
        }
        results.push({ frame, ssim });
      } catch (error) {
        results.push({
          frame,
          ssim: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log(`SSIM threshold: ${SSIM_THRESHOLD.toFixed(3)} per frame`);
    for (const result of results) {
      if (result.ssim === null) {
        log(`frame ${result.frame}: FAIL (${result.error ?? "no SSIM"})`);
      } else {
        const status = result.ssim >= SSIM_THRESHOLD ? "PASS" : "FAIL";
        log(`frame ${result.frame}: SSIM ${result.ssim.toFixed(4)} ${status}`);
      }
    }
    const measured = results
      .map((result) => result.ssim)
      .filter((value): value is number => value !== null);
    if (measured.length > 0) {
      const average =
        measured.reduce((sum, value) => sum + value, 0) / measured.length;
      log(
        `measured ${measured.length}/${results.length} frames, average SSIM ${average.toFixed(4)}`,
      );
    }

    const failed = results.filter(
      (result) => result.ssim === null || result.ssim < SSIM_THRESHOLD,
    );
    if (failed.length > 0) {
      process.exitCode = 1;
      log(`${failed.length} frame(s) below threshold or unmeasured`);
    }
  } finally {
    if (server) await server.close();
    if (KEEP_TEMP) {
      log(`kept temp artifacts at ${tempDir}`);
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`[remotion-parity] ${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
});
