import { spawn } from "node:child_process";

const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * Runs one ffmpeg invocation whose output is a file named in `args`. Nothing
 * is read from stdout, so the Host never holds the produced media in memory.
 *
 * `signal` is required: every encode carries a combined shutdown + deadline
 * signal, and the child is killed with SIGKILL so a stuck decoder cannot
 * outlive the deadline.
 */
export function runFfmpegToFile(input: {
  ffmpeg: string;
  args: readonly string[];
  /** Names the work in the thrown error, e.g. "extract audio from clip.mp4". */
  task: string;
  /** Kills the encode when aborted; the returned promise then rejects. */
  signal: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.ffmpeg, [...input.args], {
      stdio: ["ignore", "ignore", "pipe"],
      signal: input.signal,
      killSignal: "SIGKILL",
    });
    let errors = Buffer.alloc(0);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      errors = Buffer.concat([errors, chunk]).subarray(-STDERR_TAIL_BYTES);
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0) {
        if (settled) return;
        settled = true;
        resolve();
        return;
      }
      fail(
        new Error(
          `ffmpeg could not ${input.task}: ${errors.toString("utf8").trim() || `exit ${code ?? "unknown"}`}`,
        ),
      );
    });
  });
}
