import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  ProjectAssetMetadataSchema,
  ResourceSchema,
  type AssetKind,
  type ProjectAssetMetadata,
  type Resource,
} from "@clash/shared-types";
import {
  Logger,
  NodeIO,
  type GLTF,
  type JSONDocument,
} from "@gltf-transform/core";
import { SaxesParser } from "saxes";

import {
  createLocalResourceStore,
  type LocalResourceProjection,
} from "./local-resource-store.js";
export { localFfprobePath } from "./local-media-binaries.js";

interface SqliteRunResult {
  changes: number | bigint;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

const LOCAL_ASSET_INSPECTION_RECIPE =
  "asset-inspection/v4:canonical-media-facts";

const LocalAssetInspectionFactsSchema = ProjectAssetMetadataSchema.pick({
  width: true,
  height: true,
  rotationDegrees: true,
  durationMs: true,
  contentType: true,
  frameRate: true,
  videoCodec: true,
  hasAudio: true,
  audioCodec: true,
  sampleRate: true,
  channelCount: true,
  channelLayout: true,
});

export type LocalAssetInspectionFacts = Pick<
  ProjectAssetMetadata,
  | "width"
  | "height"
  | "rotationDegrees"
  | "durationMs"
  | "contentType"
  | "frameRate"
  | "videoCodec"
  | "hasAudio"
  | "audioCodec"
  | "sampleRate"
  | "channelCount"
  | "channelLayout"
>;

export interface LocalAssetInspectorInput {
  sourcePath: string;
  resource: Resource;
}

export type LocalAssetInspector = (
  input: LocalAssetInspectorInput,
) => Promise<LocalAssetInspectionFacts>;

type LocalFfprobeRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function canonicalChannelLayout(value: unknown): string | undefined {
  const layout = optionalNonEmptyString(value);
  return layout?.toLowerCase() === "unknown" ? undefined : layout;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function frameRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function durationMs(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1_000);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function displayMatrixSideData(
  video: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const sideData = Array.isArray(video.side_data_list)
    ? video.side_data_list
        .map(record)
        .filter((item): item is Record<string, unknown> => !!item)
    : [];
  return sideData.find((item) => item.side_data_type === "Display Matrix");
}

function displayRotationDegrees(video: Record<string, unknown>): number {
  const displayMatrix = displayMatrixSideData(video);
  if (!displayMatrix) return 0;
  const rotation = displayMatrix.rotation;
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) {
    throw new Error("Decoded visual Asset has a malformed display rotation.");
  }
  const normalized = ((rotation % 360) + 360) % 360;
  const canonical = Object.is(normalized, -0) ? 0 : normalized;
  if (![0, 90, 180, 270].includes(canonical)) {
    throw new Error(
      "Decoded visual Asset has an unsupported non-quarter-turn display rotation.",
    );
  }
  return canonical;
}

function mediaTypeParameters(value: string | undefined): {
  essence: string;
  parameters: Map<string, string>;
} {
  const [rawEssence = "", ...rawParameters] = (value ?? "").split(";");
  const parameters = new Map<string, string>();
  for (const rawParameter of rawParameters) {
    const separator = rawParameter.indexOf("=");
    if (separator <= 0) continue;
    parameters.set(
      rawParameter.slice(0, separator).trim().toLowerCase(),
      rawParameter
        .slice(separator + 1)
        .trim()
        .toLowerCase(),
    );
  }
  return { essence: rawEssence.trim().toLowerCase(), parameters };
}

export function canonicalAssetMediaTypeAssertion(
  value: string | undefined,
): string | undefined {
  if (!value?.trim()) return undefined;
  const { essence, parameters } = mediaTypeParameters(value);
  const canonicalEssence =
    essence === "image/jpg"
      ? "image/jpeg"
      : essence === "audio/x-wav"
        ? "audio/wav"
        : essence === "audio/mp3"
          ? "audio/mpeg"
          : essence;
  const serializedParameters = [...parameters.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, parameter]) => `${key}=${parameter}`)
    .join(";");
  return serializedParameters
    ? `${canonicalEssence};${serializedParameters}`
    : canonicalEssence;
}

function assertByteVerifiableMediaType(value: string | undefined): void {
  const { essence } = mediaTypeParameters(value);
  if (essence === "audio/l16" || essence === "audio/pcm") {
    throw new Error(
      "Headerless raw PCM cannot be published as canonical Asset media without a trusted byte-derived source contract; wrap it in a self-describing audio container.",
    );
  }
}

function sameMediaTypeAssertion(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftParsed = mediaTypeParameters(left);
  const rightParsed = mediaTypeParameters(right);
  if (leftParsed.essence !== rightParsed.essence) return false;
  return (
    leftParsed.parameters.size === rightParsed.parameters.size &&
    [...leftParsed.parameters].every(
      ([key, value]) => rightParsed.parameters.get(key) === value,
    )
  );
}

function registeredMediaTypeAssertion(resource: Resource): string | undefined {
  const canonical = canonicalAssetMediaTypeAssertion(resource.contentType);
  if (!canonical) return undefined;
  assertByteVerifiableMediaType(canonical);
  const { essence } = mediaTypeParameters(canonical);
  const matches =
    (resource.kind === "image" && essence.startsWith("image/")) ||
    (resource.kind === "video" && essence.startsWith("video/")) ||
    (resource.kind === "audio" && essence.startsWith("audio/")) ||
    (resource.kind === "model" &&
      (essence === "model/gltf-binary" || essence === "model/gltf+json"));
  if (!matches) {
    throw new Error(
      `Registered ${resource.kind} Asset content type ${resource.contentType ?? "(missing)"} does not match its kind.`,
    );
  }
  return essence;
}

