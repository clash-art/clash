/**
 * gpt-image-2 sizing.
 *
 * A size has two dimensions the caller chooses -- the aspect ratio it composed for
 * and a resolution tier -- and the provider wants one concrete `WxH`. So
 * `ratio + tier = size`, and that product is a committed table rather than runtime
 * arithmetic.
 *
 * A table is reviewable: a wrong cell shows up in a diff, while a wrong formula
 * shows up as a provider 400 or a silently reframed image. It also keeps the
 * product in lockstep with the `hilo-hub-media` plugin, which sends these exact
 * sizes to `hub.minimax.io/api/v2/image/openai/generate`. Adding a ratio means
 * computing its cells once, at authoring time, and committing them.
 *
 * Every cell must satisfy what gpt-image-2 documents:
 *
 *   - the longest edge is at most 3840px
 *   - both edges are multiples of 16px
 *   - the long:short edge ratio is at most 3:1
 *   - total pixels are within [655360, 8294400]
 *
 * `gpt-image-size.test.ts` checks all of that for every cell, so a hand-added row
 * cannot ship an invalid request.
 */

import {
  CANONICAL_RESOLUTION_TIERS,
  resolutionTierPixels,
  type CanonicalResolutionTier,
} from './resolution-tiers.js';

export const GPT_IMAGE_MAX_EDGE = 3840;
export const GPT_IMAGE_EDGE_MULTIPLE = 16;
export const GPT_IMAGE_MAX_RATIO = 3;
export const GPT_IMAGE_MIN_PIXELS = 655_360;
export const GPT_IMAGE_MAX_PIXELS = 8_294_400;

/**
 * gpt-image-2 offers three of the canonical tiers. `0.5K` is excluded because its
 * budget falls under the model's documented 655,360 pixel floor.
 */
export type GptImageResolutionTier = Extract<CanonicalResolutionTier, '1K' | '2K' | '4K'>;

export interface GptImageSize {
  width: number;
  height: number;
}

/** The canonical tiers this model supports, in ladder order. */
export const GPT_IMAGE_RESOLUTION_TIERS = CANONICAL_RESOLUTION_TIERS.filter(
  (tier): tier is (typeof CANONICAL_RESOLUTION_TIERS)[number] & { value: GptImageResolutionTier } =>
    tier.value === '1K' || tier.value === '2K' || tier.value === '4K',
);

/**
 * Ratios offered in the UI, in table order. `2:1` is what a 360x180 degree
 * equirectangular panorama needs; `3:1` and `1:3` sit exactly on the documented
 * ratio limit.
 */
export const GPT_IMAGE_ASPECT_RATIOS = [
  { label: '1:1', value: '1:1' },
  { label: '16:9', value: '16:9' },
  { label: '9:16', value: '9:16' },
  { label: '3:4', value: '3:4' },
  { label: '4:3', value: '4:3' },
  { label: '3:2', value: '3:2' },
  { label: '2:3', value: '2:3' },
  { label: '5:4', value: '5:4' },
  { label: '4:5', value: '4:5' },
  { label: '21:9', value: '21:9' },
  { label: '2:1', value: '2:1' },
  { label: '1:2', value: '1:2' },
  { label: '3:1', value: '3:1' },
  { label: '1:3', value: '1:3' },
] as const;

/**
 * The committed size table: 14 ratios x 3 tiers.
 *
 * Values match the `hilo-hub-media` plugin so both paths request the same frame.
 * That parity is the point of committing a table: the fal route and the hub route
 * resolve a ratio and tier through this one source, so the same request cannot come
 * back as two different frames.
 *
 * Three properties of the data are deliberate rather than accidental:
 *
 *   - The `16:9` row is 720p/1440p/2160p, spending less than the tier budget in
 *     exchange for a standard frame.
 *   - `3:1` and `1:3` at 4K are capped by the 3840px edge limit, so they are only
 *     modestly larger than their 2K cells. That is geometry, not a typo.
 *   - `21:9` at 1K holds 576 rows like `3:1` does, which leaves it about a quarter
 *     below its tier budget. It is kept as-is for parity with the plugin; changing
 *     it here would make the same request differ by route.
 */
