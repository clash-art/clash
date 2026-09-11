import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Session-local notes survive harness restart; the shared project remains cwd. */
export async function ensureSessionScratchpad(
  cwd: string,
  sessionId: string,
): Promise<string> {
  const directory = join(
    cwd,
    "sessions",
    `session-${encodeURIComponent(sessionId)}`,
    "scratchpad",
  );
  await mkdir(directory, { recursive: true });
  return directory;
}