function decodedMediaType(input: {
  kind: Exclude<AssetKind, "model">;
  formatName?: string;
  videoCodec?: string;
  majorBrand?: string;
  matroskaDocType?: "matroska" | "webm";
}): string {
  const formatNames = new Set(
    (input.formatName ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (input.kind === "image") {
    const codec = input.videoCodec?.toLowerCase();
    const mediaType =
      codec === "png"
        ? "image/png"
        : codec === "mjpeg" || codec === "jpeg2000"
          ? codec === "mjpeg"
            ? "image/jpeg"
            : "image/jp2"
          : codec === "gif"
            ? "image/gif"
            : codec === "webp"
              ? "image/webp"
              : codec === "svg"
                ? "image/svg+xml"
                : codec === "av1" && formatNames.has("mov")
                  ? "image/avif"
                  : undefined;
    if (mediaType) return mediaType;
  } else if (
    formatNames.has("matroska") &&
    formatNames.has("webm") &&
    input.matroskaDocType
  ) {
    return input.kind === "video"
      ? input.matroskaDocType === "webm"
        ? "video/webm"
        : "video/x-matroska"
      : input.matroskaDocType === "webm"
        ? "audio/webm"
        : "audio/x-matroska";
  } else if (formatNames.has("webm")) {
    return input.kind === "video" ? "video/webm" : "audio/webm";
  } else if (formatNames.has("matroska")) {
    return input.kind === "video" ? "video/x-matroska" : "audio/x-matroska";
  } else if (
    formatNames.has("mov") ||
    formatNames.has("mp4") ||
    formatNames.has("m4a") ||
    formatNames.has("3gp") ||
    formatNames.has("3g2") ||
    formatNames.has("mj2")
  ) {
    return input.kind === "video"
      ? input.majorBrand?.trim().toLowerCase() === "qt"
        ? "video/quicktime"
        : "video/mp4"
      : "audio/mp4";
  } else if (input.kind === "video" && formatNames.has("mpegts")) {
    return "video/mp2t";
  } else if (input.kind === "video" && formatNames.has("avi")) {
    return "video/x-msvideo";
  } else if (input.kind === "audio" && formatNames.has("mp3")) {
    return "audio/mpeg";
  } else if (input.kind === "audio" && formatNames.has("wav")) {
    return "audio/wav";
  } else if (input.kind === "audio" && formatNames.has("flac")) {
    return "audio/flac";
  } else if (input.kind === "audio" && formatNames.has("ogg")) {
    return "audio/ogg";
  } else if (input.kind === "audio" && formatNames.has("aac")) {
    return "audio/aac";
  }
  throw new Error(
    `Decoded ${input.kind} Asset format ${input.formatName ?? "(missing)"}/${input.videoCodec ?? "(missing)"} has no canonical media type mapping.`,
  );
}

function verifiedDecodedMediaType(input: {
  resource: Resource;
  registeredEssence?: string;
  formatName?: string;
  videoCodec?: string;
  majorBrand?: string;
  matroskaDocType?: "matroska" | "webm";
}): string {
  if (input.resource.kind === "model") {
    throw new Error("Model media type verification uses the glTF byte probe.");
  }
  const decoded = decodedMediaType({
    kind: input.resource.kind,
    ...(input.formatName ? { formatName: input.formatName } : {}),
    ...(input.videoCodec ? { videoCodec: input.videoCodec } : {}),
    ...(input.majorBrand ? { majorBrand: input.majorBrand } : {}),
    ...(input.matroskaDocType
      ? { matroskaDocType: input.matroskaDocType }
      : {}),
  });
  if (
    input.registeredEssence !== undefined &&
    decoded !== input.registeredEssence
  ) {
    throw new Error(
      `Decoded ${input.resource.kind} Asset has canonical media type ${decoded}, not registered ${input.registeredEssence}.`,
    );
  }
  return decoded;
}

async function inspectEbmlDocType(
  sourcePath: string,
  resource: Resource,
): Promise<"matroska" | "webm"> {
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength !== resource.byteLength) {
    throw new Error("EBML Asset bytes do not match immutable Resource length.");
  }
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    throw new Error("Matroska/WebM Asset bytes contain no EBML header.");
  }
  const limit = Math.min(bytes.byteLength - 3, 64 * 1024);
  for (let offset = 4; offset < limit; offset += 1) {
    if (bytes[offset] !== 0x42 || bytes[offset + 1] !== 0x82) continue;
    const first = bytes[offset + 2]!;
    let sizeLength = 1;
    let marker = 0x80;
    while (sizeLength <= 8 && (first & marker) === 0) {
      sizeLength += 1;
      marker >>= 1;
    }
    if (sizeLength > 8 || offset + 2 + sizeLength > bytes.byteLength) {
      break;
    }
    let size = first & (marker - 1);
    for (let index = 1; index < sizeLength; index += 1) {
      size = size * 256 + bytes[offset + 2 + index]!;
    }
    const start = offset + 2 + sizeLength;
    const end = start + size;
    if (size <= 0 || end > bytes.byteLength || size > 32) break;
    const value = bytes.subarray(start, end).toString("ascii").toLowerCase();
    if (value === "matroska" || value === "webm") return value;
    throw new Error(`Unsupported EBML document type ${value || "(empty)"}.`);
  }
  throw new Error("Matroska/WebM Asset bytes contain no EBML DocType.");
}

