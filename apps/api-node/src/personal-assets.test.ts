import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { ResolvedAssetSchema } from "@clash/shared-types";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";

it("persists imports, isolates owners, serves ranges and protects delete/restore retries", async () => {
  const db = new PGlite();
  const assetDirectory = await mkdtemp(join(tmpdir(), "clash-assets-"));
  try {
    await migrateDatabase(db);
    const tokens = ["clsh_" + "a".repeat(40), "clsh_" + "b".repeat(40)];
    for (const [i, token] of tokens.entries())
      await db.query(
        "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES($1,$1,'test',$2,'clsh_')",
        [String(i), createHash("sha256").update(token).digest("hex")],
      );
    const makeApp = () =>
      createNodeCloudApp({
        db,
        syncBaseUrl: "http://localhost",
        assetDirectory,
      });
    let app = makeApp();
    const base = "/api/v1/libraries/personal/assets";
    const request = (path = "", init: RequestInit = {}, owner = 0) =>
      app.request(base + path, {
        ...init,
        headers: { authorization: `Bearer ${tokens[owner]}`, ...init.headers },
      });
    const upload = (
      bytes = "test-media",
      kind = "image",
      type = "image/png",
    ) => {
      const body = new FormData();
      body.set("file", new File([bytes], "frame.png", { type }));
      body.set("kind", kind);
      body.set("globalAssetId", "global:test");
      return request("/import-file", { method: "POST", body });
    };
    expect((await app.request(base)).status).toBe(401);
    const imported = await upload();
    expect(imported.status).toBe(201);
    const asset = ResolvedAssetSchema.parse(await imported.json());
    expect(asset).toMatchObject({
      id: "global:test",
      status: "ready",
      lifecycle: { state: "active" },
    });
    expect((await upload()).status).toBe(201);
    expect((await upload("changed")).status).toBe(409);
    expect((await upload("x", "video")).status).toBe(400);
    expect((await upload("<script/>", "image", "text/html")).status).toBe(400);
    expect(
      (
        await request("/import-file", {
          method: "POST",
          headers: { "content-length": String(70 * 1024 * 1024) },
          body: "x",
        })
      ).status,
    ).toBe(413);
    app = makeApp(); // New service instance must read persisted state.
    expect((await (await request()).json()).assets).toEqual([asset]);
    expect((await (await request("", {}, 1)).json()).assets).toEqual([]);
    expect((await request("/global:test/media", {}, 1)).status).toBe(404);
    const partial = await request("/global:test/media", {
      headers: { range: "bytes=2-5" },
    });
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("st-m");
    expect(
      (
        await request("/global:test/media", {
          headers: { range: "bytes=999-" },
        })
      ).status,
    ).toBe(416);
    const change = (restore: boolean, id: string) =>
      request("/global:test" + (restore ? "/restore" : ""), {
        method: restore ? "POST" : "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deleteOperationId: id }),
      });
    expect((await change(false, "delete-1")).status).toBe(200);
    expect((await change(false, "delete-1")).status).toBe(200);
    expect((await request("/global:test/media")).status).toBe(404);
    expect((await change(true, "wrong")).status).toBe(409);
    expect((await change(true, "delete-1")).status).toBe(200);
    expect((await change(true, "delete-1")).status).toBe(200);
    expect((await change(false, "delete-1")).status).toBe(409);
    expect((await change(false, "delete-2")).status).toBe(200);
    expect((await change(true, "delete-1")).status).toBe(409);
    expect((await change(true, "delete-2")).status).toBe(200);
    expect(await (await request("/global:test/media")).text()).toBe(
      "test-media",
    );
    for (const file of await readdir(assetDirectory))
      await rm(join(assetDirectory, file));
    const missing = await (await request("/global:test")).json();
    expect(missing).toMatchObject({ status: "unavailable" });
    expect(missing.url).toBeUndefined();
    expect((await request("/global:test/media")).status).toBe(404);
  } finally {
    await db.close();
    await rm(assetDirectory, { recursive: true, force: true });
  }
});
