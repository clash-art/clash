import { createHash } from "node:crypto";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";

it("admits through real HTTP using database tokens and rejects forged identity/revocation", async () => {
  const db = new PGlite();
  let server: ReturnType<typeof serve> | undefined;
  try {
    await migrateDatabase(db);
    await migrateDatabase(db);
    const token = "clsh_" + "a".repeat(40);
    await db.query(
      "INSERT INTO api_token (id,user_id,name,token_hash,token_prefix) VALUES ($1,$2,$3,$4,$5)",
      [
        "token",
        "owner",
        "test",
        createHash("sha256").update(token).digest("hex"),
        "clsh_aaaa",
      ],
    );
    const app = createNodeCloudApp({
      db,
      syncBaseUrl: "https://node.example.com",
    });
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No address");
    const url = `http://127.0.0.1:${address.port}/api/v1/projects/project/cloud-admission`;
    const request = {
      schemaVersion: 1,
      projectId: "project",
      localReplicaId: "replica",
      resourceIds: [],
      metadata: {
        projectId: "project",
        name: "Project",
        description: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:00:00.000Z",
        deletedAt: null,
      },
    };
    const post = (headers: Record<string, string>, body: unknown = request) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    expect(
      (await post({ "x-user-id": "owner", "x-internal-agent": "true" })).status,
    ).toBe(401);
    const admitted = await post({ authorization: `Bearer ${token}` });
    expect(admitted.status).toBe(201);
    expect(await admitted.json()).toMatchObject({
      admission: { userId: "owner", projectId: "project", status: "pending" },
      syncBaseUrl: "https://node.example.com",
    });
    expect(
      (
        await post(
          { authorization: `Bearer ${token}` },
          { ...request, projectId: "other" },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(url + "?localReplicaId=replica", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    await db.query("UPDATE api_token SET user_id='other'");
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(404);
    await db.query("DELETE FROM api_token");
    expect(
      (
        await fetch(url + "?localReplicaId=replica", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  } finally {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server!.close((e) => (e ? reject(e) : resolve())),
      );
    await db.close();
  }
});