async function readFileSlice(
  file: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer | undefined> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) return undefined;
    offset += bytesRead;
  }
  return bytes;
}

async function inspectWaveChannelLayout(
  sourcePath: string,
  resource: Resource,
  decodedChannelCount: number,
): Promise<"mono" | "stereo" | undefined> {
  const file = await open(sourcePath, "r");
  try {
    const { size } = await file.stat();
    if (size !== resource.byteLength) {
      throw new Error(
        "WAVE Asset bytes do not match immutable Resource length.",
      );
    }
    const riff = await readFileSlice(file, 0, 12);
    if (
      !riff ||
      riff.subarray(0, 4).toString("ascii") !== "RIFF" ||
      riff.subarray(8, 12).toString("ascii") !== "WAVE"
    ) {
      return undefined;
    }

    let offset = 12;
    while (offset + 8 <= size) {
      const header = await readFileSlice(file, offset, 8);
      if (!header) return undefined;
      const chunkSize = header.readUInt32LE(4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + chunkSize;
      if (chunkEnd > size) {
        throw new Error("WAVE Asset contains a truncated RIFF chunk.");
      }
      if (header.subarray(0, 4).toString("ascii") === "fmt ") {
        if (chunkSize < 16) {
          throw new Error("WAVE Asset contains an incomplete fmt chunk.");
        }
        const format = await readFileSlice(file, chunkStart, 16);
        if (!format) {
          throw new Error("WAVE Asset contains an incomplete fmt chunk.");
        }
        const formatTag = format.readUInt16LE(0);
        const channelCount = format.readUInt16LE(2);
        if (channelCount !== decodedChannelCount) {
          throw new Error(
            "WAVE fmt channel count disagrees with the decoded audio stream.",
          );
        }
        if (formatTag !== 0x0001 && formatTag !== 0x0003) return undefined;
        return channelCount === 1
          ? "mono"
          : channelCount === 2
            ? "stereo"
            : undefined;
      }
      offset = chunkEnd + (chunkSize % 2);
    }
    return undefined;
  } finally {
    await file.close();
  }
}

function requireFact<T>(
  value: T | undefined,
  name: string,
  kind: AssetKind,
): T {
  if (value === undefined) {
    throw new Error(`Decoded ${kind} Asset is missing canonical ${name}.`);
  }
  return value;
}

const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;
// The GLB header stores its total length as uint32.
const GLB_MAX_BYTE_LENGTH = 0xffff_ffff;
const GLB_MAX_JSON_CHUNK_BYTE_LENGTH = 64 * 1024 * 1024;
const GLTF_INSPECTION_IMAGE_URI = "__clash-inspection-image";
const gltfIo = new NodeIO().setLogger(new Logger(Logger.Verbosity.SILENT));

// The glTF Transform reader copies every accessor and embedded image out of
// its buffer, so reading the real document needs the whole BIN payload in
// memory. Inspection only has the JSON, so the reader gets a copy with the
// payload-bearing structure removed: no buffers or buffer views, zero-length
// accessors, and one empty placeholder resource for every image. Scenes, nodes,
// meshes, materials, skins, animations, and cameras are still parsed by the
// library. Extension declarations are dropped because the reader rejects any
// required extension it has no implementation for, and a compressed model is
// still a model.
function gltfStructureDocument(json: GLTF.IGLTF): JSONDocument {
  const {
    buffers: _buffers,
    bufferViews: _bufferViews,
    extensionsUsed: _extensionsUsed,
    extensionsRequired: _extensionsRequired,
    ...structure
  } = json;
  return {
    json: {
      ...structure,
      // The reader accepts exactly "2.0"; parseGltfDocument owns the 2.x rule.
      asset: { ...json.asset, version: "2.0" },
      ...(json.accessors
        ? {
            accessors: json.accessors.map(
              ({ bufferView: _bufferView, sparse: _sparse, ...accessor }) => ({
                ...accessor,
                count: 0,
              }),
            ),
          }
        : {}),
      ...(json.images
        ? {
            images: json.images.map(
              ({ bufferView: _bufferView, uri: _uri, ...image }) => ({
                ...image,
                uri: GLTF_INSPECTION_IMAGE_URI,
              }),
            ),
          }
        : {}),
    },
    resources: { [GLTF_INSPECTION_IMAGE_URI]: new Uint8Array(0) },
  };
}

async function parseGltfDocument(text: string): Promise<void> {
  const value: unknown = JSON.parse(text);
  const root = record(value);
  const asset = record(root?.asset);
  const version = optionalNonEmptyString(asset?.version);
  if (!version || !/^2(?:\.|$)/.test(version)) {
    throw new Error(
      "glTF Asset bytes do not declare a supported 2.x asset version.",
    );
  }
  await gltfIo.readJSON(gltfStructureDocument(value as GLTF.IGLTF));
}

async function inspectGltf(
  sourcePath: string,
  resource: Resource,
  registeredEssence: string | undefined,
): Promise<LocalAssetInspectionFacts> {
  const file = await open(sourcePath, "r");
  try {
    const { size } = await file.stat();
    if (size !== resource.byteLength) {
      throw new Error(
        "glTF Asset bytes do not match immutable Resource length.",
      );
    }
    const magic = await readFileSlice(file, 0, Math.min(size, 4));
    const decodedEssence =
      size >= 4 && magic?.toString() === "glTF"
        ? "model/gltf-binary"
        : "model/gltf+json";
    if (
      registeredEssence !== undefined &&
      registeredEssence !== decodedEssence
    ) {
      throw new Error(
        `Decoded model Asset has canonical media type ${decodedEssence}, not registered ${registeredEssence}.`,
      );
    }
    if (decodedEssence === "model/gltf+json") {
      try {
        await parseGltfDocument(await file.readFile("utf8"));
      } catch (error) {
        throw new Error("glTF JSON Asset bytes are invalid.", { cause: error });
      }
    } else {
      if (size > GLB_MAX_BYTE_LENGTH) {
        throw new Error(
          `GLB Asset is ${size} bytes; a glTF binary container cannot exceed ${GLB_MAX_BYTE_LENGTH} bytes (4 GiB).`,
        );
      }
      // Only the container header and the JSON chunk are read; the BIN chunk
      // can be gigabytes and inspection publishes nothing derived from it.
      const header = size >= 20 ? await readFileSlice(file, 0, 20) : undefined;
      if (!header) {
        throw new Error("GLB Asset bytes do not contain a valid glTF header.");
      }
      const version = header.readUInt32LE(4);
      const declaredLength = header.readUInt32LE(8);
      const jsonLength = header.readUInt32LE(12);
      const jsonType = header.readUInt32LE(16);
      if (
        version !== 2 ||
        declaredLength !== size ||
        jsonType !== GLB_JSON_CHUNK_TYPE ||
        jsonLength > size - 20
      ) {
        throw new Error(
          "GLB Asset bytes do not contain a valid glTF 2 JSON chunk.",
        );
      }
      if (jsonLength > GLB_MAX_JSON_CHUNK_BYTE_LENGTH) {
        throw new Error(
          `GLB Asset JSON chunk is ${jsonLength} bytes; inspection accepts at most ${GLB_MAX_JSON_CHUNK_BYTE_LENGTH} bytes.`,
        );
      }
      try {
        const json = await readFileSlice(file, 20, jsonLength);
        if (!json) throw new Error("GLB Asset JSON chunk is truncated.");
        await parseGltfDocument(json.toString("utf8"));
      } catch (error) {
        throw new Error("GLB Asset JSON chunk is invalid.", { cause: error });
      }
    }
    return LocalAssetInspectionFactsSchema.parse({
      contentType: decodedEssence,
    });
  } finally {
    await file.close();
  }
}

function svgPixelLength(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function svgDocumentRoot(text: string): string | undefined {
  let document = text.replace(/^\uFEFF/u, "").trimStart();
  if (/^<\?xml\b/i.test(document)) {
    const declarationEnd = document.indexOf("?>");
    if (declarationEnd < 0) return undefined;
    document = document.slice(declarationEnd + 2).trimStart();
  }
  while (document.startsWith("<!--")) {
    const commentEnd = document.indexOf("-->");
    if (commentEnd < 0) return undefined;
    document = document.slice(commentEnd + 3).trimStart();
  }
  return /^<svg\b[^>]*>/i.exec(document)?.[0];
}

interface SvgRootAttributes {
  width?: string;
  height?: string;
  viewBox?: string;
}

function assertWellFormedSvgDocument(text: string): SvgRootAttributes {
  const parser = new SaxesParser({ xmlns: true });
  let sawRoot = false;
  let rootAttributes: SvgRootAttributes | undefined;
  parser.on("doctype", () => {
    throw new Error("SVG documents with a DOCTYPE are not accepted.");
  });
  parser.on("opentag", (tag) => {
    if (sawRoot) return;
    sawRoot = true;
    if (
      tag.local.toLowerCase() !== "svg" ||
      (tag.uri !== "" && tag.uri !== "http://www.w3.org/2000/svg")
    ) {
      throw new Error("The XML document root is not an SVG element.");
    }
    rootAttributes = {
      ...(tag.attributes.width
        ? { width: tag.attributes.width.value.trim() }
        : {}),
      ...(tag.attributes.height
        ? { height: tag.attributes.height.value.trim() }
        : {}),
      ...(tag.attributes.viewBox
        ? { viewBox: tag.attributes.viewBox.value.trim() }
        : {}),
    };
  });
  parser.on("error", (error) => {
    throw error;
  });
  try {
    parser.write(text).close();
  } catch (error) {
    throw new Error("Asset bytes are not a well-formed SVG document.", {
      cause: error,
    });
  }
  if (!sawRoot || !rootAttributes) {
    throw new Error("Asset bytes are not a well-formed SVG document.");
  }
  return rootAttributes;
}

async function inspectSvg(
  sourcePath: string,
  resource: Resource,
  registeredEssence: string | undefined,
): Promise<LocalAssetInspectionFacts | undefined> {
  if (resource.kind !== "image") return undefined;
  const bytes = await readFile(sourcePath);
  if (bytes.byteLength !== resource.byteLength) {
    throw new Error("SVG Asset bytes do not match immutable Resource length.");
  }
  const text = bytes.toString("utf8");
  const root = svgDocumentRoot(text);
  if (!root) {
    if (registeredEssence === "image/svg+xml") {
      throw new Error(
        "Registered SVG Asset bytes contain no SVG root element.",
      );
    }
    return undefined;
  }
  const rootAttributes = assertWellFormedSvgDocument(text);
  if (
    registeredEssence !== undefined &&
    registeredEssence !== "image/svg+xml"
  ) {
    throw new Error(
      `Decoded image Asset has canonical media type image/svg+xml, not registered ${registeredEssence}.`,
    );
  }
  const viewBox = rootAttributes.viewBox?.split(/[\s,]+/).map(Number);
  const viewBoxWidth =
    viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2]! > 0
      ? viewBox[2]
      : undefined;
  const viewBoxHeight =
    viewBox?.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3]! > 0
      ? viewBox[3]
      : undefined;
  const width = svgPixelLength(rootAttributes.width) ?? viewBoxWidth;
  const height = svgPixelLength(rootAttributes.height) ?? viewBoxHeight;
  if (!width || !height) {
    throw new Error(
      "SVG Asset bytes must declare positive pixel dimensions or a positive viewBox.",
    );
  }
  return LocalAssetInspectionFactsSchema.parse({
    contentType: "image/svg+xml",
    width,
    height,
    rotationDegrees: 0,
  });
}

