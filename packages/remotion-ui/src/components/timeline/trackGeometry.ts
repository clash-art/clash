import { inferTrackCategory } from '@clash/remotion-core';
import type { Track } from '@clash/remotion-core';
import { getTimelineTrackHeight } from './styles';

export type TimelineTrackBand = {
  index: number;
  top: number;
  height: number;
  bottom: number;
};

export function getTrackHeightForTrack(track: Track, primaryTrackId?: string | null): number {
  return getTimelineTrackHeight(inferTrackCategory(track, primaryTrackId));
}

export function getTimelineTrackHeights(
  tracks: readonly Track[],
  primaryTrackId?: string | null,
): number[] {
  return tracks.map((track) => getTrackHeightForTrack(track, primaryTrackId));
}

export function getTimelineTracksHeight(
  tracks: readonly Track[],
  primaryTrackId?: string | null,
): number {
  return getTimelineTrackHeights(tracks, primaryTrackId)
    .reduce((total, height) => total + height, 0);
}

export function getTrackBandAtY(
  y: number,
  tracks: readonly Track[],
  primaryTrackId?: string | null,
): TimelineTrackBand | null {
  if (y < 0) return null;
  let top = 0;
  for (let index = 0; index < tracks.length; index += 1) {
    const height = getTrackHeightForTrack(tracks[index], primaryTrackId);
    const bottom = top + height;
    if (y < bottom) return { index, top, height, bottom };
    top = bottom;
  }
  return null;
}

/**
 * The tracks live in a stack that is anchored to the bottom of the lanes
 * viewport (CapCut style). Hit-testing must therefore be relative to the
 * stack's top, not the viewport/content top: the blank space above the stack
 * is a real drop zone that inserts before the first track.
 */
export const TIMELINE_TRACK_STACK_SELECTOR = '[data-timeline-track-stack]';

export function getTrackStackElement(
  viewportEl: HTMLElement | null | undefined,
): HTMLElement | null {
  return viewportEl?.querySelector<HTMLElement>(TIMELINE_TRACK_STACK_SELECTOR) ?? null;
}

/**
 * Convert a client Y coordinate into a Y coordinate relative to the top of the
 * bottom-anchored track stack. The stack's bounding rect already reflects
 * scrolling, so no scrollTop adjustment is needed. Falls back to the legacy
 * viewport-content formula when the stack is not mounted (e.g. empty state).
 */
export function toTrackStackY(
  viewportEl: HTMLElement | null | undefined,
  clientY: number,
): number {
  if (!viewportEl) return clientY;
  const stack = getTrackStackElement(viewportEl);
  if (stack) return clientY - stack.getBoundingClientRect().top;
  const rect = viewportEl.getBoundingClientRect();
  return clientY - rect.top + viewportEl.scrollTop;
}

export function getTimelineTrackLaneElements(
  viewportEl: HTMLElement | null | undefined,
): HTMLElement[] {
  return Array.from(viewportEl?.querySelectorAll<HTMLElement>('[data-timeline-track-id]') ?? []);
}
