// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EditorProvider,
  useEditorDispatch,
  useEditorHistory,
  useEditorPlayback,
  useEditorStaticState,
  type EditorState,
  type Item,
  type Track,
} from '@clash/remotion-core';
import { TimelineItem } from './TimelineItem';
import { TIMELINE_NOTICE_EVENT } from './timelineNotice';

afterEach(cleanup);

const item: Item = {
  id: 'shot', type: 'image', src: 'photo.png', from: 30, durationInFrames: 61,
  keyframes: {
    position: [
      { frame: 0, value: [0, 0], interpolation: 'linear' },
      { frame: 30, value: [100, 0], interpolation: 'linear' },
    ],
    scale: [{ frame: 30, value: [2, 2], interpolation: 'linear' }],
    opacity: [{ frame: 45, value: 0.5, interpolation: 'hold' }],
  },
};
const track: Track = { id: 'photos', name: 'Photos', items: [item] };
// 61 frames at 2px/frame is 122px; markers spread over 60 frame steps.
const pixelsPerMarkerFrame = 122 / 60;

function LiveItem() {
  const { tracks } = useEditorStaticState();
  const dispatch = useEditorDispatch();
  const liveTrack = tracks[0]!;
  return (
    <TimelineItem
      item={liveTrack.items[0]!}
      track={liveTrack}
      trackId={liveTrack.id}
      pixelsPerFrame={2}
      isSelected
      assets={[]}
      onSelect={() => {}}
      onDelete={() => {}}
      onUpdate={(itemId, updates) => dispatch({
        type: 'UPDATE_ITEM',
        payload: { trackId: liveTrack.id, itemId, updates },
      })}
    />
  );
}

function Controls() {
  const { currentFrame } = useEditorPlayback();
  const { canUndo, undo } = useEditorHistory();
  return (
    <>
      <output aria-label="Playhead">{currentFrame}</output>
      <button type="button" onClick={undo} disabled={!canUndo}>Undo</button>
    </>
  );
}

const draw = () => {
  const states: EditorState[] = [];
  const parentPointerDown = vi.fn();
  const view = render(
    <EditorProvider
      initialState={{ fps: 30, tracks: [track], currentFrame: 0 }}
      onStateChange={(state) => states.push(state)}
    >
      <Controls />
      <div onPointerDown={parentPointerDown}>
        <LiveItem />
      </div>
    </EditorProvider>,
  );
  const marker = (frame: number) => view.container.querySelector<HTMLElement>(
    `[data-timeline-keyframe-marker][data-keyframe-frame="${frame}"]`,
  )!;
  const markerFrames = () => [...view.container.querySelectorAll<HTMLElement>('[data-timeline-keyframe-marker]')]
    .map((element) => [element.dataset.keyframeFrame, element.dataset.keyframeChannels]);
  const keyframesOf = (state: EditorState) => state.tracks[0]!.items[0]!.keyframes;
  return { ...view, states, parentPointerDown, marker, markerFrames, keyframesOf };
};

const drag = (element: HTMLElement, startX: number, ...moves: number[]) => {
  fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: startX });
  for (const x of moves) fireEvent.pointerMove(element, { pointerId: 1, clientX: x });
  fireEvent.pointerUp(element, { pointerId: 1, clientX: moves.at(-1) ?? startX });
};

