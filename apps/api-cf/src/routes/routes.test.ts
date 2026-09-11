import { describe, it, expect, vi, beforeEach } from "vitest";
import { startGeneration } from "../generation/start";
import { hostedGenerationStatus } from "../generation/status";
vi.mock("../generation/start", () => ({ startGeneration: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../generation/status", () => ({ hostedGenerationStatus: vi.fn().mockResolvedValue(undefined) }));
import type { Env } from "../config";
import { computeSignature, getSigningKey } from "../services/asset-signing";

// Mock the agents package which uses cloudflare: protocol imports
vi.mock("agents", () => ({
  Agent: class MockAgent {},
}));

// Mock cloudflare:workers protocol imports
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
  DurableObject: class MockDurableObject {},
}));

vi.mock("../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

// Mock describe service
vi.mock("../services/describe", () => ({
  generateDescription: vi.fn().mockResolvedValue("A description"),
}));

// Mock generation module (depends on cloudflare:workers)
vi.mock("../agents/generation", () => ({
  GenerationWorkflow: class MockGeneration {},
}));

// Mock project-room module (depends on cloudflare:workers)
vi.mock("../agents/project-room", () => ({
  ProjectRoom: class MockProjectRoom {},
}));

// Mock supervisor module (depends on agents, @cloudflare/ai-chat)
vi.mock("../agents/supervisor", () => ({
  SupervisorAgent: class MockSupervisor {},
}));

// We need to import the app after mocks are set up
import { createApp } from "../app";
const app = createApp();

const USER_HEADERS = { authorization: "Bearer clsh_routes_test" };

function makeEnv(overrides: Partial<Env> = {}): Env {
  const env = {
    GOOGLE_API_KEY: "test-key",
    GOOGLE_AI_STUDIO_BASE_URL: "",
    CF_AIG_TOKEN: "",
    KLING_ACCESS_KEY: "",
    KLING_SECRET_KEY: "",
    R2_BUCKET: {
      get: vi.fn(),
      head: vi.fn().mockResolvedValue({ size: 3 }),
      put: vi.fn().mockResolvedValue(undefined),
    } as any,
    R2_PUBLIC_URL: "https://r2.example.com",
    JWT_SECRET: "test-secret",
    ENVIRONMENT: "production",
    ROOM: {
      idFromName: vi.fn().mockReturnValue("room-id"),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response("ok")),
      }),
    } as any,
    GENERATION_WORKFLOW: {
      create: vi.fn().mockResolvedValue({ id: "wf-id" }),
    } as any,
    RENDER_CONTAINER: {} as any,
    DB: {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
          all: vi.fn().mockResolvedValue({ results: [] }),
          first: vi.fn().mockResolvedValue(null),
        }),
      }),
      batch: vi.fn().mockResolvedValue([]),
    } as any,
    WORKER_PUBLIC_URL: "https://api.example.com",
    ...overrides,
  } as Env;
  const routeDb = env.DB;
  env.DB = {
    ...routeDb,
    prepare: vi.fn((sql: string) => {
      if (sql.includes("FROM api_token WHERE token_hash")) {
        return {
          bind: vi.fn(() => ({
            all: vi
              .fn()
              .mockResolvedValue({ results: [{ user_id: "user-1" }] }),
          })),
        };
      }
      if (sql.includes("UPDATE api_token SET last_used_at")) {
        return {
          bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({}) })),
        };
      }
      return routeDb.prepare(sql);
    }),
  } as any;
  return env;
}

