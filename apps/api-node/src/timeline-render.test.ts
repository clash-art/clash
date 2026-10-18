import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listProjectAssets, trashProjectAsset } from "@clash/shared-types";
import { CONTRACT_SAMPLE_VIDEO_FILE } from "@clash/shared-runtime/project-host-contract";
import {
  durablePublicFailure,
  durableRunIdempotencyKey,
} from "@clash/shared-runtime/durable-run-engine";
import type { RenderServerPort } from "@clash/shared-runtime/render-server";
import { signCapability, importCapabilityKey } from "@clash/shared-runtime/signed-capability";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import { withProjectDocument } from "./project-document.ts";
import {
  PROJECT_MEDIA_URL_DOMAIN,
  PROJECT_MEDIA_URL_PREFIX,
  signProjectMediaUrl,
} from "./project-media-url.ts";
import { loadTimelineDefinition } from "./timeline-definition.ts";
import {
  createNodeTimelineRenderService,
  nodeTimelineRenderPorts,
} from "./timeline-render.ts";

const SECRET = "render-test-better-auth-secret-0123456789";
const ENDPOINT = "http://api-node.render.test";
const TOKEN = "clsh_" + "r".repeat(40);
const sample = await readFile(
  new URL(
    `../../../packages/shared-runtime/src/project-host-contract/fixtures/${CONTRACT_SAMPLE_VIDEO_FILE}`,
    import.meta.url,
  ),
);
const RENDERED = new TextEncoder().encode("rendered timeline video bytes");

let db: PGlite;
let directory: string;
let now: number;
const clock = { now: () => now };

