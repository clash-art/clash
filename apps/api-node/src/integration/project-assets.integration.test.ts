import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { openPostgres } from "../postgres.ts";
import { expect, it } from "vitest";
import { createNodeCloudApp } from "../app.ts";
import { migrateDatabase } from "../migrations.ts";
import { withProjectDocument } from "../project-document.ts";
import { readProjectAsset } from "@clash/shared-types";
it("imports immutable project assets, persists their Loro identities, and restricts media to the project owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "project-assets-"));
  const url = new URL(process.env.CLUSTER_POSTGRES_URL!);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw Error("Loopback only");
  const admin = new Pool({ connectionString: url.href });
  const databaseName = "project_assets_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${databaseName}`);
  url.pathname = "/" + databaseName;
  const connection = openPostgres({ connectionString: url.href }),
    db = connection.db;
  try {
    await migrateDatabase(db);
    const token = "clsh_" + "a".repeat(40);
    await db.query(
      "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES('t','owner','test',$1,'clsh_')",
      [createHash("sha256").update(token).digest("hex")],
    );
    await db.query(
      "INSERT INTO project(id,owner_id,name,created_at,updated_at) VALUES('p','owner','Project',now(),now()),('other','other','Other',now(),now())",
    );
    const make = () =>
      createNodeCloudApp({
        db,
        syncBaseUrl: "http://localhost",
        assetDirectory: directory,
      });
    let app = make();
    const request = (path = "", init: RequestInit = {}) =>
      app.request("/api/v1/projects/p/assets" + path, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      });
    expect((await request()).status).toBe(200);
    const upload = (bytes = "immutable-image") => {
      const body = new FormData();
      body.set("file", new File([bytes], "frame.png", { type: "image/png" }));
      body.set("kind", "image");
      body.set("projectAssetId", "asset:test");
      return request("/import-file", { method: "POST", body });
    };
    const imported = await upload();
    expect(imported.status).toBe(201);
    const asset = await imported.json();
    expect(asset).toMatchObject({ id: "asset:test", status: "ready" });
    expect((await upload()).status).toBe(201);
    expect((await upload("different")).status).toBe(409);
    expect(
      await withProjectDocument(db, "owner", "p", false, (doc) =>
        readProjectAsset(doc, "asset:test"),
      ),
    ).toMatchObject({ id: "asset:test", source: { kind: "owned" } });
    app = make();
    expect((await (await request()).json()).assets).toEqual([asset]);
    const observed = await request("/asset:test");
    expect(observed.headers.get("x-clash-read-receipt")).toBeTruthy();
    expect(await observed.json()).toEqual(asset);
    const references = await request("/asset:test/references");
    expect(references.status).toBe(200);
    expect(await references.json()).toEqual({
      projectAssetId: "asset:test",
      references: [],
    });
    const batch = await request("/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["asset:test", "missing"] }),
    });
    expect((await batch.json()).assets).toEqual([asset]);
    const media = await request("/asset:test/media", {
      headers: { range: "bytes=0-3" },
    });
    expect(media.status).toBe(206);
    expect(await media.text()).toBe("immu");
    await db.query("UPDATE api_token SET user_id='other'");
    expect((await request()).status).toBe(404);
    expect((await request("/asset:test/media")).status).toBe(404);
  } finally {
    await connection.close();
    await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
