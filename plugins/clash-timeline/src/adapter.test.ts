import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type {
  ProjectHostClient,
  ProjectHostRequest,
  ProjectHostResponse,
} from "@clash/shared-runtime/project-host-client";
import { timelineDslHash } from "@clash/shared-types";
import { PROJECT_ASSET_RENDER_CANVAS_ID } from "@clash/shared-types/timeline-contract";
import * as timelineContract from "@clash/shared-types/timeline-contract";

function hostClient(
  calls: ProjectHostRequest[],
  respond: (request: ProjectHostRequest) => ProjectHostResponse,
): ProjectHostClient {
  return {
    resolveContext: async ({ projectId, cwd } = {}) => ({
      projectId: projectId ?? "project-marker",
      source: projectId ? "explicit" : "marker",
      ...(cwd ? { workspaceRoot: cwd } : {}),
    }),
    async request<T extends ProjectHostResponse>(
      request: ProjectHostRequest<T>,
    ) {
      calls.push(request);
      return {
        projectId: request.projectId ?? "project-marker",
        value: respond(request) as T,
      };
    },
  };
}

const timeline = {
  id: "rough-cut",
  name: "Rough Cut",
  revisionId: "revision-1",
  owner: { kind: "project" },
  state: { tracks: [] },
};

for (const operation of ["create", "attach", "detach", "copy"] as const) test(`Timeline ${operation} exposes the persisted entity from the Host receipt`, async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const { TIMELINE_MCP_EXECUTORS } = await import("./timeline-mcp-executors.js");
  const calls: ProjectHostRequest[] = [];
  const adapter = createTimelineAdapter({
    // create_timeline's shipped Host response is an envelope; MCP declares the entity.
    client: hostClient(calls, ({command}) => command.action === "list_timelines"
      ? {timelines: [timeline], versions: {[timeline.id]: "host-read-receipt"}}
      : {timeline, readToken: "host-create-receipt"}),
  });
  await adapter.get({timelineId: timeline.id});
  const executor = TIMELINE_MCP_EXECUTORS[`timeline.${operation}`];
  const result = await executor.execute({id: timeline.id, name: timeline.name, timelineId: timeline.id, sourceTimelineId: timeline.id, canvasId: "main", targetCanvasId: "main"}, adapter);
  assert.deepEqual(result, timeline);
  assert.equal(executor.outputSchema.safeParse(result).success, true);
});

test("Timeline schema adapter exposes the same compact default and legacy full view as shared-types", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const adapter = createTimelineAdapter();
  const authoring = await adapter.schema({});

  assert.equal(authoring.view, "authoring");
  assert.equal(authoring.operationCatalog, undefined);
  assert.equal(authoring.jsonSchema, undefined);
  assert.equal(
    (authoring.examples as any).basic.state.tracks[1].items[1].sourceNodeId,
    "canvas-component-node-id",
  );
  assert.deepEqual(
    await adapter.schema({ view: "full" } as any),
    timelineContract.TIMELINE_DSL_DEFINITION,
  );
});

test("Timeline list records the host receipt and save sends it as MCP CAS", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) =>
      request.command.action === "list_timelines"
        ? {
            timelines: [timeline],
            versions: { "rough-cut": "timeline-host-receipt" },
          }
        : {
            timeline: { ...timeline, revisionId: "revision-2" },
            readToken: "timeline-next-receipt",
          },
    ),
    writeProjection: async (path, content) => {
      writes.push({ path, content });
    },
  });

  assert.deepEqual(
    await adapter.get({ cwd: "/workspace", timelineId: "rough-cut" }),
    timeline,
  );
  const state = { tracks: [], fps: 30, durationInFrames: 90 };
  const saved = await adapter.save({
    cwd: "/workspace",
    timelineId: "rough-cut",
    baseRevisionId: "revision-1",
    state,
  });
  assert.doesNotMatch(
    JSON.stringify(saved),
    /readToken|receipt|ifMatch|observedVersion/i,
  );

  assert.equal(
    writes[0]?.path,
    join("/workspace", "timelines", "rough-cut.timeline.yaml"),
  );
  assert.deepEqual(
    calls.map(({ command }) => command),
    [
      { action: "list_timelines" },
      {
        action: "update_timeline_state",
        timelineId: "rough-cut",
        state,
        actorClientType: "mcp",
        observedVersion: "timeline-host-receipt",
        ifMatch: "timeline-host-receipt",
      },
    ],
  );
});

