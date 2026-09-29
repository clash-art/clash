/**
 * Timeline DSL normalization helpers.
 *
 * Persistence contract: `item.assetId` identifies the stable Project Asset.
 * An existing `item.sourceNodeId` may supply a Canvas navigation hint. A lookup
 * fallback is not an authored reference and must not be copied into that field
 * on save. Legacy lookup compatibility remains in the reader. External media
 * URLs and disposable waveform data are resolved when opening the editor.
 *
 * These helpers handle:
 *  - final enforcement (strip external `src` on save)
 *
 * Kept framework-free and side-effect free so both React Flow node
 * components (VideoEditorNode) and the editor provider (VideoEditorContext)
 * can call them without entangling lifecycles.
 */

import type { Track, Item } from "@clash/remotion-core";

/**
 * Strip external `src` values from every item. Used both on save
 * (persist project media as reference-only) and on load after hydration
 * (so stale signed URLs can't leak into the render path even if hydration
 * couldn't fully migrate them). Self-contained data URLs, such as bundled
 * sticker SVGs, remain part of the item because they have no external asset
 * reference that could rehydrate them.
 */
export function stripSrcFromTracks(tracks: Track[]): Track[] {
  return tracks.map((track) => ({
    ...track,
    items: track.items.map((item) => {
      const {
        src: _src,
        justInserted: _justInserted,
        waveform: _waveform,
        ...rest
      } = item as Item & {
        src?: string;
        justInserted?: boolean;
        waveform?: number[];
      };
      return {
        ...rest,
        ...(typeof _src === "string" && _src.startsWith("data:")
          ? { src: _src }
          : {}),
      } as Item;
    }),
  }));
}
