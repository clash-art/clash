import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import { timelineOccupancyIssues } from '@clash/shared-types';
import { getItemAssetDurationInFrames } from '../utils/itemRefs';
import type {
  CaptionWordReference,
  EditorState,
  EditorAction,
  Item,
  SubtitleTextItem,
  Track,
} from '../types';
import { isSubtitleTextItem } from '../types';
import { splitSubtitleTextItemIntoStickers } from '../transcriptEditing';
import {
  canBePrimaryTrack,
  canTrackAcceptItem,
  inferTrackCategory,
  normalizeTrackCategory,
  sortTracksByCategory,
} from '../trackCategories';
import {
  rippleDeleteTimelineKeyframes,
  sliceTimelineKeyframes,
} from '../timelineKeyframes';
import {
  TIMELINE_EDITOR_ROOT_DEFAULT_OVERRIDES,
  TIMELINE_SHARED_DEFAULTS,
} from '../timelineFieldConsumers';

function choosePrimaryTrackId(tracks: Track[], preferredId?: string | null): string | null {
  const preferred = preferredId ? tracks.find((track) => track.id === preferredId) : undefined;
  if (preferred && canBePrimaryTrack(preferred)) return preferred.id;

  return tracks.find((track) => track.category === 'primary' && canBePrimaryTrack(track))?.id
    ?? tracks.find((track) => track.role === 'primary-video' && canBePrimaryTrack(track))?.id
    ?? tracks.find((track) =>
      track.items.some((item) => item.type !== 'audio') && canBePrimaryTrack(track)
    )?.id
    ?? tracks.find((track) => track.items.length === 0 && canBePrimaryTrack(track))?.id
    ?? null;
}

function createPersistentPrimaryTrack(tracks: readonly Track[]): Track {
  let id = 'primary';
  let suffix = 2;
  const usedIds = new Set(tracks.map((track) => track.id));
  while (usedIds.has(id)) {
    id = `primary-${suffix}`;
    suffix += 1;
  }
  return {
    id,
    name: 'Media',
    role: 'primary-video',
    category: 'primary',
    items: [],
  };
}

function normalizeStorylineTracks(
  tracks: Track[],
  preferredId?: string | null,
): Pick<EditorState, 'tracks' | 'primaryTrackId'> {
  let primaryTrackId = choosePrimaryTrackId(tracks, preferredId);
  let tracksWithPrimary = tracks;
  if (!primaryTrackId) {
    const persistentPrimaryTrack = createPersistentPrimaryTrack(tracks);
    tracksWithPrimary = [...tracks, persistentPrimaryTrack];
    primaryTrackId = persistentPrimaryTrack.id;
  }
  const normalizedTracks = tracksWithPrimary.map((track) => {
    const normalizedItems = track.role === 'subtitle'
      ? track.items.flatMap((item) => (
          isSubtitleTextItem(item)
            ? splitSubtitleTextItemIntoStickers(item)
            : [item]
        ))
      : track.items;
    const semanticTrack = normalizedItems === track.items
      ? track
      : { ...track, items: normalizedItems };
    if (track.id === primaryTrackId) {
      return semanticTrack.category === 'primary'
        ? semanticTrack
        : { ...semanticTrack, category: 'primary' as const };
    }

    // A malformed/legacy document may mark more than one primary lane. Keep
    // the chosen anchor and infer a regular category for every other lane.
    const base = semanticTrack.category === 'primary'
      ? { ...semanticTrack, category: undefined }
      : semanticTrack;
    const inferred = inferTrackCategory(base);
    if (inferred === 'primary') return { ...base, category: 'visual' as const };
    return normalizeTrackCategory(base);
  });

  return {
    tracks: sortTracksByCategory(normalizedTracks, primaryTrackId),
    primaryTrackId,
  };
}

function withoutFromExpression<T extends Item>(item: T): T {
  const { fromExpr: _fromExpr, ...rest } = item;
  return rest as T;
}

function applyItemUpdates(item: Item, updates: Partial<Item>): Item {
  const updated = { ...item } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete updated[key];
    } else {
      updated[key] = value;
    }
  }
  if (
    item.keyframes
    && !Object.prototype.hasOwnProperty.call(updates, 'keyframes')
    && typeof updates.durationInFrames === 'number'
    && updates.durationInFrames !== item.durationInFrames
  ) {
    const nextFrom = typeof updates.from === 'number' ? updates.from : item.from;
    const sliced = sliceTimelineKeyframes(
      item.keyframes,
      nextFrom - item.from,
      updates.durationInFrames,
    );
    if (sliced) {
      updated.keyframes = sliced;
    } else {
      delete updated.keyframes;
    }
  }
  return updated as unknown as Item;
}

function advanceMediaSource(item: Item, frames: number): Item {
  if (item.type !== 'video' && item.type !== 'audio') return item;
  return {
    ...item,
    sourceStartInFrames: (item.sourceStartInFrames ?? 0) + frames,
  };
}

const CJK_CAPTION_CHARACTER = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
const NO_CAPTION_SPACE_BEFORE = /^(?:[,.;:!?%)}，。！？；：、）》】”’…]|\])/;

function joinCaptionWords(words: string[]): string {
  let result = '';
  for (const word of words) {
    const text = word.trim();
    if (!text) continue;
    const resultCharacters = Array.from(result);
    const previous = resultCharacters[resultCharacters.length - 1] ?? '';
    const current = Array.from(text)[0] ?? '';
    const needsSpace = Boolean(
      result
      && !NO_CAPTION_SPACE_BEFORE.test(text)
      && !CJK_CAPTION_CHARACTER.test(previous)
      && !CJK_CAPTION_CHARACTER.test(current),
    );
    result += `${needsSpace ? ' ' : ''}${text}`;
  }
  return result;
}