it('moves every channel of a merged marker as one undo step and one save', () => {
  const view = draw();
  const savesBefore = view.states.length;
  const marker = view.marker(30);

  fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100 });
  fireEvent.pointerMove(marker, { pointerId: 1, clientX: 100 + 3 * pixelsPerMarkerFrame });
  fireEvent.pointerMove(marker, { pointerId: 1, clientX: 100 + 7 * pixelsPerMarkerFrame });
  fireEvent.pointerMove(marker, { pointerId: 1, clientX: 100 + 10 * pixelsPerMarkerFrame });
  // The preview follows the pointer in whole frames without touching the Timeline.
  expect(marker.dataset.keyframeFrame).toBe('40');
  expect(marker.dataset.keyframeDragging).toBe('');
  expect(view.states.length).toBe(savesBefore);
  fireEvent.pointerUp(marker, { pointerId: 1, clientX: 100 + 10 * pixelsPerMarkerFrame });

  // The clip did not start a move or a selection gesture underneath.
  expect(view.parentPointerDown).not.toHaveBeenCalled();
  expect(view.states.length).toBe(savesBefore + 1);
  const saved = view.keyframesOf(view.states.at(-1)!);
  expect(saved?.position?.map((keyframe) => keyframe.frame)).toEqual([0, 40]);
  expect(saved?.scale?.map((keyframe) => keyframe.frame)).toEqual([40]);
  expect(saved?.opacity).toEqual(item.keyframes!.opacity);
  expect(view.states.at(-1)!.tracks[0]!.items[0]!.from).toBe(item.from);
  expect(view.markerFrames()).toEqual([
    ['0', 'position'],
    ['40', 'position,scale'],
    ['45', 'opacity'],
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(view.keyframesOf(view.states.at(-1)!)).toEqual(item.keyframes);
  expect(screen.getByRole('button', { name: 'Undo' })).toHaveProperty('disabled', true);
});

it('does not seek the playhead when a drag releases, but a plain click still seeks', () => {
  const view = draw();
  const marker = view.marker(45);

  drag(marker, 200, 200 - 5 * pixelsPerMarkerFrame);
  fireEvent.click(marker);
  expect(screen.getByLabelText('Playhead').textContent).toBe('0');

  const moved = view.marker(40);
  drag(moved, 50);
  fireEvent.click(moved);
  expect(screen.getByLabelText('Playhead').textContent).toBe(String(item.from + 40));
});

it('keeps dragged keyframes inside the clip, including the end cap', () => {
  const view = draw();

  drag(view.marker(45), 200, 2000);
  expect(view.marker(60).dataset.keyframeEdge).toBe('end');
  expect(view.keyframesOf(view.states.at(-1)!)?.opacity?.[0]?.frame).toBe(60);

  const savesBefore = view.states.length;
  drag(view.marker(0), 50, -500);
  expect(view.marker(0).dataset.keyframeEdge).toBe('start');
  expect(view.states.length).toBe(savesBefore);
});

it('joins a frame held only by other channels', () => {
  const view = draw();

  drag(view.marker(45), 200, 200 - 15 * pixelsPerMarkerFrame);
  expect(view.markerFrames()).toEqual([
    ['0', 'position'],
    ['30', 'position,scale,opacity'],
  ]);
});

it('refuses a drop onto a keyframe of the same channel with a coded notice', () => {
  const view = draw();
  const notices: string[] = [];
  const handleNotice = (event: Event) => notices.push((event as CustomEvent<string>).detail);
  window.addEventListener(TIMELINE_NOTICE_EVENT, handleNotice);
  try {
    const savesBefore = view.states.length;
    drag(view.marker(0), 50, 50 + 30 * pixelsPerMarkerFrame);

    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^\[KEYFRAME_RETIME_COLLISION\] position .*frame 30/);
    expect(view.states.length).toBe(savesBefore);
    expect(view.markerFrames()).toEqual([
      ['0', 'position'],
      ['30', 'position,scale'],
      ['45', 'opacity'],
    ]);
  } finally {
    window.removeEventListener(TIMELINE_NOTICE_EVENT, handleNotice);
  }
});

it('cancels the preview without saving when the pointer is cancelled', () => {
  const view = draw();
  const savesBefore = view.states.length;
  const marker = view.marker(30);

  fireEvent.pointerDown(marker, { pointerId: 1, button: 0, clientX: 100 });
  fireEvent.pointerMove(marker, { pointerId: 1, clientX: 140 });
  fireEvent.pointerCancel(marker, { pointerId: 1 });

  expect(marker.dataset.keyframeFrame).toBe('30');
  expect(view.states.length).toBe(savesBefore);
});
