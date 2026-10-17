// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  canGenerateFilmstripInWorker,
  generateVideoFilmstripInWorker,
} from './videoThumbnailUtils';
import { filmstripSampleTimes } from './filmstripWorkerProtocol';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reports the worker path unavailable without WebCodecs so callers fall back', async () => {
  vi.stubGlobal('VideoDecoder', undefined);
  expect(canGenerateFilmstripInWorker()).toBe(false);
  await expect(
    generateVideoFilmstripInWorker({ videoSrc: 'clip.mp4', duration: 10, sampleCount: 4 }),
  ).resolves.toBeNull();
});

it('samples evenly and never past the last decodable frame', () => {
  const times = filmstripSampleTimes(10, 4);
  expect(times).toEqual([0, 2.5, 5, 7.5]);
  expect(Math.max(...filmstripSampleTimes(1, 1000))).toBeLessThanOrEqual(1 - 0.05);
});