function synchronizeSubtitleTextWithTranscript(
  item: SubtitleTextItem,
  transcript: EditorState['assetTranscripts'][string],
): SubtitleTextItem {
  const transcriptWords = new Map(transcript.words.map((word) => [word.id, word]));
  let changed = false;
  const wordRefs = (item.wordRefs ?? []).map((wordRef) => {
    if (wordRef.assetId !== transcript.assetId || !wordRef.assetWordId) return wordRef;
    const transcriptWord = transcriptWords.get(wordRef.assetWordId);
    if (!transcriptWord || transcriptWord.text === wordRef.text) return wordRef;
    changed = true;
    return { ...wordRef, text: transcriptWord.text };
  });
  if (!changed) return item;

  const wordRefsById = new Map(wordRefs.map((wordRef) => [wordRef.id, wordRef]));
  const cues = item.cues.map((cue) => {
    const cueWords = (cue.wordIds ?? [])
      .map((wordId) => wordRefsById.get(wordId))
      .filter((word): word is CaptionWordReference => Boolean(word));
    if (cueWords.length === 0) return cue;
    return {
      ...cue,
      text: joinCaptionWords(cueWords.map((word) => word.text)),
    };
  });
  return {
    ...item,
    wordRefs,
    cues,
    text: cues.map((cue) => cue.text).join('\n'),
  };
}

function captionWordOutputRange(
  item: SubtitleTextItem,
  word: CaptionWordReference,
): { start: number; end: number } | null {
  const maps = (item.sourceToOutputMap ?? [])
    .filter((entry) =>
      word.sourceStartFrame >= entry.sourceStartFrame
      && word.sourceEndFrame <= entry.sourceEndFrame
      && entry.sourceEndFrame > entry.sourceStartFrame
      && entry.outputEndFrame > entry.outputStartFrame
    )
    .sort((left, right) =>
      (left.sourceEndFrame - left.sourceStartFrame)
      - (right.sourceEndFrame - right.sourceStartFrame)
    );
  const map = maps[0];
  if (!map) return null;
  const sourceDuration = map.sourceEndFrame - map.sourceStartFrame;
  const outputDuration = map.outputEndFrame - map.outputStartFrame;
  const project = (sourceFrame: number) =>
    map.outputStartFrame
    + Math.round(((sourceFrame - map.sourceStartFrame) / sourceDuration) * outputDuration);
  return {
    start: project(word.sourceStartFrame),
    end: Math.max(project(word.sourceStartFrame) + 1, project(word.sourceEndFrame)),
  };
}

function rippleDeleteCaptionItem(
  item: SubtitleTextItem,
  startFrame: number,
  endFrame: number,
): SubtitleTextItem[] | null {
  const wordRefs = item.wordRefs ?? [];
  if (wordRefs.length === 0 || (item.sourceToOutputMap?.length ?? 0) === 0) return null;

  const removedDuration = endFrame - startFrame;
  const itemStart = item.from;
  const itemEnd = item.from + item.durationInFrames;
  const overlapStart = Math.max(itemStart, startFrame);
  const overlapEnd = Math.min(itemEnd, endFrame);
  const nextDuration = item.durationInFrames - Math.max(0, overlapEnd - overlapStart);
  if (nextDuration <= 0) return [];
  const nextFrom = itemStart < startFrame ? itemStart : startFrame;
  const shiftAbsoluteFrame = (frame: number) => {
    if (frame <= startFrame) return frame;
    if (frame >= endFrame) return frame - removedDuration;
    return startFrame;
  };

  const projectedWords = wordRefs.flatMap((word) => {
    const output = captionWordOutputRange(item, word);
    if (!output) return [];
    const absoluteStart = itemStart + output.start;
    const absoluteEnd = itemStart + output.end;
    if (absoluteEnd > startFrame && absoluteStart < endFrame) return [];
    return [{
      word,
      startFrame: Math.max(0, shiftAbsoluteFrame(absoluteStart) - nextFrom),
      endFrame: Math.max(1, shiftAbsoluteFrame(absoluteEnd) - nextFrom),
    }];
  });
  const projectedById = new Map(projectedWords.map((entry) => [entry.word.id, entry]));
  const cues = item.cues.flatMap((cue) => {
    const cueWords = (cue.wordIds ?? [])
      .map((wordId) => projectedById.get(wordId))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    if (cueWords.length === 0) return [];
    const cueStart = Math.min(...cueWords.map((entry) => entry.startFrame));
    const cueEnd = Math.max(...cueWords.map((entry) => entry.endFrame));
    return [{
      ...cue,
      startFrame: cueStart,
      durationInFrames: Math.max(1, cueEnd - cueStart),
      text: joinCaptionWords(cueWords.map((entry) => entry.word.text)),
      wordIds: cueWords.map((entry) => entry.word.id),
      sourceStartFrame: Math.min(...cueWords.map((entry) => entry.word.sourceStartFrame)),
      sourceEndFrame: Math.max(...cueWords.map((entry) => entry.word.sourceEndFrame)),
    }];
  });
  if (cues.length === 0) return [];

  const keptWordIds = new Set(cues.flatMap((cue) => cue.wordIds ?? []));
  const keptWords = projectedWords.filter((entry) => keptWordIds.has(entry.word.id));
  const sourceToOutputMap = [
    ...keptWords.map((entry) => ({
      sourceStartFrame: entry.word.sourceStartFrame,
      sourceEndFrame: entry.word.sourceEndFrame,
      outputStartFrame: entry.startFrame,
      outputEndFrame: entry.endFrame,
    })),
    ...cues.map((cue) => ({
      sourceStartFrame: cue.sourceStartFrame!,
      sourceEndFrame: cue.sourceEndFrame!,
      outputStartFrame: cue.startFrame,
      outputEndFrame: cue.startFrame + cue.durationInFrames,
    })),
  ];

  return [withoutFromExpression({
    ...item,
    from: nextFrom,
    durationInFrames: nextDuration,
    ...(item.keyframes
      ? {
          keyframes: rippleDeleteTimelineKeyframes(
            item.keyframes,
            overlapStart - itemStart,
            overlapEnd - itemStart,
            item.durationInFrames,
          ),
        }
      : {}),
    text: cues.map((cue) => cue.text).join('\n'),
    cues,
    wordRefs: keptWords.map((entry) => entry.word),
    sourceToOutputMap,
  })];
}

