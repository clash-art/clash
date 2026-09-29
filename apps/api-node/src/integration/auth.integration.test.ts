import { StreamsClient } from "@loro-dev/streams-client";
import { LoroDoc } from "loro-crdt";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { openPostgres } from "../postgres.ts";
import { migrateDatabase } from "../migrations.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { startServer } from "../server.ts";

it("signs in real accounts, issues hashed tokens and enforces session, origin and ownership boundaries", async () => {
  const input = process.env.CLUSTER_POSTGRES_URL!;
  const url = new URL(input);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw Error("Loopback only");
  const admin = new Pool({ connectionString: input });
  const name = `auth_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const database = openPostgres({ connectionString: url.href });
  let running: ReturnType<typeof startServer> | undefined;
  try {
    await migrateDatabase(database.db);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") throw Error("No listener");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const origin = `http://127.0.0.1:${address.port}`;
    running = startServer({
      DATABASE_URL: url.href,
      CLOUD_PUBLIC_URL: origin,
      PORT: String(address.port),
      BETTER_AUTH_SECRET:
        "test-only-secret-with-at-least-thirty-two-characters",
    });
    if (!running.server.listening) await once(running.server, "listening");
    const app = { request: fetch };
    const post = (
      path: string,
      body: unknown,
      cookie?: string,
      requestOrigin = origin,
    ) =>
      app.request(origin + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: requestOrigin,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      });
    const methods = await fetch(origin + "/api/better-auth/options");
    expect(methods.status).toBe(200);
    expect(await methods.json()).toMatchObject({
      password: true,
      emailOtp: false,
      google: false,
    });
    const signUp = await post("/api/better-auth/sign-up/email", {
      name: "Owner",
      email: "owner@example.test",
      password: "a-strong-test-password-123",
    });
    expect(signUp.status).toBe(200);
    const signIn = await post("/api/better-auth/sign-in/email", {
      email: "owner@example.test",
      password: "a-strong-test-password-123",
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(cookie).not.toBe("");
    const projects = await fetch(origin + "/api/v1/projects", {
      headers: { cookie },
    });
    expect(projects.status).toBe(200);
    expect(await projects.json()).toEqual({ projects: [] });

    expect((await post("/api/settings/tokens", { name: "CLI" })).status).toBe(
      401,
    );
    expect(
      (
        await post(
          "/api/settings/tokens",
          { name: "CLI" },
          cookie,
          "https://attacker.example",
        )
      ).status,
    ).toBe(403);
    const issued = await post("/api/settings/tokens", { name: "CLI" }, cookie);
    expect(issued.status).toBe(201);
    const { token, info } = await issued.json();
    expect(token).toMatch(/^clsh_[a-f0-9]{40}$/);
    const stored = await database.db.query(
      "SELECT * FROM api_token WHERE id=$1",
      [info.id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(token);
    const list = await app.request(origin + "/api/settings/tokens", {
      headers: { cookie },
    });
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: info.id, name: "CLI" }),
    ]);
    const second = await post("/api/better-auth/sign-up/email", {
      name: "Other",
      email: "other@example.test",
      password: "another-strong-password-123",
    });
    const otherCookie = second.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    expect(
      (
        await app.request(origin + `/api/settings/tokens/${info.id}`, {
          method: "DELETE",
          headers: { cookie: otherCookie, origin },
        })
      ).status,
    ).toBe(404);
    const request = {
      schemaVersion: 1,
      projectId: "project",
      localReplicaId: "replica",
      resourceIds: [],
      metadata: {
        projectId: "project",
        name: "Project",
        description: null,
        createdAt: "2026-09-17T00:00:00.000Z",
        updatedAt: "2026-09-17T00:00:00.000Z",
        deletedAt: null,
      },
    };
    expect(
      (
        await app.request(origin + "/api/v1/projects/project/cloud-admission", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        })
      ).status,
    ).toBe(201);
    const ownProjects=await fetch(origin+"/api/v1/projects",{headers:{cookie}});
    expect((await ownProjects.json()).projects).toEqual([expect.objectContaining({id:"project"})]);
    const otherProjects=await fetch(origin+"/api/v1/projects",{headers:{cookie:otherCookie}});
    expect((await otherProjects.json()).projects).toEqual([]);
    const secondDevice = await post(
      "/api/settings/tokens",
      { name: "Second device" },
      cookie,
    );
    const { token: deviceToken } = await secondDevice.json();
    const replicaUrl = origin + "/api/v1/projects/project/replica";
    const writer = new StreamsClient({ url: replicaUrl, auth: token });
    const reader = new StreamsClient({ url: replicaUrl, auth: deviceToken });
    const source = new LoroDoc(),
      replica = new LoroDoc();
    try {
      source.getMap("project").set("title", "Account-backed cross-device edit");
      source.commit();
      const appended = await writer.append({
        headers: { "idempotency-key": "account-sync" },
        part: {
          contentType: "application/json",
          body: JSON.stringify({
            id: "account-sync",
            update: Buffer.from(source.export({ mode: "update" })).toString(
              "base64",
            ),
          }),
        },
      });
      expect(appended.ok).toBe(true);
      const received = await reader.read({ offset: "-1" });
      expect(received.ok).toBe(true);
      if (!received.ok) throw Error(received.result.message);
      for (const row of received.result.payload.json() as Array<{
        update: string;
      }>)
        replica.import(Buffer.from(row.update, "base64"));
      expect(replica.toJSON()).toEqual(source.toJSON());
    } finally {
      source.free();
      replica.free();
    }
    expect(
      (
        await app.request(origin + `/api/settings/tokens/${info.id}`, {
          method: "DELETE",
          headers: { cookie, origin },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request(
          origin +
            "/api/v1/projects/project/cloud-admission?localReplicaId=replica",
          { headers: { authorization: `Bearer ${token}` } },
        )
      ).status,
    ).toBe(401);
    await post("/api/better-auth/sign-out", {}, cookie);
    expect(
      (
        await app.request(origin + "/api/settings/tokens", {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
  } finally {
    await running?.close();
    await database.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
});
