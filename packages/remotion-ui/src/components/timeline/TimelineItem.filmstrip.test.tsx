// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EditorProvider, type Asset, type Item, type Track } from '@clash/remotion-core';

const filmstripBuild = vi.hoisted(() => ({
  resolve: null as null | ((value: string | undefined) => void),
  calls: 0,
}));

vi.mock('./videoThumbnailUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./videoThumbnailUtils')>();
  return {
    ...actual,
    generateVideoFilmstrip: vi.fn(() => {
      filmstripBuild.calls += 1;
      return new Promise<string | undefined>((resolve) => {
        filmstripBuild.resolve = resolve;
      });
    }),
  };
});

vi.mock('../../utils/thumbnailCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/thumbnailCache')>();
  return {
    ...actual,
    generateVideoThumbnailAtTime: vi.fn(() => new Promise(() => {})),
  };
});

import { thumbnailCache } from '../../utils/thumbnailCache';
import { TimelineItem } from './TimelineItem';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  filmstripBuild.resolve = null;
  filmstripBuild.calls = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps and applies a filmstrip whose build outlived a layout change of the item', async () => {
  const asset: Asset = { id: 'video', name: 'Clip', type: 'video', src: 'clip.mp4', duration: 10, projectAssetId: 'pa-1', createdAt: 0 };
  const item: Item = { id: 'clip', assetId: asset.id, type: 'video', src: asset.src, from: 0, durationInFrames: 300 };
  const track: Track = { id: 'main', name: 'Main', items: [item] };
  const withWaveform: Asset = { ...asset, waveform: Array.from({ length: 4096 }, (_, index) => index % 2 ? 0.8 : 0.2) };
  const draw = (current: Asset) => <EditorProvider initialState={{ assets: [asset], tracks: [track], fps: 30 }}>
    <TimelineItem item={item} track={track} trackId={track.id} pixelsPerFrame={1} isSelected={false}
      assets={[current]} onSelect={() => {}} onDelete={() => {}} onUpdate={() => {}} />
  </EditorProvider>;

  const { rerender } = render(draw(asset));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(filmstripBuild.calls).toBe(1);

  // The waveform arriving reserves an audio band and shrinks the thumbnail
  // height while the build is in flight, which re-runs (and cancels) the
  // generation effect.
  rerender(draw(withWaveform));
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

  const setSpy = vi.spyOn(thumbnailCache, 'set');
  await act(async () => {
    filmstripBuild.resolve?.('data:filmstrip');
    await vi.advanceTimersByTimeAsync(1000);
  });

  // The superseded run joined the same in-flight build instead of starting a
  // second one, and its result was persisted rather than dropped.
  expect(filmstripBuild.calls).toBe(1);
  expect(setSpy.mock.calls.some(([key, value]) => key.startsWith('filmstrip:') && value === 'data:filmstrip')).toBe(true);
});
