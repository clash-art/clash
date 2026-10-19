import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  MEDIA_PROCESS_TIMEOUTS_MS,
  withMediaProcessDeadline,
} from "./local-media-process.js";

const execFileAsync = promisify(execFile);

export type FalQueueStatusName = "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
export type FalMockOutputKind = "image" | "video" | "audio";

export interface FalQueueLog {
  message: string;
  timestamp: string;
}

export interface FalSubmitResponse {
  request_id: string;
  response_url: string;
  status_url: string;
  cancel_url: string;
  queue_position: number;
}

export interface FalQueueStatus {
  status: FalQueueStatusName;
  request_id: string;
  response_url: string;
  queue_position?: number;
  logs?: FalQueueLog[];
  metrics?: {
    inference_time: number;
  };
}

export interface FalImageResult {
  images: Array<{
    url: string;
    width: number;
    height: number;
    content_type: string;
  }>;
  prompt: string;
  seed: number;
  has_nsfw_concepts: boolean[];
}

export interface FalVideoResult {
  video: {
    url: string;
    width: number;
    height: number;
    duration: number;
    content_type: string;
  };
  prompt: string;
  seed: number;
}

export interface FalAudioResult {
  audio: {
    url: string;
    duration: number;
    content_type: string;
  };
  prompt: string;
  transcript: string;
  seed: number;
  waveform: number[];
}

export type FalMockResult = FalImageResult | FalVideoResult | FalAudioResult;

export interface FalMockMedia {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
}

export interface FalMockQueueService {
  submit(
    modelId: string,
    input: Record<string, unknown>,
    options?: { origin?: string },
  ): Promise<FalSubmitResponse>;
  status(modelId: string, requestId: string, options?: { logs?: boolean; origin?: string }): FalQueueStatus | null;
  result(modelId: string, requestId: string, options?: { origin?: string }): FalMockResult | null;
  cancel(modelId: string, requestId: string): boolean;
  media(requestId: string): FalMockMedia | null;
}

