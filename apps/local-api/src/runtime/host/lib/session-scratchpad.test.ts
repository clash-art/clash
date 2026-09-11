import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ensureSessionScratchpad } from "./session-scratchpad";

it("isolates sessions inside the project and retains scratch notes on resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "clash-scratchpad-"));
  try {
    const first = await ensureSessionScratchpad(cwd, "../session-a");
    const second = await ensureSessionScratchpad(cwd, "session-b");
    expect(first).not.toBe(second);
    expect(relative(cwd, first).startsWith("..")).toBe(false);
    await writeFile(join(first, "notes.md"), "unfinished shot plan\n");
    expect(await ensureSessionScratchpad(cwd, "../session-a")).toBe(first);
    expect(await readFile(join(first, "notes.md"), "utf8")).toBe(
      "unfinished shot plan\n",
    );
    await expect(readFile(join(second, "notes.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
