import { z } from 'zod';

/**
 * A ratio is two numbers.
 *
 * It was a string, which meant every comparison was a spelling comparison: "16:9" and "1920:1080"
 * describe one shape and matched nothing, "16x9" was a different value again, and anything a vendor
 * spelled its own way needed a translation table per vendor. Two integers reduce, compare and
 * divide, and a custom shape is expressible without inventing a menu entry for it.
 *
 * What this deliberately does not do is decide whether a model accepts the shape. Vendors take a
 * closed set — MiniMax rejects `adaptive` and takes six ratios, Agent Platform rejects everything
 * outside its own list — so an arbitrary pair still has to be checked against the model. Snapping to
 * the nearest supported ratio would be a silent substitution, which is the failure this codebase
 * spent the day removing.
 */
export const AspectRatioSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export type AspectRatio = z.infer<typeof AspectRatioSchema>;

/** A written positive integer ratio, normalized to its smallest terms. */
export const AspectRatioStringSchema = z.string().trim().transform((value, ctx) => {
  const ratio = parseAspectRatio(value);
  if (!ratio) {
    ctx.addIssue({
      code: "custom",
      message: 'Aspect ratio must be two positive integers separated by a colon.',
    });
    return z.NEVER;
  }
  return aspectRatioLabel(ratio);
});

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The same shape in its smallest terms.
 *
 * 1920×1080 and 16:9 are one ratio, and reducing is what makes them compare equal.
 */
export function reduceAspectRatio(ratio: AspectRatio): AspectRatio {
  const divisor = greatestCommonDivisor(ratio.width, ratio.height);
  return { width: ratio.width / divisor, height: ratio.height / divisor };
}

/** How a ratio is written for people and for the vendors that take it verbatim. */
export function aspectRatioLabel(ratio: AspectRatio): string {
  const reduced = reduceAspectRatio(ratio);
  return `${reduced.width}:${reduced.height}`;
}

/** Whether two ratios are the same shape, whatever numbers they were given as. */
export function aspectRatioEquals(a: AspectRatio, b: AspectRatio): boolean {
  return a.width * b.height === b.width * a.height;
}

/**
 * Reads a written ratio.
 *
 * Accepts `16:9` and `16x9` because both are in the wild, and refuses anything else rather than
 * guessing: a ratio that parsed to the wrong shape would be silently obeyed all the way to the
 * vendor.
 */
export function parseAspectRatio(text: string): AspectRatio | undefined {
  const match = /^\s*(\d+)\s*[:x×]\s*(\d+)\s*$/i.exec(text);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/** Whether the model offers this shape, compared as a ratio rather than as a spelling. */
export function supportsAspectRatio(
  supported: readonly AspectRatio[],
  requested: AspectRatio,
): boolean {
  return supported.some((candidate) => aspectRatioEquals(candidate, requested));
}