interface FalMockRecord {
  requestId: string;
  modelId: string;
  kind: FalMockOutputKind;
  input: Record<string, unknown>;
  prompt: string;
  seed: number;
  width: number;
  height: number;
  durationSec: number;
  waveform: number[];
  createdAt: number;
  statusChecks: number;
  cancelled: boolean;
  media: FalMockMedia;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function arrayBufferBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function requestUrl(origin: string, modelId: string, requestId: string, suffix: string): string {
  return `${origin}/fal/${modelId}/requests/${requestId}${suffix}`;
}

function mediaUrl(origin: string, requestId: string, extension: string): string {
  return `${origin}/fal/media/${requestId}${extension}`;
}

function normalizeOrigin(origin: string | undefined): string {
  return origin || "http://fal.local";
}

function normalizeFalInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const body = value as Record<string, unknown>;
  const nested = body.input;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return body;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseFloat(value.replace(/s$/i, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationForInput(input: Record<string, unknown>, fallback = 5): number {
  const raw = input.duration ?? input.duration_s ?? input.seconds;
  const parsed = numberValue(raw);
  return Math.max(1, Math.min(30, parsed ?? fallback));
}

function dimensionsForAspectRatio(aspectRatio: string | undefined): {
  width: number;
  height: number;
} | null {
  if (!aspectRatio) return null;
  if (aspectRatio === "1:1") return { width: 1024, height: 1024 };
  if (aspectRatio === "9:16") return { width: 720, height: 1280 };
  if (aspectRatio === "16:9") return { width: 1024, height: 576 };
  if (aspectRatio === "3:4" || aspectRatio === "2:3" || aspectRatio === "4:5") {
    return { width: 768, height: 1024 };
  }
  if (aspectRatio === "4:3" || aspectRatio === "3:2" || aspectRatio === "5:4") {
    return { width: 1024, height: 768 };
  }

  const match = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const horizontal = Number(match[1]);
  const vertical = Number(match[2]);
  if (!(horizontal > 0) || !(vertical > 0)) return null;
  const ratio = horizontal / vertical;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return ratio >= 1
    ? { width: 1024, height: even(1024 / ratio) }
    : { width: even(1024 * ratio), height: 1024 };
}

function dimensionsForInput(input: Record<string, unknown>): { width: number; height: number } {
  const aspectDimensions = dimensionsForAspectRatio(stringValue(input.aspect_ratio));
  if (aspectDimensions) return aspectDimensions;

  const imageSize = stringValue(input.image_size);
  if (imageSize === "square_hd" || imageSize === "square") return { width: 1024, height: 1024 };
  if (imageSize === "portrait_16_9") return { width: 720, height: 1280 };
  if (imageSize === "portrait_4_3") return { width: 768, height: 1024 };
  if (imageSize === "landscape_4_3") return { width: 1024, height: 768 };
  if (imageSize === "landscape_16_9") return { width: 1024, height: 576 };

  return { width: 1024, height: 576 };
}

function inferOutputKind(modelId: string, input: Record<string, unknown>): FalMockOutputKind {
  const explicit = stringValue(input.output_type) ?? stringValue(input.__mock_output_kind);
  if (explicit === "image" || explicit === "video" || explicit === "audio") return explicit;

  const model = modelId.toLowerCase();
  if (
    model.includes("video") ||
    model.includes("sora") ||
    model.includes("kling") ||
    model.includes("veo") ||
    model.includes("seedance")
  ) {
    return "video";
  }
  if (model.includes("tts") || model.includes("speech") || model.includes("audio") || model.includes("voice")) {
    return "audio";
  }
  return "image";
}

function makeSvg(record: {
  requestId: string;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
}): Uint8Array {
  const prompt = escapeXml(record.prompt || "Mock fal image");
  const model = escapeXml(record.modelId);
  const requestId = escapeXml(record.requestId);
  const { width, height } = record;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="fal-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="42%" stop-color="#fee2e2"/>
      <stop offset="100%" stop-color="#dbeafe"/>
    </linearGradient>
    <filter id="fal-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#111827" flood-opacity="0.15"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="36" fill="url(#fal-bg)"/>
  <circle cx="${Math.round(width * 0.22)}" cy="${Math.round(height * 0.28)}" r="${Math.round(Math.min(width, height) * 0.11)}" fill="#fb7185" opacity="0.72"/>
  <circle cx="${Math.round(width * 0.78)}" cy="${Math.round(height * 0.38)}" r="${Math.round(Math.min(width, height) * 0.15)}" fill="#60a5fa" opacity="0.56"/>
  <rect x="${Math.round(width * 0.1)}" y="${Math.round(height * 0.58)}" width="${Math.round(width * 0.8)}" height="${Math.round(height * 0.24)}" rx="28" fill="#ffffff" opacity="0.9" filter="url(#fal-shadow)"/>
  <text x="50%" y="${Math.round(height * 0.68)}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.05)}" font-weight="700" fill="#111827">${prompt}</text>
  <text x="50%" y="${Math.round(height * 0.755)}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.025)}" fill="#64748b">Mock fal • ${model} • ${requestId}</text>
</svg>`;
  return new TextEncoder().encode(svg);
}

function resolveFfmpegPath(): string | null {
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
  ].filter((value): value is string => !!value);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveQlmanagePath(): string | null {
  const candidates = ["/usr/bin/qlmanage"].filter((value): value is string => !!value);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const FONT_5X7: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "/": ["00001", "00010", "00100", "01000", "10000", "00000", "00000"],
  "_": ["00000", "00000", "00000", "00000", "00000", "00000", "11111"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01111", "10000", "10000", "10011", "10001", "10001", "01110"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function makePrintableFrameText(prompt: string): string {
  if (/^[\x20-\x7E]+$/.test(prompt)) return prompt;
  return `UTF8 ${Buffer.from(prompt, "utf8").toString("hex").slice(0, 72)}`;
}

function wrapDisplayText(text: string, maxChars: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return ["Mock fal video"];
  const lines: string[] = [];
  let current = "";

  for (const segment of normalized.split(" ")) {
    const hardParts =
      segment.length > maxChars
        ? Array.from({ length: Math.ceil(segment.length / maxChars) }, (_, index) =>
            segment.slice(index * maxChars, (index + 1) * maxChars),
          )
        : [segment];
    for (const part of hardParts) {
      const next = current ? `${current} ${part}` : part;
      if (next.length > maxChars && current) {
        lines.push(current);
        current = part;
      } else {
        current = next;
      }
    }
  }

  if (current) lines.push(current);
  return lines.slice(0, 3);
}

interface VideoFrameLayout {
  canvasWidth: number;
  canvasHeight: number;
  contentX: number;
  contentY: number;
  contentWidth: number;
  contentHeight: number;
}

function makeVideoFrameLayout(record: FalMockRecord): VideoFrameLayout {
  const size = Math.max(record.width, record.height);
  if (record.width >= record.height) {
    const contentHeight = Math.round(size * (record.height / record.width));
    return {
      canvasWidth: size,
      canvasHeight: size,
      contentX: 0,
      contentY: Math.round((size - contentHeight) / 2),
      contentWidth: size,
      contentHeight,
    };
  }

  const contentWidth = Math.round(size * (record.width / record.height));
  return {
    canvasWidth: size,
    canvasHeight: size,
    contentX: Math.round((size - contentWidth) / 2),
    contentY: 0,
    contentWidth,
    contentHeight: size,
  };
}

function makeEven(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

function makeVideoFrameSvg(record: FalMockRecord, layout: VideoFrameLayout): string {
  const { canvasWidth, canvasHeight, contentX, contentY, contentWidth, contentHeight } = layout;
  const { width, height } = record;
  const promptLines = wrapDisplayText(record.prompt, Math.max(8, Math.floor(width / 26)));
  const lineHeight = Math.round(Math.min(width, height) * 0.062);
  const promptFontSize = Math.round(Math.min(width, height) * 0.048);
  const promptStartY = Math.round(contentY + contentHeight * 0.62 - ((promptLines.length - 1) * lineHeight) / 2);
  const meta = `${record.durationSec}s • ${record.modelId}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">
  <defs>
    <linearGradient id="video-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f8fafc"/>
      <stop offset="45%" stop-color="#fff1f2"/>
      <stop offset="100%" stop-color="#dbeafe"/>
    </linearGradient>
    <filter id="video-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#111827" flood-opacity="0.14"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" rx="36" fill="url(#video-bg)"/>
  <circle cx="${Math.round(contentX + contentWidth * 0.2)}" cy="${Math.round(contentY + contentHeight * 0.26)}" r="${Math.round(Math.min(width, height) * 0.1)}" fill="#fb7185" opacity="0.76"/>
  <circle cx="${Math.round(contentX + contentWidth * 0.78)}" cy="${Math.round(contentY + contentHeight * 0.35)}" r="${Math.round(Math.min(width, height) * 0.14)}" fill="#93c5fd" opacity="0.68"/>
  <rect x="${Math.round(contentX + contentWidth * 0.09)}" y="${Math.round(contentY + contentHeight * 0.54)}" width="${Math.round(contentWidth * 0.82)}" height="${Math.round(contentHeight * 0.27)}" rx="28" fill="#ffffff" opacity="0.92" filter="url(#video-shadow)"/>
  <text x="${Math.round(contentX + contentWidth * 0.5)}" y="${Math.round(contentY + contentHeight * 0.19)}" text-anchor="middle" font-family="PingFang SC, Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.038)}" font-weight="700" fill="#fb5f4b">Mock fal video</text>
  ${promptLines
    .map(
      (line, index) =>
        `<text x="${Math.round(contentX + contentWidth * 0.5)}" y="${promptStartY + index * lineHeight}" text-anchor="middle" font-family="PingFang SC, Hiragino Sans GB, Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${promptFontSize}" font-weight="700" fill="#111827">${escapeXml(line)}</text>`,
    )
    .join("\n  ")}
  <text x="${Math.round(contentX + contentWidth * 0.5)}" y="${Math.round(contentY + contentHeight * 0.755)}" text-anchor="middle" font-family="Inter, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.round(Math.min(width, height) * 0.024)}" fill="#64748b">${escapeXml(meta)}</text>
</svg>`;
}

async function makeRenderedVideoFrame(record: FalMockRecord, dir: string): Promise<{ path: string; layout: VideoFrameLayout } | null> {
  const qlmanage = resolveQlmanagePath();
  if (!qlmanage) return null;

  const layout = makeVideoFrameLayout(record);
  const svgPath = join(dir, "frame.svg");
  await writeFile(svgPath, makeVideoFrameSvg(record, layout), "utf8");
  await execFileAsync(
    qlmanage,
    ["-t", "-s", String(layout.canvasWidth), "-o", dir, svgPath],
    { timeout: 10_000, maxBuffer: 1024 * 1024 * 10 },
  );

  const pngPath = `${svgPath}.png`;
  return existsSync(pngPath) ? { path: pngPath, layout } : null;
}

function makePpmFrame(record: FalMockRecord): Buffer {
  const { width, height } = record;
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const pixels = Buffer.alloc(width * height * 3);
  const setPixel = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 3;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
  };
  const fillRect = (x: number, y: number, w: number, h: number, color: [number, number, number]) => {
    for (let yy = Math.max(0, Math.floor(y)); yy < Math.min(height, Math.ceil(y + h)); yy += 1) {
      for (let xx = Math.max(0, Math.floor(x)); xx < Math.min(width, Math.ceil(x + w)); xx += 1) {
        setPixel(xx, yy, color[0], color[1], color[2]);
      }
    }
  };
  const drawChar = (ch: string, x: number, y: number, scale: number, color: [number, number, number]) => {
    const glyph = FONT_5X7[ch.toUpperCase()] ?? FONT_5X7["?"];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== "1") continue;
        fillRect(x + col * scale, y + row * scale, scale, scale, color);
      }
    }
  };
  const drawText = (text: string, x: number, y: number, scale: number, color: [number, number, number]) => {
    let cursorX = x;
    for (const raw of text) {
      drawChar(raw, cursorX, y, scale, color);
      cursorX += 6 * scale;
    }
  };
  const wrapText = (text: string, maxChars: number) => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 3);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = x / Math.max(1, width - 1);
      const u = y / Math.max(1, height - 1);
      setPixel(x, y, 248 - Math.round(18 * u), 250 - Math.round(22 * t), 252);
    }
  }
  fillRect(width * 0.1, height * 0.58, width * 0.8, height * 0.24, [255, 255, 255]);
  fillRect(width * 0.18, height * 0.22, Math.min(width, height) * 0.18, Math.min(width, height) * 0.18, [251, 113, 133]);
  fillRect(width * 0.68, height * 0.28, Math.min(width, height) * 0.2, Math.min(width, height) * 0.2, [147, 197, 253]);

  const scale = Math.max(3, Math.round(Math.min(width, height) / 180));
  const maxChars = Math.max(10, Math.floor((width * 0.72) / (6 * scale)));
  const lines = wrapText(makePrintableFrameText(record.prompt || "Mock fal video").toUpperCase(), maxChars);
  const lineHeight = 9 * scale;
  const startY = Math.round(height * 0.63 - ((lines.length - 1) * lineHeight) / 2);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const textWidth = line.length * 6 * scale;
    drawText(line, Math.round((width - textWidth) / 2), startY + i * lineHeight, scale, [17, 24, 39]);
  }
  const meta = `${record.durationSec}S ${record.modelId}`.toUpperCase();
  const metaScale = Math.max(2, Math.round(scale * 0.7));
  drawText(
    meta.slice(0, maxChars),
    Math.round((width - Math.min(meta.length, maxChars) * 6 * metaScale) / 2),
    Math.round(height * 0.77),
    metaScale,
    [100, 116, 139],
  );
  return Buffer.concat([header, pixels]);
}

async function makeMp4(record: FalMockRecord): Promise<FalMockMedia> {
  const ffmpeg = resolveFfmpegPath();
  if (!ffmpeg) {
    return {
      bytes: makeSvg(record),
      contentType: "video/mp4",
      extension: ".mp4",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "clash-fal-video-"));
  const framePath = join(dir, "frame.ppm");
  const outputPath = join(dir, "mock.mp4");

  try {
    const renderedFrame = await makeRenderedVideoFrame(record, dir).catch(() => null);
    const inputFramePath = renderedFrame?.path ?? framePath;
    if (!renderedFrame) {
      await writeFile(framePath, makePpmFrame(record));
    }
    const videoFilter = renderedFrame
      ? `crop=${makeEven(renderedFrame.layout.contentWidth)}:${makeEven(renderedFrame.layout.contentHeight)}:${makeEven(renderedFrame.layout.contentX)}:${makeEven(renderedFrame.layout.contentY)},scale=${record.width}:${record.height},setsar=1`
      : undefined;
    await withMediaProcessDeadline(
      {
        code: "MEDIA_PROCESS_TIMEOUT",
        timeoutMs: MEDIA_PROCESS_TIMEOUTS_MS.mockVideo,
        task: `render mock fal video ${record.modelId}`,
      },
      (signal) =>
        execFileAsync(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            inputFramePath,
            "-t",
            String(record.durationSec),
            "-an",
            ...(videoFilter ? ["-vf", videoFilter] : []),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-metadata",
            `comment=Mock fal prompt: ${record.prompt}`,
            "-y",
            outputPath,
          ],
          { signal, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 * 10 },
        ),
    );
    return {
      bytes: await readFile(outputPath),
      contentType: "video/mp4",
      extension: ".mp4",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function waveformForPrompt(prompt: string, bars = 128): number[] {
  const seed = Math.abs(hashString(prompt || "mock-audio"));
  return Array.from({ length: bars }, (_, index) => {
    const a = Math.sin((index + 1) * ((seed % 17) + 3) * 0.13);
    const b = Math.sin((index + 1) * ((seed % 29) + 5) * 0.047);
    return Number(Math.max(0.08, Math.min(1, Math.abs(a * 0.55 + b * 0.35))).toFixed(3));
  });
}

function makeInfoChunk(prompt: string, durationSec: number, requestId: string): Buffer {
  const text = `Mock fal audio | duration=${durationSec}s | prompt=${prompt} | request=${requestId}`;
  const encoded = Buffer.from(`${text}\0`, "utf8");
  const padded = encoded.length % 2 === 0 ? encoded : Buffer.concat([encoded, Buffer.from([0])]);
  const sub = Buffer.alloc(8);
  sub.write("ICMT", 0, "ascii");
  sub.writeUInt32LE(padded.length, 4);
  const listSize = 4 + sub.length + padded.length;
  const header = Buffer.alloc(8);
  header.write("LIST", 0, "ascii");
  header.writeUInt32LE(listSize, 4);
  return Buffer.concat([header, Buffer.from("INFO", "ascii"), sub, padded]);
}

function makeWav(record: FalMockRecord): FalMockMedia {
  const sampleRate = 44_100;
  const channels = 1;
  const bitsPerSample = 16;
  const samples = Math.max(1, Math.round(record.durationSec * sampleRate));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const infoChunk = makeInfoChunk(record.prompt, record.durationSec, record.requestId);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const riffSize = 4 + (8 + 16) + (8 + dataSize) + infoChunk.length;
  const buffer = Buffer.alloc(8 + riffSize);
  let offset = 0;

  buffer.write("RIFF", offset, "ascii"); offset += 4;
  buffer.writeUInt32LE(riffSize, offset); offset += 4;
  buffer.write("WAVE", offset, "ascii"); offset += 4;
  buffer.write("fmt ", offset, "ascii"); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;
  buffer.writeUInt16LE(1, offset); offset += 2;
  buffer.writeUInt16LE(channels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;
  buffer.write("data", offset, "ascii"); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  const frequency = 220 + (record.seed % 420);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, i / (sampleRate * 0.05), (samples - i) / (sampleRate * 0.08));
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.28 * Math.max(0, envelope);
    buffer.writeInt16LE(Math.round(sample * 32767), offset);
    offset += 2;
  }
  infoChunk.copy(buffer, offset);

  return {
    bytes: buffer,
    contentType: "audio/wav",
    extension: ".wav",
  };
}

async function makeMedia(record: FalMockRecord): Promise<FalMockMedia> {
  if (record.kind === "image") {
    return {
      bytes: makeSvg(record),
      contentType: "image/svg+xml",
      extension: ".svg",
    };
  }
  if (record.kind === "video") return makeMp4(record);
  return makeWav(record);
}

function log(message: string, offsetMs = 0): FalQueueLog {
  return {
    message,
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
  };
}

function statusForRecord(record: FalMockRecord, includeLogs: boolean, origin: string): FalQueueStatus {
  const response_url = requestUrl(origin, record.modelId, record.requestId, "/response");
  if (record.statusChecks <= 1) {
    return {
      status: "IN_QUEUE",
      request_id: record.requestId,
      queue_position: 0,
      response_url,
    };
  }
  if (record.statusChecks === 2) {
    return {
      status: "IN_PROGRESS",
      request_id: record.requestId,
      response_url,
      ...(includeLogs
        ? {
            logs: [
              log("Loading model weights..."),
              log(`Generating ${record.kind}...`, 250),
            ],
          }
        : {}),
    };
  }
  return {
    status: "COMPLETED",
    request_id: record.requestId,
    response_url,
    ...(includeLogs ? { logs: [log("Done.")] } : {}),
    metrics: {
      inference_time: Number(((Date.now() - record.createdAt) / 1000 || 0.01).toFixed(2)),
    },
  };
}

export function createMockFalQueueService(): FalMockQueueService {
  const records = new Map<string, FalMockRecord>();

  return {
    async submit(modelId, rawInput, options) {
      const input = normalizeFalInput(rawInput);
      const requestId = `fal-mock-${randomUUID()}`;
      const prompt = stringValue(input.prompt) ?? stringValue(input.text) ?? "Mock fal output";
      const kind = inferOutputKind(modelId, input);
      const { width, height } = dimensionsForInput(input);
      const durationSec = kind === "image" ? 0 : durationForInput(input, kind === "audio" ? 5 : 4);
      const record: FalMockRecord = {
        requestId,
        modelId,
        kind,
        input,
        prompt,
        seed: Math.abs(hashString(`${modelId}:${prompt}:${requestId}`)),
        width,
        height,
        durationSec,
        waveform: waveformForPrompt(prompt),
        createdAt: Date.now(),
        statusChecks: 0,
        cancelled: false,
        media: {
          bytes: new Uint8Array(),
          contentType: "application/octet-stream",
          extension: ".bin",
        },
      };
      record.media = await makeMedia(record);
      records.set(requestId, record);
      const origin = normalizeOrigin(options?.origin);
      return {
        request_id: requestId,
        response_url: requestUrl(origin, modelId, requestId, "/response"),
        status_url: requestUrl(origin, modelId, requestId, "/status"),
        cancel_url: requestUrl(origin, modelId, requestId, "/cancel"),
        queue_position: 0,
      };
    },

    status(modelId, requestId, options) {
      const record = records.get(requestId);
      if (!record || record.modelId !== modelId || record.cancelled) return null;
      record.statusChecks += 1;
      return statusForRecord(record, !!options?.logs, normalizeOrigin(options?.origin));
    },

    result(modelId, requestId, options) {
      const record = records.get(requestId);
      if (!record || record.modelId !== modelId || record.cancelled) return null;
      record.statusChecks = Math.max(record.statusChecks, 3);
      const origin = normalizeOrigin(options?.origin);
      const url = mediaUrl(origin, requestId, record.media.extension);

      if (record.kind === "video") {
        return {
          video: {
            url,
            width: record.width,
            height: record.height,
            duration: record.durationSec,
            content_type: record.media.contentType,
          },
          prompt: record.prompt,
          seed: record.seed,
        };
      }

      if (record.kind === "audio") {
        return {
          audio: {
            url,
            duration: record.durationSec,
            content_type: record.media.contentType,
          },
          prompt: record.prompt,
          transcript: record.prompt,
          seed: record.seed,
          waveform: record.waveform,
        };
      }

      return {
        images: [
          {
            url,
            width: record.width,
            height: record.height,
            content_type: record.media.contentType,
          },
        ],
        prompt: record.prompt,
        seed: record.seed,
        has_nsfw_concepts: [false],
      };
    },

    cancel(modelId, requestId) {
      const record = records.get(requestId);
      if (!record || record.modelId !== modelId) return false;
      record.cancelled = true;
      return true;
    },

    media(requestId) {
      return records.get(requestId)?.media ?? null;
    },
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

export async function handleFalMockHttpRequest(
  service: FalMockQueueService,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const prefix = "/fal/";
  if (!url.pathname.startsWith(prefix)) return jsonResponse({ error: "Not found" }, 404);
  const rest = url.pathname.slice(prefix.length);

  if (rest.startsWith("media/")) {
    const file = rest.slice("media/".length);
    const requestId = file.replace(/\.[^.]+$/, "");
    const media = service.media(requestId);
    if (!media) return new Response("Media not found", { status: 404 });
    return new Response(arrayBufferBody(media.bytes), {
      headers: {
        "content-type": media.contentType,
        "content-length": String(media.bytes.byteLength),
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  const requestMarker = "/requests/";
  const markerIndex = rest.indexOf(requestMarker);
  if (markerIndex === -1) {
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    const input = normalizeFalInput(await request.json().catch(() => ({})));
    return jsonResponse(await service.submit(rest, input, { origin: url.origin }));
  }

  const modelId = rest.slice(0, markerIndex);
  const requestPath = rest.slice(markerIndex + requestMarker.length);
  const [requestId, action = "response"] = requestPath.split("/");

  if (!requestId) return jsonResponse({ error: "Missing request_id" }, 400);

  if (action === "status") {
    const status = service.status(modelId, requestId, {
      origin: url.origin,
      logs: url.searchParams.get("logs") === "1" || url.searchParams.get("logs") === "true",
    });
    if (!status) return jsonResponse({ error: "Request not found" }, 404);
    return jsonResponse(status, status.status === "COMPLETED" ? 200 : 202);
  }

  if (action === "response" || action === "") {
    const result = service.result(modelId, requestId, { origin: url.origin });
    if (!result) return jsonResponse({ error: "Request not found" }, 404);
    return jsonResponse(result);
  }

  if (action === "cancel") {
    if (request.method !== "POST" && request.method !== "DELETE") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    return service.cancel(modelId, requestId)
      ? jsonResponse({ ok: true })
      : jsonResponse({ error: "Request not found" }, 404);
  }

  return jsonResponse({ error: "Not found" }, 404);
}
