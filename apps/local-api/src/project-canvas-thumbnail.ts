import type { OverlayOptions } from "sharp";

import type { ProjectCanvasPreviewNode } from "@clash/shared-types";

import { createBoundedWorkQueue } from "./bounded-work-queue.js";
import { loadSharp } from "./local-image-codec.js";
import type {
  CachedProjectCanvasPreview,
  FileReplicaStore,
} from "./loro/file-replica-store.js";

export const PROJECT_CANVAS_THUMBNAIL_WIDTH = 640;
export const PROJECT_CANVAS_THUMBNAIL_HEIGHT = 360;
// The Project revision is the cache identity; browser-card dimensions stay fixed.

export const PROJECT_CANVAS_THUMBNAIL_MAX_CONCURRENT = 2;
const THUMBNAIL_RETRY_BASE_MS = 1_000;
const THUMBNAIL_RETRY_MAX_MS = 5 * 60_000;
const THUMBNAIL_MAX_ATTEMPTS = 5;

export interface ProjectCanvasThumbnailFailure {
  code: "REPRESENTATION_FAILED";
  message: string;
  retryAt?: number;
  attempts: number;
}

/** A thumbnail that cannot be rendered; the route turns this into a coded 503. */
export class ProjectCanvasThumbnailError extends Error {
  readonly code = "REPRESENTATION_FAILED" as const;

  constructor(
    message: string,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "ProjectCanvasThumbnailError";
  }
}

export interface ProjectCanvasThumbnailMedia {
  kind: "image";
  path: string;
}

export interface ProjectCanvasThumbnailInput {
  projectId: string;
  entry: CachedProjectCanvasPreview;
  resolveMedia: (
    assetId: string,
  ) => Promise<ProjectCanvasThumbnailMedia | null>;
}

interface ProjectCanvasThumbnailStore {
  readCanvasThumbnail(
    projectId: string,
    sourceVersion: string,
  ): Promise<Uint8Array | null>;
  writeCanvasThumbnail(
    projectId: string,
    sourceVersion: string,
    bytes: Uint8Array,
  ): Promise<void>;
}

type ProjectCanvasThumbnailRenderer = (
  input: ProjectCanvasThumbnailInput,
) => Promise<Uint8Array>;

function retryDelayMs(attempts: number): number {
  return Math.min(
    THUMBNAIL_RETRY_MAX_MS,
    THUMBNAIL_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 10),
  );
}

export class ProjectCanvasThumbnailCache {
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();
  private readonly failures = new Map<
    string,
    { attempts: number; retryAt?: number; message: string }
  >();
  private readonly store: ProjectCanvasThumbnailStore;
  private readonly render: ProjectCanvasThumbnailRenderer;
  private readonly queue: ReturnType<typeof createBoundedWorkQueue>;
  private readonly now: () => number;

