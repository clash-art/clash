import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Canvas } from "./canvas-ops.js";
import * as workspace from "./project-workspace.js";
import {
  listActionAssetReferences,
  markActionAssetBindingAuthority,
} from "./action-asset-bindings.js";
import { createProjectAsset } from "./project-assets.js";

describe("Project workspace model", () => {
  it.each([false, true])("publishes a complete Timeline attachment before remote reconciliation (explicit canvas=%s)", (explicit) => {
    const doc = new LoroDoc();
    if (explicit) workspace.ensureProjectCanvas(doc);
    workspace.createProjectTimeline(doc, { id: "new-timeline", name: "Editor", state: { tracks: [] } });
    doc.commit();
    const remote = new LoroDoc();
    remote.import(doc.export({ mode: "snapshot" }));
    const removed: string[] = [];
    const unsubscribe = doc.subscribeLocalUpdates((update) => {
      remote.import(update);
      const result = workspace.reconcileProjectTimelineOwnership(remote);
      removed.push(...result.removedActionNodeIds, ...result.detachedTimelineIds);
      remote.commit();
    });
    expect(workspace.attachTimelineToCanvas(doc, { timelineId: "new-timeline", canvasId: "main", actionNodeId: "new-editor" }).ok).toBe(true);
    doc.commit();
    unsubscribe();
    expect(removed).toEqual([]);
    expect(new Canvas(remote, () => {}, "main").readNode("new-editor")).not.toBeNull();
  });

  it("keeps Project Timeline persistence storage-free while retaining media identity", () => {
    const doc = new LoroDoc();

    const created = (workspace as any).createProjectTimeline(doc, {
      id: "timeline-storage-free",
      name: "Storage-free Timeline",
      state: {
        tracks: [
          {
            id: "visuals",
            items: [
              {
                id: "shot-1",
                type: "video",
                assetId: "asset-video",
                sourceNodeId: "canvas-video",
                src: "https://host-a.invalid/signed/video.mp4?token=secret",
                waveform: [0.1, 0.8, 0.2],
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
        ],
      },
    });

    expect(created).toMatchObject({ ok: true });
    expect((created.timeline.state as any).tracks[0].items[0]).toEqual({
      id: "shot-1",
      type: "video",
      assetId: "asset-video",
      sourceNodeId: "canvas-video",
      from: 0,
      durationInFrames: 30,
    });
    expect(
      (
        (workspace as any).readProjectTimeline(doc, "timeline-storage-free")
          .state as any
      ).tracks[0].items[0],
    ).not.toHaveProperty("src");
    expect(
      (
        (workspace as any).readProjectTimeline(doc, "timeline-storage-free")
          .state as any
      ).tracks[0].items[0],
    ).not.toHaveProperty("waveform");
  });

  it("does not accept backingAssetId as Timeline media identity", () => {
    const doc = new LoroDoc();

    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-legacy-identity",
        name: "Legacy identity",
        state: {
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "shot-1",
                  type: "video",
                  backingAssetId: "asset-video",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "Timeline item shot-1 contains the removed backingAssetId field; use assetId",
    });
  });

  it("rejects the removed Timeline media reference collection", () => {
    const doc = new LoroDoc();
    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-obsolete-refs",
        name: "Obsolete refs",
        state: { tracks: [], mediaAssetRefs: [{ assetId: "asset-video" }] },
      }),
    ).toEqual({
      ok: false,
      error:
        "Timeline state contains the removed mediaAssetRefs collection; use item assetId bindings",
    });
  });

  it("rejects a Project Timeline media source that has no Project Asset identity", () => {
    const doc = new LoroDoc();

    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-host-path",
        name: "Host path Timeline",
        state: {
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "shot-1",
                  type: "video",
                  src: "/Users/alice/private/shot.mp4",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "Timeline item shot-1 must reference a Project Asset before it can be persisted",
    });
    expect(
      (workspace as any).readProjectTimeline(doc, "timeline-host-path"),
    ).toBeNull();
  });

  it("rejects a media item with neither runtime bytes nor Project Asset identity", () => {
    const doc = new LoroDoc();
    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-empty-media",
        name: "Empty media",
        state: {
          tracks: [
            {
              id: "visuals",
              items: [
                {
                  id: "shot-1",
                  type: "image",
                  from: 0,
                  durationInFrames: 30,
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      ok: false,
      error:
        "Timeline item shot-1 must reference a Project Asset before it can be persisted",
    });
  });

  it("updates Timeline Action bindings in the same Project mutation", () => {
    const doc = new LoroDoc();
    createProjectAsset(doc, {
      id: "asset-video",
      kind: "video",
      source: { kind: "owned", resourceId: "resource-video" },
      lifecycle: { state: "active" },
      metadata: {},
    });
    markActionAssetBindingAuthority(doc);

    const stateWithClip = {
      tracks: [
        {
          id: "visuals",
          items: [
            {
              id: "shot-1",
              type: "video",
              assetId: "asset-video",
              from: 0,
              durationInFrames: 30,
            },
          ],
        },
      ],
    };
    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-bindings",
        name: "Bindings",
        state: stateWithClip,
      }),
    ).toMatchObject({ ok: true });
    const first = listActionAssetReferences(doc, "asset-video");
    expect(first).toMatchObject([
      {
        owner: { kind: "draft", actionId: "timeline:timeline-bindings" },
        direction: "input",
        slot: "timeline:item:shot-1",
        projectAssetId: "asset-video",
      },
    ]);

    expect(
      (workspace as any).updateProjectTimelineState(doc, "timeline-bindings", {
        tracks: [{ id: "visuals", items: [] }],
      }),
    ).toMatchObject({ ok: true });
    expect(listActionAssetReferences(doc, "asset-video")).toEqual([]);

    expect(
      (workspace as any).updateProjectTimelineState(
        doc,
        "timeline-bindings",
        stateWithClip,
      ),
    ).toMatchObject({ ok: true });
    const restored = listActionAssetReferences(doc, "asset-video");
    expect(restored).toHaveLength(1);
    expect(restored[0]!.id).not.toBe(first[0]!.id);

    (workspace as any).ensureProjectCanvas(doc, "main");
    expect(
      (workspace as any).attachTimelineToCanvas(doc, {
        timelineId: "timeline-bindings",
        canvasId: "main",
        actionNodeId: "timeline-action",
        position: { x: 0, y: 0 },
      }),
    ).toMatchObject({ ok: true });
    expect(listActionAssetReferences(doc, "asset-video")).toMatchObject([
      {
        owner: { kind: "draft", actionId: "node:timeline-action" },
        slot: "timeline:item:shot-1",
      },
    ]);
  });

  it("scopes nodes to concrete canvases in one Project Loro document", () => {
    const doc = new LoroDoc();
    const main = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectCanvas(doc, {
      id: "b-roll",
      name: "B Roll",
    });
    const broll = new Canvas(doc, () => {}, "b-roll");

    main.insertNode("main-script", "text", { content: "Main" }, null, {
      x: 0,
      y: 0,
    });
    broll.insertNode("broll-shot", "image", { assetId: "asset-1" }, null, {
      x: 0,
      y: 0,
    });

    expect(main.listNodes().map((node) => node.id)).toEqual(["main-script"]);
    expect(broll.listNodes().map((node) => node.id)).toEqual(["broll-shot"]);
    expect(doc.getMap("nodes").get("main-script")).toMatchObject({
      canvasId: "main",
    });
    expect(doc.getMap("nodes").get("broll-shot")).toMatchObject({
      canvasId: "b-roll",
    });
  });

  it("stores the Canvas registry in the Project Loro document", () => {
    const doc = new LoroDoc();

    (workspace as any).ensureProjectCanvas(doc, "main");
    (workspace as any).createProjectCanvas(doc, {
      id: "b-roll",
      name: "B Roll",
    });

    expect(doc.getMap("canvases").get("main")).toMatchObject({
      name: "Main",
    });
    expect(doc.getMap("canvases").get("b-roll")).toMatchObject({
      name: "B Roll",
    });
  });

  it("creates a generator-free plugin View node on the implicit Main Canvas", () => {
    const doc = new LoroDoc();

    const created = (workspace as any).createProjectPluginView(doc, {
      nodeId: "storyboard-draft",
      label: "Storyboard",
      view: {
        pluginId: "community.storyboard",
        definitionId: "storyboard",
        version: "1.0.0",
        schemaHash: `sha256:${"a".repeat(64)}`,
      },
      state: {
        keyElements: [],
        shots: [],
        audioLayers: [],
        uncategorized: [],
      },
    });

    expect(created).toMatchObject({ ok: true, nodeId: "storyboard-draft" });
    expect((workspace as any).listProjectCanvases(doc)).toEqual([
      expect.objectContaining({ id: "main", name: "Main" }),
    ]);
    expect(
      new Canvas(doc, () => {}, "main").readNode("storyboard-draft"),
    ).toMatchObject({
      type: "plugin-view",
      data: {
        label: "Storyboard",
        view: {
          pluginId: "community.storyboard",
          definitionId: "storyboard",
        },
      },
    });
    expect(new Canvas(doc, () => {}, "main")
      .readNode("storyboard-draft")?.data).not.toHaveProperty("generatorId");
  });

  it("does not register a Canvas merely because a scoped reader was constructed", () => {
    const doc = new LoroDoc();
    const missing = new Canvas(doc, () => {}, "typo");

    expect(missing.listNodes()).toEqual([]);
    expect(doc.getMap("canvases").get("typo")).toBeUndefined();
  });

  it("lists Project canvases in stable product order", () => {
    expect((workspace as any).listProjectCanvases).toBeTypeOf("function");

    const doc = new LoroDoc();
    doc
      .getMap("canvases")
      .set("ending", { id: "ending", name: "Ending", position: 2 });
    doc
      .getMap("canvases")
      .set("main", { id: "main", name: "Main", position: 0 });
    doc
      .getMap("canvases")
      .set("opening", { id: "opening", name: "Opening", position: 1 });

    expect(
      (workspace as any)
        .listProjectCanvases(doc)
        .map((canvas: any) => canvas.id),
    ).toEqual(["main", "opening", "ending"]);
  });

  it("stores graph references on downstream nodes and derives edges", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    canvas.insertNode("source", "text", { content: "Source" }, null, {
      x: 0,
      y: 0,
    });
    canvas.insertNode("target", "image_gen", { prompt: "Use source" }, null, {
      x: 200,
      y: 0,
    });

    canvas.insertEdge("source-target", "source", "target", "reference");

    expect(canvas.readNode("target")?.upstream).toEqual([
      { nodeId: "source", edgeId: "source-target", type: "reference" },
    ]);
    expect(doc.getMap("edges").size).toBe(0);
    expect(canvas.listEdges()).toEqual([
      {
        id: "source-target",
        source: "source",
        target: "target",
        type: "reference",
      },
    ]);
  });

  it("merges concurrent upstream additions to the same downstream node", () => {
    const base = new LoroDoc();
    const canvas = new Canvas(base, () => {}, "main");
    canvas.insertNode("source-a", "text", {}, null, { x: 0, y: 0 });
    canvas.insertNode("source-b", "text", {}, null, { x: 0, y: 100 });
    canvas.insertNode("target", "image_gen", {}, null, { x: 200, y: 0 });

    const snapshot = base.export({ mode: "snapshot" });
    const docA = LoroDoc.fromSnapshot(snapshot);
    const docB = LoroDoc.fromSnapshot(snapshot);
    const versionA = docA.version();
    const versionB = docB.version();
    new Canvas(docA, () => {}, "main").insertEdge(
      "a-target",
      "source-a",
      "target",
    );
    new Canvas(docB, () => {}, "main").insertEdge(
      "b-target",
      "source-b",
      "target",
    );

    const updateA = docA.export({ mode: "update", from: versionA });
    const updateB = docB.export({ mode: "update", from: versionB });
    docA.import(updateB);
    docB.import(updateA);

    for (const doc of [docA, docB]) {
      expect(new Canvas(doc, () => {}, "main").listEdges()).toEqual([
        {
          id: "a-target",
          source: "source-a",
          target: "target",
          type: "default",
        },
        {
          id: "b-target",
          source: "source-b",
          target: "target",
          type: "default",
        },
      ]);
    }
  });

  it("rejects upstream references across canvases", () => {
    const doc = new LoroDoc();
    const main = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectCanvas(doc, {
      id: "b-roll",
      name: "B Roll",
    });
    const broll = new Canvas(doc, () => {}, "b-roll");
    main.insertNode("main-source", "image", { assetId: "asset-1" }, null, {
      x: 0,
      y: 0,
    });
    broll.insertNode(
      "broll-action",
      "image_gen",
      { prompt: "Use source" },
      null,
      { x: 0, y: 0 },
    );

    expect(() => {
      broll.insertEdge("cross-canvas", "main-source", "broll-action");
    }).toThrow("Source node main-source not found in canvas b-roll");
    expect(broll.listEdges()).toEqual([]);
  });

  it("keeps node ids unique across every Canvas in the Project", () => {
    const doc = new LoroDoc();
    const main = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectCanvas(doc, {
      id: "b-roll",
      name: "B Roll",
    });
    const broll = new Canvas(doc, () => {}, "b-roll");
    expect(
      main.createNode("shared-id", "text", { content: "Main" }).error,
    ).toBeNull();

    expect(
      broll.createNode("shared-id", "text", { content: "B roll" }),
    ).toMatchObject({
      node_id: null,
      error: "Node shared-id already exists in canvas main",
    });
    expect(main.readNode("shared-id")?.data.content).toBe("Main");
  });

  it("creates and renames canvases through the shared registry contract", () => {
    expect((workspace as any).createProjectCanvas).toBeTypeOf("function");
    expect((workspace as any).renameProjectCanvas).toBeTypeOf("function");

    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");

    expect(
      (workspace as any).createProjectCanvas(doc, {
        id: "shots",
        name: "Shots",
      }),
    ).toMatchObject({
      ok: true,
      canvas: { id: "shots", name: "Shots", position: 1 },
    });
    expect(
      (workspace as any).renameProjectCanvas(doc, "shots", "Selects"),
    ).toMatchObject({
      ok: true,
      canvas: { id: "shots", name: "Selects" },
    });
    expect(
      (workspace as any)
        .listProjectCanvases(doc)
        .map((canvas: any) => canvas.name),
    ).toEqual(["Main", "Selects"]);
  });

  it("does not silently delete the last or a non-empty Canvas", () => {
    expect((workspace as any).deleteProjectCanvas).toBeTypeOf("function");

    const doc = new LoroDoc();
    const main = new Canvas(doc, () => {}, "main");
    (workspace as any).ensureProjectCanvas(doc, "main");
    expect((workspace as any).deleteProjectCanvas(doc, "main")).toEqual({
      ok: false,
      error: "Cannot delete the last Canvas",
    });

    (workspace as any).createProjectCanvas(doc, { id: "shots", name: "Shots" });
    main.insertNode("script", "text", { content: "Script" }, null, {
      x: 0,
      y: 0,
    });
    expect((workspace as any).deleteProjectCanvas(doc, "main")).toEqual({
      ok: false,
      error: "Canvas main is not empty",
    });
    expect((workspace as any).deleteProjectCanvas(doc, "shots")).toEqual({
      ok: true,
      canvasId: "shots",
    });
  });

  it("moves a standalone Timeline under one Canvas Action without changing its identity", () => {
    expect((workspace as any).createProjectTimeline).toBeTypeOf("function");
    expect((workspace as any).attachTimelineToCanvas).toBeTypeOf("function");
    expect((workspace as any).listStandaloneTimelines).toBeTypeOf("function");

    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    expect(
      (workspace as any).createProjectTimeline(doc, {
        id: "timeline-1",
        name: "Episode 1",
        state: { tracks: [] },
      }),
    ).toMatchObject({
      ok: true,
      timeline: { id: "timeline-1", owner: { kind: "project" } },
    });
    expect(
      (workspace as any)
        .listStandaloneTimelines(doc)
        .map((timeline: any) => timeline.id),
    ).toEqual(["timeline-1"]);

    expect(
      (workspace as any).attachTimelineToCanvas(doc, {
        timelineId: "timeline-1",
        canvasId: "main",
        actionNodeId: "timeline-action-1",
        position: { x: 120, y: 80 },
      }),
    ).toMatchObject({
      ok: true,
      timeline: {
        id: "timeline-1",
        owner: {
          kind: "canvas-action",
          canvasId: "main",
          actionNodeId: "timeline-action-1",
        },
      },
    });
    expect((workspace as any).listStandaloneTimelines(doc)).toEqual([]);
    expect(canvas.readNode("timeline-action-1")).toMatchObject({
      canvas_id: "main",
      type: "video-editor",
      data: { timelineId: "timeline-1", label: "Episode 1" },
    });
  });

  it("stores Timeline fields in a mergeable child map with one atomic revision value", () => {
    const doc = new LoroDoc();
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [{ id: "dialogue", items: [] }] },
    });

    const stored = doc.getMap("timelines").get("timeline-1") as any;
    expect(typeof stored?.get).toBe("function");
    expect(stored.get("name")).toBe("Episode 1");
    expect(stored.get("owner")).toEqual({ kind: "project" });
    expect(stored.get("revision")).toEqual({
      state: { tracks: [{ id: "dialogue", items: [] }] },
      revisionId: (workspace as any).projectTimelineRevisionId("timeline-1", {
        tracks: [{ id: "dialogue", items: [] }],
      }),
    });
    expect(stored.get("state")).toBeUndefined();
    expect(stored.get("revisionId")).toBeUndefined();
  });

  it("reads and promotes legacy plain-object Timeline records on mutation", () => {
    const doc = new LoroDoc();
    const legacyState = { tracks: [{ id: "legacy" }] };
    const legacyRevisionId = (workspace as any).projectTimelineRevisionId(
      "timeline-legacy",
      legacyState,
    );
    doc.getMap("timelines").set("timeline-legacy", {
      id: "timeline-legacy",
      name: "Legacy Cut",
      owner: { kind: "project" },
      revisionId: legacyRevisionId,
      state: legacyState,
    });

    expect((workspace as any).listProjectTimelines(doc)).toEqual([
      {
        id: "timeline-legacy",
        name: "Legacy Cut",
        owner: { kind: "project" },
        revisionId: legacyRevisionId,
        state: legacyState,
      },
    ]);

    const nextState = { tracks: [{ id: "promoted", items: [] }] };
    expect(
      (workspace as any).updateProjectTimelineState(
        doc,
        "timeline-legacy",
        nextState,
      ),
    ).toMatchObject({
      ok: true,
      timeline: {
        name: "Legacy Cut",
        owner: { kind: "project" },
        state: nextState,
      },
    });

    const stored = doc.getMap("timelines").get("timeline-legacy") as any;
    expect(typeof stored?.get).toBe("function");
    expect(stored.get("name")).toBe("Legacy Cut");
    expect(stored.get("owner")).toEqual({ kind: "project" });
    expect(stored.get("revision")).toEqual({
      state: nextState,
      revisionId: (workspace as any).projectTimelineRevisionId(
        "timeline-legacy",
        nextState,
      ),
    });
  });

  it("merges a concurrent Timeline attachment with a state revision update", () => {
    const base = new LoroDoc();
    (workspace as any).ensureProjectCanvas(base, "main");
    (workspace as any).createProjectTimeline(base, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    const snapshot = base.export({ mode: "snapshot" });
    const docA = LoroDoc.fromSnapshot(snapshot);
    const docB = LoroDoc.fromSnapshot(snapshot);
    const versionA = docA.version();
    const versionB = docB.version();

    (workspace as any).attachTimelineToCanvas(docA, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });
    const nextState = { tracks: [{ id: "dialogue", items: [] }] };
    (workspace as any).updateProjectTimelineState(
      docB,
      "timeline-1",
      nextState,
    );

    const updateA = docA.export({ mode: "update", from: versionA });
    const updateB = docB.export({ mode: "update", from: versionB });
    docA.import(updateB);
    docB.import(updateA);

    for (const doc of [docA, docB]) {
      expect((workspace as any).listProjectTimelines(doc)).toEqual([
        expect.objectContaining({
          id: "timeline-1",
          owner: {
            kind: "canvas-action",
            canvasId: "main",
            actionNodeId: "timeline-action-1",
          },
          state: nextState,
          revisionId: (workspace as any).projectTimelineRevisionId(
            "timeline-1",
            nextState,
          ),
        }),
      ]);
    }
  });

  it("merges concurrent Timeline name and owner changes", () => {
    const base = new LoroDoc();
    (workspace as any).ensureProjectCanvas(base, "main");
    (workspace as any).createProjectTimeline(base, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    const snapshot = base.export({ mode: "snapshot" });
    const docA = LoroDoc.fromSnapshot(snapshot);
    const docB = LoroDoc.fromSnapshot(snapshot);
    const versionA = docA.version();
    const versionB = docB.version();

    const timelineFields = docA.getMap("timelines").get("timeline-1") as any;
    expect(typeof timelineFields?.set).toBe("function");
    timelineFields.set("name", "Episode 1 Director Cut");
    (workspace as any).attachTimelineToCanvas(docB, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });

    const updateA = docA.export({ mode: "update", from: versionA });
    const updateB = docB.export({ mode: "update", from: versionB });
    docA.import(updateB);
    docB.import(updateA);

    for (const doc of [docA, docB]) {
      expect((workspace as any).listProjectTimelines(doc)).toEqual([
        expect.objectContaining({
          id: "timeline-1",
          name: "Episode 1 Director Cut",
          owner: {
            kind: "canvas-action",
            canvasId: "main",
            actionNodeId: "timeline-action-1",
          },
        }),
      ]);
    }
  });

  it("reconciles concurrent Timeline attachments to one owner and one Action node", () => {
    const base = new LoroDoc();
    (workspace as any).ensureProjectCanvas(base, "main");
    (workspace as any).createProjectCanvas(base, {
      id: "shots",
      name: "Shots",
    });
    (workspace as any).createProjectTimeline(base, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    const snapshot = base.export({ mode: "snapshot" });
    const docA = LoroDoc.fromSnapshot(snapshot);
    const docB = LoroDoc.fromSnapshot(snapshot);
    const versionA = docA.version();
    const versionB = docB.version();

    (workspace as any).attachTimelineToCanvas(docA, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-main",
      position: { x: 0, y: 0 },
    });
    (workspace as any).attachTimelineToCanvas(docB, {
      timelineId: "timeline-1",
      canvasId: "shots",
      actionNodeId: "timeline-shots",
      position: { x: 0, y: 0 },
    });
    const updateA = docA.export({ mode: "update", from: versionA });
    const updateB = docB.export({ mode: "update", from: versionB });
    docA.import(updateB);
    docB.import(updateA);

    for (const doc of [docA, docB]) {
      const reconciliation = (
        workspace as any
      ).reconcileProjectTimelineOwnership(doc);
      const timeline = (workspace as any).listProjectTimelines(doc)[0];
      const actionNodes = [...doc.getMap("nodes").entries()].filter(
        ([, raw]) => (raw as any)?.data?.timelineId === "timeline-1",
      );
      expect(reconciliation.removedActionNodeIds).toHaveLength(1);
      expect(actionNodes.map(([id]) => id)).toEqual([
        (timeline.owner as { actionNodeId: string }).actionNodeId,
      ]);
    }
  });

  it("preserves non-Action nodes that mention a Timeline during ownership reconciliation", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    canvas.insertNode(
      "timeline-note",
      "text",
      { timelineId: "timeline-1", content: "Editing notes" },
      null,
      { x: 0, y: 0 },
    );
    canvas.insertNode(
      "timeline-custom",
      "custom",
      { timelineId: "timeline-1", actionId: "review-timeline" },
      null,
      { x: 100, y: 0 },
    );

    expect((workspace as any).reconcileProjectTimelineOwnership(doc)).toEqual({
      removedActionNodeIds: [],
      detachedTimelineIds: [],
    });
    expect(canvas.readNode("timeline-note")).toMatchObject({
      type: "text",
      data: { timelineId: "timeline-1", content: "Editing notes" },
    });
    expect(canvas.readNode("timeline-custom")).toMatchObject({
      type: "custom",
      data: { timelineId: "timeline-1", actionId: "review-timeline" },
    });
  });

  it("detaches a corrupted non-Action owner without deleting that node", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "corrupted-owner",
      position: { x: 0, y: 0 },
    });
    doc.getMap("nodes").set("corrupted-owner", {
      canvasId: "main",
      type: "text",
      data: { timelineId: "timeline-1", content: "Keep me" },
      position: { x: 0, y: 0 },
    });

    expect((workspace as any).reconcileProjectTimelineOwnership(doc)).toEqual({
      removedActionNodeIds: [],
      detachedTimelineIds: ["timeline-1"],
    });
    expect((workspace as any).listProjectTimelines(doc)[0]).toMatchObject({
      id: "timeline-1",
      owner: { kind: "project" },
    });
    expect(canvas.readNode("corrupted-owner")).toMatchObject({
      type: "text",
      data: { timelineId: "timeline-1", content: "Keep me" },
    });
  });

  it("detaches a Canvas-owned Timeline back to standalone", () => {
    expect((workspace as any).detachTimelineFromCanvas).toBeTypeOf("function");

    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });

    expect(
      (workspace as any).detachTimelineFromCanvas(doc, "timeline-1"),
    ).toMatchObject({
      ok: true,
      timeline: { id: "timeline-1", owner: { kind: "project" } },
    });
    expect(doc.getMap("nodes").get("timeline-action-1")).toBeUndefined();
    expect(
      (workspace as any)
        .listStandaloneTimelines(doc)
        .map((timeline: any) => timeline.id),
    ).toEqual(["timeline-1"]);
  });

  it("removes incoming and outgoing edges when detaching a Timeline Action", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 100, y: 0 },
    });
    canvas.insertNode("source", "text", { content: "Source" }, null, {
      x: 0,
      y: 0,
    });
    canvas.insertNode("target", "video", { assetId: "render-1" }, null, {
      x: 200,
      y: 0,
    });
    canvas.insertEdge("source-action", "source", "timeline-action-1");
    canvas.insertEdge("action-target", "timeline-action-1", "target");

    expect(
      canvas
        .listEdges()
        .map((edge) => edge.id)
        .sort(),
    ).toEqual(["action-target", "source-action"]);

    (workspace as any).detachTimelineFromCanvas(doc, "timeline-1");

    expect(canvas.readNode("timeline-action-1")).toBeNull();
    expect(canvas.readNode("target")?.upstream).toEqual([]);
    expect(canvas.listEdges()).toEqual([]);
  });

  it("does not resurrect detached Timeline Action edges when its node id is reused", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "reusable-node",
      position: { x: 100, y: 0 },
    });
    canvas.insertNode("source", "text", { content: "Source" }, null, {
      x: 0,
      y: 0,
    });
    canvas.insertEdge("source-action", "source", "reusable-node");

    (workspace as any).detachTimelineFromCanvas(doc, "timeline-1");
    expect(canvas.listEdges()).toEqual([]);

    canvas.insertNode(
      "reusable-node",
      "text",
      { content: "Replacement" },
      null,
      { x: 100, y: 0 },
    );

    expect(canvas.readNode("reusable-node")?.upstream).toEqual([]);
    expect(canvas.listEdges()).toEqual([]);
  });

  it("advances one current Timeline revision when editable state changes", () => {
    expect((workspace as any).updateProjectTimelineState).toBeTypeOf(
      "function",
    );
    expect((workspace as any).projectTimelineRevisionId).toBeTypeOf("function");

    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");
    const created = (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    const initialRevisionId = created.timeline.revisionId;
    expect(initialRevisionId).toBe(
      (workspace as any).projectTimelineRevisionId("timeline-1", {
        tracks: [],
      }),
    );

    const updated = (workspace as any).updateProjectTimelineState(
      doc,
      "timeline-1",
      { tracks: [{ id: "dialogue", items: [] }] },
    );
    expect(updated).toMatchObject({
      ok: true,
      timeline: {
        id: "timeline-1",
        state: { tracks: [{ id: "dialogue", items: [] }] },
      },
    });
    expect(updated.timeline.revisionId).not.toBe(initialRevisionId);

    const revisionBeforeAttach = updated.timeline.revisionId;
    const attached = (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });
    expect(attached.timeline.revisionId).toBe(revisionBeforeAttach);
  });

  it("deletes a Timeline with CAS and removes every owned Canvas Action edge", () => {
    expect((workspace as any).deleteProjectTimeline).toBeTypeOf("function");

    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-delete",
      name: "Temporary proof",
      state: { tracks: [] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-delete",
      canvasId: "main",
      actionNodeId: "timeline-action-delete",
      position: { x: 0, y: 0 },
    });
    canvas.insertNode("render-target", "image_gen", {}, null, { x: 200, y: 0 });
    canvas.insertEdge(
      "timeline-render",
      "timeline-action-delete",
      "render-target",
    );
    const timeline = (workspace as any).readProjectTimeline(
      doc,
      "timeline-delete",
    );
    const readToken = (workspace as any).projectTimelineReadToken(timeline);

    expect(
      (workspace as any).deleteProjectTimeline(
        doc,
        "timeline-delete",
        "stale-token",
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("STALE_READ"),
    });
    expect(canvas.readNode("timeline-action-delete")).not.toBeNull();

    expect(
      (workspace as any).deleteProjectTimeline(
        doc,
        "timeline-delete",
        readToken,
      ),
    ).toEqual({
      ok: true,
      timelineId: "timeline-delete",
    });
    expect(
      (workspace as any).readProjectTimeline(doc, "timeline-delete"),
    ).toBeNull();
    expect(canvas.readNode("timeline-action-delete")).toBeNull();
    expect(canvas.readNode("render-target")?.upstream).toEqual([]);
    expect(canvas.listEdges()).toEqual([]);
  });

  it("copies a Timeline Action across canvases with new Action and Timeline identities", () => {
    expect((workspace as any).copyTimelineActionToCanvas).toBeTypeOf(
      "function",
    );

    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectCanvas(doc, { id: "shots", name: "Shots" });
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [{ id: "dialogue", items: [] }] },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });

    expect(
      (workspace as any).copyTimelineActionToCanvas(doc, {
        sourceTimelineId: "timeline-1",
        targetCanvasId: "shots",
        newTimelineId: "timeline-2",
        newActionNodeId: "timeline-action-2",
        position: { x: 100, y: 100 },
      }),
    ).toMatchObject({
      ok: true,
      timeline: {
        id: "timeline-2",
        owner: {
          kind: "canvas-action",
          canvasId: "shots",
          actionNodeId: "timeline-action-2",
        },
        state: { tracks: [{ id: "dialogue", items: [] }] },
      },
    });
    expect((workspace as any).listProjectTimelines(doc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "timeline-1",
          owner: {
            kind: "canvas-action",
            canvasId: "main",
            actionNodeId: "timeline-action-1",
          },
        }),
        expect.objectContaining({
          id: "timeline-2",
          owner: {
            kind: "canvas-action",
            canvasId: "shots",
            actionNodeId: "timeline-action-2",
          },
        }),
      ]),
    );
  });

  it("routes Timeline render output from current ownership", () => {
    expect((workspace as any).resolveTimelineRenderTarget).toBeTypeOf(
      "function",
    );

    const doc = new LoroDoc();
    new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: { tracks: [] },
    });
    expect(
      (workspace as any).resolveTimelineRenderTarget(doc, "timeline-1"),
    ).toEqual({
      kind: "project-assets",
    });

    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });
    expect(
      (workspace as any).resolveTimelineRenderTarget(doc, "timeline-1"),
    ).toEqual({
      kind: "canvas",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
    });
  });

  it("removes downstream upstream references when deleting nodes", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    canvas.insertNode("source", "text", { content: "Source" }, null, {
      x: 0,
      y: 0,
    });
    canvas.insertNode("target", "image_gen", { prompt: "Use source" }, null, {
      x: 200,
      y: 0,
    });
    canvas.insertEdge("source-target", "source", "target");

    expect(canvas.deleteNodes(["source"])).toEqual({
      deletedNodeIds: ["source"],
      deletedEdgeIds: ["source-target"],
    });
    expect(canvas.readNode("target")?.upstream).toEqual([]);
    expect(canvas.listEdges()).toEqual([]);
  });

  it("renders a Canvas-owned Timeline from timeline state and places the output on its Canvas", () => {
    const doc = new LoroDoc();
    markActionAssetBindingAuthority(doc);
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: {
        fps: 30,
        durationInFrames: 30,
        tracks: [{
          id: "visuals",
          items: [{
            id: "solid-1",
            type: "solid",
            from: 0,
            durationInFrames: 30,
            color: "#000000",
          }],
        }],
      },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });

    expect(canvas.execute("timeline-action-1", () => "render-1")).toMatchObject(
      {
        kind: "render",
        childNodeId: "render-1",
        error: null,
      },
    );
    expect(canvas.readNode("render-1")).toMatchObject({
      canvas_id: "main",
      type: "video",
      upstream: [{ nodeId: "timeline-action-1" }],
      data: {
        sourceTimelineId: "timeline-1",
        sourceTimelineRevisionId: (workspace as any).projectTimelineRevisionId(
          "timeline-1",
          {
            fps: 30,
            durationInFrames: 30,
            tracks: [{
              id: "visuals",
              items: [{
                id: "solid-1",
                type: "solid",
                from: 0,
                durationInFrames: 30,
                color: "#000000",
              }],
            }],
          },
        ),
        timelineDsl: {
          fps: 30,
          durationInFrames: 30,
          tracks: [{
            id: "visuals",
            items: [{
              id: "solid-1",
              type: "solid",
              from: 0,
              durationInFrames: 30,
              color: "#000000",
            }],
          }],
        },
      },
    });
  });

  it("fails Timeline render closed before Action Asset binding authority cutover", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    (workspace as any).createProjectTimeline(doc, {
      id: "timeline-1",
      name: "Episode 1",
      state: {
        fps: 30,
        durationInFrames: 30,
        tracks: [{
          id: "visuals",
          items: [{
            id: "solid-1",
            type: "solid",
            from: 0,
            durationInFrames: 30,
            color: "#000000",
          }],
        }],
      },
    });
    (workspace as any).attachTimelineToCanvas(doc, {
      timelineId: "timeline-1",
      canvasId: "main",
      actionNodeId: "timeline-action-1",
      position: { x: 0, y: 0 },
    });

    expect(canvas.execute("timeline-action-1", () => "render-1")).toMatchObject(
      {
        kind: null,
        childNodeId: "",
        error:
          "Action Asset binding authority is required before freezing run inputs",
      },
    );
    expect(canvas.readNode("render-1")).toBeNull();
  });

  it("does not treat an embedded node timelineDsl as canonical Timeline state", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    canvas.insertNode(
      "legacy-editor",
      "video-editor",
      {
        timelineDsl: {
          tracks: [{ items: [{ from: 0, durationInFrames: 30 }] }],
        },
      },
      null,
      { x: 0, y: 0 },
    );

    expect(canvas.execute("legacy-editor", () => "render-1")).toMatchObject({
      kind: null,
      error: "Timeline Action legacy-editor must reference a Project Timeline",
    });
    expect(canvas.readNode("render-1")).toBeNull();
  });

  it("updates and deletes derived edges through downstream upstream refs", () => {
    const doc = new LoroDoc();
    const canvas = new Canvas(doc, () => {}, "main");
    canvas.insertNode("source", "text", {}, null, { x: 0, y: 0 });
    canvas.insertNode("target", "image_gen", {}, null, { x: 100, y: 0 });
    canvas.insertEdge("source-target", "source", "target", "default");

    expect((canvas as any).updateEdge).toBeTypeOf("function");
    expect((canvas as any).deleteEdge).toBeTypeOf("function");
    expect(
      (canvas as any).updateEdge("source-target", { type: "materialized" }),
    ).toBe(true);
    expect(canvas.listEdges()).toEqual([
      {
        id: "source-target",
        source: "source",
        target: "target",
        type: "materialized",
      },
    ]);
    expect((canvas as any).deleteEdge("source-target")).toBe(true);
    expect(canvas.listEdges()).toEqual([]);
    expect(canvas.readNode("target")?.upstream).toEqual([]);
  });

  it("derives stable Canvas versions for implicit read-before-write CAS", () => {
    expect((workspace as any).projectCanvasReadToken).toBeTypeOf("function");
    const original = { id: "main", name: "Main", position: 0 };
    expect((workspace as any).projectCanvasReadToken(original)).toBe(
      (workspace as any).projectCanvasReadToken({ ...original }),
    );
    expect((workspace as any).projectCanvasReadToken(original)).not.toBe(
      (workspace as any).projectCanvasReadToken({
        ...original,
        name: "Primary",
      }),
    );
  });

  it("derives Timeline versions from state and ownership", () => {
    expect((workspace as any).projectTimelineReadToken).toBeTypeOf("function");
    const timeline = {
      id: "timeline-1",
      name: "Episode 1",
      owner: { kind: "project" },
      state: { tracks: [] },
    };
    expect((workspace as any).projectTimelineReadToken(timeline)).not.toBe(
      (workspace as any).projectTimelineReadToken({
        ...timeline,
        owner: {
          kind: "canvas-action",
          canvasId: "main",
          actionNodeId: "timeline-action-1",
        },
      }),
    );
    expect((workspace as any).projectTimelineReadToken(timeline)).not.toBe(
      (workspace as any).projectTimelineReadToken({
        ...timeline,
        state: { tracks: [{ id: "dialogue" }] },
      }),
    );
  });
});
