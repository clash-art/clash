import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createActionClient } from "./action-client.js";

const shipped = JSON.parse(
  readFileSync(
    new URL(
      "../../../plugins/asset-edit/generators/image-editor.json",
      import.meta.url,
    ),
    "utf8",
  ),
).spec;
const definition = {
  ...shipped,
  pluginId: "clash.asset-edit",
  version: "1.0.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
};

function fixture(
  options: {
    running?: boolean;
    custom?: boolean;
    uncertain?: boolean;
    readFailure?: boolean;
  } = {},
) {
  const writes: Array<{ path: string; body: any }> = [];
  const reads: string[] = [];
  const selected = options.custom
    ? {
        ...definition,
        pluginId: "project.photos",
        definitionId: "school-photo",
      }
    : definition;
  let run: any;
  let running = options.running;
  let readFailure = options.readFailure;
  const request = async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push({ path, body });
      if (path.endsWith("/generators"))
        return Response.json({
          generator: { id: body.generatorId },
          revision: { id: body.generatorRevisionId },
        });
      if (path.includes("/actions/transform/runs")) {
        run = {
          ...body,
          actionId: "transform",
          generatorRevision: {
            generatorId: writes[0]!.body.generatorId,
            generatorRevisionId: body.generatorRevisionId,
          },
          outputContract: selected.actions[0].outputs,
          status: running ? "running" : "succeeded",
        };
        if (options.uncertain)
          throw new Error("Connection closed after submission");
        return Response.json({ run });
      }
    }
    reads.push(path);
    if (path.startsWith("/api/v1/generator-definitions"))
      return Response.json({ definitions: [selected] });
    if (path.includes("/outputs/"))
      return Response.json({
        commit: {
          actionRunId: run.actionRunId,
          outputSlot: "output",
          asset: { kind: "media", projectAssetId: "cropped" },
        },
      });
    if (path.includes("/generator-runs/") && readFailure) {
      readFailure = false;
      throw new Error("Connection closed while reading accepted Run");
    }
    if (path.includes("/generator-runs/"))
      return Response.json({
        run: { ...run, status: running ? "running" : "succeeded" },
      });
    if (path.endsWith("/assets/cropped"))
      return Response.json({
        asset: {
          id: "cropped",
          metadata: { width: 80, height: 100 },
          url: "http://local.test/cropped.png",
        },
      });
    throw new Error(`Unexpected request ${path}`);
  };
  return {
    client: () => createActionClient(request),
    writes,
    reads,
    finish: () => {
      running = false;
    },
  };
}

describe("task-oriented native Actions", () => {
  it("turns one crop invocation into frozen inputs, a visible Run and usable output", async () => {
    const h = fixture();
    const params = {
      crop: { x: 12, y: 25, width: 80, height: 100 },
      rotation: 90,
    };
    const result = await h.client().invoke("project/a", {
      action: "image-editor.transform",
      assetId: "original",
      parameters: params,
      requestId: "edit-1",
      waitMs: 0,
    });
    expect(h.writes[0]!.body).toMatchObject({
      pluginId: "clash.asset-edit",
      definitionId: "image-editor",
      state: {},
    });
    expect(h.writes[1]!.body).toMatchObject({
      parameters: params,
      invocationInputRefs: [
        {
          slot: "source",
          target: { kind: "media", projectAssetId: "original" },
        },
      ],
      canvasPlacement: { canvasId: "main" },
    });
    expect(result).toMatchObject({
      status: "succeeded",
      outputs: [
        {
          reference: { kind: "media", projectAssetId: "cropped" },
          value: { asset: { metadata: { width: 80, height: 100 } } },
        },
      ],
    });
    expect(result.actionRunId).toBe(h.writes[1]!.body.actionRunId);
    expect(h.reads).toContain(
      "/api/v1/generator-definitions?projectId=project%2Fa",
    );
  });

  it("returns a resumable Run on timeout and waiting never resubmits the work", async () => {
    const h = fixture({ running: true });
    const client = h.client();
    const pending = await client.invoke("p", {
      action: "image-editor.transform",
      assetId: "original",
      parameters: { rotation: 90 },
      waitMs: 0,
    });
    expect(pending.status).toBe("running");
    expect(pending.outputs).toEqual([]);
    const writes = h.writes.length;
    h.finish();
    const finished = await client.wait("p", pending.actionRunId, { waitMs: 0 });
    expect(finished.status).toBe("succeeded");
    expect(finished.actionRunId).toBe(pending.actionRunId);
    expect(h.writes.length).toBe(writes);
  });

  it("discovers and invokes installed project custom Actions without built-in identifiers", async () => {
    const h = fixture({ custom: true });
    const actions = await h.client().list("p", { query: "school" });
    expect(actions.actions[0]).toMatchObject({
      key: "project.photos/school-photo/transform",
      parametersSchema: definition.actions[0].parametersSchema,
    });
    await h.client().invoke("p", {
      action: actions.actions[0].key,
      assetId: "original",
      parameters: { rotation: 180 },
      waitMs: 0,
    });
    expect(h.writes[0]!.body.pluginId).toBe("project.photos");
  });

  it("rejects unknown actions before creating empty project objects", async () => {
    const h = fixture();
    await expect(
      h.client().invoke("p", { action: "missing.action", assetId: "original" }),
    ).rejects.toThrow(/not found/i);
    expect(h.writes).toEqual([]);
  });

  it("rejects invalid crop parameters and wait options before creating a draft", async () => {
    const h = fixture();
    await expect(
      h.client().invoke("p", {
        action: "image-editor.transform",
        assetId: "original",
        parameters: { rotation: 45 },
        waitMs: 0,
      }),
    ).rejects.toThrow(/parameters/i);
    await expect(
      h.client().invoke("p", {
        action: "image-editor.transform",
        assetId: "original",
        parameters: { rotation: 90 },
        waitMs: -1,
      }),
    ).rejects.toThrow(/waitMs/i);
    expect(h.writes).toEqual([]);
  });

  it("keeps recovery identity in the error message when submission response is lost", async () => {
    const h = fixture({ uncertain: true });
    let caught: unknown;
    try {
      await h.client().invoke("p", {
        action: "image-editor.transform",
        assetId: "original",
        parameters: { rotation: 90 },
        waitMs: 0,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & { actionRunId: string };
    expect(error.actionRunId).toBeTruthy();
    expect(error.message).toContain(error.actionRunId);
    const result = await h.client().wait("p", error.actionRunId, { waitMs: 0 });
    expect(result.status).toBe("succeeded");
  });

  it("preserves an automatically assigned Run identity if the first wait loses its response", async () => {
    const h = fixture({ readFailure: true });
    let caught: unknown;
    try {
      await h.client().invoke("p", {
        action: "image-editor.transform",
        assetId: "original",
        parameters: { rotation: 90 },
        waitMs: 0,
      });
    } catch (error) {
      caught = error;
    }
    const error = caught as Error & { actionRunId: string };
    expect(error.actionRunId).toBe(h.writes[1]!.body.actionRunId);
    expect(error.message).toContain(error.actionRunId);
    const beforeRecovery = h.writes.slice();
    const result = await h.client().wait("p", error.actionRunId, { waitMs: 0 });
    expect(result.status).toBe("succeeded");
    expect(h.writes).toEqual(beforeRecovery);
  });
});
