/**
 * Deadline envelope shared by every ffmpeg/ffprobe child the Host spawns.
 * A decoder that never returns must not keep an import, a representation run,
 * or a speech transcription alive forever.
 */
export const MEDIA_PROCESS_TIMEOUTS_MS = {
  assetInspection: 30_000,
  poster: 60_000,
  waveform: 60_000,
  proxyMaximum: 30 * 60_000,
  speechAudioExtraction: 30 * 60_000,
  videoCrop: 5 * 60_000,
  mockVideo: 30_000,
} as const;

export type LocalMediaProcessTimeoutCode =
  | "ASSET_INSPECTION_TIMEOUT"
  | "REPRESENTATION_TIMEOUT"
  | "SPEECH_AUDIO_EXTRACTION_TIMEOUT"
  | "MEDIA_PROCESS_TIMEOUT";

export class LocalMediaProcessTimeoutError extends Error {
  readonly code: LocalMediaProcessTimeoutCode;
  readonly timeoutMs: number;

  constructor(
    code: LocalMediaProcessTimeoutCode,
    task: string,
    timeoutMs: number,
  ) {
    super(`${code}: ${task} did not finish within ${timeoutMs} ms.`);
    this.name = "LocalMediaProcessTimeoutError";
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs one media process under a deadline. The child receives the combined
 * signal and therefore has to kill itself when either the Host closes or the
 * deadline elapses; a timeout is mapped to its operation-specific coded error.
 */
export async function withMediaProcessDeadline<T>(
  input: {
    code: LocalMediaProcessTimeoutCode;
    timeoutMs: number;
    task: string;
    /** Host shutdown, when the caller has one. */
    signal?: AbortSignal;
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new TypeError("A media process deadline must be a positive integer.");
  }
  const timeout = AbortSignal.timeout(input.timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout])
    : timeout;
  try {
    return await run(signal);
  } catch (error) {
    if (timeout.aborted) {
      throw new LocalMediaProcessTimeoutError(
        input.code,
        input.task,
        input.timeoutMs,
      );
    }
    throw error;
  }
}
