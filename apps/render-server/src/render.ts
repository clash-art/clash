import path from "path";
import fs from "fs";
import os from "os";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { renderLog } from "./observability.js";

const log = renderLog.child("render");

type DevelopmentBundle = { path: string; sourceFingerprint: string };

let developmentBundle: DevelopmentBundle | null = null;
let developmentBundleInFlight: Promise<DevelopmentBundle> | null = null;

// Pre-built bundle written by prebundle.ts during Docker build, copied into
// the runtime stage at /app/.remotion-bundle. See Dockerfile.
const PREBUILT_BUNDLE = path.resolve(import.meta.dirname, "../.remotion-bundle");

const DEVELOPMENT_BUNDLE_SOURCE_ROOTS = [
  "../../../packages/remotion-components/src",
  "../../../packages/remotion-core/src",
  "../../../packages/remotion-effects/src",
  "../../../packages/shared-types/src",
  "../../../packages/shared-layout/src",
].map((source) => path.resolve(import.meta.dirname, source));

function newestSourceMtime(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  let newest = fs.statSync(directory).mtimeMs;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.resolve(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestSourceMtime(entryPath) : fs.statSync(entryPath).mtimeMs,
    );
  }
  return newest;
}

function developmentSourceFingerprint(): string {
  return DEVELOPMENT_BUNDLE_SOURCE_ROOTS
    .map((root) => `${root}:${newestSourceMtime(root)}`)
    .join("|");
}

async function ensureBundle(): Promise<string> {
  if (fs.existsSync(PREBUILT_BUNDLE)) {
    log.debug("bundle.prebuilt", { path: PREBUILT_BUNDLE });
    return PREBUILT_BUNDLE;
  }

  // Dev fallback (tsx watch on src/): compile from source. Slow first time
  // but only happens once per process and the dev DX of editing components
  // and re-rendering is worth it.
  const entryPoint = path.resolve(
    import.meta.dirname,
    "../../../packages/remotion-components/src/Root.tsx",
  );
  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Remotion entry point not found: ${entryPoint}`);
  }

  const sourceFingerprint = developmentSourceFingerprint();
  if (
    developmentBundle &&
    developmentBundle.sourceFingerprint === sourceFingerprint &&
    fs.existsSync(developmentBundle.path)
  ) {
    return developmentBundle.path;
  }

  if (developmentBundleInFlight) {
    const inFlight = await developmentBundleInFlight;
    return inFlight.sourceFingerprint === sourceFingerprint
      ? inFlight.path
      : ensureBundle();
  }

  log.info(developmentBundle ? "bundle.rebuilding" : "bundle.building", {
    source: "development",
  });
  const pending = (async (): Promise<DevelopmentBundle> => {
    const bundledPath = await bundle({
      entryPoint,
      onProgress: (pct) => {
        if (pct % 25 === 0) log.debug("bundle.progress", { percent: pct });
      },
    });
    return { path: bundledPath, sourceFingerprint };
  })();
  developmentBundleInFlight = pending;
  try {
    developmentBundle = await pending;
    log.info("bundle.ready", { path: developmentBundle.path });
    return developmentBundle.path;
  } finally {
    if (developmentBundleInFlight === pending) developmentBundleInFlight = null;
  }
}

export async function renderTimeline(
  timelineDsl: Record<string, any>,
  taskId: string
): Promise<Buffer> {
  const bundled = await ensureBundle();

  const {
    tracks = [],
    compositionWidth = 1920,
    compositionHeight = 1080,
    fps = 30,
    durationInFrames = 300,
  } = timelineDsl;

  const inputProps = { tracks, compositionWidth, compositionHeight, fps, durationInFrames };

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "VideoComposition",
    inputProps,
  });

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
  const outputPath = path.join(outputDir, `${taskId}.mp4`);

  log.info("render.composition", {
    task_id: taskId,
    width: compositionWidth,
    height: compositionHeight,
    fps,
    frames: durationInFrames,
  });

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    onProgress: ({ progress }) => {
      if (Math.round(progress * 100) % 25 === 0) {
        log.debug("render.progress", {
          task_id: taskId,
          percent: Math.round(progress * 100),
        });
      }
    },
  });

  const buffer = fs.readFileSync(outputPath);

  // Cleanup
  fs.rmSync(outputDir, { recursive: true, force: true });

  return buffer;
}
