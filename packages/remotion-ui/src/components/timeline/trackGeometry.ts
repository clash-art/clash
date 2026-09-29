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
  return getTimelineTrackHeight(inferTrackCategory(track, primaryTrackId)) + getTextKeyframeBandHeight(track, primaryTrackId);
}

// Reserve a separate interaction row so markers never cover the clip label.
// Geometry is independent of selection, keeping DnD and scroll positions stable.
export function getTextKeyframeBandHeight(track: Track, primaryTrackId?: string | null): number {
  return inferTrackCategory(track, primaryTrackId) === 'text'
    && track.items.some(item => Object.values(item.keyframes ?? {}).some(keys => keys.length > 0))
    ? 24 : 0;
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
