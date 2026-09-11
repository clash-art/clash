import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import type { DirectorStageState } from "@clash/shared-types";
import { DirectorStageStateSchema } from "@clash/shared-types";

export type DirectorCaptureAspectRatio = "16:9" | "9:16" | "4:3" | "3:4" | "1:1";

export type DirectorStageRenderRequest = {
  state: DirectorStageState;
  longEdge: number;
  frames: Array<{
    label: string;
    timeSeconds: number;
    aspectRatio: DirectorCaptureAspectRatio;
  }>;
  assetUrls?: Record<string, string>;
  codeSources?: Record<string, string>;
  environmentUrl?: string;
};

export type DirectorStageRenderFrame = {
  label: string;
  timeSeconds: number;
  aspectRatio: DirectorCaptureAspectRatio;
  activeCameraId?: string;
  width: number;
  height: number;
  mimeType: "image/png";
  dataBase64: string;
  sha256: string;
};

export type DirectorStageRenderResult = {
  renderer: {
    id: "clash-director-viewport-webgl";
    contractVersion: 1;
  };
  stateSha256: string;
  frames: DirectorStageRenderFrame[];
};

export interface LocalDirectorStageRenderer {
  render(request: DirectorStageRenderRequest): Promise<DirectorStageRenderResult>;
  dispose(): Promise<void>;
}

type BrowserPageLike = {
  goto(options: { url: string; timeout: number }): Promise<unknown>;
  evaluate<T>(fn: (input: any) => T | Promise<T>, input: unknown): Promise<T>;
  close(): Promise<void>;
};

type BrowserLike = {
  newPage(options: {
    context: () => null;
    logLevel: "error";
    indent: false;
    pageIndex: number;
    onBrowserLog: null;
    onLog: () => void;
  }): Promise<BrowserPageLike>;
  close(options?: { silent: boolean }): Promise<void>;
};

type BrowserCaptureResult = {
  dataUrl: string;
  width: number;
  height: number;
  activeCameraId?: string;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".wasm": "application/wasm",
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validatedRequest(input: DirectorStageRenderRequest): DirectorStageRenderRequest {
  const state = DirectorStageStateSchema.parse(input.state);
  if (!Number.isInteger(input.longEdge) || input.longEdge < 256 || input.longEdge > 4096) {
    throw new Error("Director capture longEdge must be an integer between 256 and 4096");
  }
  if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > 12) {
    throw new Error("Director capture requires between 1 and 12 frames");
  }
  const labels = new Set<string>();
  const frames = input.frames.map((frame) => {
    const label = frame.label.trim();
    if (!label || labels.has(label)) throw new Error("Director capture frame labels must be unique");
    labels.add(label);
    if (!Number.isFinite(frame.timeSeconds) || frame.timeSeconds < 0) {
      throw new Error("Director capture times must be finite non-negative seconds");
    }
    if (!["16:9", "9:16", "4:3", "3:4", "1:1"].includes(frame.aspectRatio)) {
      throw new Error(`Unsupported Director capture aspect ratio: ${frame.aspectRatio}`);
    }
    return { ...frame, label };
  });
  return { ...input, state, frames };
}

async function startBundleServer(bundleDir: string): Promise<{
  server: Server;
  url: string;
}> {
  const bundleRoot = resolve(bundleDir);
  const staticRoot = dirname(bundleRoot);
  if (!(await stat(resolve(bundleRoot, "index.html"))).isFile()) {
    throw new Error(`Packaged Director renderer is missing index.html: ${bundleRoot}`);
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      const requestedPath = pathname === "/" ? "/director-bundle/index.html" : pathname;
      const filePath = resolve(staticRoot, `.${requestedPath}`);
      const outside = relative(staticRoot, filePath);
      if (outside === ".." || outside.startsWith(`..${sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const content = await readFile(filePath);
      response.writeHead(200, {
        "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(content);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Director renderer server did not bind");
  return {
    server,
    url: `http://127.0.0.1:${address.port}/director-bundle/index.html`,
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

export function createHeadlessDirectorStageRenderer(options: {
  bundleDir: string;
  /** Rebuilds the development browser asset when workspace source changed. */
  prepareBundle?: () => Promise<void>;
  openBrowser: () => Promise<BrowserLike>;
}): LocalDirectorStageRenderer {
  let browserPromise: Promise<BrowserLike> | undefined;
  let serverPromise: Promise<{ server: Server; url: string }> | undefined;
  let renderQueue = Promise.resolve();
  let disposed = false;
  const browser = () => browserPromise ??= options.openBrowser();
  const bundleServer = () => serverPromise ??= startBundleServer(options.bundleDir);

  const render = async (unvalidated: DirectorStageRenderRequest): Promise<DirectorStageRenderResult> => {
    if (disposed) throw new Error("Director Stage renderer is disposed");
    const request = validatedRequest(unvalidated);
    const run = renderQueue.then(async () => {
      await options.prepareBundle?.();
      const [activeBrowser, served] = await Promise.all([browser(), bundleServer()]);
      const page = await activeBrowser.newPage({
        context: () => null,
        logLevel: "error",
        indent: false,
        pageIndex: 0,
        onBrowserLog: null,
        onLog: () => undefined,
      });
      try {
        await page.goto({ url: served.url, timeout: 60_000 });
        const frames: DirectorStageRenderFrame[] = [];
        for (const frame of request.frames) {
          const captured = await page.evaluate(async (payload) => {
            const capture = (globalThis as { clashDirectorCapture?: (input: unknown) => Promise<unknown> })
              .clashDirectorCapture;
            if (typeof capture !== "function") {
              throw new Error("Packaged DirectorViewport capture surface is unavailable");
            }
            return await capture(payload);
          }, {
            state: request.state,
            timeSeconds: frame.timeSeconds,
            aspectRatio: frame.aspectRatio,
            longEdge: request.longEdge,
            assetUrls: request.assetUrls,
            codeSources: request.codeSources,
            environmentUrl: request.environmentUrl,
          }) as BrowserCaptureResult;
          const prefix = "data:image/png;base64,";
          if (!captured.dataUrl.startsWith(prefix)) {
            throw new Error("Director product renderer did not return a PNG");
          }
          const bytes = Buffer.from(captured.dataUrl.slice(prefix.length), "base64");
          if (bytes.length === 0) throw new Error("Director product renderer returned an empty PNG");
          frames.push({
            ...frame,
            ...(captured.activeCameraId ? { activeCameraId: captured.activeCameraId } : {}),
            width: captured.width,
            height: captured.height,
            mimeType: "image/png",
            dataBase64: bytes.toString("base64"),
            sha256: sha256(bytes),
          });
        }
        return {
          renderer: {
            id: "clash-director-viewport-webgl" as const,
            contractVersion: 1 as const,
          },
          stateSha256: sha256(JSON.stringify(request.state)),
          frames,
        };
      } finally {
        await page.close().catch(() => undefined);
      }
    });
    renderQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    render,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await renderQueue;
      const [activeBrowser, served] = await Promise.all([
        browserPromise?.catch(() => undefined),
        serverPromise?.catch(() => undefined),
      ]);
      await Promise.all([
        activeBrowser?.close({ silent: true }).catch(() => undefined),
        served ? closeServer(served.server) : undefined,
      ]);
    },
  };
}
