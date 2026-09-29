import { LoroCloudReplicaLink } from "../../local-api/src/loro/cloud-replica-link.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { getRequestListener } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { LoroDoc } from "loro-crdt";
import { it, expect } from "vitest";
import { StreamsClient } from "@loro-dev/streams-client";
import { createReplicaStreamClient } from "@clash/replica/replica-stream-client";
import { createPostgresCloudProjectAdmissionStore } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { createReplicaHttpGateway } from "./relay-http.ts";
import { migrateDatabase } from "./migrations.ts";
import { buildProjectCheckpoint } from "./checkpoint.ts";
it("uses the SSE SDK and durable cursors for snapshot bootstrap, log-only reconnect, opaque append and failed local persistence", async () => {
  const db = new PGlite();
  await migrateDatabase(db);
  const token = "clsh_" + "a".repeat(40),
    headers = { authorization: `Bearer ${token}` };
  await db.query(
    "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
    [
      "t",
      "u",
      "test",
      createHash("sha256").update(token).digest("hex"),
      "clsh_aaaa",
    ],
  );
  await createPostgresCloudProjectAdmissionStore(db).admit({
    userId: "u",
    syncBaseUrl: "http://example.com",
    request: {
      schemaVersion: 1,
      projectId: "p",
      localReplicaId: "l",
      resourceIds: [],
      metadata: {
        projectId: "p",
        name: "p",
        description: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    },
  });
  const gateway = createReplicaHttpGateway({ db, pollMs: 25 });
  const server = createServer(getRequestListener(gateway.app.fetch));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("address");
  const url = `http://127.0.0.1:${address.port}/api/v1/projects/p/replica`;
  const source = new LoroDoc(),
    local = new LoroDoc();
  let saved: string | null = null,
    fail = false;
  const snapshots: string[] = [];
  const create = () =>
    createReplicaStreamClient({
      url,
      headers,
      loadCursor: async () => saved,
      apply: async (record) => {
        if (fail) throw Error("disk unavailable");
        if (record.data.length) local.importBatch(record.data);
        if (record.kind === "snapshot") snapshots.push(record.cursor);
        saved = record.cursor;
      },
      onError: () => {},
    });
  let client = create();
  try {
    const sdk = new StreamsClient({ url, auth: token });
    const initial = await sdk.read({ offset: "-1" });
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    if (!initial.ok) throw Error(initial.result.message);
    expect(initial.result.payload.json()).toEqual([]);
    expect(await sdk.readLatestSnapshot()).toEqual({ ok: true, result: null });
    expect((await fetch(url, { headers: { "x-user-id": "u" } })).status).toBe(
      401,
    );
    source.getMap("m").set("before", "checkpoint");
    source.commit();
    const firstWrite = await sdk.append({
      headers: { "idempotency-key": "first" },
      part: {
        contentType: "application/json",
        body: JSON.stringify({
          id: "first",
          update: Buffer.from(source.export({ mode: "update" })).toString(
            "base64",
          ),
        }),
      },
    });
    expect(firstWrite.ok, JSON.stringify(firstWrite)).toBe(true);
    if (!firstWrite.ok) throw Error(firstWrite.result.message);
    const firstOffset = firstWrite.result.nextOffset;
    expect(
      await client.append("first", source.export({ mode: "update" })),
    ).toBe(firstOffset);
    expect(
      (
        await fetch(`${url}/snapshot/${firstOffset}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: source.export({ mode: "snapshot" }).slice().buffer,
        })
      ).status,
    ).toBe(404);
    await buildProjectCheckpoint(db, "p");
    const from = source.version();
    source.getMap("m").set("after", "tail");
    source.commit();
    const update = source.export({ mode: "update", from });
    from.free();
    const secondOffset = await client.append("second", update);
    await client.start();
    expect(local.toJSON()).toEqual(source.toJSON());
    expect(snapshots).toEqual([firstOffset]);
    expect(saved).toBe(secondOffset);
    await client.close();
    client = create();
    await client.start();
    expect(snapshots).toEqual([firstOffset]); // Cursor resumes log only.
    fail = true;
    source.getMap("m").set("later", "live");
    source.commit();
    const thirdOffset = await client.append(
      "third",
      source.export({ mode: "update" }),
    );
    await expect(client.reconcile()).rejects.toThrow("disk unavailable");
    expect(saved).toBe(secondOffset);
    fail = false;
    await client.reconcile();
    expect(saved).toBe(thirdOffset);
    expect(local.toJSON()).toEqual(source.toJSON());
    expect(await client.append("second", update)).toBe(secondOffset);
    const hostDoc = new LoroDoc();
    hostDoc.getMap("host").set("offline", "kept");
    hostDoc.commit();
    let joined = false;
    const host = new LoroCloudReplicaLink({
      baseUrl: `http://127.0.0.1:${address.port}`,
      projectId: "p",
      token,
      doc: () => hostDoc,
      commit: async (_id, updates) => {
        hostDoc.importBatch(updates);
      },
      onJoined: () => {
        joined = true;
      },
      onError: () => {},
    });
    try {
      host.start();
      await expect.poll(() => joined).toBe(true);
      expect(hostDoc.getMap("m").get("before")).toBe("checkpoint");
      await client.reconcile();
      expect(local.getMap("host").get("offline")).toBe("kept");
      hostDoc.getMap("host").set("unpublished", "private local edit");
      hostDoc.commit();
      await buildProjectCheckpoint(db, "p");
      const uploaded = await sdk.readLatestSnapshot();
      if (!uploaded.ok || !uploaded.result)
        throw Error("Missing backend checkpoint");
      const snapshotDoc = new LoroDoc();
      try {
        snapshotDoc.import(uploaded.result.payload.body);
        expect(snapshotDoc.getMap("host").get("offline")).toBe("kept");
        expect(snapshotDoc.getMap("host").get("unpublished")).toBeUndefined();
      } finally {
        snapshotDoc.free();
      }
    } finally {
      await host.close();
      hostDoc.free();
    }
    await client.close();
    await buildProjectCheckpoint(db, "p");
    const retained = await db.query<{ cursor: number }>(
      "SELECT cursor FROM project_replica_checkpoint WHERE project_id=$1",
      ["p"],
    );
    // Simulate retention only inside this disposable database, after a covering checkpoint.
    await db.query(
      "DELETE FROM project_replica_event WHERE project_id=$1 AND cursor<=$2",
      ["p", retained.rows[0]!.cursor],
    );
    const latest = await sdk.readLatestSnapshot();
    expect(latest.ok).toBe(true);
    if (!latest.ok || !latest.result) throw Error("Missing checkpoint");
    saved = firstOffset;
    client = create();
    await client.start();
    expect(saved).toBe(latest.result.nextOffset);
    expect(local.getMap("host").get("offline")).toBe("kept");
    const bad = new Uint8Array([0xde, 0xad]);
    // Relay stores bytes; checkpoint worker remains the CRDT validator.
    const beforeOpaque = saved!;
    expect((await client.append("opaque", bad)) > beforeOpaque).toBe(true);
    await expect(buildProjectCheckpoint(db, "p")).rejects.toBeDefined();
    expect(
      (
        await db.query<{ cursor: number }>(
          "SELECT cursor FROM project_replica_checkpoint WHERE project_id=$1",
          ["p"],
        )
      ).rows[0]!.cursor,
    ).toBe(retained.rows[0]!.cursor);
  } finally {
    await client.close();
    await gateway.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    source.free();
    local.free();
    await db.close();
  }
});