function rippleDeleteItem(item: Item, startFrame: number, endFrame: number): Item[] {
  const itemStart = item.from;
  const itemEnd = item.from + item.durationInFrames;
  const removedDuration = endFrame - startFrame;

  if (itemEnd <= startFrame) return [item];
  if (itemStart >= endFrame) {
    return [withoutFromExpression({ ...item, from: itemStart - removedDuration } as Item)];
  }
  if (item.type === 'transition') return [];
  if (itemStart >= startFrame && itemEnd <= endFrame) return [];
  if (isSubtitleTextItem(item)) {
    const captionItems = rippleDeleteCaptionItem(item, startFrame, endFrame);
    if (captionItems) return captionItems;
  }

  if (itemStart < startFrame && itemEnd > endFrame) {
    const leftDuration = startFrame - itemStart;
    const rightDuration = itemEnd - endFrame;
    const left = withoutFromExpression({
      ...item,
      durationInFrames: leftDuration,
      ...(item.keyframes
        ? { keyframes: sliceTimelineKeyframes(item.keyframes, 0, leftDuration) }
        : {}),
    } as Item);
    const right = withoutFromExpression(advanceMediaSource({
      ...item,
      id: `${item.id}-ripple-${startFrame}-${endFrame}`,
      from: startFrame,
      durationInFrames: rightDuration,
      ...(item.keyframes
        ? {
            keyframes: sliceTimelineKeyframes(
              item.keyframes,
              endFrame - itemStart,
              rightDuration,
            ),
          }
        : {}),
    } as Item, endFrame - itemStart));
    return [left, right];
  }

  if (itemStart < startFrame) {
    const nextDuration = startFrame - itemStart;
    return [withoutFromExpression({
      ...item,
      durationInFrames: nextDuration,
      ...(item.keyframes
        ? { keyframes: sliceTimelineKeyframes(item.keyframes, 0, nextDuration) }
        : {}),
    } as Item)];
  }

  const nextDuration = itemEnd - endFrame;
  return [withoutFromExpression(advanceMediaSource({
    ...item,
    from: startFrame,
    durationInFrames: nextDuration,
    ...(item.keyframes
      ? {
          keyframes: sliceTimelineKeyframes(
            item.keyframes,
            endFrame - itemStart,
            nextDuration,
          ),
        }
      : {}),
  } as Item, endFrame - itemStart))];
}

function sliceSubtitleSticker(
  item: SubtitleTextItem,
  base: SubtitleTextItem,
  segmentStartFrame: number,
  segmentDurationInFrames: number,
): SubtitleTextItem {
  const segmentEndFrame = segmentStartFrame + segmentDurationInFrames;
  const sourceToOutputMap = (item.sourceToOutputMap ?? []).flatMap((entry) => {
    const outputStart = Math.max(segmentStartFrame, entry.outputStartFrame);
    const outputEnd = Math.min(segmentEndFrame, entry.outputEndFrame);
    if (outputEnd <= outputStart) return [];

    const outputSpan = entry.outputEndFrame - entry.outputStartFrame;
    const sourceSpan = entry.sourceEndFrame - entry.sourceStartFrame;
    const sourceAt = (outputFrame: number) => (
      outputSpan <= 0
        ? entry.sourceStartFrame
        : entry.sourceStartFrame
          + ((outputFrame - entry.outputStartFrame) / outputSpan) * sourceSpan
    );

    return [{
      sourceStartFrame: Math.round(sourceAt(outputStart)),
      sourceEndFrame: Math.round(sourceAt(outputEnd)),
      outputStartFrame: outputStart - segmentStartFrame,
      outputEndFrame: outputEnd - segmentStartFrame,
    }];
  });
  const originalCue = item.cues[0]!;
  const mappedSourceStart = sourceToOutputMap[0]?.sourceStartFrame;
  const mappedSourceEnd = sourceToOutputMap[sourceToOutputMap.length - 1]?.sourceEndFrame;
  const cueSourceSpan = (originalCue.sourceEndFrame ?? segmentEndFrame)
    - (originalCue.sourceStartFrame ?? 0);
  const fallbackSourceAt = (outputFrame: number) => (
    (originalCue.sourceStartFrame ?? 0)
    + (outputFrame / Math.max(1, item.durationInFrames)) * cueSourceSpan
  );

  return {
    ...base,
    text: item.text,
    durationInFrames: segmentDurationInFrames,
    cues: [{
      ...originalCue,
      text: item.text,
      startFrame: 0,
      durationInFrames: segmentDurationInFrames,
      sourceStartFrame: mappedSourceStart ?? Math.round(fallbackSourceAt(segmentStartFrame)),
      sourceEndFrame: mappedSourceEnd ?? Math.round(fallbackSourceAt(segmentEndFrame)),
    }],
    sourceToOutputMap: sourceToOutputMap.length > 0
      ? sourceToOutputMap
      : [{
          sourceStartFrame: Math.round(fallbackSourceAt(segmentStartFrame)),
          sourceEndFrame: Math.round(fallbackSourceAt(segmentEndFrame)),
          outputStartFrame: 0,
          outputEndFrame: segmentDurationInFrames,
        }],
  };
}

// Initial state (also exported for unit tests)
export const editorInitialState: EditorState = {
  tracks: [],
  primaryTrackId: TIMELINE_SHARED_DEFAULTS.root.primaryTrackId,
  selectedItemId: null,
  selectedTrackId: null,
  currentFrame: 0,
  playing: false,
  zoom: 1,
  assets: [],
  assetTranscripts: { ...TIMELINE_SHARED_DEFAULTS.root.assetTranscripts },
  compositionWidth: TIMELINE_SHARED_DEFAULTS.root.compositionWidth,
  compositionHeight: TIMELINE_SHARED_DEFAULTS.root.compositionHeight,
  fps: TIMELINE_SHARED_DEFAULTS.root.fps,
  durationInFrames: TIMELINE_EDITOR_ROOT_DEFAULT_OVERRIDES.durationInFrames,
};

function unhandledEditorAction(action: never): never {
  const type = (action as { type?: unknown }).type;
  throw new Error(`Unhandled Timeline editor action: ${String(type)}`);
}

