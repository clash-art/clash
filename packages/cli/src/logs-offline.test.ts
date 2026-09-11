import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCliProgram } from "./program";

it("runs a packaged log query without invoking the Host bootstrap hook", async () => {
  const home = await mkdtemp(join(tmpdir(), "clash-offline-logs-"));
  const beforeAction = vi.fn(() => {
    throw new Error("Host is unavailable");
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("CLASH_HOME", home);
  vi.stubEnv("CLASH_LOCAL_DATA_DIR", "");
  try {
    const program = createCliProgram({ beforeAction });
    await program.parseAsync(["node", "clash", "logs", "--json"]);
    expect(beforeAction).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      directory: join(home, "logs"),
      matched: 0,
    });
  } finally {
    output.mockRestore();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});
