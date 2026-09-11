import { describe, expect, it, vi } from "vitest";
import type { GeneratorRevision, ProjectGenerator } from "@clash/shared-types";
import { createGeneratorDraftEditor } from "./generatorDraftEditor";

const definitionRef = { pluginId: "clash.model-generation", definitionId: "video", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` };
const initial: { generator: ProjectGenerator; revision: GeneratorRevision } = {
  generator: { id: "draft", headRevisionId: "read-revision", definitionRef },
  revision: { id: "read-revision", generatorId: "draft", definitionRef,
    state: { modelId: "minimax-h3", prompt: "Before edit", params: { resolution: "768P" } },
    persistentInputRefs: [{ slot: "image", target: { kind: "media", projectAssetId: "reference-image" } }],
  },
};
type AdvanceInput = { generatorRevisionId: string; expectedHeadRevisionId: string; state: GeneratorRevision["state"]; persistentInputRefs: GeneratorRevision["persistentInputRefs"] };
function accepted(input: AdvanceInput) {
  return { generator: { ...initial.generator, headRevisionId: input.generatorRevisionId }, revision: { ...initial.revision,
    id: input.generatorRevisionId, parentRevisionId: input.expectedHeadRevisionId, state: input.state, persistentInputRefs: input.persistentInputRefs } };
}

describe("native Generator draft editor", () => {
  it("prepares an unchanged draft against the installed contract without rewriting its source", async () => {
    const installed = { ...definitionRef, schemaHash: `sha256:${"b".repeat(64)}` };
    const advance = vi.fn(async (_project: string, _generator: string, input: AdvanceInput) => {
      const result = accepted(input);
      return { ...result, revision: { ...result.revision, definitionRef: installed } };
    });
    const getDefinition = vi.fn(async () => ({ definition: { ...installed, title: "Installed definition", stateSchema: { type: "object" } } }));
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance, getDefinition } });
    const prepared = await editor.prepare((before) => before);
    expect(prepared.revision.id).not.toBe(initial.revision.id);
    expect(prepared.revision.definitionRef).toEqual(installed);
    expect(prepared.revision.state).toEqual(initial.revision.state);
    expect(prepared.revision.persistentInputRefs).toEqual(initial.revision.persistentInputRefs);
    expect(initial.revision.definitionRef).toEqual(definitionRef);
    advance.mockClear();
    expect(await editor.prepare((before) => before)).toEqual(prepared);
    expect(advance).not.toHaveBeenCalled();
  });

  it("rejects a registry switch during preparation instead of returning a runnable revision", async () => {
    const installed = { ...definitionRef, version: "updated" };
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: {
      getDefinition: async () => ({ definition: installed }),
      advanceGenerator: async (_project, _generator, input) => accepted(input),
    } });
    await expect(editor.prepare((before) => before)).rejects.toThrow(/Definition changed/);
    await expect(editor.flush()).rejects.toThrow(/Definition changed/);
  });

  it("does not prepare a run after contract lookup or CAS fails", async () => {
    const failure = new Error("Definition unavailable");
    const advance = vi.fn();
    const editor = createGeneratorDraftEditor({ projectId: "project", initial,
      client: { advanceGenerator: advance, getDefinition: async () => { throw failure; } } });
    await expect(editor.prepare((before) => before)).rejects.toThrow(failure);
    expect(advance).not.toHaveBeenCalled();
    await expect(editor.flush()).rejects.toThrow(failure);

    const stale = new Error("Read again");
    const conflicted = createGeneratorDraftEditor({ projectId: "project", initial, client: {
      getDefinition: async () => ({ definition: { ...definitionRef, version: "next" } }),
      advanceGenerator: async () => { throw stale; },
    } });
    await expect(conflicted.prepare((before) => before)).rejects.toThrow(stale);
    await expect(conflicted.flush()).rejects.toThrow(stale);
  });

  it("submits an explicit Canvas projection even when the native input was already attached", async () => {
    const advance = vi.fn(async (_projectId: string, _generatorId: string, input: AdvanceInput) => accepted(input));
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance } });
    const connections = [{ canvasId: "main", sourceNodeId: "source", targetNodeId: "target", asset: { kind: "media" as const, projectAssetId: "reference-image" } }];
    await editor.edit({}, undefined, connections);
    expect(advance).toHaveBeenCalledWith("project", initial.generator.id, expect.objectContaining({
      state: initial.revision.state, persistentInputRefs: initial.revision.persistentInputRefs, canvasInputConnections: connections,
    }));
  });
  it("serializes input edits with prompt edits against the acknowledged input list", async () => {
    const advance = vi.fn(async (_projectId: string, _generatorId: string, input: AdvanceInput) => accepted(input));
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance } });
    const added = { slot: "video", itemKey: "clip", target: { kind: "media" as const, projectAssetId: "video-reference" } };
    const first = editor.edit({}, (refs) => [...refs, added]);
    const second = editor.edit({ prompt: "New prompt" });
    const third = editor.edit({}, (refs) => refs.filter((ref) => ref.slot !== "image"));
    await Promise.all([first, second, third]);
    const final = await editor.flush();
    expect(final.revision.persistentInputRefs).toEqual([added]);
    expect(final.revision.state.prompt).toBe("New prompt");
    expect(advance.mock.calls[1]![2].persistentInputRefs).toEqual([...initial.revision.persistentInputRefs, added]);
    expect(advance.mock.calls[2]![2].expectedHeadRevisionId).toBe(advance.mock.calls[1]![2].generatorRevisionId);
  });
  it("reuses the current revision when the requested state is unchanged", async () => {
    const advance = vi.fn(async () => { throw new Error("An unchanged draft must not advance"); });
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance } });
    expect(await editor.edit(structuredClone(initial.revision.state))).toEqual(initial);
    expect(await editor.flush()).toEqual(initial);
    expect(advance).not.toHaveBeenCalled();
  });

  it("serializes edits against accepted revisions and flushes only after the last acknowledgement", async () => {
    let release!: (value: unknown) => void;
    const advance = vi.fn(async (_projectId: string, _generatorId: string, input: AdvanceInput): Promise<unknown> => {
      if (advance.mock.calls.length === 1) return new Promise((resolve) => { release = resolve; });
      return accepted(input);
    });
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance } });
    const first = editor.edit({ prompt: "Latest prompt" });
    const second = editor.edit({ params: { resolution: "768P", duration: 5 } });
    let flushed = false;
    const flush = editor.flush().then((value) => { flushed = true; return value; });
    await vi.waitFor(() => expect(advance).toHaveBeenCalled());
    expect(flushed).toBe(false);
    const firstRequest = advance.mock.calls[0]![2];
    expect(firstRequest.expectedHeadRevisionId).toBe(initial.revision.id);
    release(accepted(firstRequest));
    await first;
    const final = await second;
    expect(await flush).toEqual(final);
    const secondRequest = advance.mock.calls[1]![2];
    expect(secondRequest.expectedHeadRevisionId).toBe(firstRequest.generatorRevisionId);
    expect(secondRequest.state).toEqual({ ...initial.revision.state, prompt: "Latest prompt", params: { resolution: "768P", duration: 5 } });
    expect(secondRequest.persistentInputRefs).toEqual(initial.revision.persistentInputRefs);
    expect(initial.revision.state.prompt).toBe("Before edit");
  });

  it("does not submit later edits or allow flush after a rejected save", async () => {
    const failure = new Error("Stale Generator head: read again");
    const advance = vi.fn(async () => { throw failure; });
    const editor = createGeneratorDraftEditor({ projectId: "project", initial, client: { advanceGenerator: advance } });
    const results = await Promise.allSettled([editor.edit({ prompt: "First" }), editor.edit({ prompt: "Second" }), editor.flush()]);
    expect(results.every((result) => result.status === "rejected" && result.reason === failure)).toBe(true);
    expect(advance.mock.calls).toHaveLength(1);
  });

  it("rejects a response naming a different revision instead of silently rotating CAS evidence", async () => {
    const editor = createGeneratorDraftEditor({ projectId: "project", initial,
      client: { advanceGenerator: async () => initial } });
    await expect(editor.edit({ prompt: "Changed" })).rejects.toThrow(/acknowledg/i);
    await expect(editor.flush()).rejects.toThrow(/acknowledg/i);
  });
});