describe("Hono routes", () => {
  let env: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
      },
    });
    env = makeEnv();
    // Mock crypto.randomUUID
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  async function signedAssetPath(storageKey: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const key = await getSigningKey(env);
    const sig = await computeSignature(key, storageKey, exp);
    return `/assets/${storageKey}?exp=${exp}&sig=${sig}`;
  }

  // ─── Health check ───

  describe("GET /health", () => {
    it("returns 200 { status: 'ok' }", async () => {
      const res = await app.request("/health", {}, env);
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json).toEqual({ status: "ok" });
    });
  });

  // ─── Loro Remote Persistence ───

  describe("Loro remote persistence", () => {
    it("authenticates and forwards snapshot reads to the project room", async () => {
      const idFromName = vi.fn().mockReturnValue("room-id");
      const roomFetch = vi.fn().mockResolvedValue(
        new Response(new Uint8Array([7, 8, 9]), {
          headers: { "content-type": "application/octet-stream" },
        }),
      );
      env = makeEnv({
        ENVIRONMENT: "development",
        ROOM: {
          idFromName,
          get: vi.fn().mockReturnValue({ fetch: roomFetch }),
        } as any,
      });

      const res = await app.request("/loro/project%2Fone/snapshot", {}, env);

      expect(res.status).toBe(200);
      expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([
        7, 8, 9,
      ]);
      expect(idFromName).toHaveBeenCalledWith("project/one");
      const forwarded = roomFetch.mock.calls[0]?.[0] as Request;
      expect(forwarded.method).toBe("GET");
      expect(forwarded.headers.get("x-internal-loro")).toBe("true");
      expect(forwarded.headers.get("x-loro-project-id")).toBe("project/one");
      expect(new URL(forwarded.url).pathname).toBe(
        "/loro/project%2Fone/snapshot",
      );
    });

    it("authenticates and forwards exact update bytes to the project room", async () => {
      const idFromName = vi.fn().mockReturnValue("room-id");
      const roomFetch = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 204 }));
      env = makeEnv({
        ENVIRONMENT: "development",
        ROOM: {
          idFromName,
          get: vi.fn().mockReturnValue({ fetch: roomFetch }),
        } as any,
      });

      const arena = new Uint8Array([0, 4, 5, 6, 0]);
      const update = arena.subarray(1, 4);
      const res = await app.request(
        "/loro/project%2Fone/updates",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: update.slice().buffer,
        },
        env,
      );

      expect(res.status).toBe(204);
      expect(idFromName).toHaveBeenCalledWith("project/one");
      const forwarded = roomFetch.mock.calls[0]?.[0] as Request;
      expect(forwarded.method).toBe("POST");
      expect(forwarded.headers.get("x-internal-loro")).toBe("true");
      expect(forwarded.headers.get("x-loro-project-id")).toBe("project/one");
      expect(Array.from(new Uint8Array(await forwarded.arrayBuffer()))).toEqual(
        [4, 5, 6],
      );
    });

    it("stores project metadata separately from the Loro document", async () => {
      const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const prepare = vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            sql.includes("SELECT id, name")
              ? {
                  id: "project/one",
                  name: "Cloud project",
                  description: "Metadata row",
                  created_at: 1_788_480_000,
                  updated_at: 1_788_480_060,
                  deleted_at: null,
                }
              : null,
          ),
          run,
          all: vi.fn().mockResolvedValue({ results: [] }),
        })),
      }));
      env = makeEnv({ ENVIRONMENT: "development", DB: { prepare } as any });

      const getResponse = await app.request(
        "/loro/project%2Fone/metadata",
        {},
        env,
      );
      expect(getResponse.status).toBe(200);
      expect(await getResponse.json()).toEqual({
        schemaVersion: 1,
        metadata: {
          projectId: "project/one",
          name: "Cloud project",
          description: "Metadata row",
          createdAt: "2026-09-04T00:00:00.000Z",
          updatedAt: "2026-09-04T00:01:00.000Z",
          deletedAt: null,
        },
      });

      const metadata = {
        projectId: "project/one",
        name: "Local project",
        description: null,
        createdAt: "2026-09-04T00:00:00.000Z",
        updatedAt: "2026-09-04T00:01:00.000Z",
        deletedAt: null,
      };
      const putResponse = await app.request(
        "/loro/project%2Fone/metadata",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, metadata }),
        },
        env,
      );
      expect(putResponse.status).toBe(204);
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe("project cloud admission", () => {
    it("creates a personal tenant admission without requiring the DO", async () => {
      const admissionRow = {
        project_id: "project-1",
        tenant_id: "personal:user-1",
        user_id: "user-1",
        local_replica_id: "replica-1",
        sync_base_url: "https://api.example.com",
        status: "pending",
        capabilities_json: JSON.stringify({
          canvas: true,
          projectMetadata: true,
          resources: true,
        }),
        admitted_at: null,
        updated_at: 1_700_000_000,
        last_error: null,
      };
      const projectDb = {
        prepare: vi.fn((sql: string) => {
          const statement = {
            bind: vi.fn(() => statement),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
            all: vi.fn().mockResolvedValue({ results: [] }),
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes("FROM project_cloud_admission")) {
                return admissionRow;
              }
              return null;
            }),
          };
          return statement;
        }),
        batch: vi.fn().mockResolvedValue([]),
      } as any;
      env = makeEnv({ DB: projectDb });

      const res = await app.request("/api/v1/projects/project-1/cloud-admission", {
        method: "POST",
        headers: { ...USER_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          projectId: "project-1",
          localReplicaId: "replica-1",
          metadata: {
            projectId: "project-1",
            name: "Demo",
            description: null,
            createdAt: "2026-09-04T00:00:00.000Z",
            updatedAt: "2026-09-04T00:00:00.000Z",
            deletedAt: null,
          },
          resourceIds: [],
        }),
      }, env);

      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.admission.tenantId).toBe("personal:user-1");
      expect(json.admission.status).toBe("pending");
      expect(projectDb.batch).toHaveBeenCalledTimes(1);
    });
  });

  describe("Retired project messaging", () => {
    it("keeps the deleted message endpoint unavailable", async () => {
      const prepare = vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () =>
            sql.includes("SELECT 1 FROM project") ? { ok: 1 } : null,
          ),
          all: vi.fn(async () => ({ results: [] })),
          run: vi.fn(async () => ({})),
        })),
      }));
      env = makeEnv({ DB: { prepare } as any });

      const res = await app.request(
        "/api/v1/projects/project-1/room/messages",
        { headers: USER_HEADERS },
        env,
      );

      expect(res.status).toBe(404);
    });
  });

  // ─── Assets ───

  describe("GET /assets/*", () => {
    it("returns asset from R2", async () => {
      const body = new Uint8Array([1, 2, 3]);
      (env.R2_BUCKET.get as any).mockResolvedValue({
        body: new Response(body).body,
        httpMetadata: { contentType: "image/png" },
        size: body.byteLength,
      });

      const res = await app.request(
        await signedAssetPath("projects/p1/img.png"),
        {},
        env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });

    it("returns 404 for missing asset", async () => {
      (env.R2_BUCKET.get as any).mockResolvedValue(null);

      const res = await app.request(
        await signedAssetPath("missing-key"),
        {},
        env,
      );
      expect(res.status).toBe(404);
    });

    it.each([
      {
        method: "GET",
        path: "/assets/sign?key=projects%2Fp1%2Fimg.png",
        body: undefined,
      },
      {
        method: "POST",
        path: "/assets/sign-batch",
        body: JSON.stringify({ keys: ["projects/p1/img.png"] }),
      },
    ])(
      "does not mint a delivery capability from a caller-supplied key at $method $path",
      async ({ method, path, body }) => {
        const res = await app.request(
          path,
          {
            method,
            ...(body
              ? { headers: { "content-type": "application/json" }, body }
              : {}),
          },
          env,
        );

        expect(res.status).toBe(404);
      },
    );

    it("serves range requests from R2 even when the full object is cached", async () => {
      const storageKey = "projects/p1/video.mp4";
      const cached = new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "video/mp4" },
      });
      (caches.default.match as any).mockResolvedValue(cached);
      (env.R2_BUCKET.head as any) = vi.fn().mockResolvedValue({ size: 100 });
      (env.R2_BUCKET.get as any).mockResolvedValue({
        body: new Response(new Uint8Array([10, 11, 12, 13, 14, 15])).body,
        httpMetadata: { contentType: "video/mp4" },
      });

      const res = await app.request(
        await signedAssetPath(storageKey),
        {
          headers: { Range: "bytes=10-15" },
        },
        env,
      );

      expect(res.status).toBe(206);
      expect(res.headers.get("Content-Range")).toBe("bytes 10-15/100");
      expect(caches.default.match).not.toHaveBeenCalled();
      expect(env.R2_BUCKET.get).toHaveBeenCalledWith(storageKey, {
        range: { offset: 10, length: 6 },
      });
    });
  });

  describe("retired anonymous R2 upload", () => {
    it("does not expose anonymous raw R2 upload", async () => {
      const formData = new FormData();
      formData.append(
        "file",
        new File([new Uint8Array([1, 2, 3])], "test.png", {
          type: "image/png",
        }),
      );

      const res = await app.request(
        new Request("http://localhost/upload", {
          method: "POST",
          body: formData,
        }),
        {},
        env,
      );

      expect(res.status).toBe(404);
    });
  });

  // ─── Legacy raw-key thumbnail route ───

  describe("GET /thumbnails/*", () => {
    it("does not expose a thumbnail by an unauthenticated R2 object key", async () => {
      const body = new Uint8Array([10, 20, 30]);
      (env.R2_BUCKET.get as any).mockResolvedValue({
        body: new Response(body).body,
        httpMetadata: { contentType: "image/jpeg" },
      });

      const res = await app.request(
        "/thumbnails/projects/p1/video.mp4",
        {},
        env,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("retired hosted edit executor", () => {
    it.each(["/api/v1/edits", "/api/v1/edits/video-crop"])(
      "does not expose the legacy random R2/D1 execution path at %s",
      async (path) => {
        const res = await app.request(
          path,
          { method: "POST", headers: USER_HEADERS },
          env,
        );
        expect(res.status).toBe(404);
        expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
      },
    );
  });

  // ─── POST /api/generate-ids ───

  describe("POST /api/generate-ids", () => {
    it("returns generated IDs", async () => {
      const res = await app.request(
        "/api/generate-ids",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({ project_id: "proj-1", count: 3 }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.ids).toHaveLength(3);
      expect(json.project_id).toBe("proj-1");
    });
  });

  // ─── POST /api/tasks/submit ───

  describe("POST /api/tasks/submit", () => {
    it("submits image_gen task → 200 { task_id }", async () => {
      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "image_gen",
            project_id: "proj-1",
            node_id: "node-1",
            params: { prompt: "a cat", model: "nano-banana-pro" },
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.task_id).toBeDefined();
      expect(json.status).toBe("pending");
    });

    it("submits video_gen without image → 400", async () => {
      (env.R2_BUCKET.get as any).mockResolvedValue(null);

      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "video_gen",
            project_id: "proj-1",
            node_id: "node-1",
            params: { prompt: "a sunset" },
          }),
        },
        env,
      );

      expect(res.status).toBe(400);
    });

    it("submits video_thumbnail → 200 completed (no-op)", async () => {
      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "video_thumbnail",
            project_id: "proj-1",
            node_id: "node-1",
            params: {},
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.status).toBe("completed");
    });

    it("submits audio_gen to the generation workflow", async () => {
      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "audio_gen",
            project_id: "proj-1",
            node_id: "node-1",
            params: {
              prompt: "read this aloud",
              model: "gemini-3.1-flash-tts",
              model_params: { voice_name: "Kore" },
            },
          }),
        },
        env,
      );

      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json).toEqual({
        task_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        status: "pending",
      });
      expect(vi.mocked(startGeneration).mock.calls.map(([, id, params]) => ({ id, params }))).toContainEqual({
        id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        params: expect.objectContaining({
          taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          nodeId: "node-1",
          type: "audio_gen",
          projectId: "proj-1",
          prompt: "read this aloud",
          modelName: "gemini-3.1-flash-tts",
          modelParams: { voice_name: "Kore" },
        }),
      });
    });

    it("submits video_render → 501 client-side", async () => {
      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "video_render",
            project_id: "proj-1",
            node_id: "node-1",
            params: {},
          }),
        },
        env,
      );

      expect(res.status).toBe(501);
    });
  });

  // ─── GET /api/tasks/:taskId ───

  describe("GET /api/tasks/:taskId", () => {
    it("returns task status from D1", async () => {
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "asset-1",
            userId: "user-1",
            kind: "image",
            srcR2Key: "projects/proj-1/assets/img.png",
            coverR2Key: null,
            width: null,
            height: null,
            durationMs: null,
            bytes: null,
            sourceModel: null,
            sourcePrompt: null,
            sourceTaskId: "task-123",
            createdAt: 1234567890,
            updatedAt: 1234567890,
          }),
        }),
      });

      const res = await app.request("/api/tasks/task-123", {}, env);
      expect(res.status).toBe(200);

      const json: any = await res.json();
      expect(json.task_id).toBe("task-123");
      expect(json.status).toBe("completed");
      expect(json.asset_id).toBe("asset-1");
      expect(json.result_url).toBe("projects/proj-1/assets/img.png");
    });

    it("returns 404 for missing task", async () => {
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      const res = await app.request("/api/tasks/missing", {}, env);
      expect(res.status).toBe(404);
    });

    it("propagates cover_r2_key into response when present", async () => {
      (env.DB.prepare as any).mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({
            id: "asset-vid",
            userId: "u-1",
            kind: "video",
            srcR2Key: "projects/p1/assets/v.mp4",
            coverR2Key: "projects/p1/assets/v-cover.jpg",
            width: null,
            height: null,
            durationMs: null,
            bytes: null,
            sourceModel: null,
            sourcePrompt: null,
            sourceTaskId: "t-vid",
            createdAt: 1,
            updatedAt: 1,
          }),
        }),
      });

      const res = await app.request("/api/tasks/t-vid", {}, env);
      expect(res.status).toBe(200);
      const json: any = await res.json();
      expect(json.asset_id).toBe("asset-vid");
      expect(json.result_url).toBe("projects/p1/assets/v.mp4");
      expect(json.result_data.cover_url).toBe("projects/p1/assets/v-cover.jpg");
    });
  });

  // ─── submitToWorkflow failure path ───

  describe("POST /api/tasks/submit error handling", () => {
    it("returns 500 when workflow.create throws (does NOT write to D1)", async () => {
      vi.mocked(startGeneration).mockRejectedValueOnce(
        new Error("Workflow service unavailable"),
      );
      const dbRun = vi.fn().mockResolvedValue({});
      env = makeEnv({
        GENERATION_WORKFLOW: env.GENERATION_WORKFLOW,
        DB: {
          prepare: vi.fn().mockReturnValue({
            bind: vi.fn().mockReturnValue({
              run: dbRun,
              first: vi.fn().mockResolvedValue(null),
              all: vi.fn().mockResolvedValue({ results: [] }),
            }),
          }),
        } as any,
      });

      const res = await app.request(
        "/api/tasks/submit",
        {
          method: "POST",
          headers: { ...USER_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({
            task_type: "image_gen",
            project_id: "proj-1",
            node_id: "node-1",
            params: { prompt: "x" },
          }),
        },
        env,
      );

      expect(res.status).toBe(500);
      // Asset creation only happens inside the workflow; submit-failure must not write D1.
      expect(dbRun).not.toHaveBeenCalled();
    });
  });

  // ─── POST /api/custom-action/upload ───

  describe("POST /api/custom-action/upload", () => {
    it("tombstones the retired ClashAgent upload protocol", async () => {
      const form = new FormData();
      form.append(
        "file",
        new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" }),
      );

      const res = await app.request(
        "/api/custom-action/upload",
        { method: "POST", body: form },
        env,
      );
      expect(res.status).toBe(410);
      await expect(res.json()).resolves.toMatchObject({
        code: "LEGACY_CUSTOM_ACTION_PROTOCOL_RETIRED",
      });
      expect(env.R2_BUCKET.put).not.toHaveBeenCalled();
      expect(env.DB.prepare).not.toHaveBeenCalled();
    });
  });

  // ─── POST /api/describe ───
  // Note: /api/describe uses c.executionCtx.waitUntil() which requires a real
  // Cloudflare execution context. Hono's app.request() doesn't provide this.
  // This endpoint is tested indirectly via the describe service mock.
  // We can test it by providing executionCtx in the env bindings.

  describe("POST /api/describe", () => {
    it("explicitly retires the nonfunctional description endpoint", async () => {
      // Hono's app.request(path, init, env, executionCtx) takes executionCtx as 4th arg
      const executionCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      };
      const req = new Request("http://localhost/api/describe", {
        method: "POST",
        headers: { ...USER_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://example.com/img.png",
          task_id: "task-desc",
        }),
      });

      const res = await app.request(req, undefined, env, executionCtx as any);

      expect(res.status).toBe(410);
      expect(startGeneration).not.toHaveBeenCalled();
    });
  });
});
