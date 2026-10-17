/** Issue #138: the metadata service composes into the Node monolith and runs
 * alone as a microservice, over the same Postgres adapters. */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";
import { createMetadataServer, createNodeMetadataPorts } from "./metadata-service.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function setup() {
  const db = new PGlite();
  await migrateDatabase(db);
  const token = "clsh_" + "m".repeat(40);
  await db.query(
    "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
    ["t1", "owner", "Meta CLI", sha(token), "clsh_mmmm"],
  );
  await db.query(
    "INSERT INTO project (id,owner_id,tenant_id,name,created_at,updated_at) VALUES ('p1','owner','tn','Node P','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z'), ('p2','other','tn','Theirs',now(),now())",
  );
  return { db, token, ports: createNodeMetadataPorts({ db }) };
}

async function listen(fetch: (r: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No address");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function replicateMetadata(base: string, token: string) {
  const auth = { authorization: `Bearer ${token}` };
  const read = await fetch(`${base}/loro/p1/metadata`, { headers: auth });
  expect(read.status).toBe(200);
  const { metadata } = await read.json();
  expect(metadata).toMatchObject({ projectId: "p1", name: "Node P", deletedAt: null });
  const put = (m: unknown) =>
    fetch(`${base}/loro/p1/metadata`, {
      method: "PUT",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, metadata: m }),
    });
  expect((await put({ ...metadata, name: "Renamed", updatedAt: "2026-10-03T00:00:00.000Z" })).status).toBe(204);
  const stale = await put({ ...metadata, name: "Old", updatedAt: "2026-10-01T00:00:00.000Z" });
  expect(stale.status).toBe(409);
  expect((await stale.json()).metadata.name).toBe("Renamed");
  expect((await fetch(`${base}/loro/p2/metadata`, { headers: auth })).status).toBe(401);
  expect((await fetch(`${base}/loro/p1/metadata`)).status).toBe(401);
}

it("Node monolith: metadata routes served in-process next to the existing API", async () => {
  const f = await setup();
  const app = createNodeCloudApp({ db: f.db as never, syncBaseUrl: "https://node.test", metadataService: f.ports });
  const { server, base } = await listen(app.fetch);
  try {
    await replicateMetadata(base, f.token);
    // Session-only route: a token is not a session (same contract as api-cf).
    expect((await fetch(`${base}/api/projects`, { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(401);
    // Existing Node routes keep their own contract (syncTransport field).
    const v1 = await fetch(`${base}/api/v1/projects/p1`, { headers: { authorization: `Bearer ${f.token}` } });
    expect(v1.status).toBe(200);
    expect((await v1.json()).syncTransport).toBe("streams");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {
    server.close();
    await f.db.close();
  }
});

it("Node microservice: the same ports compose into a metadata-only server", async () => {
  const f = await setup();
  const { server, base } = await listen(createMetadataServer(f.ports).fetch);
  try {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "ok", service: "clash-meta" });
    await replicateMetadata(base, f.token);
    const card = await fetch(`${base}/api/v1/projects/p1`, { headers: { authorization: `Bearer ${f.token}` } });
    expect(card.status).toBe(200);
    expect(await card.json()).toMatchObject({ id: "p1", name: "Renamed", assets: [], assetCount: 0 });
    expect((await fetch(`${base}/api/v1/projects/p2`, { headers: { authorization: `Bearer ${f.token}` } })).status).toBe(404);
    expect((await fetch(`${base}/api/projects`, { method: "POST" })).status).toBe(404);
  } finally {
    server.close();
    await f.db.close();
  }
});
