/**
 * Parity (#138): the lean metadata Worker (@clash/metadata-service + D1
 * adapters, no better-auth) must answer exactly like api-cf's in-process
 * routes, on the same database, for every route it takes over.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("./containers/render", () => ({ RenderContainer: class MockRenderContainer {} }));

import { createApp } from "./app";
import { createMetadataWorker } from "./metadata-worker";
import { createSqliteD1 } from "../../web/app/test-support/sqlite-d1";

for (const ORIGIN of ["http://localhost:8789", "https://parity.example.test"]) {
  describe(`metadata Worker parity with api-cf (${ORIGIN})`, () => {
    const { d1, sqlite, counter } = createSqliteD1();
    const nodes: Record<string, unknown[]> = {
      p1: [
        { id: "n1", type: "image", data: { assetId: "a1", createdAt: "2026-10-01T00:00:00.000Z" } },
        { id: "n2", type: "video", data: { assetId: "a2" } },
        { id: "n3", type: "image", data: { assetId: "missing" } },
        { id: "n4", type: "image", data: { assetId: "a1" } },
        { id: "t", type: "text", data: {} },
      ],
    };
    const ROOM = {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        fetch: async () => Response.json(nodes[id] ?? []),
      }),
    };
    const env = {
      DB: d1,
      ROOM,
      ENVIRONMENT: "test",
      JWT_SECRET: "parity-jwt-secret",
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: "parity-secret-0123456789abcdef0123456789",
    } as never;
    const app = createApp();
    const meta = createMetadataWorker();
    let cookie = "";
    let token = "";
    let userId = "";

    const both = async (path: string, init: RequestInit = {}) => {
      const a = await app.request(path, init, env);
      const m = await meta.fetch(new Request(`${ORIGIN}${path}`, init), env);
      const norm = (t: string) => t.replace(/exp=\d+&sig=[\w-]+/g, "exp=E&sig=S");
      return {
        api: { status: a.status, body: norm(await a.text()) },
        meta: { status: m.status, body: norm(await m.text()) },
      };
    };

    beforeAll(async () => {
      const res = await app.request(
        "/api/better-auth/sign-up/email",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email: "parity@example.com", password: "parity-pass-123", name: "Parity" }),
        },
        env,
      );
      expect(res.status).toBe(200);
      cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      userId = (sqlite.prepare("SELECT id FROM users").get() as { id: string }).id;
      const ins = sqlite.prepare(
        "INSERT INTO project (id, owner_id, name, description, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      ins.run("p1", userId, "One", "first", 1_790_000_000, 1_790_000_100, null);
      ins.run("p2", userId, "Two", null, 1_790_000_500, 1_790_000_600, null);
      ins.run("p3", userId, "Gone", null, 1_790_000_700, 1_790_000_800, 1_790_000_900);
      ins.run("px", "someone-else", "Theirs", null, 1_790_000_000, 1_790_000_000, null);
      const asset = sqlite.prepare(
        "INSERT INTO assets (id, user_id, kind, src_r2_key, cover_r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      asset.run("a1", userId, "image", "u/a1.png", null, 1_790_000_010);
      asset.run("a2", userId, "video", "u/a2.mp4", "u/a2.jpg", 1_790_000_020);
      asset.run("a3", userId, "image", "u/a3.png", null, 1_790_000_030);
      asset.run("a4", userId, "audio", "u/a4.mp3", null, 1_790_000_040);
      const ref = sqlite.prepare("INSERT INTO asset_refs (asset_id, project_id, imported_at) VALUES (?, ?, ?)");
      ref.run("a1", "p1", 1_790_000_011);
      ref.run("a3", "p1", 1_790_000_031);
      ref.run("a4", "p1", 1_790_000_041);
      ref.run("a3", "p2", 1_790_000_032);
      const created = await app.request(
        "/api/settings/tokens",
        { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ name: "Parity CLI" }) },
        env,
      );
      token = ((await created.json()) as { token: string }).token;
    });

    const routes: [string, string][] = [
      ["projects list", "/api/projects"],
      ["project get", "/api/projects/p1"],
      ["project get (assets via refs only)", "/api/projects/p2"],
      ["project get (deleted)", "/api/projects/p3"],
      ["project get (other owner)", "/api/projects/px"],
      ["v1 project get", "/api/v1/projects/p1"],
      ["v1 project get (missing)", "/api/v1/projects/nope"],
      ["tokens", "/api/settings/tokens"],
      ["metadata get", "/loro/p1/metadata"],
      ["metadata get (deleted, owner)", "/loro/p3/metadata"],
      ["metadata get (other owner)", "/loro/px/metadata"],
    ];

    for (const [name, path] of routes) {
      it(`${name}: session cookie`, async () => {
        const r = await both(path, { headers: { cookie } });
        if (process.env.PARITY_DEBUG) (await import("node:fs")).appendFileSync(process.env.PARITY_DEBUG, `${path} ${r.meta.status} ${r.meta.body.slice(0, 600)}\n`);
        expect(r.meta).toEqual(r.api);
      });
      it(`${name}: no credential`, async () => {
        const r = await both(path);
        expect(r.meta).toEqual(r.api);
      });
      it(`${name}: API token`, async () => {
        const r = await both(path, { headers: { authorization: `Bearer ${token}` } });
        expect(r.meta).toEqual(r.api);
      });
    }

    it("v1 behind the web gateway (require-identity) without credential", async () => {
      const r = await both("/api/v1/projects/p1", { headers: { "x-clash-require-identity": "1" } });
      expect(r.meta).toEqual(r.api);
      expect(r.meta.status).toBe(401);
    });

    it("forged x-user-id is ignored by both", async () => {
      const r = await both("/api/projects", { headers: { "x-user-id": userId } });
      expect(r.meta).toEqual(r.api);
      expect(r.meta.status).toBe(401);
    });

    it("metadata PUT: written, stale 409, oversize 413, bad envelope 400 — same on both", async () => {
      const read = await meta.fetch(new Request(`${ORIGIN}/loro/p2/metadata`, { headers: { cookie } }), env);
      const { metadata } = (await read.json()) as { metadata: Record<string, unknown> };
      const bodies = [
        { ...metadata, name: "Renamed", updatedAt: "2026-10-10T00:00:00.000Z" },
        { ...metadata, name: "Stale", updatedAt: "2026-01-01T00:00:00.000Z" },
        { ...metadata, name: "x".repeat(513), updatedAt: "2026-10-11T00:00:00.000Z" },
        { ...metadata, projectId: "p1" },
      ];
      const statuses: number[] = [];
      for (const m of bodies) {
        const init = () => ({
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, metadata: m }),
        });
        const a = await app.request("/loro/p2/metadata", init(), env);
        const w = await meta.fetch(new Request(`${ORIGIN}/loro/p2/metadata`, init()), env);
        expect(w.status).toBe(a.status);
        expect(await w.text()).toBe(await a.text());
        statuses.push(w.status);
      }
      expect(statuses).toEqual([204, 409, 413, 400]);
    });

    it("lean Worker uses fewer D1 queries than api-cf", async () => {
      const counts: Record<string, [number, number]> = {};
      for (const path of ["/api/projects/p1", "/api/settings/tokens", "/loro/p1/metadata"]) {
        counter.reset();
        await app.request(path, { headers: { cookie } }, env);
        const api = counter.count;
        counter.reset();
        await meta.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), env);
        counts[path] = [api, counter.count];
      }
      for (const [api, lean] of Object.values(counts)) expect(lean).toBeLessThanOrEqual(api);
    });

    it("defers a refresh-due session to api-cf (API_CF) and api-cf refreshes it", async () => {
      sqlite.prepare("UPDATE sessions SET expires_at = ?").run(Date.now() + 60 * 60 * 1000);
      const seen: string[] = [];
      const deferEnv = {
        ...(env as object),
        API_CF: {
          fetch: async (r: Request) => {
            seen.push(r.headers.get("x-clash-meta-deferred") ?? "");
            return app.request(new URL(r.url).pathname, { headers: r.headers }, env);
          },
        },
      } as never;
      const res = await meta.fetch(new Request(`${ORIGIN}/api/settings/tokens`, { headers: { cookie } }), deferEnv);
      expect(res.status).toBe(200);
      expect(seen).toEqual(["1"]);
      const after = (sqlite.prepare("SELECT expires_at FROM sessions").get() as { expires_at: number }).expires_at;
      expect(after).toBeGreaterThan(Date.now() + 2 * 24 * 60 * 60 * 1000);
    });
  });
}
