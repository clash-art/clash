// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { describe, expect, it, vi } from "vitest";
import { createProjectGenerator, readProjectGenerator, advanceProjectGeneratorHead, type GeneratorRevision } from "@clash/shared-types";
import { useNativeGeneratorDraft } from "./useNativeGeneratorDraft";

it("projects native state and uses an accepted edit before replica delivery", async () => {
  const doc = new LoroDoc();
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const revision = { id: "before", generatorId: "draft", definitionRef, state: { modelId: "minimax-h3", prompt: "Original", params: {} }, persistentInputRefs: [] };
  const created = createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "before" }, revision });
  if (!created.ok) throw new Error(created.error.message);
  let release!: (value: Response) => void;
  const request = vi.fn(async (_path: string, _init?: RequestInit) => new Promise<Response>((resolve) => { release = resolve; }));
  const { result } = renderHook(() => useNativeGeneratorDraft({ projectId: "project", generatorId: "draft", doc, request }));
  expect(result.current?.projection?.revision.state.prompt).toBe("Original");
  let pending!: ReturnType<NonNullable<typeof result.current>["edit"]>;
  act(() => { pending = result.current!.edit({ prompt: "Edited" }); });
  await waitFor(() => expect(request).toHaveBeenCalled());
  const input = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(result.current?.projection?.revision.id).toBe("before");
  await act(async () => {
    release(Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
      ...revision, id: input.generatorRevisionId, parentRevisionId: "before", state: input.state,
    } }));
    await pending;
  });
  expect(result.current?.projection?.revision.state.prompt).toBe("Edited");
  expect((await result.current!.flush()).revision.id).toBe(input.generatorRevisionId);
  expect(readProjectGenerator(doc, "draft")?.headRevisionId).toBe("before");
});

describe("native draft availability", () => {
  it("does not invent native state when the Generator is missing", () => {
    const { result } = renderHook(() => useNativeGeneratorDraft({ projectId: "project", generatorId: "missing", doc: new LoroDoc() }));
    expect(result.current?.error).toMatch(/Generator/);
    expect(result.current?.projection).toBeNull();
  });
  it("leaves ordinary Canvas nodes outside the native editor", () => {
    const { result } = renderHook(() => useNativeGeneratorDraft({ projectId: "project", generatorId: null, doc: null }));
    expect(result.current).toBeNull();
  });
});

it("removes a newly observed external input rather than treating the old empty list as unchanged", async () => {
  const doc = new LoroDoc();
  const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const revision = { id: "before", generatorId: "draft", definitionRef, state: { modelId: "minimax-h3", prompt: "Original", params: {} }, persistentInputRefs: [] };
  const created = createProjectGenerator(doc, { head: { id: "draft", headRevisionId: "before" }, revision });
  if (!created.ok) throw new Error(created.error.message);
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    const input = JSON.parse(init!.body as string);
    return Response.json({ generator: { ...created.generator, headRevisionId: input.generatorRevisionId }, revision: {
      ...revision, id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs,
    } });
  });
  const { result } = renderHook(() => useNativeGeneratorDraft({ projectId: "project", generatorId: "draft", doc, request }));
  await act(async () => {
    const changed = advanceProjectGeneratorHead(doc, { generatorId: "draft", expectedHeadRevisionId: "before", editPolicy: "advance-head",
      revision: { ...revision, id: "external", parentRevisionId: "before", persistentInputRefs: [{ slot: "video", target: { kind: "media", projectAssetId: "asset" } }] } });
    if (!changed.ok) throw new Error(changed.error.message);
    doc.commit();
  });
  await act(async () => { await result.current!.edit({}, () => []); });
  expect(request).toHaveBeenCalled();
  const input = JSON.parse(request.mock.calls[0]![1]!.body as string);
  expect(input.expectedHeadRevisionId).toBe("external");
  expect(input.persistentInputRefs).toEqual([]);
});

it.each([false, true])("forks native inputs and unsaved edits without advancing the source (Action Card: %s)", async (actionCard) => {
  const doc = new LoroDoc();
  const definitionRef = { pluginId: actionCard ? "test.paint" : "clash.model-generation", definitionId: actionCard ? "paint" : "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
  const definition = { ...definitionRef, stateSchema: { type: "object" } };
  const revision: GeneratorRevision = { id: "source-revision", generatorId: "source", definitionRef,
    state: actionCard ? { prompt: "Original", quality: "fine" } : { modelId: "minimax-h3", prompt: "Original", params: { duration: 5 } },
    persistentInputRefs: [{ slot: "image", target: { kind: "media" as const, projectAssetId: "reference" } }] };
  const created = createProjectGenerator(doc, { head: { id: "source", headRevisionId: revision.id }, revision });
  if (!created.ok) throw new Error(created.error.message);
  doc.getMap("nodes").set("source-node", { type: "action-badge", canvasId: "other-canvas", parentId: "source-group", data: { generatorId: "source", ...(actionCard ? { actionCardId: "paint-card" } : {}) } });
  const request = vi.fn(async (_path: string, init?: RequestInit) => {
    if (!init?.body) return Response.json({ definition });
    const input = JSON.parse(init!.body as string);
    return Response.json({ generator: { id: input.generatorId, headRevisionId: input.generatorRevisionId, definitionRef },
      revision: { ...revision, id: input.generatorRevisionId, generatorId: input.generatorId, state: input.state,
        persistentInputRefs: input.persistentInputRefs, forkedFrom: input.forkedFrom } });
  });
  const draftEdit = vi.fn((before: GeneratorRevision, disclosed?: unknown) => {
    if (actionCard) expect(disclosed).toEqual(definition);
    return { state: before.state, persistentInputRefs: before.persistentInputRefs };
  });
  const { result } = renderHook(() => useNativeGeneratorDraft({ projectId: "project", generatorId: "source", doc, request }));
  await act(async () => { await result.current!.copy({ sourceNodeId: "source-node", nodeId: "copy-node", label: "Copy",
    statePatch: { prompt: "Unsaved copy edit" }, ...(actionCard ? { draftEdit } : {}) }); });
  const mutations = request.mock.calls.filter(([, init]) => init?.body);
  expect(mutations).toHaveLength(1);
  if (actionCard) expect(draftEdit).toHaveBeenCalled();
  const [path, init] = mutations[0]!;
  expect(path).toBe("/api/v1/projects/project/generators");
  const input = JSON.parse(init!.body as string);
  expect(input.generatorId).not.toBe("source");
  expect(input.forkedFrom).toEqual({ generatorId: "source", generatorRevisionId: revision.id });
  expect(input.state).toEqual({ ...revision.state, prompt: "Unsaved copy edit" });
  expect(input.persistentInputRefs).toEqual(revision.persistentInputRefs);
  expect(input.placement).toEqual({ canvasId: "other-canvas", nodeId: "copy-node", label: "Copy", parentId: "source-group", sourceNodeId: "source-node", ...(actionCard ? { actionCardId: "paint-card" } : {}) });
  expect(readProjectGenerator(doc, "source")?.headRevisionId).toBe(revision.id);
  request.mockClear();
  doc.getMap("nodes").set("source-node", { type: "action-badge", data: { generatorId: "rewired" } });
  await expect(result.current!.copy({ sourceNodeId: "source-node", nodeId: "another-copy", label: "Copy", statePatch: {} }))
    .rejects.toThrow(/source placement changed/i);
  expect(request).not.toHaveBeenCalled();
});