beforeEach(async () => {
  now = 1_800_000_000_000;
  db = new PGlite();
  directory = await mkdtemp(join(tmpdir(), "api-node-render-"));
  await migrateDatabase(db);
  await db.query(
    "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES('t','owner','render',$1,'clsh_')",
    [createHash("sha256").update(TOKEN).digest("hex")],
  );
  await db.query(
    "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('p','owner','Render',now(),now())",
  );
});
afterEach(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function nodeApp(render: boolean) {
  const app = createNodeCloudApp({
    db,
    syncBaseUrl: ENDPOINT,
    assetDirectory: directory,
    timeline: {
      definition: loadTimelineDefinition(),
      receiptSecret: SECRET,
      ...(render ? { render: { clock } } : {}),
    },
  });
  const authed = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${TOKEN}`);
    return app.request(`${ENDPOINT}${path}`, { ...init, headers });
  };
  const command = async (body: unknown) => {
    const response = await authed("/api/v1/projects/p/host-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const importClip = async (projectAssetId: string) => {
    const form = new FormData();
    form.set("projectAssetId", projectAssetId);
    form.set("kind", "video");
    form.set(
      "file",
      new File([sample], CONTRACT_SAMPLE_VIDEO_FILE, { type: "video/mp4" }),
    );
    const response = await authed("/api/v1/projects/p/assets/import-file", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(201);
  };
  const requestRender = async () => {
    const created = await command({
      action: "create_timeline",
      timelineId: "tl",
      name: "Render",
      state: {
        tracks: [
          {
            id: "media",
            items: [
              {
                id: "clip",
                type: "video",
                assetId: "asset:clip",
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
          {
            id: "titles",
            items: [
              { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
            ],
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    return command({
      action: "request_timeline_render",
      timelineId: "tl",
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
  };
  return { app, command, importClip, requestRender };
}

const readProject = <T>(work: Parameters<typeof withProjectDocument<T>>[4]) =>
  withProjectDocument<T>(db, "owner", "p", false, work);
const renderNode = (renderNodeId: string) =>
  readProject((doc) => {
    const node = doc.getMap("nodes").get(renderNodeId) as
      | { data: Record<string, unknown> }
      | undefined;
    return node?.data;
  });
const eventCount = async () =>
  Number(
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM project_replica_event WHERE project_id='p'",
      )
    ).rows[0]!.n,
  );

describe("Node Timeline render", () => {
  it("claims and journals the render node in the host-command transaction, renders once and publishes once", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    const submitted = await node.requestRender();
    expect(submitted.status).toBe(200);
    const { actionRunId, renderNodeId } = submitted.body;
    expect(actionRunId).toBe(`timeline-render:${renderNodeId}`);

    // Claimed with the creating append: the local Host only picks up pending
    // nodes without a pendingTask.
    expect(await renderNode(renderNodeId)).toMatchObject({
      status: "generating",
      pendingTask: actionRunId,
    });
    expect(
      (await db.query("SELECT action_run_id FROM cloud_run_dispatch")).rows,
    ).toEqual([{ action_run_id: actionRunId }]);
    // A failure left on the claimed node (an earlier attempt) is cleared on success.
    await withProjectDocument(db, "owner", "p", true, (doc) => {
      const nodes = doc.getMap("nodes");
      const claimed = nodes.get(renderNodeId) as { data: Record<string, unknown> };
      nodes.set(renderNodeId, {
        ...claimed,
        data: { ...claimed.data, error: "Render timed out", errorCode: "deadline_exceeded" },
      });
    });

    const renders: Array<Record<string, any>> = [];
    const mediaReads: number[] = [];
    const renderServer: RenderServerPort = {
      async fetch(path, init) {
        expect(path).toBe("/render");
        const body = JSON.parse(String(init.body));
        renders.push(body);
        // render-server reads the media through the signed URL, unauthenticated.
        const src = body.timelineDsl.tracks[0].items[0].src as string;
        const media = await node.app.request(src, {
          headers: { range: "bytes=0-15" },
        });
        mediaReads.push(media.status);
        expect(new Uint8Array(await media.arrayBuffer())).toEqual(
          new Uint8Array(sample.subarray(0, 16)),
        );
        return new Response(RENDERED, {
          headers: { "X-Render-Width": "64", "X-Render-Height": "64" },
        });
      },
    };
    const worker = {
      renderServer,
      mediaSecret: SECRET,
      publicUrl: ENDPOINT,
      assetDirectory: directory,
      clock,
    };
    const service = createNodeTimelineRenderService(db, worker);
    const identity = { actionRunId, outputSlot: "output" };
    for (
      let n = 0;
      n < 8 && (await service.journal.load(identity))?.phase !== "succeeded";
      n++
    )
      await service.coordinator.coordinate({ type: "advance", identity });
    const run = (await service.journal.load(identity))!;
    expect(run.phase).toBe("succeeded");
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatchObject({ projectId: "p", taskId: actionRunId });
    expect(renders[0]!.timelineDsl.tracks[0].items[0].src).toMatch(
      new RegExp(`^${ENDPOINT}${PROJECT_MEDIA_URL_PREFIX}/p/asset%3Aclip\\?exp=\\d+&sig=`),
    );
    expect(mediaReads).toEqual([206]);

    const published = async () => ({
      node: await renderNode(renderNodeId),
      assets: await readProject((doc) =>
        listProjectAssets(doc, { projectId: "p" }).map((entry) => ({
          id: entry.id,
          provenance: entry.provenance,
        })),
      ),
      resources: Number(
        (
          await db.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM project_resource WHERE project_id='p'",
          )
        ).rows[0]!.n,
      ),
    });
    const first = await published();
    expect(first.node).toMatchObject({ status: "completed", assetId: actionRunId });
    expect(first.node?.pendingTask ?? null).toBeNull();
    expect(first.node?.error ?? null).toBeNull();
    expect(first.node?.errorCode ?? null).toBeNull();
    expect(first.assets).toEqual(
      expect.arrayContaining([
        { id: actionRunId, provenance: { kind: "render", actionRunId } },
      ]),
    );
    expect(first.assets).toHaveLength(2);
    expect(first.resources).toBe(2);
    const events = await eventCount();

    // Rerun on this worker and on a second one: the journal is terminal.
    expect(
      (await service.coordinator.coordinate({ type: "advance", identity })).kind,
    ).toBe("terminal");
    const second = createNodeTimelineRenderService(db, worker);
    expect(
      (await second.coordinator.coordinate({ type: "advance", identity })).kind,
    ).toBe("terminal");
    // Redelivery of the publish step after its commit (crash before the
    // journal CAS): run-keyed publication is a no-op.
    await nodeTimelineRenderPorts(db, worker).publish({
      run,
      idempotencyKey: durableRunIdempotencyKey(run),
      stagedOutput: run.stagedOutput!,
    });
    expect(renders).toHaveLength(1);
    expect(await published()).toEqual(first);
    expect(await eventCount()).toBe(events);
  });

  it("marks only the node this run still claims as failed", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    const { body } = await node.requestRender();
    const service = createNodeTimelineRenderService(db, {
      renderServer: {
        fetch: async () => new Response("composition failed", { status: 500 }),
      },
      mediaSecret: SECRET,
      publicUrl: ENDPOINT,
      assetDirectory: directory,
      clock,
    });
    const identity = { actionRunId: body.actionRunId, outputSlot: "output" };
    for (
      let n = 0;
      n < 8 && (await service.journal.load(identity))?.projectedAt === undefined;
      n++
    )
      await service.coordinator.coordinate({ type: "advance", identity });
    const run = await service.journal.load(identity);
    expect(run?.phase).toBe("failed");
    const failed = await renderNode(body.renderNodeId);
    expect(failed).toMatchObject({
      status: "failed",
      error: durablePublicFailure(run!.failure!).message,
      errorCode: run!.failure!.code,
    });
    expect(failed?.pendingTask ?? null).toBeNull();
    expect(
      await readProject((doc) =>
        listProjectAssets(doc, { projectId: "p" }).map((entry) => entry.id),
      ),
    ).toEqual(["asset:clip"]);
  });

  it("fails the render node with reference_unavailable, before rendering, when its clip's Asset is unavailable", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    const { body } = await node.requestRender();
    // The clip leaves the Project after admission (a merged trash on another
    // replica): the resolver, not the renderer, must catch it.
    await withProjectDocument(db, "owner", "p", true, (doc) => {
      expect(
        trashProjectAsset(doc, {
          id: "asset:clip",
          deleteOperationId: "merged-trash",
          deletedAt: new Date(now).toISOString(),
          purgeAfter: new Date(now + 86_400_000).toISOString(),
        }).ok,
      ).toBe(true);
    });
    let renders = 0;
    const service = createNodeTimelineRenderService(db, {
      renderServer: {
        fetch: async () => {
          renders += 1;
          return new Response(RENDERED);
        },
      },
      mediaSecret: SECRET,
      publicUrl: ENDPOINT,
      assetDirectory: directory,
      clock,
    });
    const identity = { actionRunId: body.actionRunId, outputSlot: "output" };
    for (
      let n = 0;
      n < 8 && (await service.journal.load(identity))?.projectedAt === undefined;
      n++
    )
      await service.coordinator.coordinate({ type: "advance", identity });
    const run = await service.journal.load(identity);
    expect(run).toMatchObject({
      phase: "failed",
      failure: { code: "reference_unavailable", retryable: false },
    });
    expect(run!.failure!.message).toContain("asset:clip");
    expect(renders).toBe(0);
    const failed = await renderNode(body.renderNodeId);
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "reference_unavailable",
      error: durablePublicFailure(run!.failure!).message,
    });
    expect(failed?.pendingTask ?? null).toBeNull();
  });

  it("answers 501 and creates nothing when no render server is configured", async () => {
    const node = nodeApp(false);
    await node.importClip("asset:clip");
    const nodesBefore = await readProject((doc) => doc.getMap("nodes").size);
    const submitted = await node.requestRender();
    expect(submitted).toEqual({
      status: 501,
      body: {
        code: "COMMAND_UNAVAILABLE",
        error: "This project command is not connected on this server.",
      },
    });
    expect(await readProject((doc) => doc.getMap("nodes").size)).toBe(nodesBefore);
    expect((await db.query("SELECT * FROM cloud_durable_run_journal")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM cloud_run_dispatch")).rows).toEqual([]);
    // The signed media route exists only where renders run.
    const url = await signProjectMediaUrl({
      secret: SECRET,
      publicUrl: ENDPOINT,
      projectId: "p",
      assetId: "asset:clip",
      now,
    });
    expect((await node.app.request(url)).status).toBe(404);
  });
});

describe("signed Project media URL", () => {
  const sign = (assetId = "asset:clip", at = now) =>
    signProjectMediaUrl({
      secret: SECRET,
      publicUrl: ENDPOINT,
      projectId: "p",
      assetId,
      now: at,
    });

  it("serves exactly the signed Asset's bytes, with ranges, without a session", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    const url = await sign();
    const full = await node.app.request(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBe("private, no-store");
    expect(full.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(new Uint8Array(sample));
    const ranged = await node.app.request(url, { headers: { range: "bytes=4-7" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 4-7/${sample.length}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      new Uint8Array(sample.subarray(4, 8)),
    );
  });

  it("rejects an expired URL", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    const url = await sign();
    now += 60 * 60 * 1000;
    const response = await node.app.request(url);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Media URL expired" });
  });

  it("rejects tampered signatures, subjects, expiries and other domains", async () => {
    const node = nodeApp(true);
    await node.importClip("asset:clip");
    await node.importClip("asset:other");
    const url = new URL(await sign());
    const sig = url.searchParams.get("sig")!;
    const exp = Number(url.searchParams.get("exp"));
    const variants: string[] = [];
    const flipped = new URL(url);
    flipped.searchParams.set("sig", `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`);
    variants.push(flipped.href);
    variants.push(url.href.replace("asset%3Aclip", "asset%3Aother"));
    const later = new URL(url);
    later.searchParams.set("exp", String(exp + 60));
    variants.push(later.href);
    const unsigned = new URL(url);
    unsigned.searchParams.delete("sig");
    variants.push(unsigned.href);
    // The same secret without the media domain (e.g. another capability) does not verify.
    const undomained = new URL(url);
    undomained.searchParams.set(
      "sig",
      await signCapability(await importCapabilityKey(SECRET), "p/asset%3Aclip", exp),
    );
    variants.push(undomained.href);
    const otherSecret = new URL(url);
    otherSecret.searchParams.set(
      "sig",
      await signCapability(
        await importCapabilityKey("another-secret-of-sufficient-length-000"),
        "p/asset%3Aclip",
        exp,
        PROJECT_MEDIA_URL_DOMAIN,
      ),
    );
    variants.push(otherSecret.href);
    for (const variant of variants)
      expect((await node.app.request(variant)).status, variant).toBe(403);
  });

  it("answers 404 for a validly signed Asset that is not active in the Project", async () => {
    const node = nodeApp(true);
    expect((await node.app.request(await sign("asset:missing"))).status).toBe(404);
  });
});
