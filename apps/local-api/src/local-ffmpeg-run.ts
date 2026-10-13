import { spawn } from "node:child_process";

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Runs one ffmpeg invocation whose output is a file named in `args`. Nothing
 * is read from stdout, so the Host never holds the produced media in memory.
 */
export function runFfmpegToFile(input: {
  ffmpeg: string;
  args: readonly string[];
  /** Names the work in the thrown error, e.g. "extract audio from clip.mp4". */
  task: string;
  /** Kills the encode when aborted; the returned promise then rejects. */
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.ffmpeg, [...input.args], {
      stdio: ["ignore", "ignore", "pipe"],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    let errors = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      errors = Buffer.concat([errors, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `ffmpeg could not ${input.task}: ${errors.toString("utf8").trim() || `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}
