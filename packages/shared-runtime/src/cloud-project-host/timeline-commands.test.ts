import { createHmac, randomUUID } from "node:crypto";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Canvas,
  DEFAULT_CANVAS_ID,
  listTimelineExportProgress,
  projectTimelineRenderActionRunId,
  type ProjectHostCommand,
} from "@clash/shared-types";
import manifest from "../../../../plugins/remotion/manifest.json";
import timeline from "../../../../plugins/remotion/generators/timeline.json";
import { createCloudPluginCatalog } from "./plugin-catalog.js";
import {
  executeTimelineHostCommand,
  parseTimelineHostCommand,
  timelineReceiptMessage,
  type TimelineHostCommandPorts,
} from "./timeline-commands.js";

const definitions = createCloudPluginCatalog(
  [{ manifest, generators: { "generators/timeline.json": timeline } }],
  { executableGeneratorIds: ["clash.timeline"] },
).generatorDefinitions();

const signer =
  (secret: string) =>
  (version: string): string =>
    createHmac("sha256", secret)
      .update(timelineReceiptMessage("user", "project", version))
      .digest("base64url");

const ports: TimelineHostCommandPorts = {
  definitions,
  sign: signer("secret"),
  newId: () => randomUUID(),
};

describe("executeTimelineHostCommand", () => {
  let doc: LoroDoc;
  beforeEach(() => {
    doc = new LoroDoc();
  });
  afterEach(() => doc.free());
  const run = (command: ProjectHostCommand, with_ = ports) =>
    executeTimelineHostCommand(doc, command, with_);
  const body = (result: { body: unknown }) =>
    result.body as Record<string, any>;

  it("creates, lists, updates, attaches, detaches and deletes with signed observations", () => {
    expect(run({ action: "list_timelines" })).toMatchObject({
      status: 200,
      mutated: false,
      body: { timelines: [], versions: {} },
    });
    const created = run({
      action: "create_timeline",
      timelineId: "tl",
      name: "Cut",
      state: { tracks: [] },
    });
    expect(created).toMatchObject({ status: 200, mutated: true });
    expect(body(created).timeline).toMatchObject({ id: "tl", name: "Cut" });
    const listed = body(run({ action: "list_timelines" }));
    expect(listed.timelines).toEqual([body(created).timeline]);
    expect(listed.versions.tl).toBe(body(created).readToken);

    const updated = run({
      action: "update_timeline_state",
      timelineId: "tl",
      state: { tracks: [], fps: 24 },
      ifMatch: listed.versions.tl,
    });
    expect(updated).toMatchObject({ status: 200, mutated: true });
    expect(body(updated).timeline.revisionId).not.toBe(
      body(created).timeline.revisionId,
    );

    const attached = run({
      action: "attach_timeline",
      timelineId: "tl",
      canvasId: DEFAULT_CANVAS_ID,
      actionNodeId: "timeline-action",
      ifMatch: body(updated).readToken,
    });
    expect(attached.status).toBe(200);
    expect(body(attached).timeline.owner).toEqual({
      kind: "canvas-action",
      canvasId: DEFAULT_CANVAS_ID,
      actionNodeId: "timeline-action",
    });
    const detached = run({
      action: "detach_timeline",
      timelineId: "tl",
      ifMatch: body(attached).readToken,
    });
    expect(detached.status).toBe(200);
    expect(body(detached).timeline.owner).toEqual({ kind: "project" });

    expect(
      run({
        action: "delete_timeline",
        timelineId: "tl",
        ifMatch: body(detached).readToken,
      }),
    ).toEqual({
      status: 200,
      mutated: true,
      body: { deleted: true, timelineId: "tl" },
    });
    expect(body(run({ action: "list_timelines" })).timelines).toEqual([]);
  });

  it("rejects missing, stale and foreign observations without mutating", () => {
    const created = body(
      run({ action: "create_timeline", timelineId: "tl", name: "Cut" }),
    );
    const write = (ifMatch?: string, with_ = ports) =>
      run(
        {
          action: "update_timeline_state",
          timelineId: "tl",
          state: { tracks: [] },
          ...(ifMatch ? { ifMatch } : {}),
        },
        with_,
      );
    expect(write()).toMatchObject({ status: 409, mutated: false });
    // A version without this Host's receipt, or with another Host's, is not a read.
    expect(write(created.version)).toMatchObject({ status: 409, mutated: false });
    expect(
      write(created.readToken, { ...ports, sign: signer("other-secret") }),
    ).toMatchObject({ status: 409, mutated: false });
    expect(write(created.readToken).status).toBe(200);
    expect(write(created.readToken)).toMatchObject({
      status: 409,
      mutated: false,
    });
  });

  it("answers 404 for a missing Timeline and 501 for commands it does not serve", () => {
    const missing = run({
      action: "update_timeline_state",
      timelineId: "missing",
      state: { tracks: [] },
      ifMatch: "anything",
    });
    expect(missing.status).toBe(404);
    expect(body(missing).code).toMatch(/_NOT_FOUND$/);
    for (const command of [
      { action: "request_timeline_render", timelineId: "tl" },
      { action: "list_timeline_renders" },
      { action: "list_canvases" },
    ] as ProjectHostCommand[])
      expect(run(command)).toEqual({
        status: 501,
        mutated: false,
        body: {
          code: "COMMAND_UNAVAILABLE",
          error: "This project command is not connected on this server.",
        },
      });
  });

  it("queues the pending render node for an adapter that executes renders", () => {
    const withRender = { ...ports, timelineRender: { actorUserId: "user" } };
    const created = body(
      run({
        action: "create_timeline",
        timelineId: "tl",
        name: "Cut",
        state: {
          tracks: [
            {
              id: "titles",
              items: [
                { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
              ],
            },
          ],
        },
      }),
    );
    const render = (ifMatch: string) =>
      run(
        { action: "request_timeline_render", timelineId: "tl", ifMatch },
        withRender,
      );
    expect(render(created.version)).toMatchObject({ status: 409, mutated: false });
    expect(listTimelineExportProgress(doc, "tl")).toEqual([]);

    const requested = render(created.readToken);
    expect(requested).toMatchObject({ status: 200, mutated: true });
    const { renderNodeId, actionRunId, submitted } = body(requested);
    expect(submitted).toBe(true);
    expect(actionRunId).toBe(projectTimelineRenderActionRunId(renderNodeId));
    expect(listTimelineExportProgress(doc, "tl")).toEqual([
      {
        renderNodeId,
        timelineId: "tl",
        timelineRevisionId: created.timeline.revisionId,
        status: "queued",
      },
    ]);
    expect(doc.getMap("nodes").get(renderNodeId)).toMatchObject({
      type: "video",
      data: { actorType: "user", actorUserId: "user", timelineDsl: { durationInFrames: 30 } },
    });

    const attached = body(
      run({
        action: "attach_timeline",
        timelineId: "tl",
        canvasId: DEFAULT_CANVAS_ID,
        actionNodeId: "timeline-action",
        ifMatch: created.readToken,
      }),
    );
    const onCanvas = body(render(attached.readToken));
    expect(
      new Canvas(doc, () => {}, DEFAULT_CANVAS_ID).readNode(onCanvas.renderNodeId),
    ).toMatchObject({
      type: "video",
      upstream: [{ nodeId: "timeline-action" }],
      data: {
        status: "pending",
        sourceTimelineActionId: "node:timeline-action",
        renderTarget: {
          kind: "canvas",
          canvasId: DEFAULT_CANVAS_ID,
          actionNodeId: "timeline-action",
        },
      },
    });
  });

  it("answers a retried render under the same idempotency key with the original render", () => {
    const withRender = (actorUserId = "user") => ({
      ...ports,
      timelineRender: { actorUserId },
    });
    const create = (timelineId: string) =>
      body(
        run({
          action: "create_timeline",
          timelineId,
          name: "Cut",
          state: {
            tracks: [
              {
                id: "titles",
                items: [
                  { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
                ],
              },
            ],
          },
        }),
      );
    const created = create("tl");
    const render = (
      extra: Partial<Extract<ProjectHostCommand, { action: "request_timeline_render" }>>,
      with_ = withRender(),
    ) =>
      run(
        {
          action: "request_timeline_render",
          timelineId: "tl",
          ifMatch: created.readToken,
          ...extra,
        } as ProjectHostCommand,
        with_,
      );

    const first = render({ idempotencyKey: "intent-1" });
    expect(first).toMatchObject({ status: 200, mutated: true });
    const retried = render({ idempotencyKey: "intent-1" });
    expect(retried).toEqual({ status: 200, mutated: false, body: body(first) });
    expect(listTimelineExportProgress(doc, "tl")).toHaveLength(1);

    // Another intent, and the same key from another actor, are new renders.
    const second = render({ idempotencyKey: "intent-2" });
    const otherActor = render({ idempotencyKey: "intent-1" }, withRender("other"));
    const renderNodeIds = [first, second, otherActor].map(
      (result) => body(result).renderNodeId,
    );
    expect(new Set(renderNodeIds).size).toBe(renderNodeIds.length);
    expect(render({}).mutated).toBe(true);

    // The same key for another request is refused without writing.
    const nodeCount = doc.getMap("nodes").size;
    const other = create("tl-2");
    for (const reused of [
      render({ idempotencyKey: "intent-1", actorAgentId: "agent" }),
      run(
        {
          action: "request_timeline_render",
          timelineId: "tl-2",
          ifMatch: other.readToken,
          idempotencyKey: "intent-1",
        },
        withRender(),
      ),
    ])
      expect(reused).toMatchObject({
        status: 409,
        mutated: false,
        body: { code: "IDEMPOTENCY_KEY_CONFLICT" },
      });
    expect(doc.getMap("nodes").size).toBe(nodeCount);
  });

  it("replays a keyed render of a Canvas-placed Timeline onto the same linked node", () => {
    const withRender = { ...ports, timelineRender: { actorUserId: "user" } };
    const created = body(
      run({
        action: "create_timeline",
        timelineId: "tl",
        name: "Cut",
        state: {
          tracks: [
            {
              id: "titles",
              items: [
                { id: "title", type: "text", text: "Hi", from: 0, durationInFrames: 30 },
              ],
            },
          ],
        },
        placement: { canvasId: DEFAULT_CANVAS_ID, actionNodeId: "timeline-action" },
      }),
    );
    const render = () =>
      run(
        {
          action: "request_timeline_render",
          timelineId: "tl",
          ifMatch: created.readToken,
          idempotencyKey: "intent",
        },
        withRender,
      );
    const first = body(render());
    expect(body(render()).renderNodeId).toBe(first.renderNodeId);
    const canvas = new Canvas(doc, () => {}, DEFAULT_CANVAS_ID);
    expect(canvas.readNode(first.renderNodeId)).toMatchObject({
      upstream: [{ nodeId: "timeline-action" }],
      data: { status: "pending" },
    });
    expect(
      canvas.listNodes("video").map((node) => node.id),
    ).toEqual([first.renderNodeId]);
  });

  it("fails closed when the Timeline projection surface is not installed", () => {
    expect(
      run({ action: "list_timelines" }, { ...ports, definitions: [] }),
    ).toMatchObject({
      status: 503,
      mutated: false,
      body: { code: "GENERATOR_PROJECTION_SURFACE_NOT_INSTALLED" },
    });
    expect(
      run(
        { action: "list_timelines" },
        { ...ports, definitions: [...definitions, ...definitions] },
      ),
    ).toMatchObject({
      status: 409,
      body: { code: "GENERATOR_PROJECTION_SURFACE_AMBIGUOUS" },
    });
  });

  it("rejects malformed command bodies before execution", () => {
    expect(parseTimelineHostCommand({ action: "nope" })).toEqual({
      ok: false,
      result: {
        status: 400,
        mutated: false,
        body: { code: "INVALID_COMMAND", error: "Invalid project command" },
      },
    });
    expect(parseTimelineHostCommand({ action: "list_timelines" })).toEqual({
      ok: true,
      command: { action: "list_timelines" },
    });
  });
});