// Reducer function — exported for unit tests; in app code consumers should
// dispatch through useEditorDispatch and let the provider drive it.
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  const next = applyEditorAction(state, action);
  if (next.tracks === state.tracks) return next;
  // Playback, zoom and appearance edits never scan clip geometry. DnD already
  // resolves collisions; this also protects direct inserts and numeric edits.
  if (action.type === 'UPDATE_ITEM' && !('from' in action.payload.updates) && !('durationInFrames' in action.payload.updates)) return next;
  const changedTracks = next.tracks.filter(track => !state.tracks.includes(track));
  return timelineOccupancyIssues({ tracks: changedTracks }).length ? state : next;
}

function applyEditorAction(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'ROLL_EDIT': {
      const { trackId, leftItemId, rightItemId, boundaryFrame } = action.payload;
      const track = state.tracks.find(candidate => candidate.id === trackId);
      const left = track?.items.find(item => item.id === leftItemId);
      const right = track?.items.find(item => item.id === rightItemId);
      if (!left || !right || !Number.isFinite(boundaryFrame) || left.from + left.durationInFrames !== right.from) return state;
      const leftMedia = left.type === 'video' || left.type === 'audio';
      const rightMedia = right.type === 'video' || right.type === 'audio';
      const rightOffset = rightMedia ? right.sourceStartInFrames ?? 0 : 0;
      const leftSourceEnd = leftMedia ? getItemAssetDurationInFrames(left, state.assets, state.fps) : undefined;
      const min = Math.max(left.from + 1, rightMedia ? right.from - rightOffset : 0);
      const max = Math.min(right.from + right.durationInFrames - 1,
        leftSourceEnd === undefined ? Infinity : left.from + leftSourceEnd - (leftMedia ? left.sourceStartInFrames ?? 0 : 0));
      if (min > max) return state;
      const boundary = Math.max(min, Math.min(max, Math.round(boundaryFrame)));
      if (boundary === right.from) return state;
      // Validate only the completed edit. Either intermediate update can overlap
      // its neighbor; neither intermediate state is published or enters history.
      let next = applyEditorAction(state, { type: 'UPDATE_ITEM', payload: { trackId, itemId: left.id,
        updates: { durationInFrames: boundary - left.from } } });
      next = applyEditorAction(next, { type: 'UPDATE_ITEM', payload: { trackId, itemId: right.id,
        updates: { from: boundary, durationInFrames: right.from + right.durationInFrames - boundary,
          ...(rightMedia ? { sourceStartInFrames: rightOffset + boundary - right.from } : {}) } } });
      for (const candidateTrack of next.tracks) {
        for (const item of candidateTrack.items) {
          if (item.type !== 'transition' || item.fromItemId !== left.id || item.toItemId !== right.id) continue;
          const duration = Math.min(item.durationInFrames, (boundary - left.from) * 2, (right.from + right.durationInFrames - boundary) * 2);
          next = applyEditorAction(next, { type: 'UPDATE_ITEM', payload: { trackId: candidateTrack.id, itemId: item.id,
            updates: { from: boundary - Math.floor(duration / 2), durationInFrames: duration } } });
        }
      }
      return next;
    }
    case 'ADD_TRACK':
      return {
        ...state,
        ...normalizeStorylineTracks(
          [...state.tracks, action.payload],
          state.primaryTrackId,
        ),
      };

    case 'INSERT_TRACK': {
      const newTracks = [...state.tracks];
      const { track, index } = action.payload;

      // Insert at specific index
      newTracks.splice(index, 0, track);


      return {
        ...state,
        ...normalizeStorylineTracks(newTracks, state.primaryTrackId),
      };
    }

    case 'REMOVE_TRACK': {
      const remainingTracks = state.tracks.filter((t) => t.id !== action.payload);
      return {
        ...state,
        ...normalizeStorylineTracks(remainingTracks, state.primaryTrackId),
        selectedTrackId: state.selectedTrackId === action.payload ? null : state.selectedTrackId,
      };
    }

    case 'SET_PRIMARY_TRACK':
      if (!state.tracks.some((track) => track.id === action.payload && canBePrimaryTrack(track))) return state;
      return {
        ...state,
        ...normalizeStorylineTracks(state.tracks, action.payload),
      };

    case 'UPDATE_TRACK': {
      const nextTracks = state.tracks.map((t) =>
        t.id === action.payload.id ? { ...t, ...action.payload.updates } : t
      );
      const updated = nextTracks.find((track) => track.id === action.payload.id);
      if (updated && updated.items.some((item) => !canTrackAcceptItem(updated, item, state.primaryTrackId))) {
        return state;
      }
      return {
        ...state,
        ...normalizeStorylineTracks(nextTracks, state.primaryTrackId),
      };
    }

    case 'REORDER_TRACKS':
      return {
        ...state,
        ...normalizeStorylineTracks(action.payload, state.primaryTrackId),
      };

    case 'ADD_ITEM': {
      const targetTrack = state.tracks.find((track) => track.id === action.payload.trackId);
      if (!targetTrack || !canTrackAcceptItem(targetTrack, action.payload.item, state.primaryTrackId)) {
        return state;
      }
      const nextTracks = state.tracks.map((track) => {
        if (track.id !== action.payload.trackId) return track;
        return normalizeTrackCategory({
          ...track,
          items: [...track.items, action.payload.item],
        }, state.primaryTrackId);
      });
      return {
        ...state,
        ...normalizeStorylineTracks(nextTracks, state.primaryTrackId),
      };
    }

    case 'MOVE_ITEM': {
      const { sourceTrackId, targetTrackId, itemId, from } = action.payload;
      const sourceTrack = state.tracks.find((track) => track.id === sourceTrackId);
      const targetTrack = state.tracks.find((track) => track.id === targetTrackId);
      const item = sourceTrack?.items.find((candidate) => candidate.id === itemId);
      if (!sourceTrack || !targetTrack || !item) return state;

      if (sourceTrackId === targetTrackId) {
        return editorReducer(state, {
          type: 'UPDATE_ITEM',
          payload: { trackId: sourceTrackId, itemId, updates: { from } },
        });
      }
      if (!canTrackAcceptItem(targetTrack, item, state.primaryTrackId)) return state;

      const movedItem = withoutFromExpression({ ...item, from } as Item);
      const movedTracks = state.tracks
        .map((track) => {
          if (track.id === sourceTrackId) {
            return { ...track, items: track.items.filter((candidate) => candidate.id !== itemId) };
          }
          if (track.id === targetTrackId) {
            return normalizeTrackCategory({ ...track, items: [...track.items, movedItem] }, state.primaryTrackId);
          }
          return track;
        })
        .filter((track) => track.items.length > 0 || track.id === state.primaryTrackId);

      return {
        ...state,
        ...normalizeStorylineTracks(movedTracks, state.primaryTrackId),
      };
    }

    case 'REMOVE_ITEM': {
      // Remove the item first
      const tracksAfterRemoval = state.tracks.map((t) =>
        t.id === action.payload.trackId
          ? { ...t, items: t.items.filter((i) => i.id !== action.payload.itemId) }
          : t
      );

      // Auto-delete empty tracks
      const finalTracks = tracksAfterRemoval.filter(
        (track) => track.items.length > 0 || track.id === state.primaryTrackId,
      );

      return {
        ...state,
        ...normalizeStorylineTracks(finalTracks, state.primaryTrackId),
        selectedItemId: state.selectedItemId === action.payload.itemId ? null : state.selectedItemId,
      };
    }

    case 'UPDATE_ITEM': {
      const targetItem = state.tracks
        .find((track) => track.id === action.payload.trackId)
        ?.items.find((item) => item.id === action.payload.itemId);
      if (!targetItem) return state;
      const currentValues = targetItem as unknown as Record<string, unknown>;
      const hasChange = Object.entries(action.payload.updates).some(
        ([key, value]) => !Object.is(currentValues[key], value),
      );
      if (!hasChange) return state;
      const synchronizeStickerUpdates = (item: Item): Item => {
        const updated = applyItemUpdates(item, action.payload.updates);
        if (!isSubtitleTextItem(item) || item.cues.length !== 1) return updated;
        const subtitleUpdates = action.payload.updates as Partial<SubtitleTextItem>;
        const updatedSubtitle = updated as SubtitleTextItem;
        const nextText = typeof subtitleUpdates.text === 'string'
          ? subtitleUpdates.text
          : item.text;
        const nextDuration = typeof subtitleUpdates.durationInFrames === 'number'
          ? subtitleUpdates.durationInFrames
          : item.durationInFrames;
        const cue = {
          ...item.cues[0]!,
          startFrame: 0,
          durationInFrames: nextDuration,
          text: nextText,
        };
        const sourceStartFrame = cue.sourceStartFrame
          ?? item.wordRefs?.[0]?.sourceStartFrame
          ?? 0;
        const sourceEndFrame = cue.sourceEndFrame
          ?? item.wordRefs?.[item.wordRefs.length - 1]?.sourceEndFrame
          ?? Math.max(1, nextDuration);
        return {
          ...updatedSubtitle,
          text: nextText,
          cues: subtitleUpdates.cues !== undefined
            ? subtitleUpdates.cues
            : [cue],
          sourceToOutputMap: subtitleUpdates.sourceToOutputMap !== undefined
            ? subtitleUpdates.sourceToOutputMap
            : [{
                sourceStartFrame,
                sourceEndFrame,
                outputStartFrame: 0,
                outputEndFrame: nextDuration,
              }],
        };
      };
      return {
        ...state,
        tracks: state.tracks.map((t) =>
          t.id === action.payload.trackId
            ? {
                ...t,
                items: t.items.map((i) =>
                  i.id === action.payload.itemId ? synchronizeStickerUpdates(i) : i
                ),
              }
          : t
        ),
      };
    }

    case 'SPLIT_ITEM': {
      const { trackId, itemId, splitFrame } = action.payload;

      return {
        ...state,
        tracks: state.tracks.map((t) => {
          if (t.id !== trackId) return t;

          const newItems = t.items.flatMap((item) => {
            if (item.id !== itemId) return [item];


            // Check if split frame is within item bounds
            const itemEnd = item.from + item.durationInFrames;

            if (splitFrame <= item.from || splitFrame >= itemEnd) {
              console.warn('⚠️ Split frame out of bounds, keeping original item');
              return [item];
            }

            // Step 1: Copy - 创建副本并修改 ID
            const cleanBase = (it: any) => {
              const clone = { ...it };
              delete clone.sourceMinStartInFrames;
              delete clone.sourceMaxEndInFrames;
              delete clone.justInserted;
              return clone;
            };

            const secondItem: any = {
              ...cleanBase(item),
              id: `${item.id}-split-${Date.now()}`,
            };

            // Step 2: 第一个 item - 保留前半部分
            const firstDuration = splitFrame - item.from;
            const currentOffset = (item as any).sourceStartInFrames || 0;

            const firstItem: any = {
              ...cleanBase(item),
              durationInFrames: firstDuration,
              ...(item.keyframes
                ? { keyframes: sliceTimelineKeyframes(item.keyframes, 0, firstDuration) }
                : {}),
              // 保持原始的 sourceStartInFrames，不添加任何人工锁
              // 素材的天然边界会自动限制扩展范围
              ...(item.type === 'video' || item.type === 'audio'
                ? {
                    sourceStartInFrames: currentOffset,
                  }
                : {}),
            };

            // Step 3: 第二个 item - 保留后半部分
            const secondDuration = itemEnd - splitFrame;
            const consumedFrames = splitFrame - item.from;
            const newSourceOffset = currentOffset + consumedFrames;

            Object.assign(secondItem, {
              from: splitFrame,
              durationInFrames: secondDuration,
              ...(item.keyframes
                ? {
                    keyframes: sliceTimelineKeyframes(
                      item.keyframes,
                      consumedFrames,
                      secondDuration,
                    ),
                  }
                : {}),
              // 设置新的 sourceStartInFrames 到 split 点，不添加任何人工锁
              // 素材的天然边界会自动限制扩展范围
              ...(item.type === 'video' || item.type === 'audio'
                ? {
                    sourceStartInFrames: newSourceOffset,
                  }
                : {}),
              // Mark as justInserted so TimelineItem will regenerate thumbnail
              justInserted: item.type === 'video',
            });

            if (isSubtitleTextItem(item) && item.cues.length === 1) {
              return [
                sliceSubtitleSticker(
                  item,
                  firstItem as SubtitleTextItem,
                  0,
                  firstDuration,
                ),
                sliceSubtitleSticker(
                  item,
                  secondItem as SubtitleTextItem,
                  firstDuration,
                  secondDuration,
                ),
              ];
            }

            return [firstItem as Item, secondItem as Item];
          });

          return { ...t, items: newItems };
        }),
      };
    }

    case 'RIPPLE_DELETE_RANGE': {
      const startFrame = Math.max(0, Math.floor(action.payload.startFrame));
      const endFrame = Math.min(
        state.durationInFrames,
        Math.ceil(action.payload.endFrame),
      );
      if (endFrame <= startFrame) return state;
      const rippleResultsByOriginalItemId = new Map<string, Item[]>();
      for (const track of state.tracks) {
        for (const item of track.items) {
          if (item.type === 'transition') continue;
          rippleResultsByOriginalItemId.set(
            item.id,
            track.locked ? [item] : rippleDeleteItem(item, startFrame, endFrame),
          );
        }
      }
      const tracks = state.tracks.map((track) => track.locked
        ? track
        : {
            ...track,
            items: track.items.flatMap((item) => {
              if (item.type !== 'transition') {
                return rippleResultsByOriginalItemId.get(item.id) ?? [];
              }
              return rippleDeleteItem(item, startFrame, endFrame).flatMap((shiftedItem) => {
                if (shiftedItem.type !== 'transition') return [];
                const boundaryFrame = shiftedItem.from + Math.floor(shiftedItem.durationInFrames / 2);
                const fromItem = (rippleResultsByOriginalItemId.get(item.fromItemId ?? '') ?? [])
                  .find((candidate) => candidate.from + candidate.durationInFrames === boundaryFrame);
                const toItem = (rippleResultsByOriginalItemId.get(item.toItemId ?? '') ?? [])
                  .find((candidate) => candidate.from === boundaryFrame);
                if (!fromItem || !toItem) return [];
                return [{
                  ...shiftedItem,
                  fromItemId: fromItem.id,
                  toItemId: toItem.id,
                }];
              });
            }),
          });
      const selectedItemStillExists = state.selectedItemId
        ? tracks.some((track) => track.items.some((item) => item.id === state.selectedItemId))
        : false;
      return {
        ...state,
        tracks,
        durationInFrames: Math.max(1, state.durationInFrames - (endFrame - startFrame)),
        selectedItemId: selectedItemStillExists ? state.selectedItemId : null,
        currentFrame: Math.min(startFrame, Math.max(0, state.durationInFrames - (endFrame - startFrame) - 1)),
        playing: false,
      };
    }

    case 'RESTORE_TIMELINE_SNAPSHOT':
      return {
        ...state,
        ...normalizeStorylineTracks(action.payload.tracks, state.primaryTrackId),
        durationInFrames: action.payload.durationInFrames,
        currentFrame: Math.min(state.currentFrame, Math.max(0, action.payload.durationInFrames - 1)),
        playing: false,
      };

    case 'SELECT_ITEM':
      return { ...state, selectedItemId: action.payload };

    case 'SELECT_TRACK':
      return { ...state, selectedTrackId: action.payload };

    case 'SET_CURRENT_FRAME':
      return { ...state, currentFrame: action.payload };

    case 'SET_PLAYING':
      return { ...state, playing: action.payload };

    case 'SET_ZOOM':
      return { ...state, zoom: action.payload };

    case 'ADD_ASSET':
      return {
        ...state,
        assets: [...state.assets, action.payload],
      };

    case 'UPSERT_ASSET': {
      const existingIndex = state.assets.findIndex((asset) =>
        asset.id === action.payload.id ||
        Boolean(action.payload.sourceNodeId && asset.sourceNodeId === action.payload.sourceNodeId)
      );
      if (existingIndex < 0) {
        return { ...state, assets: [...state.assets, action.payload] };
      }
      return {
        ...state,
        assets: state.assets.map((asset, index) => index === existingIndex ? action.payload : asset),
      };
    }

    case 'SET_ASSET_TRANSCRIPT':
      return {
        ...state,
        tracks: state.tracks.map((track) => ({
          ...track,
          items: track.items.map((item) => (
            isSubtitleTextItem(item)
              ? synchronizeSubtitleTextWithTranscript(item, action.payload)
              : item
          )),
        })),
        assetTranscripts: {
          ...state.assetTranscripts,
          [action.payload.assetId]: action.payload,
        },
      };

    case 'REMOVE_ASSET':
      return {
        ...state,
        assets: state.assets.filter((a) => a.id !== action.payload),
      };

    case 'SET_COMPOSITION_SIZE':
      return {
        ...state,
        compositionWidth: action.payload.width,
        compositionHeight: action.payload.height,
      };

    case 'SET_DURATION':
      return { ...state, durationInFrames: action.payload };

    default:
      return unhandledEditorAction(action);
  }
}