  constructor(options: {
    store: ProjectCanvasThumbnailStore;
    render?: ProjectCanvasThumbnailRenderer;
    maxConcurrent?: number;
    now?: () => number;
  }) {
    this.store = options.store;
    this.render = options.render ?? renderProjectCanvasThumbnail;
    this.now = options.now ?? Date.now;
    const maxConcurrent =
      options.maxConcurrent ?? PROJECT_CANVAS_THUMBNAIL_MAX_CONCURRENT;
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new TypeError(
        "Project canvas thumbnail concurrency must be a positive integer.",
      );
    }
    this.queue = createBoundedWorkQueue({ concurrency: maxConcurrent });
  }

  /** The known failure for one immutable revision, if it is still current. */
  failureFor(
    projectId: string,
    sourceVersion: string,
  ): ProjectCanvasThumbnailFailure | undefined {
    const key = this.key(projectId, sourceVersion);
    const failure = this.failures.get(key);
    if (!failure) return undefined;
    if (failure.retryAt !== undefined && failure.retryAt <= this.now()) {
      this.failures.delete(key);
      return undefined;
    }
    return {
      code: "REPRESENTATION_FAILED",
      message: failure.message,
      attempts: failure.attempts,
      ...(failure.retryAt === undefined ? {} : { retryAt: failure.retryAt }),
    };
  }

  get(input: ProjectCanvasThumbnailInput): Promise<Uint8Array> {
    const key = this.key(input.projectId, input.entry.sourceVersion);
    const active = this.inFlight.get(key);
    if (active) return active;
    const failure = this.failureFor(input.projectId, input.entry.sourceVersion);
    if (failure) {
      return Promise.reject(
        new ProjectCanvasThumbnailError(failure.message, failure.retryAt),
      );
    }

    const run = this.queue
      .enqueue("foreground", () => this.readOrRender(input))
      .catch((error: unknown) => {
        const recorded = this.recordFailure(key, error);
        throw new ProjectCanvasThumbnailError(
          recorded.message,
          recorded.retryAt,
        );
      })
      .then((bytes) => {
        this.failures.delete(key);
        return bytes;
      })
      .finally(() => {
        if (this.inFlight.get(key) === run) this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return run;
  }

  private key(projectId: string, sourceVersion: string): string {
    return `${encodeURIComponent(projectId)}:${sourceVersion}`;
  }

  private recordFailure(
    key: string,
    error: unknown,
  ): { message: string; retryAt?: number } {
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    const retryAt =
      attempts >= THUMBNAIL_MAX_ATTEMPTS
        ? undefined
        : this.now() + retryDelayMs(attempts);
    this.failures.set(key, { attempts, message, retryAt });
    return { message, retryAt };
  }

  private async readOrRender(
    input: ProjectCanvasThumbnailInput,
  ): Promise<Uint8Array> {
    const cached = await this.store.readCanvasThumbnail(
      input.projectId,
      input.entry.sourceVersion,
    );
    if (cached) return cached;
    const rendered = await this.render(input);
    await this.store.writeCanvasThumbnail(
      input.projectId,
      input.entry.sourceVersion,
      rendered,
    );
    return rendered;
  }
}

export function createProjectCanvasThumbnailCache(
  store: FileReplicaStore,
): ProjectCanvasThumbnailCache {
  return new ProjectCanvasThumbnailCache({ store });
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function nodeFill(node: ProjectCanvasPreviewNode): string {
  if (node.type === "group") return "#deddda";
  if (node.type === "image" || node.type === "video") return "#cacac6";
  if (node.type.includes("action")) return "#ddd5ce";
  if (node.type.includes("video-editor") || node.type.includes("timeline")) {
    return "#c7c7c3";
  }
  return "#f7f6f3";
}

function backgroundSvg(
  entry: CachedProjectCanvasPreview,
  transform: (node: ProjectCanvasPreviewNode) => {
    x: number;
    y: number;
    width: number;
    height: number;
  },
): Buffer {
  const nodes = [...entry.preview.nodes].sort(
    (left, right) =>
      Number(right.type === "group") - Number(left.type === "group"),
  );
  const shapes = nodes
    .map((node) => {
      const rect = transform(node);
      const radius = Math.max(2, Math.min(8, rect.height * 0.08));
      const strokeDash = node.type === "group" ? ' stroke-dasharray="5 4"' : "";
      const label = node.label
        ? `<text x="${rect.x + Math.max(4, rect.width * 0.05)}" y="${rect.y + Math.max(10, rect.height * 0.17)}" font-family="Inter, Arial, sans-serif" font-size="${Math.max(7, Math.min(12, rect.height * 0.12))}" font-weight="600" fill="#57534e">${escapeXml(node.label.slice(0, 42))}</text>`
        : "";
      return `<g><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${radius}" fill="${nodeFill(node)}" stroke="#a8a29e" stroke-width="1"${strokeDash}/>${label}</g>`;
    })
    .join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PROJECT_CANVAS_THUMBNAIL_WIDTH}" height="${PROJECT_CANVAS_THUMBNAIL_HEIGHT}" viewBox="0 0 ${PROJECT_CANVAS_THUMBNAIL_WIDTH} ${PROJECT_CANVAS_THUMBNAIL_HEIGHT}"><rect width="100%" height="100%" fill="#e7e7e4"/>${shapes}</svg>`,
  );
}

async function mediaTile(
  media: ProjectCanvasThumbnailMedia,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const radius = Math.max(2, Math.min(8, height * 0.08));
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="white"/></svg>`,
  );
  const sharp = await loadSharp();
  return sharp(media.path, { failOn: "error", limitInputPixels: 100_000_000 })
    .rotate()
    .resize(width, height, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

export async function renderProjectCanvasThumbnail(
  input: ProjectCanvasThumbnailInput,
): Promise<Uint8Array> {
  const { bounds } = input.entry.preview;
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new TypeError("Main canvas thumbnail requires non-empty bounds.");
  }
  // Loaded before the per-tile loop so a missing codec fails the thumbnail, not each tile.
  const sharp = await loadSharp();
  const padding = 24;
  const scale = Math.min(
    (PROJECT_CANVAS_THUMBNAIL_WIDTH - padding * 2) / bounds.width,
    (PROJECT_CANVAS_THUMBNAIL_HEIGHT - padding * 2) / bounds.height,
  );
  const contentWidth = bounds.width * scale;
  const contentHeight = bounds.height * scale;
  const offsetX = (PROJECT_CANVAS_THUMBNAIL_WIDTH - contentWidth) / 2;
  const offsetY = (PROJECT_CANVAS_THUMBNAIL_HEIGHT - contentHeight) / 2;
  const transform = (node: ProjectCanvasPreviewNode) => ({
    x: offsetX + (node.x - bounds.x) * scale,
    y: offsetY + (node.y - bounds.y) * scale,
    width: Math.max(1, node.width * scale),
    height: Math.max(1, node.height * scale),
  });
  const overlays: OverlayOptions[] = [];

  for (const node of input.entry.preview.nodes) {
    if (!node.assetId || (node.type !== "image" && node.type !== "video")) {
      continue;
    }
    try {
      const media = await input.resolveMedia(node.assetId);
      if (!media) continue;
      const rect = transform(node);
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const tile = await mediaTile(media, width, height);
      if (!tile) continue;
      overlays.push({
        input: tile,
        left: Math.round(rect.x),
        top: Math.round(rect.y),
      });
    } catch (error) {
      console.warn(
        `[local-api] skipped canvas thumbnail media ${node.assetId}`,
        error,
      );
    }
  }

  return new Uint8Array(
    await sharp(backgroundSvg(input.entry, transform))
      .composite(overlays)
      .webp({ quality: 76, effort: 4 })
      .toBuffer(),
  );
}
