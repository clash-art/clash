// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EditorProvider, type Asset, type Item, type Track } from '@clash/remotion-core';
import { TimelineItem } from './TimelineItem';

afterEach(cleanup);

it('scales the same waveform geometry on zoom while keeping source trim in viewport pixels', () => {
  const waveform = Array.from({ length: 1024 }, (_, index) => index % 2 ? 0.8 : 0.2);
  const asset: Asset = { id: 'audio', name: 'Speech', type: 'audio', src: 'speech.wav', duration: 10, waveform, createdAt: 0 };
  const item: Item = { id: 'clip', assetId: asset.id, type: 'audio', src: asset.src, from: 60, durationInFrames: 120, sourceStartInFrames: 30 };
  const track: Track = { id: 'audio-track', name: 'Speech', category: 'audio', items: [item] };
  const draw = (pixelsPerFrame: number) => <EditorProvider initialState={{ assets: [asset], tracks: [track], fps: 30 }}>
    <TimelineItem item={item} track={track} trackId={track.id} pixelsPerFrame={pixelsPerFrame} isSelected={false}
      assets={[asset]} onSelect={() => {}} onDelete={() => {}} onUpdate={() => {}} />
  </EditorProvider>;
  const { container, rerender } = render(draw(1));
  const svg = container.querySelector('[data-waveform-renderer]')!;
  const originalPath = svg.querySelector('path')!.getAttribute('d');
  const originalWidth = Number(svg.getAttribute('width'));
  rerender(draw(2));
  expect(Number(svg.getAttribute('width'))).toBe(originalWidth * 2);
  expect(svg.parentElement!.style.transform).toBe('translateX(-60px)');
  expect(svg.querySelector('path')!.getAttribute('d')).toBe(originalPath);
});