// Context
type EditorContextType = {
  state: EditorState;
  dispatch: React.Dispatch<EditorDispatchAction>;
};

export type EditorHistoryCommand =
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'BEGIN_HISTORY_GROUP' }
  | { type: 'END_HISTORY_GROUP' };

export type EditorDispatchAction = EditorAction | EditorHistoryCommand;

export type TimelineHistorySnapshot = Pick<
  EditorState,
  | 'tracks'
  | 'primaryTrackId'
  | 'durationInFrames'
  | 'compositionWidth'
  | 'compositionHeight'
>;

export type EditorHistoryState = {
  present: EditorState;
  past: TimelineHistorySnapshot[];
  future: TimelineHistorySnapshot[];
  groupSnapshot: TimelineHistorySnapshot | null;
  groupChanged: boolean;
};

type EditorHistoryContextType = {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  beginHistoryGroup: () => void;
  endHistoryGroup: () => void;
};

type EditorStaticState = Omit<EditorState, 'currentFrame' | 'playing'>;
type EditorPlaybackState = Pick<EditorState, 'currentFrame' | 'playing'>;
type EditorPlaybackRefs = {
  currentFrameRef: React.MutableRefObject<number>;
  playingRef: React.MutableRefObject<boolean>;
};

const EditorContext = createContext<EditorContextType | undefined>(undefined);
const EditorStaticStateContext = createContext<EditorStaticState | undefined>(undefined);
const EditorPlaybackContext = createContext<EditorPlaybackState | undefined>(undefined);
const EditorPlaybackRefsContext = createContext<EditorPlaybackRefs | undefined>(undefined);
const EditorDispatchContext = createContext<React.Dispatch<EditorDispatchAction> | undefined>(undefined);
const EditorHistoryContext = createContext<EditorHistoryContextType | undefined>(undefined);