test("Timeline save returns the declared public operation receipt", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const state = {
    tracks: [
      {
        id: "visual",
        items: [
          {
            id: "hero-motion",
            type: "composition",
            from: 0,
            durationInFrames: 90,
            compositionKind: "custom",
            runtime: "remotion",
            compositionId: "hero",
            sourcePath: "components/hero-node.tsx",
            sourceNodeId: "hero-node",
          },
        ],
      },
    ],
    fps: 30,
    durationInFrames: 90,
  };
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) =>
      request.command.action === "list_timelines"
        ? {
            timelines: [timeline],
            versions: { "rough-cut": "timeline-host-receipt" },
          }
        : {
            timeline: {
              ...timeline,
              revisionId: "revision-2",
              state,
            },
            readToken: "timeline-next-receipt",
          },
    ),
    writeProjection: async () => {},
  });

  await adapter.get({
    cwd: "/workspace",
    projectId: "project-1",
    timelineId: "rough-cut",
  });
  const saved = await adapter.save({
    cwd: "/workspace",
    projectId: "project-1",
    timelineId: "rough-cut",
    baseRevisionId: "revision-1",
    state,
  });

  assert.deepEqual(saved, {
    applied: true,
    projectId: "project-1",
    timelineId: "rough-cut",
    revisionId: "revision-2",
    owner: { kind: "project" },
    filePath: join("/workspace", "timelines", "rough-cut.timeline.yaml"),
    sources: ["hero-node"],
    timelineHash: await timelineDslHash(
      state as Parameters<typeof timelineDslHash>[0],
    ),
  });
  assert.equal(
    timelineContract.TIMELINE_OPERATION_REGISTRY.agent[
      "timeline.save"
    ].outputSchema.safeParse(saved).success,
    true,
  );
});

test("Timeline mutation without a prior host read fails before writing", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  let writes = 0;
  const adapter = createTimelineAdapter({
    client: hostClient(calls, () => ({ timeline })),
    writeProjection: async () => {
      writes += 1;
    },
  });

  await assert.rejects(
    adapter.save({
      cwd: "/workspace",
      timelineId: "rough-cut",
      baseRevisionId: "revision-1",
      state: { tracks: [] },
    }),
    /READ_REQUIRED.*clash_timeline_get/i,
  );
  assert.equal(writes, 0);
  assert.deepEqual(calls, []);
});

test("Timeline validation uses the typed host command rather than a CLI process", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const adapter = createTimelineAdapter({
    client: hostClient(calls, () => ({
      ok: true,
      contractFingerprint: "fnv1a32:test",
    })),
  });

  assert.deepEqual(
    await adapter.validate({
      projectId: "project-1",
      state: { tracks: [] },
    }),
    { ok: true, contractFingerprint: "fnv1a32:test" },
  );
  assert.deepEqual(
    calls.map(({ command }) => command),
    [{ action: "validate_timeline", document: { tracks: [] } }],
  );
});

test("Timeline render submits directly after an observed read", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) =>
      request.command.action === "list_timelines"
        ? {
            timelines: [timeline],
            versions: { "rough-cut": "timeline-host-receipt" },
          }
        : {
            submitted: true,
            timelineId: "rough-cut",
            sourceTimelineRevisionId: "revision-1",
            renderNodeId: "render-1",
            target: { kind: "project-assets" },
          },
    ),
  });

  await adapter.get({ projectId: "project-1", timelineId: "rough-cut" });
  assert.deepEqual(
    await adapter.render({
      projectId: "project-1",
      timelineId: "rough-cut",
      wait: false,
    }),
    {
      submitted: true,
      completed: false,
      timelineId: "rough-cut",
      sourceTimelineRevisionId: "revision-1",
      renderNodeId: "render-1",
      target: { kind: "project-assets" },
      status: "pending",
    },
  );
  assert.deepEqual(calls.at(-1)?.command, {
    action: "request_timeline_render",
    timelineId: "rough-cut",
    actorClientType: "mcp",
    observedVersion: "timeline-host-receipt",
    ifMatch: "timeline-host-receipt",
  });
});