export const GPT_IMAGE_SIZES: Readonly<
  Record<GptImageResolutionTier, Readonly<Record<string, GptImageSize>>>
> = {
  '1K': {
    '1:1': { width: 1024, height: 1024 },
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '3:4': { width: 864, height: 1152 },
    '4:3': { width: 1152, height: 864 },
    '3:2': { width: 1248, height: 832 },
    '2:3': { width: 832, height: 1248 },
    '5:4': { width: 1120, height: 896 },
    '4:5': { width: 896, height: 1120 },
    '21:9': { width: 1344, height: 576 },
    '2:1': { width: 1440, height: 720 },
    '1:2': { width: 720, height: 1440 },
    '3:1': { width: 1728, height: 576 },
    '1:3': { width: 576, height: 1728 },
  },
  '2K': {
    '1:1': { width: 2048, height: 2048 },
    '16:9': { width: 2560, height: 1440 },
    '9:16': { width: 1440, height: 2560 },
    '3:4': { width: 1728, height: 2304 },
    '4:3': { width: 2304, height: 1728 },
    '3:2': { width: 2496, height: 1664 },
    '2:3': { width: 1664, height: 2496 },
    '5:4': { width: 2240, height: 1792 },
    '4:5': { width: 1792, height: 2240 },
    '21:9': { width: 3024, height: 1296 },
    '2:1': { width: 2880, height: 1440 },
    '1:2': { width: 1440, height: 2880 },
    '3:1': { width: 3552, height: 1184 },
    '1:3': { width: 1184, height: 3552 },
  },
  '4K': {
    '1:1': { width: 2880, height: 2880 },
    '16:9': { width: 3840, height: 2160 },
    '9:16': { width: 2160, height: 3840 },
    '3:4': { width: 2448, height: 3264 },
    '4:3': { width: 3264, height: 2448 },
    '3:2': { width: 3504, height: 2336 },
    '2:3': { width: 2336, height: 3504 },
    '5:4': { width: 3200, height: 2560 },
    '4:5': { width: 2560, height: 3200 },
    '21:9': { width: 3696, height: 1584 },
    '2:1': { width: 3840, height: 1920 },
    '1:2': { width: 1920, height: 3840 },
    '3:1': { width: 3840, height: 1280 },
    '1:3': { width: 1280, height: 3840 },
  },
} as const;

/** Parse `"W:H"` into a numeric ratio. Returns undefined for anything else. */
export function parseAspectRatio(ratio: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ratio.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width > 0) || !(height > 0)) return undefined;
  return width / height;
}

/** True when the ratio is within the documented 3:1 limit. */
export function isSupportedGptImageRatio(ratio: string): boolean {
  const value = parseAspectRatio(ratio);
  if (value === undefined) return false;
  const longOverShort = value >= 1 ? value : 1 / value;
  return longOverShort <= GPT_IMAGE_MAX_RATIO + 1e-9;
}

function quantize(value: number): number {
  return Math.round(value / GPT_IMAGE_EDGE_MULTIPLE) * GPT_IMAGE_EDGE_MULTIPLE;
}

// Budgets come from the shared ladder, so a tier means the same thing here as it
// does for every other model.
const tierPixels = resolutionTierPixels;

/**
 * Derive a size for a ratio the table does not list.
 *
 * The picker lets a caller enter a custom ratio, so the committed table cannot be
 * the only answer. This spends the tier's pixel budget on that ratio and then
 * pulls the result back inside the documented limits, which is also how a new
 * table row should be computed before it is committed.
 */