// Default state for normalization
const defaultState = editorInitialState;

// Normalize initial state by merging with defaults
export function normalizeInitialState(providedState?: Partial<EditorState>): EditorState {
  // Filter out undefined values to prevent overwriting defaults
  const filteredState = Object.fromEntries(
    Object.entries(providedState ?? {}).filter(([_, value]) => value !== undefined)
  ) as Partial<EditorState>;
  const merged = { ...defaultState, ...filteredState };
  Object.assign(
    merged,
    normalizeStorylineTracks(
      merged.tracks,
      filteredState.primaryTrackId,
    ),
  );

  if (!merged.fps || merged.fps < 1) {
    merged.fps = defaultState.fps;
  }

  if (!merged.durationInFrames || merged.durationInFrames < 1) {
    let maxEnd = 0;
    for (const track of merged.tracks) {
      for (const item of track.items) {
        const end = item.from + item.durationInFrames;
        if (end > maxEnd) maxEnd = end;
      }
    }
    merged.durationInFrames = maxEnd > 0 ? maxEnd : defaultState.durationInFrames;
  }

  return merged;
}

const TIMELINE_HISTORY_LIMIT = 100;

const TIMELINE_HISTORY_ACTIONS = new Set<EditorAction['type']>([
  'ADD_TRACK',
  'INSERT_TRACK',
  'REMOVE_TRACK',
  'SET_PRIMARY_TRACK',
  'UPDATE_TRACK',
  'REORDER_TRACKS',
  'ADD_ITEM',
  'MOVE_ITEM',
  'ROLL_EDIT',
  'REMOVE_ITEM',
  'UPDATE_ITEM',
  'SPLIT_ITEM',
  'RIPPLE_DELETE_RANGE',
  'RESTORE_TIMELINE_SNAPSHOT',
  'SET_COMPOSITION_SIZE',
  'SET_DURATION',
]);

