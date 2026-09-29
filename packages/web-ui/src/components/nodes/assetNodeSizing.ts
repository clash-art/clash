import type { AssetStatus } from '@clash/web-ui/lib/assetStatus';

export const MAX_MEDIA_DIMENSION = 500;
export const DEFAULT_MEDIA_DIMENSION = 400;
export const MIN_MEDIA_WIDTH = 240;
export const MIN_MEDIA_HEIGHT = 180;

export type MediaSize = { width: number; height: number };

const toNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

export const hasValidMeasuredSize = (width: unknown, height: unknown): boolean => {
    const widthValue = toNumber(width);
    const heightValue = toNumber(height);
    if (widthValue === null || heightValue === null) return false;
    return widthValue >= MIN_MEDIA_WIDTH && heightValue >= MIN_MEDIA_HEIGHT;
};

export const getMeasuredSize = (width: unknown, height: unknown): MediaSize | null => {
    const widthValue = toNumber(width);
    const heightValue = toNumber(height);
    if (widthValue === null || heightValue === null) return null;
    return { width: widthValue, height: heightValue };
};

export { calculateScaledDimensions } from '@clash/shared-layout';

export function calculateDimensionsFromAspectRatio(aspectRatio?: string): MediaSize {
    if (!aspectRatio) {
        return { width: DEFAULT_MEDIA_DIMENSION, height: DEFAULT_MEDIA_DIMENSION };
    }

    const parts = aspectRatio.split(':');
    if (parts.length !== 2) {
        return { width: DEFAULT_MEDIA_DIMENSION, height: DEFAULT_MEDIA_DIMENSION };
    }

    const widthRatio = parseFloat(parts[0]);
    const heightRatio = parseFloat(parts[1]);

    if (!widthRatio || !heightRatio) {
        return { width: DEFAULT_MEDIA_DIMENSION, height: DEFAULT_MEDIA_DIMENSION };
    }

    if (widthRatio >= heightRatio) {
        const width = MAX_MEDIA_DIMENSION;
        const height = Math.round((heightRatio / widthRatio) * MAX_MEDIA_DIMENSION);
        return { width, height };
    }

    const height = MAX_MEDIA_DIMENSION;
    const width = Math.round((widthRatio / heightRatio) * MAX_MEDIA_DIMENSION);
    return { width, height };
}

/**
 * Resolve the size to render a media node with, in two layers:
 *
 *   1. measuredSize (Loro-persisted `node.width/height`) — trust it when valid
 *   2. aspectRatioDimensions — placeholder for draft/generating nodes that
 *      don't have an asset row yet
 *
 * Previously this had a third layer for `naturalDimensions` (probe-based) +
 * preview-width/height fields, but those were redundant: the probed value is
 * always the same as what eventually gets written to `measuredSize` via the
 * reconciliation effect in ImageNode/VideoNode. Keeping three layers in the
 * frontend meant every component had to understand the precedence; two
 * layers means "trust Loro if it has a size, else use aspectRatio."
 */
type ResolveInitialSizeParams = {
    measuredWidth?: unknown;
    measuredHeight?: unknown;
    aspectRatioDimensions: MediaSize;
};

export const resolveInitialMediaSize = ({
    measuredWidth,
    measuredHeight,
    aspectRatioDimensions,
}: ResolveInitialSizeParams): MediaSize => {
    if (hasValidMeasuredSize(measuredWidth, measuredHeight)) {
        return getMeasuredSize(measuredWidth, measuredHeight) ?? aspectRatioDimensions;
    }
    return aspectRatioDimensions;
};
