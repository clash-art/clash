/**
 * The shared Project Host contract against the real api-cf app in workerd
 * (D1, R2 and ProjectRoom from cloudflare:test), authenticated with a D1 API
 * token like every other public client.
 *
 * Today api-cf serves only the plugin catalog. Timeline host-command and the
 * Project Asset routes are declared, as the editor requires, and listed as
 * known gaps: they must keep failing until the remote adapter implements them.
 */
import { env } from "cloudflare:test";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generatorDefinitionFromExecutablePluginRegistration,
  type ExecutablePluginGeneratorRegistration,
} from "@clash/shared-types";
import {
  CONTRACT_SAMPLE_VIDEO_FILE,
  describeProjectHostContract,
} from "@clash/shared-runtime/project-host-contract";
import { executeTimelineHostCommand } from "@clash/shared-runtime/cloud-project-host/timeline-commands";
import { createLocalTimelineGenerator } from "@clash/shared-runtime/timeline-generator-product";
import { createApp } from "../app";
import { contentHash } from "../services/project-content";
import { cloudPluginCatalog } from "../services/cloud-plugin-catalog";

beforeEach(() => {
  // A clsh_ token resolves identity from D1; nothing may leave the Worker.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    throw new Error(`Unexpected external request: ${String(request)}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describeProjectHostContract("api-cf (Cloudflare Workers)", async () => {
  const projectId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    token = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(projectId, "Contract", userId, userId, Date.now(), Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      userId,
      "contract",
      await contentHash(token),
      token.slice(0, 10),
      Date.now(),
    )
    .run();
  const app = createApp();
  const sample = env.CONTRACT_SAMPLE_VIDEO_BASE64;
  if (!sample) throw new Error("CONTRACT_SAMPLE_VIDEO_BASE64 binding is missing");
  return {
    endpoint: "https://clash.test",
    projectId,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${token}`);
      return app.request(
        String(input instanceof Request ? input.url : input),
        { ...init, headers },
        env,
      );
    },
    capabilities: {
      "catalog.generators": "supported",
      "catalog.views": "supported",
      "catalog.actions": "supported",
      "timeline.list": "supported",
      "timeline.create": "supported",
      "timeline.update": "supported",
      "timeline.attach": "supported",
      "timeline.detach": "supported",
      "timeline.delete": "supported",
      // No cloud render executor; host-command must answer 501 for it.
      "timeline.render": "unavailable",
      "assets.list": "supported",
      "assets.batch": "supported",
      "assets.get": "supported",
      "assets.references": "supported",
      "assets.import": "supported",
      "assets.trash": "unavailable",
      "assets.restore": "unavailable",
      "assets.media": "supported",
    },
    knownGaps: [
      "timeline.list",
      "timeline.create",
      "timeline.update",
      "timeline.attach",
      "timeline.detach",
      "timeline.delete",
      "timeline.render",
      "assets.list",
      "assets.batch",
      "assets.get",
      "assets.references",
      "assets.import",
      "assets.trash",
      "assets.restore",
      "assets.media",
    ],
    sampleVideo: {
      bytes: Uint8Array.from(atob(sample), (char) => char.charCodeAt(0)),
      fileName: CONTRACT_SAMPLE_VIDEO_FILE,
      contentType: "video/mp4",
    },
    close: async () => {
      await env.DB.prepare("DELETE FROM api_token WHERE user_id = ?")
        .bind(userId)
        .run();
      await env.DB.prepare("DELETE FROM project WHERE id = ?")
        .bind(projectId)
        .run();
    },
  };
});

/**
 * Deployed workerd rejects code generation from strings; the vitest pool
 * enables unsafe-eval for its module runner, so emulate the restriction where
 * Ajv would compile (`new Function`).
 */
function withoutCodeGeneration<T>(run: () => T): T {
  const original = globalThis.Function;
  const forbidden = function () {
    throw new EvalError("Code generation from strings disallowed for this context");
  } as unknown as FunctionConstructor;
  Object.defineProperty(forbidden, "prototype", { value: original.prototype });
  globalThis.Function = forbidden;
  try {
    return run();
  } finally {
    globalThis.Function = original;
  }
}

describe("cloud plugin catalog without code generation", () => {
  it("validates Timeline state with the precompiled validators", () => {
    const definitions = cloudPluginCatalog().generatorDefinitions();
    const doc = new LoroDoc();
    try {
      const ports = {
        definitions,
        sign: (version: string) => version.replace(/[^A-Za-z0-9._~-]/g, "_"),
        newId: () => crypto.randomUUID(),
      };
      withoutCodeGeneration(() => {
        const created = executeTimelineHostCommand(
          doc,
          { action: "create_timeline", timelineId: "tl", name: "Cut" },
          ports,
        );
        expect(created).toMatchObject({ status: 200, mutated: true });
        const updated = executeTimelineHostCommand(
          doc,
          {
            action: "update_timeline_state",
            timelineId: "tl",
            state: { tracks: [], fps: 24 },
            ifMatch: (created.body as { readToken: string }).readToken,
          },
          ports,
        );
        expect(updated).toMatchObject({ status: 200, mutated: true });
      });
    } finally {
      doc.free();
    }
  });

  it("would fail on a schema without a precompiled validator", () => {
    const [installed] = cloudPluginCatalog().generatorDefinitions();
    const { pluginId, version, schemaHash, ...spec } = installed!;
    const definition = generatorDefinitionFromExecutablePluginRegistration({
      pluginId,
      version,
      schemaHash,
      document: {
        apiVersion: "clash.generator/v1",
        kind: "generator",
        spec: { ...spec, stateSchema: { ...spec.stateSchema, title: "Unregistered" } },
      } as ExecutablePluginGeneratorRegistration["document"],
    });
    const doc = new LoroDoc();
    try {
      const outcome = withoutCodeGeneration(() => {
        try {
          return createLocalTimelineGenerator(doc, definition, {
            id: "tl",
            name: "Cut",
            owner: { kind: "project" },
            revisionId: "genesis",
            state: { tracks: [] },
          });
        } catch (error) {
          return { ok: false, error: { message: String(error) } };
        }
      });
      expect(outcome).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("Code generation from strings disallowed") },
      });
    } finally {
      doc.free();
    }
  });
});