function timelineSnapshot(state: EditorState): TimelineHistorySnapshot {
  return {
    tracks: state.tracks,
    primaryTrackId: state.primaryTrackId,
    durationInFrames: state.durationInFrames,
    compositionWidth: state.compositionWidth,
    compositionHeight: state.compositionHeight,
  };
}

function restoreTimelineSnapshot(
  current: EditorState,
  snapshot: TimelineHistorySnapshot,
): EditorState {
  const selectedItemStillExists = current.selectedItemId
    ? snapshot.tracks.some((track) =>
        track.items.some((item) => item.id === current.selectedItemId),
      )
    : false;
  const selectedTrackStillExists = current.selectedTrackId
    ? snapshot.tracks.some((track) => track.id === current.selectedTrackId)
    : false;

  return {
    ...current,
    ...snapshot,
    selectedItemId: selectedItemStillExists ? current.selectedItemId : null,
    selectedTrackId: selectedTrackStillExists ? current.selectedTrackId : null,
    currentFrame: Math.min(
      current.currentFrame,
      Math.max(0, snapshot.durationInFrames - 1),
    ),
    playing: false,
  };
}

function timelineDocumentChanged(previous: EditorState, next: EditorState): boolean {
  return previous.tracks !== next.tracks
    || previous.primaryTrackId !== next.primaryTrackId
    || previous.durationInFrames !== next.durationInFrames
    || previous.compositionWidth !== next.compositionWidth
    || previous.compositionHeight !== next.compositionHeight;
}

function pushPast(
  past: TimelineHistorySnapshot[],
  snapshot: TimelineHistorySnapshot,
): TimelineHistorySnapshot[] {
  return [...past, snapshot].slice(-TIMELINE_HISTORY_LIMIT);
}

export function createEditorHistoryState(
  providedState?: Partial<EditorState>,
): EditorHistoryState {
  return {
    present: normalizeInitialState(providedState),
    past: [],
    future: [],
    groupSnapshot: null,
    groupChanged: false,
  };
}

function finishHistoryGroup(state: EditorHistoryState): EditorHistoryState {
  if (!state.groupSnapshot) return state;
  return {
    ...state,
    past: state.groupChanged
      ? pushPast(state.past, state.groupSnapshot)
      : state.past,
    groupSnapshot: null,
    groupChanged: false,
  };
}

export function editorHistoryReducer(
  history: EditorHistoryState,
  action: EditorDispatchAction,
): EditorHistoryState {
  if (action.type === 'BEGIN_HISTORY_GROUP') {
    if (history.groupSnapshot) return history;
    return {
      ...history,
      groupSnapshot: timelineSnapshot(history.present),
      groupChanged: false,
    };
  }

  if (action.type === 'END_HISTORY_GROUP') {
    return finishHistoryGroup(history);
  }

  if (action.type === 'UNDO') {
    const settled = finishHistoryGroup(history);
    const snapshot = settled.past[settled.past.length - 1];
    if (!snapshot) return settled;
    return {
      ...settled,
      present: restoreTimelineSnapshot(settled.present, snapshot),
      past: settled.past.slice(0, -1),
      future: [timelineSnapshot(settled.present), ...settled.future],
    };
  }

  if (action.type === 'REDO') {
    const settled = finishHistoryGroup(history);
    const snapshot = settled.future[0];
    if (!snapshot) return settled;
    return {
      ...settled,
      present: restoreTimelineSnapshot(settled.present, snapshot),
      past: pushPast(settled.past, timelineSnapshot(settled.present)),
      future: settled.future.slice(1),
    };
  }

  const present = editorReducer(history.present, action);
  const shouldRecord = TIMELINE_HISTORY_ACTIONS.has(action.type)
    && timelineDocumentChanged(history.present, present);

  if (!shouldRecord) {
    return present === history.present ? history : { ...history, present };
  }

  if (history.groupSnapshot) {
    return {
      ...history,
      present,
      future: [],
      groupChanged: true,
    };
  }

  return {
    ...history,
    present,
    past: pushPast(history.past, timelineSnapshot(history.present)),
    future: [],
  };
}

