import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import { createLocalApiApp } from "./app";
import { LocalProjectUpgradeError } from "./local-project-upgrade";

it("keeps project metadata navigable when another project's preview cannot upgrade", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-project-list-recovery-"));
  const docs = new Map<string, LoroDoc>();
  let brokenId: string | undefined;
  const app = createLocalApiApp({ dataDir, projectAssetReplica: {
    async inspect(id, read) {
      if (id === brokenId) throw new LocalProjectUpgradeError(id, "Unavailable legacy model");
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return read(docs.get(id)!);
    },
    async mutate(id, mutate) {
      if (!docs.has(id)) docs.set(id, new LoroDoc());
      return (await mutate(docs.get(id)!)).value;
    },
  } });
  try {
    const create = async (name: string) => {
      const response = await app.request("/api/v1/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    brokenId = await create("Old project");
    const newId = await create("随便什么吧");
    const response = await app.request("/api/v1/projects");
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: { id: string; name: string }[] };
    expect(body.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: brokenId, name: "Old project" }),
      expect.objectContaining({ id: newId, name: "随便什么吧" }),
    ]));
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