export function computeGptImageSize(
  ratio: string,
  tier: GptImageResolutionTier,
): GptImageSize {
  const parsed = parseAspectRatio(ratio);
  const value = parsed !== undefined && isSupportedGptImageRatio(ratio) ? parsed : 1;
  const longOverShort = value >= 1 ? value : 1 / value;

  let long = quantize(Math.sqrt(tierPixels(tier) * longOverShort));
  long = Math.min(long, GPT_IMAGE_MAX_EDGE);
  let short = quantize(long / longOverShort);
  // Rounding down can push the ratio past the 3:1 limit.
  if (long / short > GPT_IMAGE_MAX_RATIO) short += GPT_IMAGE_EDGE_MULTIPLE;

  // Shrink together until the pixel ceiling is satisfied, then grow together until
  // the floor is, so the ratio is preserved either way.
  while (long * short > GPT_IMAGE_MAX_PIXELS && short > GPT_IMAGE_EDGE_MULTIPLE * 16) {
    long = Math.max(GPT_IMAGE_EDGE_MULTIPLE, long - GPT_IMAGE_EDGE_MULTIPLE * 2);
    short = Math.max(GPT_IMAGE_EDGE_MULTIPLE, quantize(long / longOverShort));
    if (long / short > GPT_IMAGE_MAX_RATIO) short += GPT_IMAGE_EDGE_MULTIPLE;
  }
  while (long * short < GPT_IMAGE_MIN_PIXELS && long < GPT_IMAGE_MAX_EDGE) {
    long = Math.min(GPT_IMAGE_MAX_EDGE, long + GPT_IMAGE_EDGE_MULTIPLE * 2);
    short = quantize(long / longOverShort);
    if (long / short > GPT_IMAGE_MAX_RATIO) short += GPT_IMAGE_EDGE_MULTIPLE;
  }

  return value >= 1 ? { width: long, height: short } : { width: short, height: long };
}

/**
 * Look up the committed size for a ratio and tier.
 *
 * Declared ratios come from the table; a custom ratio is derived the same way a new
 * table row would be.
 */
export function gptImageSizeForRatio(
  ratio: string,
  tier: GptImageResolutionTier,
): GptImageSize {
  return GPT_IMAGE_SIZES[tier]?.[ratio.trim()] ?? computeGptImageSize(ratio, tier);
}

/** Format a size the way the OpenAI `size` parameter expects. */
export function formatGptImageSize(size: GptImageSize): string {
  return `${size.width}x${size.height}`;
}

/**
 * Resolve the size for a generation request.
 *
 * Precedence runs from most specific to least: explicit pixel dimensions, an
 * explicit `WxH` size, then the declared ratio and tier. `auto` only survives when
 * the caller named no ratio, because otherwise it would discard that ratio.
 */
export function resolveGptImageSize(
  params: Record<string, unknown>,
  aspectRatio?: string,
): GptImageSize | 'auto' {
  const width = Number(params.width);
  const height = Number(params.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    return { width, height };
  }

  const size = typeof params.size === 'string' ? params.size : undefined;
  const explicit = size ? /^(\d+)x(\d+)$/.exec(size) : null;
  if (explicit) return { width: Number(explicit[1]), height: Number(explicit[2]) };

  const declaredRatio =
    typeof params.aspect_ratio === 'string' ? params.aspect_ratio : aspectRatio;
  const concrete = typeof params.resolution === "string" ? /^(\d+)x(\d+)$/.exec(params.resolution) : null;
  if (concrete) {
    const width = Number(concrete[1]);
    const height = Number(concrete[2]);
    const ratio = declaredRatio && declaredRatio !== "auto" ? parseAspectRatio(declaredRatio) : undefined;
    if (ratio !== undefined && Math.abs(width / height - ratio) > 1e-9) {
      throw new Error("Resolution does not match the requested aspect ratio. Choose matching dimensions or Auto aspect ratio.");
    }
    return { width, height };
  }
  if (!declaredRatio || declaredRatio === 'auto') return 'auto';
  if (params.resolution === "auto") {
    // Documented native sizes; this is ratio spelling, never a fabricated resolution tier.
    const native: Record<string, GptImageSize> = {
      "1:1": { width: 1024, height: 1024 }, "3:2": { width: 1536, height: 1024 },
      "2:3": { width: 1024, height: 1536 }, "4:3": { width: 1536, height: 1152 },
      "3:4": { width: 1152, height: 1536 }, "16:9": { width: 2048, height: 1152 },
      "9:16": { width: 1152, height: 2048 },
    };
    if (!native[declaredRatio]) throw new Error("Unsupported automatic GPT Image aspect ratio.");
    return native[declaredRatio]!;
  }

  const tier =
    typeof params.resolution === 'string' &&
    GPT_IMAGE_RESOLUTION_TIERS.some(entry => entry.value === params.resolution)
      ? (params.resolution as GptImageResolutionTier)
      : '2K';
  return gptImageSizeForRatio(declaredRatio, tier);
}
