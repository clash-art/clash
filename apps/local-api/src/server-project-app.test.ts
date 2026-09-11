import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startLocalApiServer } from "./server";

test("daemon with agent runtime disabled serves project APIs without initializing an ACP adapter", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-no-acp-"));
  const previous = process.env.CLASH_LOCAL_DATA_DIR;
  process.env.CLASH_LOCAL_DATA_DIR = dataDir;
  let server: Awaited<ReturnType<typeof startLocalApiServer>> | undefined;
  try {
    server = await startLocalApiServer({
      port: 0,
      dataDir,
      agentRuntime: "disabled",
      discovery: { enabled: false },
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No listening address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/local/harnesses`,
    );
    expect((await response.json()).harnesses).toEqual([]);
    expect(await readdir(dataDir)).not.toContain("agent-bin");
    expect(await readdir(dataDir)).not.toContain("acp-bin");
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (previous === undefined) delete process.env.CLASH_LOCAL_DATA_DIR;
    else process.env.CLASH_LOCAL_DATA_DIR = previous;
    await rm(dataDir, { recursive: true, force: true });
  }
}, 30000);
