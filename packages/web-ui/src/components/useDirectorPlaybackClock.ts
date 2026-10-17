import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

/** How often playback publishes the playhead to React UI (timeline, readouts). */
export const DIRECTOR_PLAYHEAD_UI_HZ = 12;

/**
 * Director Stage playback clock.
 *
 * The returned ref advances on every animation frame while playing; the 3D
 * viewport reads it inside its render loop. React state is only published at
 * `DIRECTOR_PLAYHEAD_UI_HZ` (and once when playback stops), so the host surface
 * and its panels do not re-render on every frame. Seeks and other external
 * writes to `playheadSeconds` move the clock.
 */
export function useDirectorPlaybackClock({
  playing,
  durationSeconds,
  playheadSeconds,
  setPlayheadSeconds,
}: {
  playing: boolean;
  durationSeconds: number | undefined;
  playheadSeconds: number;
  setPlayheadSeconds: Dispatch<SetStateAction<number>>;
}): { readonly current: number } {
  const playheadRef = useRef(playheadSeconds);
  const lastPublishedRef = useRef(playheadSeconds);

  useEffect(() => {
    if (playheadSeconds !== lastPublishedRef.current) {
      playheadRef.current = playheadSeconds;
      lastPublishedRef.current = playheadSeconds;
    }
  }, [playheadSeconds]);

  useEffect(() => {
    if (!playing || !durationSeconds) return;
    const publish = () => {
      lastPublishedRef.current = playheadRef.current;
      setPlayheadSeconds(playheadRef.current);
    };
    let request = 0;
    let previous = performance.now();
    let lastPublished = previous;
    const tick = (now: number) => {
      const delta = (now - previous) / 1000;
      previous = now;
      playheadRef.current = (playheadRef.current + delta) % durationSeconds;
      if (now - lastPublished >= 1000 / DIRECTOR_PLAYHEAD_UI_HZ) {
        lastPublished = now;
        publish();
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      publish();
    };
  }, [playing, durationSeconds, setPlayheadSeconds]);

  return playheadRef;
}
