/** Messages between the timeline and `filmstrip.worker.ts`. */
export type FilmstripWorkerRequest = {
  id: number;
  src: string;
  duration: number;
  sampleCount: number;
  frameHeight: number;
};

export type FilmstripWorkerResponse =
  | { id: number; type: 'meta'; frameWidth: number; frameHeight: number; sampleCount: number }
  | { id: number; type: 'sample'; index: number; bitmap: ImageBitmap }
  | { id: number; type: 'done'; blob: Blob }
  /** WebCodecs/demux cannot handle this source; the caller should fall back. */
  | { id: number; type: 'unsupported'; reason: string };

/** Sample times shared by the worker and the main-thread fallback. */
export function filmstripSampleTimes(duration: number, sampleCount: number): number[] {
  const samples = Math.max(1, sampleCount);
  const interval = duration / samples;
  return Array.from({ length: samples }, (_, index) =>
    Math.min(index * interval, Math.max(0, duration - 0.05)),
  );
}
