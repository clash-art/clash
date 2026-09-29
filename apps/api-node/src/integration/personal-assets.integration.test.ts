import { LoroDoc } from "loro-crdt";
import { createLoroStreamSession } from "@clash/replica/loro-stream-session";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { openPostgres } from "../postgres.ts";
import { migrateDatabase } from "../migrations.ts";
import { startServer } from "../server.ts";

it("retains authenticated browser uploads across a Node restart and serializes competing deletions in PostgreSQL", async () => {
  const url = new URL(process.env.CLUSTER_POSTGRES_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw Error("Loopback only");
  const admin = new Pool({ connectionString: url.href });
  const name = `assets_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  url.pathname = `/${name}`;
  const db = openPostgres({ connectionString: url.href });
  const directory = await mkdtemp(join(tmpdir(), "node-asset-integration-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw Error("No address");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = "http://localhost:3002";
  const env = {
    DATABASE_URL: url.href,
    CLOUD_PUBLIC_URL: origin,
    PORT: String(address.port),
    CLOUD_ASSET_DIR: directory,
    BETTER_AUTH_SECRET: "test-only-secret-at-least-thirty-two-characters",
  };
  let server: ReturnType<typeof startServer> | undefined;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await migrateDatabase(db.db);
    server = startServer(env);
    if (!server.server.listening) await once(server.server, "listening");
    const signup = await fetch(base + "/api/better-auth/sign-up/email", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: "asset-owner@example.test",
        name: "Asset Owner",
        password: "integration-password-123",
      }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const creation = await fetch(base + "/api/v1/projects", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "Browser project" }),
    });
    expect(creation.status).toBe(201);
    const { id: projectId } = await creation.json();
    const replicaUrl = base + `/api/v1/projects/${projectId}/replica`;
    expect(
      (await fetch(replicaUrl, { method: "HEAD", headers: { cookie } })).status,
    ).toBe(200);
    expect(
      (
        await fetch(replicaUrl, {
          method: "POST",
          headers: { cookie, origin: "https://attacker.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    const first = new LoroDoc(),
      second = new LoroDoc();
    first.getMap("acceptance").set("draft", "offline draft");
    first.commit();
    const sessions = [first, second].map((doc) =>
      createLoroStreamSession({
        doc,
        url: replicaUrl,
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("cookie", cookie);
          headers.set("origin", origin);
          return fetch(input, { ...init, headers });
        },
      }),
    );
    try {
      await sessions[0]!.start();
      await sessions[1]!.start();
      expect(second.getMap("acceptance").get("draft")).toBe("offline draft");
      second.getMap("acceptance").set("reply", "another browser");
      second.commit();
      await expect
        .poll(() => first.getMap("acceptance").get("reply"))
        .toBe("another browser");
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    const timelineCommand = (body: unknown) =>
      fetch(base + `/api/v1/projects/${projectId}/host-command`, {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const timelineCreation = await timelineCommand({
      action: "create_timeline",
      timelineId: "timeline-http",
      name: "Persisted timeline",
      state: { tracks: [] },
    });
    expect(timelineCreation.status).toBe(200);
    const timeline = await timelineCreation.json();
    const competing = await Promise.all(
      [24, 30].map((fps) =>
        timelineCommand({
          action: "update_timeline_state",
          timelineId: "timeline-http",
          state: { tracks: [], fps },
          ifMatch: timeline.readToken,
        }),
      ),
    );
    expect(competing.map((r) => r.status).sort()).toEqual([200, 409]);
    const accepted = await competing.find((r) => r.status === 200)!.json();
    const path = "/api/v1/libraries/personal/assets";
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRusAAAAASUVORK5CYII=",
      "base64",
    );
    const form = () => {
      const body = new FormData();
      body.set("file", new File([bytes], "pixel.png", { type: "image/png" }));
      body.set("kind", "image");
      body.set("globalAssetId", "global:integration");
      return body;
    };
    expect(
      (
        await fetch(base + path + "/import-file", {
          method: "POST",
          headers: { cookie, origin: "https://attacker.example" },
          body: form(),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(base + path + "/import-file", {
          method: "POST",
          headers: { cookie, origin },
          body: form(),
        })
      ).status,
    ).toBe(201);
    await server.close();
    server = startServer(env);
    if (!server.server.listening) await once(server.server, "listening");
    const restoredTimelines = await (
      await timelineCommand({ action: "list_timelines" })
    ).json();
    expect(restoredTimelines.timelines).toEqual([accepted.timeline]);
    const resumedWrite = await timelineCommand({
      action: "update_timeline_state",
      timelineId: "timeline-http",
      state: { tracks: [], fps: 60 },
      ifMatch: accepted.readToken,
    });
    expect(resumedWrite.status).toBe(200);
    const list = await fetch(base + path, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).assets).toEqual([
      expect.objectContaining({ id: "global:integration", status: "ready" }),
    ]);
    const media = await fetch(base + path + "/global:integration/media", {
      headers: { cookie },
    });
    expect(Buffer.from(await media.arrayBuffer())).toEqual(bytes);
    const deletes = await Promise.all(
      ["one", "two"].map((deleteOperationId) =>
        fetch(base + path + "/global:integration", {
          method: "DELETE",
          headers: { cookie, origin, "content-type": "application/json" },
          body: JSON.stringify({ deleteOperationId }),
        }),
      ),
    );
    expect(deletes.map((r) => r.status).sort()).toEqual([200, 409]);
  } finally {
    await server?.close();
    await db.close();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
