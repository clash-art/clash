import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { migrateDatabase } from "./migrations.ts";
import {
  createPostgresOutbox,
  createPostgresReplicaLog,
} from "./replica-log.ts";
import { withProjectDocument } from "./project-document.ts";
import { runOutboxWorker } from "./outbox-worker.ts";
import { createRelayStore } from "./relay-store.ts";
import {
  createPluginActionSweep,
  PLUGIN_ACTIONS_UNAVAILABLE_MESSAGE,
  withPluginActionSweep,
} from "./plugin-actions.ts";

let db: PGlite;
let browser: LoroDoc;
let appended = 0;

beforeEach(async () => {
  db = new PGlite();
  await migrateDatabase(db);
  await db.query(
    "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('p','owner','Project',now(),now())",
  );
  browser = new LoroDoc();
  appended = 0;
});
afterEach(async () => {
  browser.free();
  await db.close();
});

/** A browser edit through the opaque relay, as the replica gateway appends it. */
async function browserSets(nodes: Record<string, unknown>) {
  const before = browser.version();
  for (const [id, node] of Object.entries(nodes))
    browser.getMap("nodes").set(id, node);
  browser.commit();
  await createPostgresReplicaLog(db, "p").append({
    id: `browser-${(appended += 1)}`,
    update: browser.export({ mode: "update", from: before }),
  });
  before.free();
}

const customAction = (data: Record<string, unknown> = {}) => ({
  id: "action",
  type: "image",
  data: {
    status: "pending",
    actionType: "custom:fal-render",
    customActionId: "fal-render",
    actorType: "user",
    actorUserId: "owner",
    pluginBinding: {
      pluginId: "acme.render",
      exportId: "fal-render",
    },
    ...data,
  },
});

const readNodes = () =>
  withProjectDocument(db, "owner", "p", false, (doc) =>
    doc.getMap("nodes").toJSON() as Record<string, { data: Record<string, unknown> }>,
  );
const head = () => createRelayStore(db, "p").head();

describe("plugin Actions on the Node adapter", () => {
  it("fails a pending custom Action plugin_unavailable instead of leaving it pending", async () => {
    await browserSets({ action: customAction() });
    const sweep = createPluginActionSweep(db);
    try {
      expect(await sweep.sweep("p")).toEqual(["action"]);
      const { action } = await readNodes();
      expect(action!.data).toMatchObject({
        status: "failed",
        error: PLUGIN_ACTIONS_UNAVAILABLE_MESSAGE,
        errorCode: "plugin_unavailable",
      });
      expect(action!.data.pendingTask ?? undefined).toBeUndefined();
      // The authored request is kept; only its outcome changes.
      expect(action!.data).toMatchObject({
        actionType: "custom:fal-render",
        pluginBinding: { pluginId: "acme.render" },
      });

      // Its own failure append is swept too, and appends nothing more.
      const after = await head();
      expect(await sweep.sweep("p")).toEqual([]);
      expect(await head()).toBe(after);
    } finally {
      sweep.close();
    }
  });

  it("leaves claimed, completed and non-Action nodes alone", async () => {
    await browserSets({
      claimed: customAction({ status: "generating", pendingTask: "run-1" }),
      completed: customAction({ status: "completed", assetId: "asset-1" }),
      generation: {
        type: "image",
        data: { status: "pending", prompt: "a cat", actorUserId: "owner" },
      },
    });
    const sweep = createPluginActionSweep(db);
    try {
      const before = await head();
      expect(await sweep.sweep("p")).toEqual([]);
      expect(await head()).toBe(before);
      const nodes = await readNodes();
      expect(nodes.claimed!.data).toMatchObject({
        status: "generating",
        pendingTask: "run-1",
      });
      expect(nodes.completed!.data.status).toBe("completed");
      expect(nodes.generation!.data.status).toBe("pending");
    } finally {
      sweep.close();
    }
  });

  it("catches a cached replica up to Actions added after an earlier sweep", async () => {
    await browserSets({ note: { type: "text", data: { status: "completed" } } });
    const sweep = createPluginActionSweep(db, { maxProjects: 1 });
    try {
      expect(await sweep.sweep("p")).toEqual([]);
      await browserSets({ later: customAction() });
      expect(await sweep.sweep("p")).toEqual(["later"]);
      expect((await readNodes()).later!.data.errorCode).toBe(
        "plugin_unavailable",
      );
    } finally {
      sweep.close();
    }
  });

  it("does not write into a deleted Project", async () => {
    await browserSets({ action: customAction() });
    await db.query("UPDATE project SET deleted_at=now() WHERE id='p'");
    const sweep = createPluginActionSweep(db);
    try {
      const before = await head();
      expect(await sweep.sweep("p")).toEqual([]);
      expect(await head()).toBe(before);
    } finally {
      sweep.close();
    }
  });

  it("runs with each notification delivery of the outbox worker", async () => {
    await browserSets({ action: customAction() });
    const sweep = createPluginActionSweep(db);
    const stop = new AbortController();
    const notified: string[] = [];
    try {
      await runOutboxWorker({
        outbox: createPostgresOutbox(db),
        publisher: withPluginActionSweep(
          {
            publish: async (event) => {
              notified.push(event.projectId);
            },
          },
          {
            ...sweep,
            sweep: async (projectId) => {
              const failed = await sweep.sweep(projectId);
              stop.abort();
              return failed;
            },
          },
        ),
        signal: stop.signal,
      });
      expect(notified).toEqual(["p"]);
      expect((await readNodes()).action!.data).toMatchObject({
        status: "failed",
        errorCode: "plugin_unavailable",
      });
    } finally {
      sweep.close();
    }
  });
});
