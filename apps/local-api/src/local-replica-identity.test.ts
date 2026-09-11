import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getLocalReplicaId } from "./local-replica-identity.js";

describe("persistent local replica identity", () => {
  it("survives concurrent startup and reopening without adopting another profile's identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-replica-"));
    try {
      const [first, concurrent] = await Promise.all([
        getLocalReplicaId(join(root, "a")),
        getLocalReplicaId(join(root, "a")),
      ]);
      expect(concurrent).toBe(first);
      expect(await getLocalReplicaId(join(root, "a"))).toBe(first);
      expect(await getLocalReplicaId(join(root, "b"))).not.toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
