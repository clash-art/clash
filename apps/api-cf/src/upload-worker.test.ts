import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ tracing: undefined, DurableObject: class {} }));
import { createCloudflareIdentity, createUploadWorkerApp } from "./upload-worker";
import { createApp, isUploadServicePath } from "./app";
import { createD1ContentReferenceIndex } from "./services/project-content-cloud";

function fakeD1(tokens: Record<string, string> = {}) {
  const rows: any[] = [];
  const db = {
    rows,
    prepare(sql: string) {
      return {
        bind(...v: any[]) {
          return {
            async first() {
              if (sql.includes("project_content_ref"))
                return rows.find((r) => r.project_id === v[0] && r.ref_kind === v[1] && r.ref_key === v[2]) ?? null;
              return null;
            },
            async all() {
              if (sql.includes("api_token")) {
                const hit = Object.entries(tokens).find(([h]) => h === v[0]);
                return { results: hit ? [{ user_id: hit[1] }] : [] };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("DELETE")) {
                for (let i = rows.length - 1; i >= 0; i--) if (rows[i].project_id === v[0]) rows.splice(i, 1);
              } else if (sql.includes("'document'"))
                rows.push({ project_id: v[0], ref_kind: "document", ref_key: v[1], byte_length: v[2], content_type: v[3], asset_kind: null });
              else if (sql.includes("'resource'"))
                rows.push({ project_id: v[0], ref_kind: "resource", ref_key: v[1], byte_length: null, content_type: null, asset_kind: v[2] });
              return {};
            },
          };
        },
      };
    },
  };
  return db;
}

describe("upload Worker (#130)", () => {
  it("identity ignores a forged x-user-id and has no session without cookie", async () => {
    const identity = createCloudflareIdentity({ DB: fakeD1() } as never);
    expect(
      await identity.verify(new Request("https://u/", { headers: { "x-user-id": "forged" } })),
    ).toBeNull();
  });

  it("identity accepts a clsh_ API token via the shared D1 lookup", async () => {
    const token = "clsh_test";
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), (b) => b.toString(16).padStart(2, "0")).join("");
    const identity = createCloudflareIdentity({ DB: fakeD1({ [hash]: "u1" }) } as never);
    expect(await identity.verify(new Request("https://u/", { headers: { authorization: `Bearer ${token}` } }))).toEqual({ userId: "u1" });
  });

  it("document-body route rejects unauthenticated callers without touching ROOM", async () => {
    const room = { idFromName: vi.fn(), get: vi.fn() };
    const app = createUploadWorkerApp();
    const response = await app.request(
      "/api/v1/projects/p1/document-bodies/sha256%3Aabc?upload=begin&uploadId=0123456789abcdef",
      { method: "PUT", headers: { "x-user-id": "forged", "x-local-replica-id": "r1" } },
      { DB: fakeD1(), ROOM: room, R2_BUCKET: {}, ENVIRONMENT: "test" },
      { waitUntil() {}, passThroughOnException() {} } as never,
    );
    expect(response.status).toBe(401);
    expect(room.get).not.toHaveBeenCalled();
  });

  it("D1 index round-trips documents and resources", async () => {
    const index = createD1ContentReferenceIndex(fakeD1() as never);
    await index.replace("p1", {
      documents: [{ digest: "sha256:aa", byteLength: 3, contentType: "application/json" }],
      resources: [{ resourceId: "r1", kind: "image" as never }],
    });
    expect(await index.document("p1", "sha256:aa")).toEqual({ digest: "sha256:aa", byteLength: 3, contentType: "application/json" });
    expect(await index.resource("p1", "r1")).toEqual({ resourceId: "r1", kind: "image" });
    expect(await index.document("p2", "sha256:aa")).toBeUndefined();
    await index.replace("p1", { documents: [], resources: [] });
    expect(await index.document("p1", "sha256:aa")).toBeUndefined();
  });

  it("api-cf forwards only upload paths to API_UPLOAD when bound", async () => {
    expect(isUploadServicePath("/api/v1/projects/p/document-bodies/sha256:x")).toBe(true);
    expect(isUploadServicePath("/api/v1/projects/p/resources/r/delivery")).toBe(false);
    const upload = vi.fn(async () => new Response("from upload", { status: 207 }));
    const app = createApp();
    const res = await app.request(
      "/api/v1/projects/p/document-bodies/sha256%3Ax",
      { method: "PUT" },
      { API_UPLOAD: { fetch: upload } } as never,
    );
    expect(res.status).toBe(207);
    expect(upload).toHaveBeenCalledOnce();
  });
});
