import { describe, expect, it } from "vitest";
import * as sharedTypes from "./index.js";

const AGENT_OPERATION_KEYS = [
  "timeline.open",
  "timeline.schema",
  "timeline.validate",
  "timeline.list",
  "timeline.get",
  "timeline.create",
  "timeline.save",
  "timeline.attach",
  "timeline.detach",
  "timeline.copy",
  "timeline.render",
  "timeline.pull",
  "timeline.apply",
] as const;

const EDITOR_COMMAND_KEYS = [
  "timeline.command.add_clip",
  "timeline.command.trim_clip",
  "timeline.command.split_clip",
] as const;

const EDITOR_ACTION_KEYS = [
  "timeline.action.ADD_TRACK",
  "timeline.action.INSERT_TRACK",
  "timeline.action.REMOVE_TRACK",
  "timeline.action.SET_PRIMARY_TRACK",
  "timeline.action.UPDATE_TRACK",
  "timeline.action.REORDER_TRACKS",
  "timeline.action.ADD_ITEM",
  "timeline.action.MOVE_ITEM",
  "timeline.action.REMOVE_ITEM",
  "timeline.action.UPDATE_ITEM",
  "timeline.action.SPLIT_ITEM",
  "timeline.action.RIPPLE_DELETE_RANGE",
  "timeline.action.RESTORE_TIMELINE_SNAPSHOT",
  "timeline.action.SELECT_ITEM",
  "timeline.action.SELECT_TRACK",
  "timeline.action.SET_CURRENT_FRAME",
  "timeline.action.SET_PLAYING",
  "timeline.action.SET_ZOOM",
  "timeline.action.ADD_ASSET",
  "timeline.action.UPSERT_ASSET",
  "timeline.action.SET_ASSET_TRANSCRIPT",
  "timeline.action.REMOVE_ASSET",
  "timeline.action.SET_COMPOSITION_SIZE",
  "timeline.action.SET_DURATION",
  "timeline.action.UNDO",
  "timeline.action.REDO",
  "timeline.action.BEGIN_HISTORY_GROUP",
  "timeline.action.END_HISTORY_GROUP",
] as const;

type RegistryShape = {
  agent: Record<string, any>;
  editorCommands: Record<string, any>;
  editorActions: Record<string, any>;
};

const registry = (
  sharedTypes as unknown as { TIMELINE_OPERATION_REGISTRY?: RegistryShape }
).TIMELINE_OPERATION_REGISTRY ?? {
  agent: {},
  editorCommands: {},
  editorActions: {},
};

