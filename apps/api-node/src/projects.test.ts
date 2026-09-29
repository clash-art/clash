import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { createNodeCloudApp } from "./app.ts";
import { migrateDatabase } from "./migrations.ts";

it("creates owned projects and supports read, rename, archive and restore without cross-account access", async () => {
  const db = new PGlite();
  try {
    await migrateDatabase(db);
    const token = "clsh_" + "a".repeat(40);
    await db.query(
      "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES('t','owner','test',$1,'clsh_')",
      [createHash("sha256").update(token).digest("hex")],
    );
    const app = createNodeCloudApp({ db, syncBaseUrl: "http://localhost" });
    const request = (path: string, method = "GET", body?: unknown) =>
      app.request("/api/v1/projects" + path, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    expect((await request("", "POST", { name: " " })).status).toBe(400);
    const created = await request("", "POST", { name: "  First project  " });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project).toMatchObject({
      id: expect.any(String),
      name: "First project",
    });
    const path = `/${project.id}`;
    expect((await (await request(path)).json()).name).toBe("First project");
    expect((await request(path, "PATCH", { name: "Renamed" })).status).toBe(
      200,
    );
    expect((await (await request(path)).json()).name).toBe("Renamed");
    await db.query("UPDATE api_token SET user_id='stranger'");
    for (const method of ["GET", "PATCH", "DELETE"])
      expect(
        (
          await request(
            path,
            method,
            method === "PATCH" ? { name: "Hacked" } : undefined,
          )
        ).status,
      ).toBe(404);
    await db.query("UPDATE api_token SET user_id='owner'");
    expect((await request(path, "DELETE")).status).toBe(200);
    expect((await request(path)).status).toBe(404);
    expect((await (await request("?archived=only")).json()).projects).toEqual([
      expect.objectContaining({ id: project.id }),
    ]);
    expect((await request(path + "/restore", "POST")).status).toBe(200);
    expect((await request(path)).status).toBe(200);
  } finally {
    await db.close();
  }
});