/** Production adapter for the Resource inspection port. */
export function createLocalFfprobeAssetInspector(options: {
  ffprobePath: string;
  run?: LocalFfprobeRunner;
}): LocalAssetInspector {
  const run: LocalFfprobeRunner =
    options.run ??
    (async (file, args) => {
      const result = await execFileAsync(file, args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      return { stdout: result.stdout };
    });
  return async ({ sourcePath, resource }) => {
    const registeredEssence = registeredMediaTypeAssertion(resource);
    if (resource.kind === "model") {
      return inspectGltf(sourcePath, resource, registeredEssence);
    }
    if (
      resource.kind === "image" &&
      (registeredEssence === undefined || registeredEssence === "image/svg+xml")
    ) {
      const svg = await inspectSvg(sourcePath, resource, registeredEssence);
      if (svg) return svg;
    }
    const ffprobeArgs = [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      ...(resource.kind === "image"
        ? ["-show_frames", "-read_intervals", "%+#1"]
        : []),
      sourcePath,
    ];
    const { stdout } = await run(options.ffprobePath, ffprobeArgs);
    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch (error) {
      throw new Error("ffprobe returned malformed Asset inspection JSON.", {
        cause: error,
      });
    }
    const root = record(output);
    if (!root) throw new Error("ffprobe returned no Asset inspection object.");
    const streams = Array.isArray(root.streams)
      ? root.streams
          .map(record)
          .filter((item): item is Record<string, unknown> => !!item)
      : [];
    const frames = Array.isArray(root.frames)
      ? root.frames
          .map(record)
          .filter((item): item is Record<string, unknown> => !!item)
      : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const firstVideoFrame = frames.find(
      (frame) => frame.media_type === "video" || frame.codec_type === "video",
    );
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const format = record(root.format);
    const formatName = optionalNonEmptyString(format?.format_name);
    const majorBrand = optionalNonEmptyString(
      record(format?.tags)?.major_brand,
    );
    const width = optionalPositiveInteger(video?.width);
    const height = optionalPositiveInteger(video?.height);
    const rotationSource =
      firstVideoFrame && displayMatrixSideData(firstVideoFrame)
        ? firstVideoFrame
        : video;
    const rotation = rotationSource
      ? displayRotationDegrees(rotationSource)
      : undefined;
    const swapsDisplayDimensions = rotation === 90 || rotation === 270;
    const displayWidth = swapsDisplayDimensions ? height : width;
    const displayHeight = swapsDisplayDimensions ? width : height;
    const duration = durationMs(
      format?.duration ?? video?.duration ?? audio?.duration,
    );
    const rate = frameRate(video?.avg_frame_rate ?? video?.r_frame_rate);
    const videoCodec = optionalNonEmptyString(video?.codec_name);
    const audioCodec = optionalNonEmptyString(audio?.codec_name);
    const sampleRate = optionalPositiveInteger(audio?.sample_rate);
    const channelCount = optionalPositiveInteger(audio?.channels);
    const formatNames = new Set(
      (formatName ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim()),
    );
    const channelLayout =
      canonicalChannelLayout(audio?.channel_layout) ??
      (audio && channelCount && formatNames.has("wav")
        ? await inspectWaveChannelLayout(sourcePath, resource, channelCount)
        : undefined);
    const matroskaDocType =
      formatNames.has("matroska") && formatNames.has("webm")
        ? await inspectEbmlDocType(sourcePath, resource)
        : undefined;

    if (resource.kind === "image") {
      if (!video) throw new Error("Decoded image Asset has no visual stream.");
      requireFact(width, "width", resource.kind);
      requireFact(height, "height", resource.kind);
      requireFact(rotation, "display rotation", resource.kind);
      requireFact(videoCodec, "image codec", resource.kind);
    } else if (resource.kind === "video") {
      if (!video) throw new Error("Decoded video Asset has no video stream.");
      requireFact(width, "width", resource.kind);
      requireFact(height, "height", resource.kind);
      requireFact(rotation, "display rotation", resource.kind);
      requireFact(duration, "duration", resource.kind);
      requireFact(rate, "frame rate", resource.kind);
      requireFact(videoCodec, "video codec", resource.kind);
      if (audio) {
        requireFact(audioCodec, "audio codec", resource.kind);
        requireFact(sampleRate, "sample rate", resource.kind);
        requireFact(channelCount, "channel count", resource.kind);
        requireFact(channelLayout, "channel layout", resource.kind);
      }
    } else {
      if (!audio) throw new Error("Decoded audio Asset has no audio stream.");
      requireFact(duration, "duration", resource.kind);
      requireFact(audioCodec, "audio codec", resource.kind);
      requireFact(sampleRate, "sample rate", resource.kind);
      requireFact(channelCount, "channel count", resource.kind);
      requireFact(channelLayout, "channel layout", resource.kind);
    }
    const contentType = verifiedDecodedMediaType({
      resource,
      ...(registeredEssence ? { registeredEssence } : {}),
      ...(formatName ? { formatName } : {}),
      ...(videoCodec ? { videoCodec } : {}),
      ...(majorBrand ? { majorBrand } : {}),
      ...(matroskaDocType ? { matroskaDocType } : {}),
    });
    if (resource.kind === "image") {
      return LocalAssetInspectionFactsSchema.parse({
        contentType,
        width: displayWidth,
        height: displayHeight,
        rotationDegrees: rotation,
      });
    }
    if (resource.kind === "video") {
      return LocalAssetInspectionFactsSchema.parse({
        contentType,
        width: displayWidth,
        height: displayHeight,
        rotationDegrees: rotation,
        durationMs: duration,
        frameRate: rate,
        videoCodec,
        hasAudio: !!audio,
        ...(audio
          ? {
              audioCodec,
              sampleRate,
              channelCount,
              channelLayout,
            }
          : {}),
      });
    }
    return LocalAssetInspectionFactsSchema.parse({
      contentType,
      durationMs: duration,
      hasAudio: true,
      audioCodec,
      sampleRate,
      channelCount,
      channelLayout,
    });
  };
}

export interface LocalAssetInspection {
  facts: LocalAssetInspectionFacts;
}

export interface LocalAssetInspectionService {
  /**
   * Inspects and enriches one Resource once. Facts are Host-private registry
   * state keyed by immutable Resource identity.
   */
  inspect(input: {
    source: LocalResourceProjection;
    knownFacts?: ProjectAssetMetadata;
  }): Promise<LocalAssetInspection>;
  /**
   * Verifies staged bytes under caller-frozen kind/media assertions, then
   * seals the canonical Resource and records one versioned L1 receipt.
   */
  finalize(input: {
    resourceId: string;
    kind: AssetKind;
    contentType?: string;
  }): Promise<{
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
  }>;
}

interface InspectionRow {
  sourceResourceId: string;
  recipe: string;
  facts: LocalAssetInspectionFacts;
}

const nodeRequire = createRequire(import.meta.url);

function openDatabase(path: string): SqliteDatabase {
  const { DatabaseSync } = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS local_asset_inspections (
      source_resource_id TEXT NOT NULL,
      recipe TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      inspected_at INTEGER NOT NULL,
      PRIMARY KEY (source_resource_id, recipe)
    );
  `);
  const inspectionTable = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'local_asset_inspections'
    `,
    )
    .get();
  if (
    typeof inspectionTable?.sql !== "string" ||
    !/\brecipe\b/i.test(inspectionTable.sql)
  ) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE local_asset_inspections
        RENAME TO local_asset_inspections_unversioned;
      CREATE TABLE local_asset_inspections (
        source_resource_id TEXT NOT NULL,
        recipe TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        inspected_at INTEGER NOT NULL,
        PRIMARY KEY (source_resource_id, recipe)
      );
      DROP TABLE local_asset_inspections_unversioned;
      COMMIT;
    `);
  }
  return database;
}

function parseInspectionRow(row: Record<string, unknown>): InspectionRow {
  const sourceResourceId = row.source_resource_id;
  const recipe = row.recipe;
  const factsJson = row.facts_json;
  if (
    typeof sourceResourceId !== "string" ||
    !sourceResourceId ||
    typeof recipe !== "string" ||
    !recipe ||
    typeof factsJson !== "string"
  ) {
    throw new Error("Local Asset inspection row is corrupt.");
  }
  let facts: unknown;
  try {
    facts = JSON.parse(factsJson);
  } catch (error) {
    throw new Error("Local Asset inspection facts are corrupt.", {
      cause: error,
    });
  }
  return {
    sourceResourceId,
    recipe,
    facts: LocalAssetInspectionFactsSchema.parse(facts),
  };
}

function sameResourceFacts(
  left: LocalResourceProjection,
  right: LocalResourceProjection,
): boolean {
  return JSON.stringify(left.resource) === JSON.stringify(right.resource);
}

function assertCompleteInspectionFacts(
  resource: Resource,
  facts: LocalAssetInspectionFacts,
): LocalAssetInspectionFacts {
  const contentType = requireFact(
    facts.contentType,
    "content type",
    resource.kind,
  );
  assertByteVerifiableMediaType(contentType);
  if (
    resource.contentType !== undefined &&
    !sameMediaTypeAssertion(
      canonicalAssetMediaTypeAssertion(facts.contentType),
      canonicalAssetMediaTypeAssertion(resource.contentType),
    )
  ) {
    throw new Error(
      `Decoded ${resource.kind} Asset content type does not match immutable Resource facts.`,
    );
  }
  if (resource.kind === "image") {
    requireFact(facts.width, "width", resource.kind);
    requireFact(facts.height, "height", resource.kind);
    requireFact(facts.rotationDegrees, "display rotation", resource.kind);
  } else if (resource.kind === "video") {
    requireFact(facts.width, "width", resource.kind);
    requireFact(facts.height, "height", resource.kind);
    requireFact(facts.rotationDegrees, "display rotation", resource.kind);
    requireFact(facts.durationMs, "duration", resource.kind);
    requireFact(facts.frameRate, "frame rate", resource.kind);
    requireFact(facts.videoCodec, "video codec", resource.kind);
    requireFact(facts.hasAudio, "audio presence", resource.kind);
    if (facts.hasAudio) {
      requireFact(facts.audioCodec, "audio codec", resource.kind);
      requireFact(facts.sampleRate, "sample rate", resource.kind);
      requireFact(facts.channelCount, "channel count", resource.kind);
      requireFact(facts.channelLayout, "channel layout", resource.kind);
    }
  } else if (resource.kind === "audio") {
    requireFact(facts.durationMs, "duration", resource.kind);
    if (facts.hasAudio !== true) {
      throw new Error(
        "Decoded audio Asset is missing canonical audio presence.",
      );
    }
    requireFact(facts.audioCodec, "audio codec", resource.kind);
    requireFact(facts.sampleRate, "sample rate", resource.kind);
    requireFact(facts.channelCount, "channel count", resource.kind);
    requireFact(facts.channelLayout, "channel layout", resource.kind);
  }
  return facts;
}

export function createLocalAssetInspectionService(options: {
  dataDir: string;
  clashRoot?: string;
  inspectResource?: LocalAssetInspector;
}): LocalAssetInspectionService {
  const databasePath = `${options.dataDir}/local.sqlite`;
  const resources = createLocalResourceStore({
    dataDir: options.dataDir,
    ...(options.clashRoot ? { clashRoot: options.clashRoot } : {}),
  });
  const inspectionInFlight = new Map<string, Promise<InspectionRow>>();

  async function withDatabase<T>(
    task: (database: SqliteDatabase) => T,
  ): Promise<T> {
    await mkdir(options.dataDir, { recursive: true });
    const database = openDatabase(databasePath);
    try {
      return task(database);
    } finally {
      database.close();
      await chmod(databasePath, 0o600).catch(() => undefined);
    }
  }

  async function readInspection(
    sourceResourceId: string,
  ): Promise<InspectionRow | undefined> {
    return withDatabase((database) => {
      const row = database
        .prepare(
          `
          SELECT source_resource_id, recipe, facts_json
          FROM local_asset_inspections
          WHERE source_resource_id = ? AND recipe = ?
        `,
        )
        .get(sourceResourceId, LOCAL_ASSET_INSPECTION_RECIPE);
      return row ? parseInspectionRow(row) : undefined;
    });
  }

  async function persistInspection(input: {
    source: LocalResourceProjection;
    facts: LocalAssetInspectionFacts;
  }): Promise<InspectionRow> {
    const facts = assertCompleteInspectionFacts(
      input.source.resource,
      LocalAssetInspectionFactsSchema.parse(input.facts),
    );
    await withDatabase((database) => {
      database
        .prepare(
          `
          INSERT OR IGNORE INTO local_asset_inspections (
            source_resource_id, recipe, facts_json, inspected_at
          ) VALUES (?, ?, ?, ?)
        `,
        )
        .run(
          input.source.resource.id,
          LOCAL_ASSET_INSPECTION_RECIPE,
          JSON.stringify(facts),
          Date.now(),
        );
    });
    const stored = await readInspection(input.source.resource.id);
    if (!stored) {
      throw new Error(
        `Local Asset inspection for ${input.source.resource.id} was not indexed.`,
      );
    }
    assertCompleteInspectionFacts(input.source.resource, stored.facts);
    if (JSON.stringify(stored.facts) !== JSON.stringify(facts)) {
      throw new Error(
        `Local Asset inspection candidate for ${input.source.resource.id} conflicts with the inspection CAS winner.`,
      );
    }
    return stored;
  }

  async function ensureInspection(
    source: LocalResourceProjection,
  ): Promise<InspectionRow> {
    const stored = await readInspection(source.resource.id);
    if (stored) {
      assertCompleteInspectionFacts(source.resource, stored.facts);
      const canonicalContentType = canonicalAssetMediaTypeAssertion(
        stored.facts.contentType,
      );
      if (!canonicalContentType) {
        throw new Error(
          `Decoded ${source.resource.kind} Asset is missing a canonical media type.`,
        );
      }
      await resources.seal({
        resourceId: source.resource.id,
        kind: source.resource.kind,
        contentType: canonicalContentType,
      });
      return stored;
    }

    const inspectResource = options.inspectResource;
    if (!inspectResource) {
      throw new Error(
        "A Host byte-probe adapter is required before Asset publication.",
      );
    }

    const key = `${source.resource.id}\u0000${LOCAL_ASSET_INSPECTION_RECIPE}`;
    const existing = inspectionInFlight.get(key);
    if (existing) return existing;

    const task = (async () => {
      const raced = await readInspection(source.resource.id);
      if (raced) {
        assertCompleteInspectionFacts(source.resource, raced.facts);
        return raced;
      }
      const probed = LocalAssetInspectionFactsSchema.parse(
        await inspectResource({
          sourcePath: source.path,
          resource: source.resource,
        }),
      );
      const facts = assertCompleteInspectionFacts(
        source.resource,
        mergeInspectionFacts(
          source.resource.id,
          inspectionFactsFromResource(source),
          probed,
        ),
      );
      const canonicalContentType = canonicalAssetMediaTypeAssertion(
        facts.contentType,
      );
      if (!canonicalContentType) {
        throw new Error(
          `Decoded ${source.resource.kind} Asset is missing a canonical media type.`,
        );
      }
      const canonicalSource = await resources.seal({
        resourceId: source.resource.id,
        kind: source.resource.kind,
        contentType: canonicalContentType,
      });
      return persistInspection({ source: canonicalSource, facts });
    })();
    inspectionInFlight.set(key, task);
    try {
      return await task;
    } finally {
      if (inspectionInFlight.get(key) === task) {
        inspectionInFlight.delete(key);
      }
    }
  }

  async function installedSource(
    input: LocalResourceProjection,
  ): Promise<LocalResourceProjection> {
    const source = await resources.resolve(input.resource.id);
    if (!source || !sameResourceFacts(source, input)) {
      throw new Error(
        `Source Resource ${input.resource.id} is not installed with the claimed immutable facts.`,
      );
    }
    return source;
  }

  function inspectionFactsFromResource(
    source: LocalResourceProjection,
  ): LocalAssetInspectionFacts {
    const contentType = canonicalAssetMediaTypeAssertion(
      source.resource.contentType,
    );
    return LocalAssetInspectionFactsSchema.parse({
      ...(contentType ? { contentType } : {}),
    });
  }

  function mergeInspectionFacts(
    sourceResourceId: string,
    left: LocalAssetInspectionFacts,
    right: LocalAssetInspectionFacts,
  ): LocalAssetInspectionFacts {
    const merged: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      const existing = merged[key];
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(value)
      ) {
        throw new Error(
          `Inspection fact ${key} for ${sourceResourceId} conflicts with the persisted Resource facts.`,
        );
      }
      merged[key] = value;
    }
    return LocalAssetInspectionFactsSchema.parse(merged);
  }

  return {
    async finalize(input) {
      const staged = await resources.resolveStaged(input.resourceId);
      const sealed = await resources.resolve(input.resourceId);
      if (!staged && !sealed) {
        throw new Error(
          `Bytes ${input.resourceId} are not available for Asset verification.`,
        );
      }
      if (sealed) {
        const stored = await readInspection(input.resourceId);
        if (stored) {
          const facts = assertCompleteInspectionFacts(
            sealed.resource,
            stored.facts,
          );
          const canonicalContentType = canonicalAssetMediaTypeAssertion(
            facts.contentType,
          );
          if (!canonicalContentType) {
            throw new Error(
              `Decoded ${sealed.resource.kind} Asset is missing a canonical media type.`,
            );
          }
          const source = await resources.seal({
            resourceId: input.resourceId,
            kind: sealed.resource.kind,
            contentType: canonicalContentType,
          });
          const assertedContentType = canonicalAssetMediaTypeAssertion(
            input.contentType,
          );
          if (
            source.resource.kind !== input.kind ||
            (assertedContentType !== undefined &&
              !sameMediaTypeAssertion(
                assertedContentType,
                source.resource.contentType,
              ))
          ) {
            throw new Error(
              `Local Resource ${input.resourceId} already has different verified media facts than ${input.kind}/${assertedContentType ?? "an unspecified media type"}.`,
            );
          }
          return { source, facts };
        }
      }
      const inspectResource = options.inspectResource;
      if (!inspectResource) {
        throw new Error(
          "A Host byte-probe adapter is required before Asset publication.",
        );
      }
      const assertedContentType = canonicalAssetMediaTypeAssertion(
        input.contentType ?? sealed?.resource.contentType,
      );
      const evidence = staged ?? sealed!;
      const assertedResource = ResourceSchema.parse({
        id: input.resourceId,
        kind: input.kind,
        digest: {
          algorithm: "sha256",
          value:
            "digest" in evidence
              ? evidence.digest
              : evidence.resource.digest.value,
        },
        byteLength:
          "byteLength" in evidence
            ? evidence.byteLength
            : evidence.resource.byteLength,
        ...(assertedContentType ? { contentType: assertedContentType } : {}),
      });
      const facts = assertCompleteInspectionFacts(
        assertedResource,
        mergeInspectionFacts(
          input.resourceId,
          LocalAssetInspectionFactsSchema.parse({
            ...(assertedResource.contentType
              ? { contentType: assertedResource.contentType }
              : {}),
          }),
          LocalAssetInspectionFactsSchema.parse(
            await inspectResource({
              sourcePath: evidence.path,
              resource: assertedResource,
            }),
          ),
        ),
      );
      const canonicalContentType = canonicalAssetMediaTypeAssertion(
        facts.contentType,
      );
      if (!canonicalContentType) {
        throw new Error(
          `Decoded ${input.kind} Asset is missing a canonical media type.`,
        );
      }
      const source = await resources.seal({
        ...(staged
          ? { receipt: staged.receipt }
          : { resourceId: input.resourceId }),
        kind: assertedResource.kind,
        contentType: canonicalContentType,
      });
      const canonicalFacts = LocalAssetInspectionFactsSchema.parse({
        ...facts,
        contentType: canonicalContentType,
      });
      const winner = await persistInspection({
        source,
        facts: canonicalFacts,
      });
      return { source, facts: winner.facts };
    },

    async inspect(input) {
      const source = await installedSource(input.source);
      const inspection = await ensureInspection(source);
      // Caller metadata remains a display hint outside the byte-probe
      // authority. Only immutable Resource facts and verified probe output can
      // enter this result.
      return { facts: inspection.facts };
    },
  };
}
