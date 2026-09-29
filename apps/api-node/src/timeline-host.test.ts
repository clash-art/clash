import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  validateExecutablePluginPackage,
} from "@clash/shared-types";
import manifest from "../../../plugins/remotion/manifest.json";
import document from "../../../plugins/remotion/generators/timeline.json";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
const pkg = validateExecutablePluginPackage(
  manifest,
  {},
  {},
  { generators: { "generators/timeline.json": document } },
);
const definition = generatorDefinitionFromExecutablePluginRegistration({
  pluginId: pkg.manifest.id,
  version: pkg.manifest.version,
  schemaHash: `sha256:${"a".repeat(64)}`,
  document: pkg.generators["generators/timeline.json"]!,
});
it("persists timeline commands, rejects stale or fabricated observations, and isolates owners", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const token = "clsh_" + "a".repeat(40);
    await db.query(
      "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES('t','owner','test',$1,'clsh_')",
      [createHash("sha256").update(token).digest("hex")],
    );
    await db.query(
      "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('p','owner','Project',now(),now())",
    );
    const options = {
      db,
      syncBaseUrl: "http://localhost",
      timeline: { definition, receiptSecret: "test-receipt-secret" },
    };
    let app = createNodeCloudApp(options);
    const command = (body: unknown, id = "p") =>
      app.request(`/api/v1/projects/${id}/host-command`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await command({ action: "list_timelines" })).status).toBe(200);
    const invalidPlacement = await command({
      action: "create_timeline",
      timelineId: "rejected",
      name: "Rejected",
      state: { tracks: [] },
      placement: { canvasId: "missing", actionNodeId: "action-missing" },
    });
    expect(invalidPlacement.ok).toBe(false);
    expect(
      (await (await command({ action: "list_timelines" })).json()).timelines,
    ).toEqual([]);
    const created = await command({
      action: "create_timeline",
      timelineId: "tl",
      name: "Timeline",
      state: { tracks: [] },
    });
    expect(created.status).toBe(200);
    const first = await created.json();
    expect(first.timeline.name).toBe("Timeline");
    expect(
      (
        await command({
          action: "update_timeline_state",
          timelineId: "tl",
          state: { tracks: [] },
        })
      ).status,
    ).toBe(409);
    const update = await command({
      action: "update_timeline_state",
      timelineId: "tl",
      state: { tracks: [], fps: 24 },
      ifMatch: first.readToken,
    });
    expect(update.status).toBe(200);
    const second = await update.json();
    expect(second.timeline.revisionId).not.toBe(first.timeline.revisionId);
    expect(
      (
        await command({
          action: "update_timeline_state",
          timelineId: "tl",
          state: { tracks: [] },
          ifMatch: first.readToken,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await command({
          action: "delete_timeline",
          timelineId: "tl",
          ifMatch: second.version,
          actorClientType: "agent",
        })
      ).status,
    ).toBe(409);
    app = createNodeCloudApp(options);
    const listed = await (await command({ action: "list_timelines" })).json();
    expect(listed.timelines).toEqual([second.timeline]);
    await db.query("UPDATE api_token SET user_id='other'");
    expect((await command({ action: "list_timelines" })).status).toBe(404);
    await db.query("UPDATE api_token SET user_id='owner'");
    expect(
      (
        await command({
          action: "delete_timeline",
          timelineId: "tl",
          ifMatch: listed.versions.tl,
        })
      ).status,
    ).toBe(200);
    expect(
      (await (await command({ action: "list_timelines" })).json()).timelines,
    ).toEqual([]);
  } finally {
    await db.close();
  }
});