type EditorProviderProps = {
  children: ReactNode;
  initialState?: Partial<EditorState>;
  onStateChange?: (state: EditorState) => void;
};

// Provider
export function EditorProvider({ children, initialState: providedInitialState, onStateChange }: EditorProviderProps) {
  const [historyState, dispatch] = useReducer(
    editorHistoryReducer,
    providedInitialState,
    createEditorHistoryState,
  );
  const state = historyState.present;

  // Legacy onStateChange support - prefer using stateRef in Editor component instead
  // This still has some overhead, but much less than before (only runs on persistable changes)
  const prevPersistableRef = React.useRef<{ content: string; zoom: number } | null>(null);
  const stateRef = React.useRef(state);
  const currentFrameRef = React.useRef(state.currentFrame);
  const playingRef = React.useRef(state.playing);
  stateRef.current = state;
  currentFrameRef.current = state.currentFrame;
  playingRef.current = state.playing;

  const {
    tracks,
    primaryTrackId,
    selectedItemId,
    selectedTrackId,
    compositionWidth,
    compositionHeight,
    fps,
    durationInFrames,
    assets,
    assetTranscripts,
    zoom,
  } = state;

  const staticState = React.useMemo<EditorStaticState>(
    () => ({
      tracks,
      primaryTrackId,
      selectedItemId,
      selectedTrackId,
      zoom,
      assets,
      assetTranscripts,
      compositionWidth,
      compositionHeight,
      fps,
      durationInFrames,
    }),
    [
      tracks,
      primaryTrackId,
      selectedItemId,
      selectedTrackId,
      zoom,
      assets,
      assetTranscripts,
      compositionWidth,
      compositionHeight,
      fps,
      durationInFrames,
    ],
  );

  const playbackState = React.useMemo<EditorPlaybackState>(
    () => ({
      currentFrame: state.currentFrame,
      playing: state.playing,
    }),
    [state.currentFrame, state.playing],
  );

  const playbackRefs = React.useMemo<EditorPlaybackRefs>(
    () => ({
      currentFrameRef,
      playingRef,
    }),
    [],
  );

  const fullContext = React.useMemo<EditorContextType>(
    () => ({
      state,
      dispatch,
    }),
    [state, dispatch],
  );

  const historyContext = React.useMemo<EditorHistoryContextType>(
    () => ({
      canUndo: historyState.past.length > 0 || historyState.groupChanged,
      canRedo: historyState.future.length > 0,
      undo: () => dispatch({ type: 'UNDO' }),
      redo: () => dispatch({ type: 'REDO' }),
      beginHistoryGroup: () => dispatch({ type: 'BEGIN_HISTORY_GROUP' }),
      endHistoryGroup: () => dispatch({ type: 'END_HISTORY_GROUP' }),
    }),
    [dispatch, historyState.future.length, historyState.groupChanged, historyState.past.length],
  );

  // Zoom changes frequently without changing any authored content. Retain the
  // content comparison across those changes instead of traversing every clip
  // and media payload again for each wheel tick.
  const observesState = Boolean(onStateChange);
  const persistableContent = React.useMemo(() => observesState
    ? JSON.stringify({ tracks, primaryTrackId, compositionWidth, compositionHeight, fps, durationInFrames, assets, assetTranscripts })
    : null,
  [observesState, tracks, primaryTrackId, compositionWidth, compositionHeight, fps, durationInFrames, assets, assetTranscripts]);

  React.useEffect(() => {
    if (!onStateChange || persistableContent === null) return;

    const previous = prevPersistableRef.current;
    if (previous?.content !== persistableContent || previous.zoom !== zoom) {
      prevPersistableRef.current = { content: persistableContent, zoom };
      onStateChange(stateRef.current);
    }
  }, [onStateChange, persistableContent, zoom]);

  return (
    <EditorHistoryContext.Provider value={historyContext}>
      <EditorDispatchContext.Provider value={dispatch}>
        <EditorPlaybackRefsContext.Provider value={playbackRefs}>
          <EditorStaticStateContext.Provider value={staticState}>
            <EditorPlaybackContext.Provider value={playbackState}>
              <EditorContext.Provider value={fullContext}>{children}</EditorContext.Provider>
            </EditorPlaybackContext.Provider>
          </EditorStaticStateContext.Provider>
        </EditorPlaybackRefsContext.Provider>
      </EditorDispatchContext.Provider>
    </EditorHistoryContext.Provider>
  );
}

function useRequiredContext<T>(context: React.Context<T | undefined>, hookName: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${hookName} must be used within EditorProvider`);
  }
  return value;
}

// Full editor hook for consumers that truly need the complete state object.
export function useEditor() {
  return useRequiredContext(EditorContext, 'useEditor');
}

export function useEditorStaticState() {
  return useRequiredContext(EditorStaticStateContext, 'useEditorStaticState');
}

export function useEditorPlayback() {
  return useRequiredContext(EditorPlaybackContext, 'useEditorPlayback');
}

export function useEditorPlaybackRefs() {
  return useRequiredContext(EditorPlaybackRefsContext, 'useEditorPlaybackRefs');
}

export function useEditorDispatch() {
  return useRequiredContext(EditorDispatchContext, 'useEditorDispatch');
}

export function useEditorHistory() {
  return useRequiredContext(EditorHistoryContext, 'useEditorHistory');
}
