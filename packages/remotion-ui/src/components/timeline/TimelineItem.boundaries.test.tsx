// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EditorProvider, type Item, type Track } from '@clash/remotion-core';
import { TimelineItem } from './TimelineItem';

afterEach(cleanup);
const item: Item = { id: 'title', type: 'text', color: '#fff', text: '大队委竞选', from: 0, durationInFrames: 60, keyframes: { opacity: [{ frame: 0, value: 0, interpolation: 'linear' }, { frame: 59, value: 1, interpolation: 'linear' }] } };
const track: Track = { id: 'titles', name: 'Titles', category: 'text', items: [item] };
const draw = (selected: boolean) => <EditorProvider initialState={{ tracks: [track] }}><TimelineItem item={item} track={track} trackId={track.id} pixelsPerFrame={2} isSelected={selected} assets={[]} onSelect={() => {}} onDelete={() => {}} onUpdate={() => {}} /></EditorProvider>;

it('puts keyframe markers on the top edge without reserving a band below the text label', () => {
  const { container } = render(draw(true));
  const marker = container.querySelector<HTMLElement>('[data-timeline-keyframe-marker]')!;
  const label = container.querySelector<HTMLElement>('[title="大队委竞选"]')!;
  expect(parseFloat(marker.style.top)).toBe(-parseFloat(marker.style.height) / 2);
  expect(marker.style.bottom).toBe('');
  // The label may use the full clip height again; markers only overlap its top border.
  expect(parseFloat(label.style.height)).toBeGreaterThanOrEqual(24);
});

it('reveals an inset edge line only when the resize target is hovered, with an invisible wider hit area', () => {
  const { container } = render(draw(false));
  const handle = container.querySelector<HTMLElement>('[data-timeline-resize-edge="right"]');
  expect(handle).not.toBeNull();
  expect(handle!.style.backgroundColor).toBe('transparent');
  expect(handle!.querySelector('[data-resize-edge-line]')).toBeNull();
  fireEvent.pointerEnter(handle!);
  const line = handle!.querySelector<HTMLElement>('[data-resize-edge-line]')!;
  expect(line).not.toBeNull();
  expect(parseFloat(line.style.width)).toBeLessThan(parseFloat(handle!.style.width));
  fireEvent.pointerLeave(handle!);
  expect(handle!.querySelector('[data-resize-edge-line]')).toBeNull();
});
