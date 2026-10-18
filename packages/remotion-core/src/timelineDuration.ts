import type { Track } from './types';
import { TIMELINE_EDITOR_ROOT_DEFAULT_OVERRIDES } from './timelineFieldConsumers';

/** Duration of an empty Timeline. Content always wins once any item exists. */
export const EMPTY_TIMELINE_DURATION_IN_FRAMES = TIMELINE_EDITOR_ROOT_DEFAULT_OVERRIDES.durationInFrames;

/** Frame after the last frame any item occupies, or 0 for an empty Timeline. */
export function timelineContentEndFrame(tracks: readonly Pick<Track, 'items'>[]): number {
  let end = 0;
  for (const track of tracks) {
    for (const item of track.items) {
      const itemEnd = item.from + item.durationInFrames;
      if (Number.isFinite(itemEnd) && itemEnd > end) end = itemEnd;
    }
  }
  return Math.ceil(end);
}

/**
 * The composition duration is derived from content, never stored as an
 * independent number: the Player, the transport timecode, the inspector and the
 * persisted DSL all read this one value, so a clip can never extend past it.
 */
export function deriveTimelineDurationInFrames(tracks: readonly Pick<Track, 'items'>[]): number {
  const end = timelineContentEndFrame(tracks);
  return end > 0 ? end : EMPTY_TIMELINE_DURATION_IN_FRAMES;
}
