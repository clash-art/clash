import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createLocalApiApp } from "./app.js";

const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

describe("local agent environment route", () => {
  it("hands a hydrated PATH to subsequent ACP spawns on loopback only", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "clash-agent-env-"));
    const updateSpawnEnv = vi.fn();
    const app = createLocalApiApp({
      dataDir,
      localAcp: { updateSpawnEnv } as never,
    });
    const previousPath = process.env.PATH;
    try {
      const denied = await app.request("/api/v1/local/agent-environment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ PATH: "/late/bin:/usr/bin" }),
      });
      expect(denied.status).toBe(403);
      expect(updateSpawnEnv).not.toHaveBeenCalled();

      const invalid = await app.request(
        "/api/v1/local/agent-environment",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ PATH: "" }),
        },
        LOOPBACK,
      );
      expect(invalid.status).toBe(400);
      expect(updateSpawnEnv).not.toHaveBeenCalled();

      const accepted = await app.request(
        "/api/v1/local/agent-environment",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ PATH: "/late/bin:/usr/bin" }),
        },
        LOOPBACK,
      );
      expect(accepted.status).toBe(200);
      const agentBin = join(dataDir, "agent-bin");
      const spawnPath = `${agentBin}:/late/bin:/usr/bin`;
      expect(await accepted.json()).toEqual({
        ok: true,
        PATH: "/late/bin:/usr/bin",
        spawnPath,
      });
      expect(updateSpawnEnv).toHaveBeenCalledWith({ PATH: spawnPath });
      expect(process.env.PATH).toBe(spawnPath);
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
