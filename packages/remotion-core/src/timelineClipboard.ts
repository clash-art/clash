import { timelineItemsOverlap } from '@clash/shared-types';
import { editorReducer } from './state/EditorContext';
import { canTrackAcceptItem } from './trackCategories';
import type { EditorAction, EditorState, Item, Track } from './types';

/**
 * Items copied from the Timeline. Offsets are relative to the earliest copied
 * item, so a multi-item paste keeps the clips' spacing.
 */
export type TimelineClipboard = {
  items: Array<{ item: Item; offsetInFrames: number }>;
};

/** Copies the given items (transitions are bound to neighbours and are skipped). */
export function copyTimelineItems(
  tracks: readonly Track[],
  itemIds: readonly string[],
): TimelineClipboard | null {
  const wanted = new Set(itemIds);
  const items = tracks
    .flatMap((track) => track.items)
    .filter((item) => wanted.has(item.id) && item.type !== 'transition');
  if (items.length === 0) return null;
  const anchor = Math.min(...items.map((item) => item.from));
  return {
    items: items
      .slice()
      .sort((a, b) => a.from - b.from)
      .map((item) => ({ item: structuredClone(item), offsetInFrames: item.from - anchor })),
  };
}

/** The selected item's track, else the selected track. */
export function currentTimelineTrackId(
  state: Pick<EditorState, 'tracks' | 'selectedItemId' | 'selectedTrackId'>,
): string | null {
  if (state.selectedItemId) {
    const owner = state.tracks.find((track) =>
      track.items.some((item) => item.id === state.selectedItemId));
    if (owner) return owner.id;
  }
  if (state.selectedTrackId && state.tracks.some((track) => track.id === state.selectedTrackId)) {
    return state.selectedTrackId;
  }
  return null;
}

function trackFits(track: Track, item: Item, primaryTrackId: string | null | undefined): boolean {
  return !track.locked
    && canTrackAcceptItem(track, item, primaryTrackId)
    && !track.items.some((existing) => timelineItemsOverlap(existing, item));
}

export type TimelinePastePlan = {
  actions: EditorAction[];
  pastedItemIds: string[];
  /** Tracks created because neither the current track nor any track above it fit. */
  createdTrackIds: string[];
};

/**
 * Paste rule:
 *  1. each item starts at `playheadFrame` + its copied offset;
 *  2. it goes on the current track when the whole item fits there;
 *  3. otherwise walk upward through the existing tracks above, one by one,
 *     and use the first that fits the whole item;
 *  4. only if none fits, create a new track at the top.
 * Every step is simulated through the real reducer, so the plan reflects
 * track normalization and is never rejected by the occupancy guard.
 */
export function planTimelinePaste(
  state: EditorState,
  clipboard: TimelineClipboard,
  options: { playheadFrame: number; createId: (kind: 'item' | 'track') => string },
): TimelinePastePlan {
  const playheadFrame = Math.max(0, Math.round(options.playheadFrame));
  const currentTrackId = currentTimelineTrackId(state);
  const plan: TimelinePastePlan = { actions: [], pastedItemIds: [], createdTrackIds: [] };
  let simulated = state;

  for (const { item: source, offsetInFrames } of clipboard.items) {
    const { fromExpr: _fromExpr, ...rest } = structuredClone(source);
    const item = { ...rest, id: options.createId('item'), from: playheadFrame + offsetInFrames } as Item;

    const tracks = simulated.tracks;
    const currentIndex = currentTrackId ? tracks.findIndex((track) => track.id === currentTrackId) : -1;
    let action: EditorAction | null = null;
    for (let index = currentIndex; index >= 0; index -= 1) {
      if (trackFits(tracks[index], item, simulated.primaryTrackId)) {
        action = { type: 'ADD_ITEM', payload: { trackId: tracks[index].id, item } };
        break;
      }
    }
    let next = action ? editorReducer(simulated, action) : simulated;
    if (!action || next === simulated) {
      const trackId = options.createId('track');
      action = {
        type: 'INSERT_TRACK',
        payload: {
          index: 0,
          track: { id: trackId, name: item.type.charAt(0).toUpperCase() + item.type.slice(1), items: [item] },
        },
      };
      next = editorReducer(simulated, action);
      if (next === simulated) continue;
      plan.createdTrackIds.push(trackId);
    }
    plan.actions.push(action);
    plan.pastedItemIds.push(item.id);
    simulated = next;
  }
  return plan;
}
