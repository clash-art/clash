import { realpathSync } from "node:fs";

export interface WatchPathEnv {
  platform?: NodeJS.Platform;
  realpathNative?: (path: string) => string;
}

/**
 * Path to hand to `fs.watch`. On Windows a path holding 8.3 short names
 * (`C:\Users\RUNNER~1\...`) makes libuv abort the whole process: change
 * notifications carry long-form names and its prefix check in
 * `src\win\fs-event.c` is an assert. Canonicalise to the long form there;
 * every other platform gets the input back untouched. A path that cannot be
 * resolved (not created yet) is returned as given so `watch` reports it.
 */
export function watchablePath(path: string, env: WatchPathEnv = {}): string {
  if ((env.platform ?? process.platform) !== "win32") return path;
  try {
    return (env.realpathNative ?? realpathSync.native)(path);
  } catch {
    return path;
  }
}
