import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { LoroDoc } from "loro-crdt";
import { expect, it } from "vitest";
import {
  createProjectDocumentAsset,
  markDocumentAssetAuthority,
} from "@clash/shared-types";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import { PROJECT_CLOUD_CONTENT_PART_BYTES as PART } from "@clash/asset-sdk/delivery";
import type { ContentPublishedEvent } from "@clash/asset-sdk/upload-service";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import {
  createFsAssetDeliveryStore,
  createInProcessContentRoom,
  createPostgresContentAdmission,
  createPostgresContentReferenceIndex,
  createPostgresUploadIdentity,
  createUploadServer,
} from "./content-upload.ts";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function setup() {
  const db = new PGlite();
  await migrateDatabase(db);
  const token = "clsh_" + "b".repeat(40);
  await db.query(
    "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
    ["t", "owner", "test", sha(token), "clsh_bbbb"],
  );
  await db.query(
    "INSERT INTO project (id,owner_id,tenant_id,name,created_at,updated_at) VALUES ('p1','owner','tn','P',now(),now())",
  );
  await db.query(
    `INSERT INTO project_cloud_admission (project_id,tenant_id,user_id,local_replica_id,sync_base_url,status,capabilities_json)
     VALUES ('p1','tn','owner','r1','https://node.test','admitted','{"canvas":true,"resources":true}')`,
  );
  // In-process room: the Project document lives in this process.
  const body = new Uint8Array(PART + 4321);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7) & 0xff;
  const digest = `sha256:${sha(body)}`;
  const doc = new LoroDoc();
  markDocumentAssetAuthority(doc);
  createProjectDocumentAsset(doc, {
    id: "rev", documentAssetId: "docasset", documentKind: "media.transcript", schemaVersion: 1,
    mutability: "versioned", body: { digest, byteLength: body.length, contentType: "application/json" },
    producer: { kind: "actor", actor: { kind: "user", id: "owner" } }, sourceRefs: [],
  });
  const index = createPostgresContentReferenceIndex(db);
  const room = createInProcessContentRoom({ compute: () => projectSyncContent(doc), index, debounceMs: 1 });
  const dir = await mkdtemp(join(tmpdir(), "clash-upload-"));
  const ports = {
    identity: createPostgresUploadIdentity(db),
    admission: createPostgresContentAdmission(db),
    index,
    store: createFsAssetDeliveryStore(dir),
    room,
  };
  return { db, token, body, digest, room, ports, dir };
}

async function listen(fetch: (r: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

it("Node monolith: one process serves admission + rooms + multipart uploads with resume", async () => {
  const f = await setup();
  const app = createNodeCloudApp({ db: f.db, syncBaseUrl: "https://node.test", contentUpload: f.ports });
  const { server, base } = await listen(app.fetch);
  const published: ContentPublishedEvent[] = [];
  f.room.events.on("content.published", (e) => published.push(e));
  try {
    // The room indexes its references after an accepted update.
    f.room.changed("p1");
    await f.room.flush();
    expect(await f.ports.index.document("p1", f.digest)).toMatchObject({ byteLength: f.body.length });
    const url = (q: string) => `${base}/api/v1/projects/p1/document-bodies/${encodeURIComponent(f.digest)}${q}`;
    const headers = { authorization: `Bearer ${f.token}`, "x-local-replica-id": "r1" };
    const put = (q: string, body?: Uint8Array) => fetch(url(q), { method: "PUT", headers, body: body as unknown as BodyInit });
    const id = "node-mono-session-0001";
    expect((await put(`?upload=begin&uploadId=${id}`)).status).toBe(200);
    expect((await put(`?upload=part&uploadId=${id}&partNumber=1`, f.body.slice(0, PART))).status).toBe(204);
    const resumed = await (await put(`?upload=begin&uploadId=${id}`)).json();
    expect(resumed.parts).toEqual([{ partNumber: 1, sha256: sha(f.body.slice(0, PART)) }]);
    expect((await put(`?upload=part&uploadId=${id}&partNumber=2`, f.body.slice(PART))).status).toBe(204);
    expect((await put(`?upload=complete&uploadId=${id}`)).status).toBe(204);
    const got = new Uint8Array(await (await fetch(url(""), { headers })).arrayBuffer());
    expect(sha(got)).toBe(f.digest.slice(7));
    await new Promise((r) => setTimeout(r, 5));
    expect(published).toEqual([{ type: "content.published", projectId: "p1", kind: "document", digest: f.digest, byteLength: f.body.length }]);
    // Forged identity is not accepted.
    expect((await fetch(url(""), { headers: { "x-user-id": "owner", "x-local-replica-id": "r1" } })).status).toBe(401);
    // Existing monolith routes are still served by the same process.
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {
    server.close();
    await f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});

it("Node microservice: the same ports compose into an upload-only server", async () => {
  const f = await setup();
  const { server, base } = await listen(createUploadServer(f.ports).fetch);
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    // Index miss → in-process room computes refs and refreshes the index.
    const r = await fetch(
      `${base}/api/v1/projects/p1/document-bodies/${encodeURIComponent(f.digest)}?upload=begin&uploadId=node-micro-session-01`,
      { method: "PUT", headers: { authorization: `Bearer ${f.token}`, "x-local-replica-id": "r1" } },
    );
    expect(r.status).toBe(200);
    expect(await f.ports.index.document("p1", f.digest)).toBeDefined();
    expect((await fetch(`${base}/api/v1/projects`)).status).toBe(404);
  } finally {
    server.close();
    await f.db.close();
    await rm(f.dir, { recursive: true, force: true });
  }
});
