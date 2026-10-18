// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EditorProvider, useEditorPlayback, type Item, type Track } from '@clash/remotion-core';
import { TimelineItem } from './TimelineItem';

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

function Playhead() {
  const { currentFrame } = useEditorPlayback();
  return <output aria-label="Playhead">{currentFrame}</output>;
}

const draw = (selected: boolean) => render(
  <EditorProvider initialState={{ fps: 30, tracks: [track], currentFrame: 0 }}>
    <Playhead />
    <TimelineItem item={item} track={track} trackId={track.id} pixelsPerFrame={2} isSelected={selected} assets={[]} onSelect={() => {}} onDelete={() => {}} onUpdate={() => {}} />
  </EditorProvider>,
);

it('marks the union of keyframe frames on the selected clip only', () => {
  const { container, unmount } = draw(false);
  expect(container.querySelectorAll('[data-timeline-keyframe-marker]')).toHaveLength(0);
  unmount();

  const selected = draw(true);
  const markers = [...selected.container.querySelectorAll<HTMLElement>('[data-timeline-keyframe-marker]')];
  expect(markers.map((marker) => [marker.dataset.keyframeFrame, marker.dataset.keyframeChannels])).toEqual([
    ['0', 'position'],
    ['30', 'position,scale'],
    ['45', 'opacity'],
  ]);
  expect(markers[1]!.getAttribute('title')).toBe('位置 + 缩放关键帧 · 00:00:02:00');
});

it('seeks the playhead to a marker on click', () => {
  const { container } = draw(true);
  const marker = container.querySelector<HTMLElement>('[data-timeline-keyframe-marker][data-keyframe-frame="45"]')!;
  fireEvent.click(marker);
  expect(screen.getByLabelText('Playhead').textContent).toBe('75');
});