test("Timeline render polls the Host standalone-render readback", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) => {
      if (request.command.action === "list_timelines") {
        return {
          timelines: [timeline],
          versions: { "rough-cut": "timeline-host-receipt" },
        };
      }
      if (request.command.action === "request_timeline_render") {
        return {
          submitted: true,
          timelineId: "rough-cut",
          sourceTimelineRevisionId: "revision-1",
          renderNodeId: "render-1",
          target: { kind: "project-assets" },
        };
      }
      if (request.command.action === "list_timeline_renders") {
        return {
          canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
          status: "all",
          renders: [
            {
              node: {
                id: "render-1",
                canvas_id: PROJECT_ASSET_RENDER_CANVAS_ID,
                type: "video",
                data: { status: "completed", assetId: "asset-render-1" },
              },
            },
          ],
        };
      }
      if (request.command.action === "get") {
        return { error: `Canvas ${PROJECT_ASSET_RENDER_CANVAS_ID} not found` };
      }
      return {
        error: `Unexpected action ${String(request.command.action)}`,
      };
    }),
  });

  await adapter.get({ projectId: "project-1", timelineId: "rough-cut" });
  assert.deepEqual(
    await adapter.render({
      projectId: "project-1",
      timelineId: "rough-cut",
      wait: true,
    }),
    {
      submitted: true,
      completed: true,
      timelineId: "rough-cut",
      sourceTimelineRevisionId: "revision-1",
      renderNodeId: "render-1",
      target: { kind: "project-assets" },
      status: "completed",
      asset: { id: "asset-render-1" },
    },
  );
  assert.deepEqual(calls.at(-1)?.command, {
    action: "list_timeline_renders",
    status: "all",
  });
});

test("Timeline render polls a Canvas target through native render readback", async () => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) => {
      if (request.command.action === "list_timelines") {
        return {
          timelines: [timeline],
          versions: { "rough-cut": "timeline-host-receipt" },
        };
      }
      if (request.command.action === "request_timeline_render") {
        return {
          submitted: true,
          timelineId: "rough-cut",
          sourceTimelineRevisionId: "revision-1",
          renderNodeId: "render-1",
          target: {
            kind: "canvas",
            canvasId: "main",
            actionNodeId: "timeline-action",
          },
        };
      }
      if (request.command.action === "list_timeline_renders") {
        return {
          status: "all",
          renders: [
            {
              node: {
                id: "render-1",
                data: { status: "completed", assetId: "asset-render-1" },
              },
            },
          ],
        };
      }
      return {
        error: `Unexpected action ${String(request.command.action)}`,
      };
    }),
  });

  await adapter.get({ projectId: "project-1", timelineId: "rough-cut" });
  assert.deepEqual(
    await adapter.render({
      projectId: "project-1",
      timelineId: "rough-cut",
      wait: true,
    }),
    {
      submitted: true,
      completed: true,
      timelineId: "rough-cut",
      sourceTimelineRevisionId: "revision-1",
      renderNodeId: "render-1",
      target: {
        kind: "canvas",
        canvasId: "main",
        actionNodeId: "timeline-action",
      },
      status: "completed",
      asset: { id: "asset-render-1" },
    },
  );
  assert.deepEqual(calls.at(-1)?.command, {
    action: "list_timeline_renders",
    status: "all",
  });
});

test("Timeline render waits for the 30-minute default budget", async (t) => {
  const { createTimelineAdapter } = await import("./adapter.js");
  const calls: ProjectHostRequest[] = [];
  let now = 0;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
    now += 700_000;
    callback();
    return 0 as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
  const adapter = createTimelineAdapter({
    client: hostClient(calls, (request) => {
      if (request.command.action === "list_timelines") {
        return {
          timelines: [timeline],
          versions: { "rough-cut": "timeline-host-receipt" },
        };
      }
      if (request.command.action === "request_timeline_render") {
        return {
          submitted: true,
          timelineId: "rough-cut",
          sourceTimelineRevisionId: "revision-1",
          renderNodeId: "render-1",
          target: { kind: "project-assets" },
        };
      }
      if (request.command.action === "list_timeline_renders") {
        return {
          canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
          status: "all",
          renders: [
            {
              node: {
                id: "render-1",
                canvas_id: PROJECT_ASSET_RENDER_CANVAS_ID,
                type: "video",
                data: { status: "generating" },
              },
            },
          ],
        };
      }
      return { error: `Unexpected action ${String(request.command.action)}` };
    }),
  });

  await adapter.get({ projectId: "project-1", timelineId: "rough-cut" });
  const result = await adapter.render({
    projectId: "project-1",
    timelineId: "rough-cut",
    wait: true,
  });

  assert.equal(result.status, "pending");
  assert.equal(
    calls.filter(({ command }) => command.action === "list_timeline_renders")
      .length,
    4,
  );
});
