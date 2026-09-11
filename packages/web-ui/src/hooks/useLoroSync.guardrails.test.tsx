import { LoroDoc, UndoManager } from "loro-crdt";
import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { useLoroSync } from "./useLoroSync";
import { setRuntimeConfigOverride } from "../lib/runtimeConfig";
import {
  agentReadToken,
  Canvas,
  canvasBatchDeleteReadToken,
  canvasNodeReadToken,
  createProjectAsset,
  createProjectDocumentAsset,
  createProjectGenerator,
  listActionAssetBindings,
  markActionAssetBindingAuthority,
  projectDirectorStageReadToken,
  type HostMutationRecord,
} from "@clash/shared-types";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
} from "@clash/replica/loro-protocol";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  binaryType = "arraybuffer";
  bufferedAmount = 0;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;
  readonly url: string;
  readonly sent: unknown[] = [];

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.({});
    });
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1006, reason: "host replaced", wasClean: false });
  }
}

describe("useLoroSync guardrails", () => {
  it("never deletes the local project snapshot just because the schema marker changed", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/web-ui/src/hooks/useLoroSync.ts"),
      "utf8",
    );
    const migrationStart = source.indexOf(
      "const versionKey = `loro-schema-version-${projectId}`",
    );
    const loadStart = source.indexOf(
      "const snapshot = await loadFromDB(projectId)",
      migrationStart,
    );
    const migrationSource = source.slice(migrationStart, loadStart);

    expect(migrationStart).toBeGreaterThan(-1);
    expect(migrationSource).not.toContain("deleteFromDB(projectId)");
    expect(migrationSource).toContain(
      "localStorage.setItem(versionKey, LORO_SCHEMA_VERSION)",
    );
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ timelines: [], versions: {} }), { headers: { "content-type": "application/json" } })));
    FakeWebSocket.instances = [];
    setRuntimeConfigOverride(undefined);
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    delete globalThis.__CLASH_DESKTOP__;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setRuntimeConfigOverride(undefined);
    globalThis.__CLASH_RUNTIME_CONFIG__ = undefined;
    delete globalThis.__CLASH_DESKTOP__;
    window.localStorage.clear();
  });

  it.each([false, true])("releases the mounted replica and undo history after final unmount (StrictMode=%s)", async (strict) => {
    const freeUndo = vi.spyOn(UndoManager.prototype, "free");
    const { result, rerender, unmount } = renderHook(
      ({ canvasId }) => useLoroSync({ projectId: "replica-lifetime", canvasId }),
      { initialProps: { canvasId: "main" }, wrapper: ({ children }: { children: ReactNode }) => strict ? <StrictMode>{children}</StrictMode> : children },
    );
    await waitFor(() => expect(result.current.connected).toBe(true));
    const doc = result.current.doc!;
    const freeDoc = vi.spyOn(doc, "free");
    act(() => { doc.getMap("draft").set("text", "keep editing"); doc.commit(); });
    await waitFor(() => expect(result.current.canUndo).toBe(true));
    act(() => { result.current.undo(); });
    expect(doc.getMap("draft").get("text")).toBeUndefined();
    act(() => { result.current.redo(); });
    expect(doc.getMap("draft").get("text")).toBe("keep editing");
    rerender({ canvasId: "another-canvas" });
    await act(async () => {});
    expect(result.current.doc).toBe(doc);
    expect(freeDoc).not.toHaveBeenCalled();
    expect(freeUndo).not.toHaveBeenCalled();

    // A commit may queue an undo refresh immediately before the component leaves.
    act(() => { doc.getMap("draft").set("text", "last edit"); doc.commit(); unmount(); });
    await act(async () => {});
    expect(freeDoc).toHaveBeenCalledOnce();
    expect(freeUndo).toHaveBeenCalledOnce();
    expect(() => doc.toJSON()).toThrow();
    expect(() => (freeUndo.mock.contexts[0] as UndoManager).canUndo()).toThrow();
  });

  it("closes every snapshot database connection and retains the final edit after remount", async () => {
    const factory = new IDBFactory();
    const open = factory.open.bind(factory);
    const databases: IDBDatabase[] = [];
    vi.spyOn(factory, "open").mockImplementation((...args) => {
      const request = open(...args);
      request.addEventListener("success", () => databases.push(request.result));
      return request;
    });
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    vi.stubGlobal("indexedDB", factory);
    const mounted = renderHook(() => useLoroSync({ projectId: "database-lifetime" }));
    await waitFor(() => expect(mounted.result.current.connected).toBe(true));
    try {
      await waitFor(() => {
        expect(databases.length).toBeGreaterThan(0);
        expect(new Set(close.mock.contexts)).toEqual(new Set(databases));
      });
      act(() => { const doc = mounted.result.current.doc!; doc.getMap("draft").set("text", "last edit"); doc.commit(); });
      mounted.unmount();
      await waitFor(() => expect(new Set(close.mock.contexts)).toEqual(new Set(databases)));
      const fresh = renderHook(() => useLoroSync({ projectId: "database-lifetime" }));
      try {
        await waitFor(() => expect(fresh.result.current.connected).toBe(true));
        expect(fresh.result.current.doc!.getMap("draft").get("text")).toBe("last edit");
      } finally { fresh.unmount(); }
      await waitFor(() => expect(new Set(close.mock.contexts)).toEqual(new Set(databases)));
    } finally { mounted.unmount(); }
  });

  it("releases every owned replica, history and socket across repeated project opens", async () => {
    const histories = vi.spyOn(UndoManager.prototype, "free");
    const documents: LoroDoc[] = [];
    for (let cycle = 0; cycle < 50; cycle++) {
      const mounted = renderHook(() => useLoroSync({ projectId: `reopen-${cycle % 2}` }));
      try {
        await waitFor(() => expect(mounted.result.current.connected).toBe(true));
        const doc = mounted.result.current.doc!;
        documents.push(doc);
        act(() => { doc.getMap("draft").set("cycle", cycle); doc.commit(); });
      } finally { mounted.unmount(); }
      await act(async () => {});
    }
    expect(histories.mock.contexts).toHaveLength(documents.length);
    for (const doc of documents) expect(() => doc.toJSON()).toThrow();
    for (const history of histories.mock.contexts) expect(() => (history as UndoManager).canUndo()).toThrow();
    for (const socket of FakeWebSocket.instances) {
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      expect(socket.onmessage).toBeNull();
      expect(socket.onclose).toBeNull();
    }
  });

  it.each(["get", "put"] as const)("closes snapshot database handles when a %s transaction aborts", async (operation) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    const original = IDBObjectStore.prototype[operation];
    let aborted: IDBDatabase | undefined;
    vi.spyOn(IDBObjectStore.prototype, operation).mockImplementationOnce(function (this: IDBObjectStore, ...args: Parameters<typeof original>) {
      const request = Reflect.apply(original, this, args);
      aborted = this.transaction.db;
      this.transaction.abort();
      return request;
    });
    const mounted = renderHook(() => useLoroSync({ projectId: `database-abort-${operation}` }));
    try {
      await waitFor(() => expect(mounted.result.current.connected).toBe(true));
      if (operation === "put") {
        act(() => { const doc = mounted.result.current.doc!; doc.getMap("draft").set("text", "save"); doc.commit(); });
        mounted.unmount();
      }
      await waitFor(() => {
        expect(aborted).toBeDefined();
        expect(close.mock.contexts).toContain(aborted);
      });
    } finally { mounted.unmount(); }
  });

  it("detaches closed socket callbacks and ignores events queued before unmount", async () => {
    const onPresenceChange = vi.fn();
    const mounted = renderHook(() => useLoroSync({ projectId: "socket-lifetime", onPresenceChange }));
    await waitFor(() => expect(mounted.result.current.connected).toBe(true));
    const socket = FakeWebSocket.instances.at(-1)!;
    const lateOpen = socket.onopen!;
    const lateMessage = socket.onmessage!;
    const lateClose = socket.onclose!;
    const sent = [...socket.sent];
    mounted.unmount();
    await act(async () => {
      lateOpen({});
      await lateMessage({ data: JSON.stringify({ type: "presence", clients: [] }) });
      lateClose({ code: 1006, reason: "queued close", wasClean: false });
    });
    expect(onPresenceChange).not.toHaveBeenCalled();
    expect(socket.sent).toEqual(sent);
    expect(socket.onopen).toBeNull();
    expect(socket.onmessage).toBeNull();
    expect(socket.onerror).toBeNull();
    expect(socket.onclose).toBeNull();
  });

  it("pauses failed project loading, preserves local edits and retries only when requested", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { result, unmount } = renderHook(() => useLoroSync({ projectId: "load-recovery" }));
    try {
      await waitFor(() => expect(result.current.connected).toBe(true));
      const socket = FakeWebSocket.instances.at(-1)!;
      const doc = result.current.doc!;
      doc.getMap("draft-test").set("text", "Keep local edits");
      const problem = { type: "project.load-error", projectId: "load-recovery", code: "PROJECT_UPGRADE_FAILED", nodeId: "draft", message: "Restore the original plugin package, then retry." };
      for (const malformed of [{ ...problem, message: null }, { ...problem, nodeId: 3 }, { ...problem, code: "unknown" }]) {
        await act(async () => { await socket.onmessage?.({ data: JSON.stringify(malformed) }); });
        expect(result.current.projectLoadError).toBeUndefined();
      }
      await act(async () => { await socket.onmessage?.({ data: JSON.stringify({ ...problem, projectId: "other" }) }); });
      expect(result.current.projectLoadError).toBeUndefined();
      await act(async () => { await socket.onmessage?.({ data: JSON.stringify(problem) }); });
      expect(result.current.projectLoadError).toEqual(problem);
      expect(result.current.connected).toBe(false);
      expect(result.current.syncRejected).toBe(false);
      vi.useFakeTimers();
      await act(async () => { socket.close(1011, "Unable to open Project"); await vi.advanceTimersByTimeAsync(6000); });
      expect(FakeWebSocket.instances).toEqual([socket]);
      vi.useRealTimers();
      await act(async () => { result.current.retryProjectLoad(); });
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      expect(result.current.projectLoadError).toBeUndefined();
      expect(result.current.doc).toBe(doc);
      expect(doc.getMap("draft-test").get("text")).toBe("Keep local edits");
      expect(FakeWebSocket.instances[1]?.sent.map(frame => decode(frame as Uint8Array).type)).toContain(MessageType.JoinRequest);
      await act(async () => { socket.close(1011, "Late close from the first attempt"); });
      expect(result.current.connected).toBe(true);
    } finally { vi.useRealTimers(); unmount(); }
  });

  it.each([false, true])("reports a rejected sync and keeps its local draft without reconnecting it (leave during recovery=%s)", async (leave) => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const onMutation = vi.fn();
    const { result, unmount } = renderHook(() => useLoroSync({ projectId: "rejected-sync", onMutation }));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const socket = FakeWebSocket.instances.at(-1)!;
    const doc = result.current.doc!;
    const version = doc.version();
    try {
      await act(async () => {
        await socket.onmessage?.({ data: encode({ type: MessageType.JoinResponseOk, crdt: CrdtType.Loro,
          roomId: "rejected-sync", permission: "write", version: version.encode() }) });
        doc.getMap("draft-test").set("text", "Keep this edit");
        doc.commit();
      });
      const message = decode(socket.sent.at(-1) as Uint8Array);
      if (message.type !== MessageType.DocUpdate) throw new Error("Expected draft update");
      await act(async () => {
        await socket.onmessage?.({ data: encode({ type: MessageType.Ack, crdt: CrdtType.Loro,
          roomId: "rejected-sync", refId: message.batchId, status: UpdateStatusCode.AppError }) });
      });
      expect(result.current.connected).toBe(false);
      expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({ accepted: false, operation: "project_sync", error: expect.stringMatching(/not saved/i) }));
      expect(doc.getMap("draft-test").get("text")).toBe("Keep this edit");
      vi.useFakeTimers();
      await act(async () => { socket.drop(); await vi.advanceTimersByTimeAsync(6000); });
      expect(FakeWebSocket.instances).toEqual([socket]);
      vi.useRealTimers();
      await act(async () => {
        doc.getMap("draft-test").set("latest", "Pending autosave");
        doc.commit();
        const recovery = result.current.prepareSyncRecovery();
        if (leave) unmount();
        await recovery;
      });
      if (!leave) expect(result.current.recoveryDraft?.snapshot).toBeInstanceOf(Uint8Array);
      unmount();
      const fresh = renderHook(() => useLoroSync({ projectId: "rejected-sync" }));
      try {
        await waitFor(() => expect(fresh.result.current.isInitialized).toBe(true));
        expect(fresh.result.current.doc!.getMap("draft-test").get("text")).toBeUndefined();
        expect(fresh.result.current.recoveryDraft).toBeDefined();
        const backup = new LoroDoc();
        try {
          backup.import(new Uint8Array(fresh.result.current.recoveryDraft!.snapshot));
          expect(backup.getMap("draft-test").get("text")).toBe("Keep this edit");
          expect(backup.getMap("draft-test").get("latest")).toBe("Pending autosave");
        } finally { backup.free(); }
      } finally { fresh.unmount(); }
    } finally { version.free(); unmount(); vi.useRealTimers(); }
  });

  it("debounces snapshot serialization itself and flushes pending changes on unmount", async () => {
    const { result, unmount } = renderHook(() => useLoroSync({ projectId: "snapshot-batching" }));
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.connected).toBe(true));
    const doc = result.current.doc!;
    const exports = vi.spyOn(doc, "export");
    vi.useFakeTimers();
    try {
      for (const text of ["first", "second", "latest"]) {
        await act(async () => {
          doc.getMap("performance-test").set("text", text);
          doc.commit();
        });
      }
      const snapshots = () => exports.mock.calls.filter(([options]) => options.mode === "snapshot");
      expect(snapshots()).toHaveLength(0);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(snapshots()).toHaveLength(1);
      await act(async () => {
        doc.getMap("performance-test").set("text", "before-switch");
        doc.commit();
      });
      unmount();
      expect(snapshots()).toHaveLength(2);
      const lastSnapshotIndex = exports.mock.calls.map(([options]) => options.mode === "snapshot").lastIndexOf(true);
      const restored = new LoroDoc();
      try {
        restored.import(exports.mock.results[lastSnapshotIndex].value);
        expect(restored.getMap("performance-test").get("text")).toBe("before-switch");
      } finally { restored.free(); }
      await vi.advanceTimersByTimeAsync(1000);
      expect(snapshots()).toHaveLength(2);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("keeps pending snapshot saves independent across mounted projects", async () => {
    const first = renderHook(() => useLoroSync({ projectId: "snapshot-first" }));
    const second = renderHook(() => useLoroSync({ projectId: "snapshot-second" }));
    await waitFor(() => expect(first.result.current.connected && second.result.current.connected).toBe(true));
    const firstDoc = first.result.current.doc!;
    const secondDoc = second.result.current.doc!;
    const firstExports = vi.spyOn(firstDoc, "export");
    const secondExports = vi.spyOn(secondDoc, "export");
    vi.useFakeTimers();
    try {
      await act(async () => { firstDoc.getMap("performance-test").set("text", "first"); firstDoc.commit(); });
      await act(async () => { secondDoc.getMap("performance-test").set("text", "second"); secondDoc.commit(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(firstExports.mock.calls.filter(([options]) => options.mode === "snapshot")).toHaveLength(1);
      expect(secondExports.mock.calls.filter(([options]) => options.mode === "snapshot")).toHaveLength(1);
    } finally {
      first.unmount();
      second.unmount();
      vi.useRealTimers();
    }
  });

  it("refreshes a replaced Desktop Host before reconnecting the Project Loro socket", async () => {
    globalThis.__CLASH_RUNTIME_CONFIG__ = {
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:50138",
      wsBaseUrl: "ws://127.0.0.1:50138",
    };
    const refreshRuntime = vi.fn().mockResolvedValue({
      mode: "desktop",
      apiBaseUrl: "http://127.0.0.1:55137",
      wsBaseUrl: "ws://127.0.0.1:55137",
    });
    globalThis.__CLASH_DESKTOP__ = {
      isDesktop: true,
      newWindow: vi.fn(),
      refreshRuntime,
    };

    const { result } = renderHook(() =>
      useLoroSync({ projectId: "host-failover" }),
    );
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "ws://127.0.0.1:50138/sync/host-failover?protocol=loro-v1",
    );

    act(() => FakeWebSocket.instances[0]?.drop());
    act(() => {
      expect(
        result.current.addNode("pending-generation", {
          type: "image",
          position: { x: 100, y: 100 },
          data: { status: "pending", prompt: "dog" },
        }),
      ).toBe(true);
    });

    await waitFor(
      () => {
        expect(refreshRuntime).toHaveBeenCalledTimes(1);
        expect(FakeWebSocket.instances[1]?.url).toBe(
          "ws://127.0.0.1:55137/sync/host-failover?protocol=loro-v1",
        );
      },
      { timeout: 2_000 },
    );
    const { LoroDoc } = await import("loro-crdt");
    const server = new LoroDoc();
    const serverVersion = server.version();
    await act(async () => {
      await FakeWebSocket.instances[1]?.onmessage?.({
        data: encode({
          type: MessageType.JoinResponseOk,
          crdt: CrdtType.Loro,
          roomId: "host-failover",
          permission: "write",
          version: serverVersion.encode(),
        }).buffer,
      });
    });
    serverVersion.free();
    const replayedUpdate = FakeWebSocket.instances[1]?.sent
      .filter((value): value is Uint8Array => value instanceof Uint8Array)
      .map((value) => decode(value))
      .find((message) => message.type === MessageType.DocUpdate);
    expect(replayedUpdate?.type).toBe(MessageType.DocUpdate);
    if (!replayedUpdate || replayedUpdate.type !== MessageType.DocUpdate) {
      throw new Error("missing offline replay update");
    }
    const replayed = new LoroDoc();
    replayed.importBatch(replayedUpdate.updates);
    expect(replayed.getMap("nodes").get("pending-generation")).toMatchObject({
      data: { status: "pending", prompt: "dog" },
    });
  });

  it("publishes local Canvas node and edge commits to the React projection", async () => {
    const onNodesChange = vi.fn();
    const onEdgesChange = vi.fn();
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "local-react-projection",
        onNodesChange,
        onEdgesChange,
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    onNodesChange.mockClear();
    onEdgesChange.mockClear();

    act(() => {
      expect(
        result.current.addNode("editor", {
          type: "image-editor",
          position: { x: 100, y: 100 },
          data: { label: "Image Editor" },
        }),
      ).toBe(true);
      expect(
        result.current.addNode("edited-image", {
          type: "image",
          position: { x: 500, y: 100 },
          data: {
            label: "Edited Image",
            status: "completed",
            assetId: "asset:edit:one",
          },
        }),
      ).toBe(true);
      expect(
        result.current.addEdge("editor-edited-image", {
          source: "editor",
          target: "edited-image",
          type: "default",
        }),
      ).toBe(true);
    });

    expect(onNodesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: "edited-image" })]),
    );
    expect(onEdgesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "editor-edited-image",
          source: "editor",
          target: "edited-image",
        }),
      ]),
    );

    act(() => {
      expect(
        result.current.updateNode("edited-image", {
          data: {
            label: "Edited Image",
            status: "failed",
            error: "client transform failed",
          },
        }),
      ).toBe(true);
    });
    expect(onNodesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "edited-image",
          data: expect.objectContaining({
            status: "failed",
            error: "client transform failed",
          }),
        }),
      ]),
    );
  });

  it("projects a linked pending Asset immediately from the shared Canvas operation", async () => {
    const onNodesChange = vi.fn();
    const onEdgesChange = vi.fn();
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "linked-pending-react-projection",
        onNodesChange,
        onEdgesChange,
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      expect(
        result.current.addNode("image-editor", {
          type: "image-editor",
          position: { x: 100, y: 100 },
          data: { label: "Image Editor" },
        }),
      ).toBe(true);
    });
    onNodesChange.mockClear();
    onEdgesChange.mockClear();

    act(() => {
      expect(
        result.current.createLinkedNode({
          nodeId: "pending-image",
          nodeType: "image",
          data: {
            label: "Edited Image",
            status: "pending",
            taskId: "run:client:one",
          },
          parentId: null,
          sourceNodeId: "image-editor",
        }),
      ).toMatchObject({ nodeId: "pending-image" });
    });

    expect(onNodesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending-image",
          data: expect.objectContaining({
            status: "pending",
            taskId: "run:client:one",
          }),
        }),
      ]),
    );
    expect(onEdgesChange).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          source: "image-editor",
          target: "pending-image",
        }),
      ]),
    );
  });

  it("hides an unavailable parent in the view without rewriting the received project", async () => {
    const onNodesChange = vi.fn();
    const { result, unmount } = renderHook(() => useLoroSync({ projectId: "missing-parent-projection", onNodesChange }));
    const remote = new LoroDoc();
    try {
      await waitFor(() => expect(result.current.isInitialized).toBe(true));
      remote.getMap("nodes").set("child", { type: "text", canvasId: "main", parentId: "missing", extent: "parent", position: { x: 12, y: 34 }, data: { content: "Retain this text" } });
      remote.commit();
      const raw = remote.getMap("nodes").get("child");
      await act(async () => { result.current.doc!.import(remote.export({ mode: "snapshot" })); });
      expect(onNodesChange).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ id: "child", parentId: undefined, extent: undefined })]));
      expect(result.current.doc!.getMap("nodes").get("child")).toEqual(raw);
    } finally { unmount(); remote.free(); }
  });

  it("keeps its public API object stable across parent-only renders", async () => {
    const { result, rerender } = renderHook(
      ({ renderToken }) => {
        void renderToken;
        return useLoroSync({
          projectId: "stable-public-api-hook",
          canvasId: "main",
          syncServerUrl: "ws://localhost:7777",
        });
      },
      { initialProps: { renderToken: 0 } },
    );

    await waitFor(() => {
      expect(result.current.isInitialized).toBe(true);
      expect(result.current.connected).toBe(true);
      expect(result.current.canvases.length).toBeGreaterThan(0);
    });
    const before = result.current;

    rerender({ renderToken: 1 });

    expect(result.current).toBe(before);
  });

  it("manages independently revisioned Director Stages through the live Project replica", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "director-stage-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const initialState = {
      schemaVersion: 1 as const,
      scene: {
        backgroundColor: "#101114",
        grid: { visible: true, snap: false, size: 1 },
      },
      objects: [],
      cameras: [
        {
          id: "camera-1",
          name: "Camera 1",
          position: [0, 2, 8] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          fov: 45,
        },
      ],
      shots: [],
      activeCameraId: "camera-1",
      animation: { durationSeconds: 10, fps: 30, tracks: [] },
    };

    act(() => {
      expect(
        result.current.createDirectorStage({
          id: "stage-1",
          name: "Opening blocking",
          state: initialState,
        }).ok,
      ).toBe(true);
      expect(
        result.current.attachDirectorStage({
          stageId: "stage-1",
          actionNodeId: "director-action-1",
          position: { x: 160, y: 120 },
        }).ok,
      ).toBe(true);
    });

    const attached = result.current.directorStages[0];
    expect(attached?.owner).toEqual({
      kind: "canvas-action",
      canvasId: "main",
      actionNodeId: "director-action-1",
    });
    const before = projectDirectorStageReadToken(attached!);

    act(() => {
      expect(
        result.current.applyDirectorStageState("stage-1", {
          ...initialState,
          scene: { ...initialState.scene, backgroundColor: "#202126" },
        }),
      ).toBe(true);
    });
    expect(
      projectDirectorStageReadToken(result.current.directorStages[0]!),
    ).not.toBe(before);

    act(() => {
      expect(result.current.detachDirectorStage("stage-1").ok).toBe(true);
    });
    expect(result.current.standaloneDirectorStages[0]?.owner).toEqual({
      kind: "project",
    });
  });

  it("writes nodes into the selected Canvas scope in one Project document", async () => {
    const { result, rerender } = renderHook(
      ({ canvasId }) =>
        useLoroSync({
          projectId: "multi-canvas-hook",
          canvasId,
          syncServerUrl: "ws://localhost:7777",
        }),
      { initialProps: { canvasId: "main" } },
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    act(() => {
      result.current.addNode("main-node", {
        type: "text",
        position: { x: 0, y: 0 },
        data: { content: "Main" },
      });
      expect(
        result.current.createCanvas({ id: "shots", name: "Shots" }).ok,
      ).toBe(true);
    });

    rerender({ canvasId: "shots" });
    act(() => {
      result.current.addNode("shots-node", {
        type: "image",
        position: { x: 0, y: 0 },
        data: { assetId: "asset-1" },
      });
    });

    expect(result.current.doc?.getMap("nodes").get("main-node")).toMatchObject({
      canvasId: "main",
    });
    expect(result.current.doc?.getMap("nodes").get("shots-node")).toMatchObject(
      { canvasId: "shots" },
    );
    expect(result.current.doc?.getMap("canvases").get("main")).toBeTruthy();
    expect(result.current.doc?.getMap("canvases").get("shots")).toBeTruthy();
  });

  it("adds a project asset node to an explicit Canvas without changing the selected Canvas", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "explicit-canvas-add-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    act(() => {
      expect(
        result.current.createCanvas({ id: "shots", name: "Shots" }).ok,
      ).toBe(true);
      expect(
        result.current.addNodeToCanvas("shots", "asset-node", {
          type: "image",
          position: { x: 100, y: 100 },
          data: { assetId: "asset-1" },
        }),
      ).toBe(true);
    });

    expect(result.current.doc?.getMap("nodes").get("asset-node")).toMatchObject(
      {
        canvasId: "shots",
        data: { assetId: "asset-1" },
      },
    );
    expect(
      new Canvas(result.current.doc!, () => {}, "main").readNode("asset-node"),
    ).toBeNull();
    expect(
      new Canvas(result.current.doc!, () => {}, "shots").readNode("asset-node"),
    ).toBeTruthy();
  });

  it("does not create Canvas or node state from an unknown selected id", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result, rerender } = renderHook(
      ({ canvasId }) =>
        useLoroSync({
          projectId: "unknown-canvas-hook",
          canvasId,
          syncServerUrl: "ws://localhost:7777",
          onMutation: (mutation) => mutations.push(mutation),
        }),
      { initialProps: { canvasId: "main" } },
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    rerender({ canvasId: "typo" });
    let added: unknown;
    act(() => {
      added = result.current.addNode("should-not-exist", {
        type: "text",
        position: { x: 0, y: 0 },
        data: { content: "No" },
      });
    });

    expect(added).toBe(false);
    expect(result.current.doc?.getMap("canvases").get("typo")).toBeUndefined();
    expect(
      result.current.doc?.getMap("nodes").get("should-not-exist"),
    ).toBeUndefined();
    expect(mutations.at(-1)).toMatchObject({
      operation: "canvas_add_node",
      accepted: false,
      error: "Canvas typo not found",
    });
  });

  it("restores the Canvas projection after rejecting an entire layout", async () => {
    const onNodesChange = vi.fn();
    const onMutation = vi.fn();
    const { result } = renderHook(() => useLoroSync({
      projectId: "layout-rejection-projection",
      syncServerUrl: "ws://localhost:7777",
      onNodesChange,
      onMutation,
    }));
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    act(() => {
      for (const id of ["editable", "source", "target"])
        result.current.addNode(id, { id, type: "text", position: { x: 0, y: 0 }, data: { content: id } });
      result.current.addEdge("reference", { id: "reference", source: "source", target: "target" });
    });
    const before = result.current.doc?.toJSON();
    onNodesChange.mockClear();
    act(() => {
      expect(result.current.applyLayout([
        { id: "editable", patch: { position: { x: 100, y: 100 } } },
        { id: "source", patch: { position: { x: 200, y: 100 } } },
      ])).toBe(false);
    });
    expect(result.current.doc?.toJSON()).toEqual(before);
    expect(onNodesChange.mock.lastCall?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "editable", position: { x: 0, y: 0 } }),
      expect.objectContaining({ id: "source", position: { x: 0, y: 0 } }),
    ]));
    expect(onMutation).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false, error: expect.stringContaining("IMMUTABLE_NODE") }));
    expect(result.current.syncRejected).toBe(false);
  });

  it.each([
    { position: { x: 55, y: 90 } },
    { width: 260, height: 58, style: { width: 260, height: 58 } },
    { data: { label: "Changed" } },
  ])("rejects a referenced node patch locally without changing its replica: %j", async (patch) => {
    const onMutation = vi.fn();
    const { result, unmount } = renderHook(() => useLoroSync({ projectId: "referenced-patch", onMutation }));
    try {
      await waitFor(() => expect(result.current.isInitialized).toBe(true));
      const doc = result.current.doc!;
      act(() => {
        const created = createProjectGenerator(doc, { head: { id: "native-draft", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "native-draft", definitionRef: { pluginId: "clash.agent-text", definitionId: "text", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` },
          state: { prompt: "Existing brief" }, persistentInputRefs: [],
        } });
        if (!created.ok) throw new Error(created.error.message);
        const canvas = new Canvas(doc, () => {});
        canvas.createNode("source", "action-badge", { generatorId: "native-draft", actionCardId: "agent-text", label: "Source" });
        canvas.createNode("output", "text", { content: "Existing result" });
        canvas.insertEdge("output-edge", "source", "output");
      });
      const before = doc.toJSON();
      let updated: unknown;
      act(() => { updated = result.current.updateNode("source", patch); });
      expect(updated).toBe(false);
      expect(doc.toJSON()).toEqual(before);
      expect(onMutation).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false, error: expect.stringContaining("IMMUTABLE_NODE") }));
      expect(result.current.syncRejected).toBe(false);
    } finally { unmount(); }
  });

  it("does not turn updateNode into an implicit create", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "update-missing-node-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    let updated: unknown;
    act(() => {
      updated = result.current.updateNode("missing", { data: { label: "No" } });
    });

    expect(updated).toBe(false);
    expect(result.current.doc?.getMap("nodes").get("missing")).toBeUndefined();
    expect(mutations.at(-1)).toMatchObject({
      operation: "canvas_update",
      accepted: false,
      error: "Node not found: missing",
    });
  });

  it("projects only the selected Canvas and replays state when the Canvas changes", async () => {
    const projectedNodeIds: string[][] = [];
    const { result, rerender } = renderHook(
      ({ canvasId }) =>
        useLoroSync({
          projectId: "multi-canvas-projection",
          canvasId,
          syncServerUrl: "ws://localhost:7777",
          onNodesChange: (nodes) =>
            projectedNodeIds.push(nodes.map((node) => node.id)),
        }),
      { initialProps: { canvasId: "main" } },
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const remote = new (await import("loro-crdt")).LoroDoc();
    remote
      .getMap("canvases")
      .set("main", { id: "main", name: "Main", position: 0 });
    remote
      .getMap("canvases")
      .set("shots", { id: "shots", name: "Shots", position: 1 });
    remote.getMap("nodes").set("main-node", {
      canvasId: "main",
      type: "text",
      position: { x: 0, y: 0 },
      data: { content: "Main" },
      upstream: [],
    });
    remote.getMap("nodes").set("shots-node", {
      canvasId: "shots",
      type: "image",
      position: { x: 0, y: 0 },
      data: { assetId: "asset-1" },
      upstream: [],
    });
    act(() => {
      result.current.doc?.import(remote.export({ mode: "snapshot" }));
    });
    await waitFor(() => expect(projectedNodeIds.at(-1)).toEqual(["main-node"]));

    rerender({ canvasId: "shots" });
    await waitFor(() =>
      expect(projectedNodeIds.at(-1)).toEqual(["shots-node"]),
    );
  });

  it("stores UI edge mutations as downstream upstream references", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "derived-edge-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("source", {
        type: "text",
        position: { x: 0, y: 0 },
        data: {},
      });
      result.current.addNode("target", {
        type: "image_gen",
        position: { x: 100, y: 0 },
        data: {},
      });
      result.current.addEdge("source-target", {
        source: "source",
        target: "target",
        type: "default",
      });
    });

    expect(result.current.doc?.getMap("edges").size).toBe(0);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").readNode("target"),
    ).toMatchObject({
      upstream: [
        { nodeId: "source", edgeId: "source-target", type: "default" },
      ],
    });

    act(() => {
      result.current.updateEdge("source-target", { type: "materialized" });
    });
    expect(
      new Canvas(result.current.doc!, () => {}, "main").readNode("target"),
    ).toMatchObject({
      upstream: [
        { nodeId: "source", edgeId: "source-target", type: "materialized" },
      ],
    });

    act(() => {
      result.current.removeEdge("source-target");
    });
    expect(
      new Canvas(result.current.doc!, () => {}, "main").readNode("target"),
    ).toMatchObject({ upstream: [] });
  });

  it.each([
    { document: true, action: false, reject: false },
    { document: false, action: false, reject: false },
    { document: false, action: true, reject: false },
    { document: true, action: false, reject: true },
    { document: false, action: false, reject: true, leave: true },
    { document: false, action: false, reject: false, leave: true },
  ])("deletes only the selected native edge through the Host (Document=$document, Action=$action, rejected=$reject, leave=$leave)", async ({ document, action, reject, leave }) => {
    const onMutation = vi.fn();
    const projectId = `native-edge/${document}-${action}-${reject}`;
    const edgeId = "selected/edge";
    const { result, unmount } = renderHook(() => useLoroSync({ projectId, onMutation }));
    try {
      await waitFor(() => expect(result.current.isInitialized).toBe(true));
      const doc = result.current.doc!;
      const target = document
        ? { kind: "document" as const, documentAssetId: "script", revisionId: "saved" }
        : { kind: "media" as const, projectAssetId: "asset" };
      act(() => {
        if (document) expect(createProjectDocumentAsset(doc, {
          id: "saved", documentAssetId: "script", documentKind: "text.plain", schemaVersion: 1, mutability: "versioned",
          body: { digest: `sha256:${"a".repeat(64)}`, byteLength: 1, contentType: "application/json" },
          producer: { kind: "actor", actor: { kind: "user" } }, sourceRefs: [],
        }).ok).toBe(true);
        else expect(createProjectAsset(doc, { id: "asset", kind: "image", source: { kind: "owned", resourceId: "asset" }, lifecycle: { state: "active" }, metadata: {} }).ok).toBe(true);
        expect(createProjectGenerator(doc, { head: { id: "generator", headRevisionId: "initial" }, revision: {
          id: "initial", generatorId: "generator", definitionRef: { pluginId: action ? "example.action" : "clash.model-generation", definitionId: "image", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` },
          state: { prompt: "Existing input", ...(!action ? { modelId: "minimax-h3", params: {} } : {}) }, persistentInputRefs: [{ slot: document ? "text" : "image", itemKey: "input", target }],
        } }).ok).toBe(true);
        const canvas = new Canvas(doc, () => {});
        for (const id of ["source", "other-source"]) canvas.createNode(id, document ? "text" : "image", document ? { documentRevision: target } : { assetId: "asset" });
        canvas.createNode("placement", "action-badge", { generatorId: "generator", ...(action ? { actionCardId: "action" } : {}) });
        canvas.insertEdge(edgeId, "source", "placement");
        canvas.insertEdge("retained-edge", "other-source", "placement");
        doc.commit();
      });
      const before = doc.toJSON();
      const request = vi.fn(async (_path: string, _init?: RequestInit) => reject
        ? Response.json({ error: "The target was referenced. Copy it before editing." }, { status: 409 })
        : Response.json({ deleted: true, edgeId }));
      vi.stubGlobal("fetch", request);
      act(() => { expect(result.current.removeEdge(edgeId)).toBe(false); });
      if (leave) {
        onMutation.mockClear();
        unmount();
        await act(async () => {});
        expect(onMutation).not.toHaveBeenCalled();
        return;
      }
      await waitFor(() => expect(request).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/projects/${encodeURIComponent(projectId)}/canvas/edges/${encodeURIComponent(edgeId)}`),
        expect.objectContaining({ method: "DELETE" }),
      ));
      await waitFor(() => expect(onMutation).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: !reject, operation: "canvas_delete_edge", entity: { kind: "canvas-edge", id: edgeId } })));
      // Only the Host publishes the updated graph and native revision over sync.
      expect(doc.toJSON()).toEqual(before);
      if (reject) expect(onMutation).toHaveBeenLastCalledWith(expect.objectContaining({ error: expect.stringContaining("referenced") }));
    } finally { unmount(); }
  });

  it("keeps GUI node edits and Canvas Action Asset bindings in one mutation path", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "canvas-binding-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      createProjectAsset(result.current.doc!, {
        id: "asset-a",
        kind: "image",
        source: { kind: "owned", resourceId: "resource-a" },
        lifecycle: { state: "active" },
        metadata: {},
      });
      createProjectAsset(result.current.doc!, {
        id: "asset-b",
        kind: "image",
        source: { kind: "owned", resourceId: "resource-b" },
        lifecycle: { state: "active" },
        metadata: {},
      });
      markActionAssetBindingAuthority(result.current.doc!);
      result.current.addNode("action", {
        type: "action-badge",
        position: { x: 100, y: 0 },
        data: {
          actionType: "image-gen",
          modelId: "gpt-image-2",
          referenceImageAssetIds: ["asset-a"],
        },
      });
    });
    expect(listActionAssetBindings(result.current.doc!)).toEqual([
      expect.objectContaining({
        owner: { kind: "draft", actionId: "node:action" },
        projectAssetId: "asset-a",
      }),
    ]);

    act(() => {
      expect(
        result.current.updateNode("action", {
          data: { referenceImageAssetIds: ["asset-b"] },
        }),
      ).toBe(true);
    });
    expect(listActionAssetBindings(result.current.doc!)).toEqual([
      expect.objectContaining({ projectAssetId: "asset-b" }),
    ]);
  });

  it("exposes synchronized Canvas registry operations to the product UI", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "canvas-registry-hook",
        canvasId: "main",
        syncServerUrl: "ws://localhost:7777",
      }),
    );
    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    expect((result.current as any).canvases).toEqual([
      { id: "main", name: "Main", position: 0 },
    ]);
    expect((result.current as any).createCanvas).toBeTypeOf("function");
    expect((result.current as any).renameCanvas).toBeTypeOf("function");
    expect((result.current as any).deleteCanvas).toBeTypeOf("function");

    act(() => {
      expect(
        (result.current as any).createCanvas({ id: "shots", name: "Shots" }).ok,
      ).toBe(true);
    });
    expect(
      (result.current as any).canvases.map((canvas: any) => canvas.name),
    ).toEqual(["Main", "Shots"]);

    act(() => {
      expect((result.current as any).renameCanvas("shots", "Selects").ok).toBe(
        true,
      );
    });
    expect(
      (result.current as any).canvases.map((canvas: any) => canvas.name),
    ).toEqual(["Main", "Selects"]);

    act(() => {
      expect((result.current as any).deleteCanvas("shots").ok).toBe(true);
    });
    expect((result.current as any).canvases).toEqual([
      { id: "main", name: "Main", position: 0 },
    ]);
  });

  it("does not let addNode overwrite an existing canvas node", async () => {
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-add-node",
        syncServerUrl: "ws://localhost:7777",
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("node-1", {
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Original", content: "keep me" },
      });
    });

    let rejected: unknown;
    act(() => {
      rejected = result.current.addNode("node-1", {
        type: "video-editor",
        position: { x: 10, y: 10 },
        data: { timelineDsl: { tracks: [] } },
      });
    });

    expect(rejected).toBe(false);
    const persisted = result.current.doc?.getMap("nodes").get("node-1") as {
      type?: string;
      data?: Record<string, unknown>;
    };
    expect(persisted.type).toBe("text");
    expect(persisted.data?.content).toBe("keep me");
    expect(persisted.data?.timelineDsl).toBeUndefined();
  });

  it("emits host mutation envelopes for direct node updates", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-node-mutation-envelope",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("text-1", {
        id: "text-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Script", content: "before" },
      });
    });

    const before = result.current.doc?.getMap("nodes").get("text-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const beforeReadToken = canvasNodeReadToken({ id: "text-1", ...before });

    act(() => {
      result.current.updateNode("text-1", {
        data: { label: "Script v2" },
      });
    });

    const after = result.current.doc?.getMap("nodes").get("text-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const afterReadToken = canvasNodeReadToken({ id: "text-1", ...after });

    expect(mutations).toContainEqual({
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: "text-1" },
      beforeReadToken,
      afterReadToken,
      resultEntityId: "text-1",
      accepted: true,
    });
  });

  it("emits mutation envelopes for node creation and duplicate creation rejection", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-add-node-mutation-envelope",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    let created: unknown;
    act(() => {
      created = result.current.addNode("node-1", {
        id: "node-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Original", content: "keep me" },
      });
    });

    expect(created).toBe(true);
    const current = result.current.doc?.getMap("nodes").get("node-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const readToken = canvasNodeReadToken({ id: "node-1", ...current });
    expect(mutations).toContainEqual({
      operation: "canvas_add_node",
      entity: { kind: "canvas-node", id: "node-1" },
      afterReadToken: readToken,
      resultEntityId: "node-1",
      accepted: true,
    });

    let duplicate: unknown;
    act(() => {
      duplicate = result.current.addNode("node-1", {
        id: "node-1",
        type: "image",
        position: { x: 10, y: 10 },
        data: { label: "Overwrite" },
      });
    });

    expect(duplicate).toBe(false);
    expect(mutations).toContainEqual({
      operation: "canvas_add_node",
      entity: { kind: "canvas-node", id: "node-1" },
      beforeReadToken: readToken,
      accepted: false,
      error: "Node already exists: node-1",
    });
  });

  it("emits mutation envelopes for edge add, update, and delete", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-edge-mutation-envelope",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("source-1", {
        id: "source-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Source", content: "hello" },
      });
      result.current.addNode("target-1", {
        id: "target-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Target", status: "draft" },
      });
    });
    mutations.length = 0;

    let added: unknown;
    act(() => {
      added = result.current.addEdge("edge-1", {
        id: "edge-1",
        source: "source-1",
        target: "target-1",
      });
    });
    expect(added).toBe(true);
    expect(mutations).toContainEqual({
      operation: "canvas_add_edge",
      entity: { kind: "canvas-edge", id: "edge-1" },
      resultEntityId: "edge-1",
      accepted: true,
    });

    let updated: unknown;
    act(() => {
      updated = result.current.updateEdge("edge-1", {
        label: "primary",
      });
    });
    expect(updated).toBe(true);
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_update_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        resultEntityId: "edge-1",
        accepted: true,
      }),
    );

    let removed: unknown;
    act(() => {
      removed = result.current.removeEdge("edge-1");
    });
    expect(removed).toBe(true);
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_delete_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        resultEntityId: "edge-1",
        accepted: true,
      }),
    );
  });

  it("emits rejected mutation envelopes when direct node patches hit guardrails", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-rejected-mutation-envelope",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("text-1", {
        id: "text-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Script", content: "before" },
      });
      result.current.addNode("render-1", {
        id: "render-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Rendered", assetId: "asset-1", status: "completed" },
      });
      result.current.addEdge("edge-1", {
        id: "edge-1",
        source: "text-1",
        target: "render-1",
      });
    });

    const before = result.current.doc?.getMap("nodes").get("text-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const beforeReadToken = canvasNodeReadToken({ id: "text-1", ...before });

    act(() => {
      result.current.updateNode("text-1", {
        data: { content: "after" },
      });
    });

    expect(result.current.doc?.getMap("nodes").get("text-1")).toMatchObject({
      data: { content: "before" },
    });
    expect(mutations).toContainEqual({
      operation: "canvas_update",
      entity: { kind: "canvas-node", id: "text-1" },
      beforeReadToken,
      accepted: false,
      error:
        "Refusing to patch referenced text content through canvas update. Text node text-1 has downstream node(s): render-1. Use text projection or copy-on-write/replace workflow instead.",
    });
  });

  it("emits a rejection envelope when deleting a referenced node", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-timeline-delete-mutation-envelope",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("editor-1", { type: "text", position: { x: 0, y: 0 }, data: { label: "Source", content: "Source" } });
      result.current.addNode("render-1", {
        id: "render-1",
        type: "video",
        position: { x: 200, y: 0 },
        data: { label: "Render", assetId: "asset-render", status: "completed" },
      });
      result.current.addEdge("edge-render", {
        id: "edge-render",
        source: "editor-1",
        target: "render-1",
      });
    });

    const before = result.current.doc?.getMap("nodes").get("editor-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const beforeReadToken = canvasNodeReadToken({ id: "editor-1", ...before });
    let deleteRejected: unknown;
    act(() => {
      deleteRejected = result.current.removeNode("editor-1");
    });
    expect(deleteRejected).toBe(false);
    expect(mutations).toContainEqual({
      operation: "canvas_delete",
      entity: { kind: "canvas-node", id: "editor-1" },
      beforeReadToken,
      accepted: false,
      error:
        "Refusing to delete referenced node editor-1. It has downstream node(s): render-1. Remove or rewire those references first.",
    });
  });

  it("requires agent runtime patches against existing nodes to carry matching read tokens", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-agent-runtime-read-proof",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("scratch-1", {
        id: "scratch-1",
        type: "text",
        position: { x: 200, y: 0 },
        data: { label: "Scratch", content: "draft" },
      });
    });
    mutations.length = 0;

    const scratchBefore = result.current.doc
      ?.getMap("nodes")
      .get("scratch-1") as {
      id?: string;
      type?: string;
      position?: unknown;
      data?: Record<string, unknown>;
    };
    const scratchReadToken = canvasNodeReadToken({
      id: "scratch-1",
      ...scratchBefore,
    });

    let missingDeleteProof: unknown;
    act(() => {
      missingDeleteProof = result.current.removeNode("scratch-1", {
        actorClientType: "agent",
      });
    });

    expect(missingDeleteProof).toBe(false);
    expect(result.current.doc?.getMap("nodes").get("scratch-1")).toBeTruthy();
    expect(mutations).toContainEqual({
      operation: "canvas_delete",
      entity: { kind: "canvas-node", id: "scratch-1" },
      beforeReadToken: scratchReadToken,
      accepted: false,
      error:
        "Missing canvas delete read proof for agent. Run `clash canvas get --json` first, then retry the mutation.",
    });

    let acceptedDeleteProof: unknown;
    act(() => {
      acceptedDeleteProof = result.current.removeNode("scratch-1", {
        actorClientType: "agent",
        ifMatch: scratchReadToken,
      });
    });

    expect(acceptedDeleteProof).toBe(true);
    expect(
      result.current.doc?.getMap("nodes").get("scratch-1"),
    ).toBeUndefined();
    expect(mutations).toContainEqual({
      operation: "canvas_delete",
      entity: { kind: "canvas-node", id: "scratch-1" },
      expectedReadToken: scratchReadToken,
      beforeReadToken: scratchReadToken,
      resultEntityId: "scratch-1",
      accepted: true,
    });
  });

  it("requires agent runtime edge mutations to carry matching read tokens", async () => {
    const edgeReadToken = (edgeId: string) => {
      const edge = new Canvas(result.current.doc!, () => {}, "main")
        .listEdges()
        .find((candidate) => candidate.id === edgeId);
      return agentReadToken({ namespace: "edge", subject: edge });
    };
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-agent-runtime-edge-read-proof",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("source-1", {
        id: "source-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Source", content: "draft" },
      });
      result.current.addNode("target-1", {
        id: "target-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Target", status: "draft" },
      });
      result.current.addEdge("edge-1", {
        id: "edge-1",
        source: "source-1",
        target: "target-1",
        type: "default",
      });
    });
    mutations.length = 0;
    const beforeReadToken = edgeReadToken("edge-1");

    let missingUpdateProof: unknown;
    act(() => {
      missingUpdateProof = (result.current.updateEdge as any)(
        "edge-1",
        { type: "agent-edit" },
        {
          actorClientType: "agent",
        },
      );
    });
    expect(missingUpdateProof).toBe(false);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges()[0]?.type,
    ).toBe("default");
    expect(mutations).toContainEqual({
      operation: "canvas_update_edge",
      entity: { kind: "canvas-edge", id: "edge-1" },
      beforeReadToken,
      accepted: false,
      error:
        "Missing canvas edge update read proof for agent. Run `clash canvas edges --json` first, then retry the mutation.",
    });

    let staleUpdateProof: unknown;
    act(() => {
      staleUpdateProof = (result.current.updateEdge as any)(
        "edge-1",
        { type: "agent-edit" },
        {
          actorClientType: "agent",
          ifMatch: "edge-v1:stale",
        },
      );
    });
    expect(staleUpdateProof).toBe(false);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges()[0]?.type,
    ).toBe("default");
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_update_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        expectedReadToken: "edge-v1:stale",
        beforeReadToken,
        accepted: false,
      }),
    );

    let acceptedUpdateProof: unknown;
    act(() => {
      acceptedUpdateProof = (result.current.updateEdge as any)(
        "edge-1",
        { type: "agent-edit" },
        {
          actorClientType: "agent",
          ifMatch: beforeReadToken,
        },
      );
    });
    expect(acceptedUpdateProof).toBe(true);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges()[0]?.type,
    ).toBe("agent-edit");
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_update_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        expectedReadToken: beforeReadToken,
        beforeReadToken,
        resultEntityId: "edge-1",
        accepted: true,
      }),
    );

    const afterUpdateReadToken = edgeReadToken("edge-1");
    let staleDeleteProof: unknown;
    act(() => {
      staleDeleteProof = (result.current.removeEdge as any)("edge-1", {
        actorClientType: "agent",
        ifMatch: beforeReadToken,
      });
    });
    expect(staleDeleteProof).toBe(false);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges(),
    ).toHaveLength(1);

    let acceptedDeleteProof: unknown;
    act(() => {
      acceptedDeleteProof = (result.current.removeEdge as any)("edge-1", {
        actorClientType: "agent",
        ifMatch: afterUpdateReadToken,
      });
    });
    expect(acceptedDeleteProof).toBe(true);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges(),
    ).toEqual([]);
    expect(mutations).toContainEqual({
      operation: "canvas_delete_edge",
      entity: { kind: "canvas-edge", id: "edge-1" },
      expectedReadToken: afterUpdateReadToken,
      beforeReadToken: afterUpdateReadToken,
      resultEntityId: "edge-1",
      accepted: true,
    });
  });

  it("requires agent runtime edge creation between existing nodes to carry a graph read token", async () => {
    const edgesReadToken = () => {
      const edges = new Canvas(result.current.doc!, () => {}, "main")
        .listEdges()
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
      return agentReadToken({ namespace: "edges", subject: { edges } });
    };
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-agent-runtime-add-edge-read-proof",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("source-1", {
        id: "source-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Source", content: "draft" },
      });
      result.current.addNode("target-1", {
        id: "target-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Target", status: "draft" },
      });
    });
    mutations.length = 0;
    const graphReadToken = edgesReadToken();

    let missingProof: unknown;
    act(() => {
      missingProof = (result.current.addEdge as any)(
        "edge-1",
        {
          id: "edge-1",
          source: "source-1",
          target: "target-1",
          type: "default",
        },
        {
          actorClientType: "agent",
        },
      );
    });
    expect(missingProof).toBe(false);
    expect(result.current.doc?.getMap("edges").get("edge-1")).toBeUndefined();
    expect(mutations).toContainEqual({
      operation: "canvas_add_edge",
      entity: { kind: "canvas-edge", id: "edge-1" },
      beforeReadToken: graphReadToken,
      accepted: false,
      error:
        "Missing canvas edge add read proof for agent. Run `clash canvas edges --json` first, then retry the mutation.",
    });

    let staleProof: unknown;
    act(() => {
      staleProof = (result.current.addEdge as any)(
        "edge-1",
        {
          id: "edge-1",
          source: "source-1",
          target: "target-1",
          type: "default",
        },
        {
          actorClientType: "agent",
          ifMatch: "edges-v1:stale",
        },
      );
    });
    expect(staleProof).toBe(false);
    expect(result.current.doc?.getMap("edges").get("edge-1")).toBeUndefined();
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_add_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        expectedReadToken: "edges-v1:stale",
        beforeReadToken: graphReadToken,
        accepted: false,
      }),
    );

    let accepted: unknown;
    act(() => {
      accepted = (result.current.addEdge as any)(
        "edge-1",
        {
          id: "edge-1",
          source: "source-1",
          target: "target-1",
          type: "default",
        },
        {
          actorClientType: "agent",
          ifMatch: graphReadToken,
        },
      );
    });
    expect(accepted).toBe(true);
    expect(
      new Canvas(result.current.doc!, () => {}, "main").listEdges()[0],
    ).toMatchObject({
      source: "source-1",
      target: "target-1",
    });
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_add_edge",
        entity: { kind: "canvas-edge", id: "edge-1" },
        expectedReadToken: graphReadToken,
        beforeReadToken: graphReadToken,
        resultEntityId: "edge-1",
        accepted: true,
      }),
    );
  });

  it("batch deletes closed subgraphs atomically and rejects external orphaning", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-batch-delete",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("source-1", {
        id: "source-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Source", content: "source" },
      });
      result.current.addNode("child-1", {
        id: "child-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Child", status: "completed" },
      });
      result.current.addNode("external-1", {
        id: "external-1",
        type: "video",
        position: { x: 400, y: 0 },
        data: { label: "External", status: "completed" },
      });
      result.current.addEdge("edge-internal", {
        id: "edge-internal",
        source: "source-1",
        target: "child-1",
      });
    });
    mutations.length = 0;

    let closedDelete: unknown;
    act(() => {
      closedDelete = result.current.removeNodes(["source-1", "child-1"]);
    });
    expect(closedDelete).toBe(true);
    expect(result.current.doc?.getMap("nodes").get("source-1")).toBeUndefined();
    expect(result.current.doc?.getMap("nodes").get("child-1")).toBeUndefined();
    expect(result.current.doc?.getMap("nodes").get("external-1")).toBeTruthy();
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_batch_delete",
        entity: { kind: "canvas-node-batch", id: "source-1,child-1" },
        resultEntityId: "source-1,child-1",
        accepted: true,
      }),
    );

    act(() => {
      result.current.addNode("source-2", {
        id: "source-2",
        type: "text",
        position: { x: 0, y: 200 },
        data: { label: "Source 2", content: "source" },
      });
      result.current.addNode("child-2", {
        id: "child-2",
        type: "image",
        position: { x: 200, y: 200 },
        data: { label: "Child 2", status: "completed" },
      });
      result.current.addEdge("edge-internal-2", {
        id: "edge-internal-2",
        source: "source-2",
        target: "child-2",
      });
      result.current.addEdge("edge-external-2", {
        id: "edge-external-2",
        source: "child-2",
        target: "external-1",
      });
    });
    mutations.length = 0;

    let rejectedDelete: unknown;
    act(() => {
      rejectedDelete = result.current.removeNodes(["source-2", "child-2"]);
    });
    expect(rejectedDelete).toBe(false);
    expect(result.current.doc?.getMap("nodes").get("source-2")).toBeTruthy();
    expect(result.current.doc?.getMap("nodes").get("child-2")).toBeTruthy();
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_batch_delete",
        entity: { kind: "canvas-node-batch", id: "source-2,child-2" },
        accepted: false,
        error:
          "Refusing to delete referenced node(s). Batch would orphan downstream reference(s): child-2 -> external-1. Delete a closed subgraph or rewire those references first.",
      }),
    );
  });

  it("requires agent batch delete to carry a matching graph-aware read token", async () => {
    const mutations: HostMutationRecord[] = [];
    const { result } = renderHook(() =>
      useLoroSync({
        projectId: "guardrail-agent-batch-delete-read-proof",
        syncServerUrl: "ws://localhost:7777",
        onMutation: (mutation) => mutations.push(mutation),
      }),
    );

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    act(() => {
      result.current.addNode("agent-source-1", {
        id: "agent-source-1",
        type: "text",
        position: { x: 0, y: 0 },
        data: { label: "Agent source", content: "source" },
      });
      result.current.addNode("agent-child-1", {
        id: "agent-child-1",
        type: "image",
        position: { x: 200, y: 0 },
        data: { label: "Agent child", status: "completed" },
      });
      result.current.addEdge("agent-edge-internal", {
        id: "agent-edge-internal",
        source: "agent-source-1",
        target: "agent-child-1",
      });
    });
    mutations.length = 0;

    let rejectedDelete: unknown;
    act(() => {
      rejectedDelete = result.current.removeNodes(
        ["agent-source-1", "agent-child-1"],
        {
          actorClientType: "agent",
        },
      );
    });

    expect(rejectedDelete).toBe(false);
    expect(
      result.current.doc?.getMap("nodes").get("agent-source-1"),
    ).toBeTruthy();
    expect(
      result.current.doc?.getMap("nodes").get("agent-child-1"),
    ).toBeTruthy();
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_batch_delete",
        entity: {
          kind: "canvas-node-batch",
          id: "agent-source-1,agent-child-1",
        },
        accepted: false,
        error:
          "Missing canvas batch delete read proof for agent. Run `clash canvas delete-plan --node <id> --node <id> --json` first, then retry the mutation.",
      }),
    );

    const readBatchNode = (id: string) => {
      const raw = result.current.doc!.getMap("nodes").get(id) as any;
      return {
        id,
        type: raw.type,
        data: raw.data,
        parentId: raw.parentId,
        position: raw.position,
      };
    };
    const readToken = canvasBatchDeleteReadToken({
      nodes: [readBatchNode("agent-source-1"), readBatchNode("agent-child-1")],
      edges: [
        {
          id: "agent-edge-internal",
          source: "agent-source-1",
          target: "agent-child-1",
          type: "default",
        },
      ],
    });

    act(() => {
      result.current.addNode("agent-external-1", {
        id: "agent-external-1",
        type: "video",
        position: { x: 400, y: 0 },
        data: { label: "External", status: "completed" },
      });
      result.current.addEdge("agent-edge-external", {
        id: "agent-edge-external",
        source: "agent-child-1",
        target: "agent-external-1",
      });
    });
    mutations.length = 0;

    let staleDelete: unknown;
    act(() => {
      staleDelete = result.current.removeNodes(
        ["agent-source-1", "agent-child-1"],
        {
          actorClientType: "agent",
          ifMatch: readToken,
        },
      );
    });

    expect(staleDelete).toBe(false);
    expect(
      result.current.doc?.getMap("nodes").get("agent-source-1"),
    ).toBeTruthy();
    expect(
      result.current.doc?.getMap("nodes").get("agent-child-1"),
    ).toBeTruthy();
    expect(mutations.at(-1)).toEqual(
      expect.objectContaining({
        operation: "canvas_batch_delete",
        entity: {
          kind: "canvas-node-batch",
          id: "agent-source-1,agent-child-1",
        },
        expectedReadToken: readToken,
        accepted: false,
      }),
    );
    expect(mutations.at(-1)?.error).toContain(
      "Stale canvas batch delete rejected",
    );

    act(() => {
      result.current.removeEdge("agent-edge-external");
    });
    const freshReadToken = canvasBatchDeleteReadToken({
      nodes: [readBatchNode("agent-source-1"), readBatchNode("agent-child-1")],
      edges: [
        {
          id: "agent-edge-internal",
          source: "agent-source-1",
          target: "agent-child-1",
          type: "default",
        },
      ],
    });
    mutations.length = 0;

    let acceptedDelete: unknown;
    act(() => {
      acceptedDelete = result.current.removeNodes(
        ["agent-source-1", "agent-child-1"],
        {
          actorClientType: "agent",
          ifMatch: freshReadToken,
        },
      );
    });

    expect(acceptedDelete).toBe(true);
    expect(
      result.current.doc?.getMap("nodes").get("agent-source-1"),
    ).toBeUndefined();
    expect(
      result.current.doc?.getMap("nodes").get("agent-child-1"),
    ).toBeUndefined();
    expect(mutations).toContainEqual(
      expect.objectContaining({
        operation: "canvas_batch_delete",
        entity: {
          kind: "canvas-node-batch",
          id: "agent-source-1,agent-child-1",
        },
        expectedReadToken: freshReadToken,
        beforeReadToken: freshReadToken,
        resultEntityId: "agent-source-1,agent-child-1",
        accepted: true,
      }),
    );
  });
});