describe("Timeline operation annotations", () => {
  it("registers every public agent operation, editor command, and editor action", () => {
    expect(Object.keys(registry.agent)).toEqual(AGENT_OPERATION_KEYS);
    expect(Object.keys(registry.editorCommands)).toEqual(EDITOR_COMMAND_KEYS);
    expect(Object.keys(registry.editorActions)).toEqual(expect.arrayContaining([...EDITOR_ACTION_KEYS]));
  });

  it("carries executable schemas and concurrency metadata on every operation", () => {
    const annotations = [
      ...Object.values(registry.agent),
      ...Object.values(registry.editorCommands),
      ...Object.values(registry.editorActions),
    ];

    for (const annotation of annotations) {
      expect(annotation.id).toEqual(expect.any(String));
      expect(annotation.description.trim().length).toBeGreaterThan(0);
      expect(annotation.inputSchema.safeParse).toEqual(expect.any(Function));
      expect(annotation.outputSchema.safeParse).toEqual(expect.any(Function));
      expect(["read", "write"]).toContain(annotation.access);
      expect(annotation.readOnly).toBe(annotation.access === "read");
      expect(["none", "host-enforced"]).toContain(annotation.cas);
      expect(["none", "records-observation", "requires-observation"]).toContain(
        annotation.readProof,
      );
      expect(annotation.preconditions).toEqual(expect.any(Array));
      expect(annotation.preconditions.length).toBeGreaterThan(0);
      expect(annotation.runtimeConsumers).toEqual(expect.any(Array));
      expect(annotation.runtimeConsumers.length).toBeGreaterThan(0);
      expect(annotation.public).toBe(true);
      expect(typeof annotation.agentCallable).toBe("boolean");
    }
  });

  it("keeps Timeline render receipts storage-free", () => {
    const output = registry.agent["timeline.render"].outputSchema;
    const base = {
      submitted: true,
      completed: true,
      timelineId: "timeline-1",
      sourceTimelineRevisionId: "revision-1",
      renderNodeId: "render-1",
      target: { kind: "project-assets" },
      status: "completed",
      asset: { id: "project-asset-1" },
    };

    expect(output.safeParse(base).success).toBe(true);
    expect(
      output.safeParse({
        ...base,
        asset: {
          id: "project-asset-1",
          srcR2Key: "projects/project-1/assets/render.mp4",
        },
      }).success,
    ).toBe(false);
    expect(
      output.safeParse({
        ...base,
        asset: {
          id: "project-asset-1",
          signedUrl: "https://media.example/render.mp4?signature=secret",
        },
      }).success,
    ).toBe(false);
  });

  it("binds every public agent operation to its real CLI or MCP surface", () => {
    for (const operation of Object.values(registry.agent)) {
      expect(operation.surfaceBindings).toEqual(expect.any(Array));
      expect(operation.surfaceBindings.length).toBeGreaterThan(0);
    }
    expect(registry.agent["timeline.open"].surfaceBindings).toEqual([
      "mcp:clash_timeline_open",
    ]);
    expect(registry.agent["timeline.get"].surfaceBindings).toEqual([
      "mcp:clash_timeline_get",
    ]);
    expect(registry.agent["timeline.save"].surfaceBindings).toEqual([
      "mcp:clash_timeline_save",
    ]);
    expect(registry.agent["timeline.render"].surfaceBindings).toEqual([
      "cli:timeline render",
      "mcp:clash_timeline_render",
    ]);
    expect(registry.agent["timeline.pull"].surfaceBindings).toEqual([
      "cli:timeline pull",
    ]);
  });

  it("declares the Project Timeline read-proof and CAS workflow", () => {
    for (const id of ["timeline.schema", "timeline.validate"] as const) {
      expect(registry.agent[id]).toMatchObject({
        access: "read",
        readOnly: true,
        cas: "none",
        readProof: "none",
      });
    }

    for (const id of [
      "timeline.list",
      "timeline.get",
      "timeline.pull",
    ] as const) {
      expect(registry.agent[id]).toMatchObject({
        access: "read",
        readOnly: true,
        cas: "none",
        readProof: "records-observation",
      });
    }

    expect(registry.agent["timeline.create"]).toMatchObject({
      access: "write",
      readOnly: false,
      cas: "host-enforced",
      readProof: "none",
    });

    expect(registry.agent["timeline.render"]).toMatchObject({
      access: "write",
      readOnly: false,
      cas: "none",
      readProof: "records-observation",
    });

    for (const id of [
      "timeline.attach",
      "timeline.detach",
      "timeline.copy",
      "timeline.save",
      "timeline.apply",
    ] as const) {
      expect(registry.agent[id]).toMatchObject({
        access: "write",
        readOnly: false,
        cas: "host-enforced",
        readProof: "requires-observation",
      });
    }
  });

  it("directs writes through automatic validation and reserves standalone validation for diagnosis", () => {
    expect(registry.agent["timeline.validate"].description).toMatch(
      /diagnos.*only when no write is intended/i,
    );
    expect(registry.agent["timeline.validate"].description).toMatch(
      /do not use (?:it )?as a preflight for create, save, or apply/i,
    );
    expect(registry.agent["timeline.create"].description).toMatch(
      /automatically validate.*invalid state leaves Project state unchanged/i,
    );
    expect(registry.agent["timeline.save"].description).toMatch(
      /automatically validate.*invalid state leaves the Timeline revision unchanged/i,
    );
    expect(registry.agent["timeline.apply"].description).toMatch(
      /automatically validate.*invalid input leaves the Timeline revision unchanged/i,
    );
  });

  it("allows a Timeline render to use the full default Run budget", () => {
    const schema = registry.agent["timeline.render"].inputSchema;

    expect(
      schema.safeParse({
        timelineId: "long-render",
        timeoutMs: 1_800_000,
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        timelineId: "long-render",
        timeoutMs: 0,
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        timelineId: "long-render",
        timeoutMs: 1_000.5,
      }).success,
    ).toBe(false);
  });

  it("links every document-bearing operation to the canonical field contract", () => {
    expect(registry.agent["timeline.validate"].inputContractRefs).toEqual({
      document: "TIMELINE_DSL_DEFINITION.jsonSchema",
    });
    expect(registry.agent["timeline.create"].inputContractRefs).toEqual({
      state: "TIMELINE_DSL_DEFINITION.jsonSchema",
    });
    expect(registry.agent["timeline.apply"].inputContractRefs).toEqual({
      document: "TIMELINE_DSL_DEFINITION.jsonSchema",
    });
  });

  it("validates representative agent and editor payloads at runtime", () => {
    expect(
      registry.agent["timeline.schema"].inputSchema.safeParse({}).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.schema"].inputSchema.safeParse({
        view: "authoring",
      }).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.schema"].inputSchema.safeParse({
        view: "full",
      }).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.schema"].inputSchema.safeParse({
        view: "verbose",
      }).success,
    ).toBe(false);
    expect(
      registry.agent["timeline.schema"].inputSchema.safeParse({ extra: true })
        .success,
    ).toBe(false);

    expect(
      registry.agent["timeline.create"].inputSchema.safeParse({
        id: "episode-1",
        name: "Episode 1",
        state: { tracks: [] },
      }).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.create"].inputSchema.safeParse({
        id: "",
        name: "Episode 1",
        state: { tracks: [] },
      }).success,
    ).toBe(false);

    expect(
      registry.agent["timeline.attach"].inputSchema.safeParse({
        timelineId: "episode-1",
        canvasId: "main",
        actionNodeId: "edit-episode-1",
        position: { x: 10, y: 20 },
      }).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.attach"].inputSchema.safeParse({
        timelineId: "episode-1",
        canvasId: "main",
        position: { x: Number.NaN, y: 20 },
      }).success,
    ).toBe(false);
    expect(
      registry.agent["timeline.attach"].inputSchema.safeParse({
        timelineId: "episode-1",
        canvasId: "main",
        expectedReadToken: "caller-visible-proof-is-not-part-of-the-contract",
      }).success,
    ).toBe(false);

    expect(
      registry.agent["timeline.apply"].inputSchema.safeParse({
        timelineId: "episode-1",
        document: { tracks: [] },
      }).success,
    ).toBe(true);
    expect(
      registry.agent["timeline.apply"].inputSchema.safeParse({
        timelineId: "episode-1",
      }).success,
    ).toBe(false);

    expect(
      registry.editorCommands[
        "timeline.command.add_clip"
      ].inputSchema.safeParse({
        type: "add_clip",
        trackId: "main",
        sourceNodeId: "source-1",
        itemType: "video",
        from: 0,
        durationInFrames: 90,
      }).success,
    ).toBe(true);
    expect(
      registry.editorCommands[
        "timeline.command.add_clip"
      ].inputSchema.safeParse({
        type: "add_clip",
        trackId: "main",
        sourceNodeId: "source-1",
        itemType: "video",
        from: 0,
        durationInFrames: 0,
      }).success,
    ).toBe(false);

    expect(
      registry.editorActions[
        "timeline.action.SET_COMPOSITION_SIZE"
      ].inputSchema.safeParse({
        type: "SET_COMPOSITION_SIZE",
        payload: { width: 1920, height: 1080 },
      }).success,
    ).toBe(true);
    expect(
      registry.editorActions[
        "timeline.action.SET_COMPOSITION_SIZE"
      ].inputSchema.safeParse({
        type: "SET_COMPOSITION_SIZE",
        payload: { width: 0, height: 1080 },
      }).success,
    ).toBe(false);
  });

  it("derives editor item and track payload fields from the annotated DSL", () => {
    const addItem =
      registry.editorActions["timeline.action.ADD_ITEM"].inputSchema;
    expect(
      addItem.safeParse({
        type: "ADD_ITEM",
        payload: {
          trackId: "visual",
          item: {
            id: "poster",
            type: "image",
            src: "/poster.png",
            from: 0,
            durationInFrames: 30,
            mediaFit: "cover",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      addItem.safeParse({
        type: "ADD_ITEM",
        payload: {
          trackId: "visual",
          item: {
            id: "poster",
            type: "image",
            src: "/poster.png",
            from: 0,
            durationInFrames: 30,
            audioDucking: { amountDb: -12, attackFrames: 2, releaseFrames: 4 },
          },
        },
      }).success,
    ).toBe(false);

    const updateItem =
      registry.editorActions["timeline.action.UPDATE_ITEM"].inputSchema;
    expect(
      updateItem.safeParse({
        type: "UPDATE_ITEM",
        payload: {
          trackId: "visual",
          itemId: "title",
          updates: { fontWeight: 600 },
        },
      }).success,
    ).toBe(true);
    expect(
      updateItem.safeParse({
        type: "UPDATE_ITEM",
        payload: {
          trackId: "visual",
          itemId: "title",
          updates: { fontWeight: {} },
        },
      }).success,
    ).toBe(false);
    expect(
      updateItem.safeParse({
        type: "UPDATE_ITEM",
        payload: {
          trackId: "visual",
          itemId: "title",
          updates: { inventedField: true },
        },
      }).success,
    ).toBe(false);

    const updateTrack =
      registry.editorActions["timeline.action.UPDATE_TRACK"].inputSchema;
    expect(
      updateTrack.safeParse({
        type: "UPDATE_TRACK",
        payload: {
          id: "visual",
          updates: { hidden: false, category: "visual" },
        },
      }).success,
    ).toBe(true);
    expect(
      updateTrack.safeParse({
        type: "UPDATE_TRACK",
        payload: { id: "visual", updates: { category: "invented" } },
      }).success,
    ).toBe(false);
    expect(
      updateTrack.safeParse({
        type: "UPDATE_TRACK",
        payload: { id: "visual", updates: { inventedField: true } },
      }).success,
    ).toBe(false);
  });

  it("publishes a serializable catalog without copying executable schemas", () => {
    const catalog = (
      sharedTypes as unknown as { TIMELINE_OPERATION_CATALOG?: RegistryShape }
    ).TIMELINE_OPERATION_CATALOG ?? {
      agent: {},
      editorCommands: {},
      editorActions: {},
    };

    expect(Object.keys(catalog.agent)).toEqual(AGENT_OPERATION_KEYS);
    expect(Object.keys(catalog.editorCommands)).toEqual(EDITOR_COMMAND_KEYS);
    expect(Object.keys(catalog.editorActions)).toEqual(expect.arrayContaining([...EDITOR_ACTION_KEYS]));
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);

    for (const annotation of Object.values(catalog).flatMap(Object.values)) {
      expect(annotation).not.toHaveProperty("inputSchema");
      expect(annotation).not.toHaveProperty("outputSchema");
      expect(annotation.inputJsonSchema).toEqual(expect.any(Object));
      expect(annotation.outputJsonSchema).toEqual(expect.any(Object));
    }
  });
});
