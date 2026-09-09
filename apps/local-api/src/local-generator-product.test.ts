import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
import type {
  ExecutablePluginGeneratorRegistration,
  GeneratorDefinition,
} from "@clash/shared-types";
import {
  commitActionRunOutcome,
  createProjectAsset,
  ensureActionRunRequest,
  ensureOutputCommit,
  readGeneratorRevision,
  readProjectActionRun,
  resolveOutputCommitAssetType,
} from "@clash/shared-types";

import { createLocalApiApp } from "./app.js";
import { createSqliteDurableRunJournal } from "./durable-run-journal.js";
import { FileReplicaStore } from "./loro/file-replica-store.js";
import { LocalLoroRoomHub } from "./sync.js";
import {
  buildLocalGeneratorDurableRunCommand,
  buildLocalGeneratorDurableRunCommands,
  createLocalGeneratorProductService,
} from "./local-generator-product.js";
import type { BuiltLocalGeneratorActionRun } from "./local-generator-contract.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "clash-generator-product-"));
  temporaryDirectories.push(directory);
  return directory;
}

const definition: GeneratorDefinition = {
  pluginId: "clash.codex-imagegen",
  definitionId: "codex-imagegen",
  version: "0.1.0",
  schemaHash: `sha256:${"a".repeat(64)}`,
  stateSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1 },
      aspect_ratio: { type: "string", enum: ["1:1", "16:9"] },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  editPolicy: "fork-when-materialized",
  persistentInputs: [
    {
      slot: "image",
      accepts: [{ kind: "media", mediaKind: "image" }],
      cardinality: { minItems: 0, maxItems: 5 },
    },
  ],
  actions: [
    {
      id: "generate",
      executorExportId: "generate-image",
      parametersSchema: { type: "object", additionalProperties: false },
      invocationInputs: [],
      outputs: [
        {
          slot: "image",
          assetType: { kind: "media", mediaKind: "image" },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    },
  ],
};

const registration: ExecutablePluginGeneratorRegistration = {
  pluginId: definition.pluginId,
  version: definition.version,
  schemaHash: definition.schemaHash,
  document: {
    apiVersion: "clash.generator/v1",
    kind: "generator",
    spec: {
      definitionId: definition.definitionId,
      stateSchema: definition.stateSchema,
      editPolicy: definition.editPolicy,
      persistentInputs: definition.persistentInputs,
      actions: definition.actions,
    },
  },
};

const stageDefinition: GeneratorDefinition = {
  pluginId: "clash.stage",
  definitionId: "director-stage",
  version: "1.0.0",
  schemaHash: `sha256:${"b".repeat(64)}`,
  stateSchema: {
    type: "object",
    properties: { scene: { type: "string", minLength: 1 } },
    required: ["scene"],
    additionalProperties: false,
  },
  editPolicy: "advance-head",
  persistentInputs: [],
  actions: [
    {
      id: "render-still",
      executorExportId: "render-still",
      parametersSchema: { type: "object", additionalProperties: false },
      invocationInputs: [],
      outputs: [
        {
          slot: "image",
          assetType: { kind: "media", mediaKind: "image" },
          cardinality: { minItems: 1, maxItems: 1 },
        },
      ],
    },
  ],
};

describe("Local Generator product surface", () => {
  it("lists and resolves only Host-owned semantic definitions", async () => {
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      listPluginGenerators: async () => [registration],
      resolveGeneratorDefinition: async () => definition,
    } as Parameters<typeof createLocalApiApp>[0]);

    const listed = await app.request("/api/v1/generator-definitions");
    expect(listed.status, await listed.clone().text()).toBe(200);
    await expect(listed.json()).resolves.toEqual({ definitions: [definition] });

    const read = await app.request(
      "/api/v1/generator-definitions/clash.codex-imagegen/codex-imagegen",
    );
    expect(read.status, await read.clone().text()).toBe(200);
    const readBody = await read.json();
    expect(readBody).toEqual({ definition });
    expect(JSON.stringify(readBody)).not.toContain("runtime");
  });

  it("creates and reads a Project Generator whose definition provenance is Host-derived", async () => {
    const doc = new LoroDoc();
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      resolveGeneratorDefinition: async () => definition,
      generatorProjectAuthority: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) =>
          mutation(doc, async () => undefined),
      },
    } as Parameters<typeof createLocalApiApp>[0]);

    const created = await app.request("/api/v1/projects/project-1/generators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generatorId: "imagegen-1",
        generatorRevisionId: "imagegen-1:r1",
        pluginId: "clash.codex-imagegen",
        definitionId: "codex-imagegen",
        state: { prompt: "a paper lighthouse", aspect_ratio: "16:9" },
        persistentInputRefs: [],
      }),
    });

    expect(created.status, await created.clone().text()).toBe(201);
    await expect(created.json()).resolves.toEqual({
      generator: {
        id: "imagegen-1",
        headRevisionId: "imagegen-1:r1",
        definitionRef: {
          pluginId: definition.pluginId,
          definitionId: definition.definitionId,
          version: definition.version,
          schemaHash: definition.schemaHash,
        },
      },
      revision: {
        id: "imagegen-1:r1",
        generatorId: "imagegen-1",
        definitionRef: {
          pluginId: definition.pluginId,
          definitionId: definition.definitionId,
          version: definition.version,
          schemaHash: definition.schemaHash,
        },
        state: { prompt: "a paper lighthouse", aspect_ratio: "16:9" },
        persistentInputRefs: [],
      },
    });

    const read = await app.request(
      "/api/v1/projects/project-1/generators/imagegen-1",
    );
    expect(read.status, await read.clone().text()).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      generator: { id: "imagegen-1", headRevisionId: "imagegen-1:r1" },
      revision: { id: "imagegen-1:r1", generatorId: "imagegen-1" },
    });
  });

  it("advances a Stage head under the Host-derived edit policy and preserves its old revision", async () => {
    const doc = new LoroDoc();
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      resolveGeneratorDefinition: async () => stageDefinition,
      generatorProjectAuthority: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) =>
          mutation(doc, async () => undefined),
      },
    } as Parameters<typeof createLocalApiApp>[0]);
    const collection = "/api/v1/projects/project-1/generators";
    const created = await app.request(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generatorId: "stage-1",
        generatorRevisionId: "stage-1:r1",
        pluginId: stageDefinition.pluginId,
        definitionId: stageDefinition.definitionId,
        state: { scene: "courtyard" },
        persistentInputRefs: [],
      }),
    });
    expect(created.status).toBe(201);

    const advanced = await app.request(`${collection}/stage-1/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedHeadRevisionId: "stage-1:r1",
        generatorRevisionId: "stage-1:r2",
        state: { scene: "courtyard at night" },
        persistentInputRefs: [],
      }),
    });

    expect(advanced.status, await advanced.clone().text()).toBe(201);
    await expect(advanced.json()).resolves.toMatchObject({
      generator: { id: "stage-1", headRevisionId: "stage-1:r2" },
      revision: {
        id: "stage-1:r2",
        parentRevisionId: "stage-1:r1",
        state: { scene: "courtyard at night" },
        definitionRef: {
          pluginId: stageDefinition.pluginId,
          definitionId: stageDefinition.definitionId,
          version: stageDefinition.version,
          schemaHash: stageDefinition.schemaHash,
        },
      },
    });
    expect(
      readGeneratorRevision(doc, {
        generatorId: "stage-1",
        generatorRevisionId: "stage-1:r1",
      }),
    ).toMatchObject({ state: { scene: "courtyard" } });

    const spoofedPolicy = await app.request(`${collection}/stage-1/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedHeadRevisionId: "stage-1:r2",
        generatorRevisionId: "stage-1:r3",
        state: { scene: "spoofed" },
        persistentInputRefs: [],
        editPolicy: "fork-when-materialized",
        definitionRef: { pluginId: "attacker.shadow" },
      }),
    });
    expect(spoofedPolicy.status).toBe(400);
    expect(
      readGeneratorRevision(doc, {
        generatorId: "stage-1",
        generatorRevisionId: "stage-1:r3",
      }),
    ).toBeNull();
  });

  it("returns copy-on-write for a materialized Codex head and accepts the fork through create", async () => {
    const doc = new LoroDoc();
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      resolveGeneratorDefinition: async () => definition,
      generatorProjectAuthority: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) =>
          mutation(doc, async () => undefined),
      },
    } as Parameters<typeof createLocalApiApp>[0]);
    const collection = "/api/v1/projects/project-1/generators";
    const initialState = { prompt: "a paper lighthouse", aspect_ratio: "16:9" };
    expect(
      (
        await app.request(collection, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            generatorId: "imagegen-materialized",
            generatorRevisionId: "imagegen-materialized:r1",
            pluginId: definition.pluginId,
            definitionId: definition.definitionId,
            state: initialState,
            persistentInputRefs: [],
          }),
        })
      ).status,
    ).toBe(201);
    expect(
      ensureActionRunRequest(doc, {
        actionRunId: "run-materialized",
        generatorRevision: {
          generatorId: "imagegen-materialized",
          generatorRevisionId: "imagegen-materialized:r1",
        },
        actionId: "generate",
        executor: {
          pluginId: definition.pluginId,
          version: definition.version,
          exportId: "generate-image",
          schemaHash: definition.schemaHash,
        },
        invocationFingerprint: `sha256:${"c".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [],
        outputContract: definition.actions[0]!.outputs,
      }),
    ).toMatchObject({ ok: true });

    const blocked = await app.request(
      `${collection}/imagegen-materialized/revisions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedHeadRevisionId: "imagegen-materialized:r1",
          generatorRevisionId: "imagegen-materialized:r2",
          state: { ...initialState, prompt: "a blue paper lighthouse" },
          persistentInputRefs: [],
        }),
      },
    );
    expect(blocked.status, await blocked.clone().text()).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "GENERATOR_FORK_REQUIRED",
      copyOnWrite: {
        required: true,
        forkedFrom: {
          generatorId: "imagegen-materialized",
          generatorRevisionId: "imagegen-materialized:r1",
        },
      },
    });
    expect(
      readGeneratorRevision(doc, {
        generatorId: "imagegen-materialized",
        generatorRevisionId: "imagegen-materialized:r2",
      }),
    ).toBeNull();

    const forked = await app.request(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generatorId: "imagegen-fork",
        generatorRevisionId: "imagegen-fork:r1",
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: { ...initialState, prompt: "a blue paper lighthouse" },
        persistentInputRefs: [],
        forkedFrom: {
          generatorId: "imagegen-materialized",
          generatorRevisionId: "imagegen-materialized:r1",
        },
      }),
    });
    expect(forked.status, await forked.clone().text()).toBe(201);
    await expect(forked.json()).resolves.toMatchObject({
      generator: { id: "imagegen-fork", headRevisionId: "imagegen-fork:r1" },
      revision: {
        forkedFrom: {
          generatorId: "imagegen-materialized",
          generatorRevisionId: "imagegen-materialized:r1",
        },
      },
    });
  });

  it("rejects invalid initial state and client-supplied definition provenance", async () => {
    const doc = new LoroDoc();
    const app = createLocalApiApp({
      dataDir: await dataDir(),
      resolveGeneratorDefinition: async () => definition,
      generatorProjectAuthority: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) =>
          mutation(doc, async () => undefined),
      },
    } as Parameters<typeof createLocalApiApp>[0]);
    const base = {
      generatorId: "imagegen-invalid",
      generatorRevisionId: "imagegen-invalid:r1",
      pluginId: definition.pluginId,
      definitionId: definition.definitionId,
      state: { prompt: "" },
      persistentInputRefs: [],
    };

    const invalidState = await app.request(
      "/api/v1/projects/project-1/generators",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(base),
      },
    );
    expect(invalidState.status, await invalidState.clone().text()).toBe(422);
    await expect(invalidState.json()).resolves.toMatchObject({
      error: expect.stringMatching(/state.*prompt/i),
    });

    const spoofed = await app.request("/api/v1/projects/project-1/generators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...base,
        state: { prompt: "valid" },
        definitionRef: {
          pluginId: "attacker.shadow",
          definitionId: "shadow",
          version: "9.9.9",
          schemaHash: `sha256:${"f".repeat(64)}`,
        },
      }),
    });
    expect(spoofed.status).toBe(400);

    const malformedReference = await app.request(
      "/api/v1/projects/project-1/generators",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...base,
          state: { prompt: "valid" },
          persistentInputRefs: [{ slot: "image", target: { kind: "media" } }],
        }),
      },
    );
    expect(
      malformedReference.status,
      await malformedReference.clone().text(),
    ).toBe(400);
  });

  it("persists public Run intent before the private task, wakes work, and reads the exact output winner", async () => {
    const directory = await dataDir();
    const doc = new LoroDoc();
    const journal = createSqliteDurableRunJournal(directory);
    const checkpoints: Array<{
      status: string | null;
      privateTaskExists: boolean;
    }> = [];
    const processProjectWork = vi.fn(async () => undefined);
    const app = createLocalApiApp({
      dataDir: directory,
      userId: "local-user",
      resolveGeneratorDefinition: async () => definition,
      processProjectWork,
      generatorProjectAuthority: {
        inspect: async (_projectId, read) => read(doc),
        mutate: async (_projectId, mutation) =>
          mutation(doc, async () => {
            const run = readProjectActionRun(doc, "run-imagegen-1");
            const task = await journal.load({
              actionRunId: "run-imagegen-1",
              outputSlot: "image",
            });
            checkpoints.push({
              status: run?.status ?? null,
              privateTaskExists: task !== undefined,
            });
          }),
      },
    } as Parameters<typeof createLocalApiApp>[0]);

    const created = await app.request("/api/v1/projects/project-1/generators", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generatorId: "imagegen-1",
        generatorRevisionId: "imagegen-1:r1",
        pluginId: definition.pluginId,
        definitionId: definition.definitionId,
        state: { prompt: "a paper lighthouse", aspect_ratio: "16:9" },
        persistentInputRefs: [],
      }),
    });
    expect(created.status).toBe(201);
    checkpoints.length = 0;

    const spoofedSubmission = await app.request(
      "/api/v1/projects/project-1/generators/imagegen-1/actions/generate/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionRunId: "run-imagegen-spoofed",
          generatorRevisionId: "imagegen-1:r1",
          parameters: {},
          invocationInputRefs: [],
          definitionRef: { pluginId: "attacker.shadow" },
          executor: { pluginId: "attacker.shadow", exportId: "steal" },
          outputContract: [],
          invocationFingerprint: `sha256:${"f".repeat(64)}`,
          realm: "process-stdio",
        }),
      },
    );
    expect(spoofedSubmission.status).toBe(400);
    expect(readProjectActionRun(doc, "run-imagegen-spoofed")).toBeNull();

    const submitted = await app.request(
      "/api/v1/projects/project-1/generators/imagegen-1/actions/generate/runs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actionRunId: "run-imagegen-1",
          generatorRevisionId: "imagegen-1:r1",
          parameters: {},
          invocationInputRefs: [],
        }),
      },
    );

    expect(submitted.status, await submitted.clone().text()).toBe(202);
    await expect(submitted.json()).resolves.toMatchObject({
      run: {
        actionRunId: "run-imagegen-1",
        actionId: "generate",
        status: "running",
        executor: {
          pluginId: definition.pluginId,
          version: definition.version,
          exportId: "generate-image",
          schemaHash: definition.schemaHash,
        },
      },
    });
    expect(checkpoints).toEqual([
      { status: "pending", privateTaskExists: false },
      { status: "running", privateTaskExists: true },
    ]);

    const task = await journal.load({
      actionRunId: "run-imagegen-1",
      outputSlot: "image",
    });
    expect(task?.executorInput).toMatchObject({
      targetKind: "generator-action",
      binding: {
        pluginId: definition.pluginId,
        version: definition.version,
        exportId: "generate-image",
        schemaHash: definition.schemaHash,
      },
      actionId: "generate",
      publicOwner: {
        actionId: "imagegen-1",
        actionRevisionId: "imagegen-1:r1",
      },
      kind: "image",
      projectId: "project-1",
      input: {
        values: {
          prompt: "a paper lighthouse",
          aspect_ratio: "16:9",
          __generatorActionId: "generate",
        },
        references: [],
      },
    });
    await vi.waitFor(() =>
      expect(processProjectWork).toHaveBeenCalledWith("project-1"),
    );

    const runRead = await app.request(
      "/api/v1/projects/project-1/generator-runs/run-imagegen-1",
    );
    expect(runRead.status).toBe(200);
    await expect(runRead.json()).resolves.toMatchObject({
      run: { actionRunId: "run-imagegen-1", status: "running" },
    });

    const missingOutput = await app.request(
      "/api/v1/projects/project-1/generator-runs/run-imagegen-1/outputs/image",
    );
    expect(missingOutput.status).toBe(404);

    expect(
      createProjectAsset(doc, {
        id: "asset:imagegen-1",
        kind: "image",
        source: { kind: "owned", resourceId: "resource:imagegen-1" },
        lifecycle: { state: "active" },
        metadata: { contentType: "image/png", width: 1, height: 1 },
      }),
    ).toMatchObject({ ok: true });
    expect(
      ensureOutputCommit(
        doc,
        {
          actionRunId: "run-imagegen-1",
          outputSlot: "image",
          asset: { kind: "media", projectAssetId: "asset:imagegen-1" },
        },
        resolveOutputCommitAssetType,
      ),
    ).toMatchObject({ ok: true });
    expect(
      commitActionRunOutcome(doc, {
        actionRunId: "run-imagegen-1",
        status: "succeeded",
      }),
    ).toMatchObject({ ok: true });

    const output = await app.request(
      "/api/v1/projects/project-1/generator-runs/run-imagegen-1/outputs/image",
    );
    expect(output.status, await output.clone().text()).toBe(200);
    await expect(output.json()).resolves.toEqual({
      commit: {
        actionRunId: "run-imagegen-1",
        outputSlot: "image",
        asset: { kind: "media", projectAssetId: "asset:imagegen-1" },
      },
    });
  });

  it("persists and broadcasts a live-room checkpoint before the mutation continues", async () => {
    const directory = await dataDir();
    const projectId = "checkpointed-generator-project";
    const hub = new LocalLoroRoomHub(directory, undefined, null);
    const peer = new LoroDoc();
    const room = await hub.room(projectId);
    room.addPeer((update) => peer.import(update));
    const store = new FileReplicaStore(join(directory, "projects"));

    await hub.mutateProjectWithCheckpoint(
      projectId,
      async (doc, checkpoint) => {
        doc.getMap("generator-product-test").set("phase", "public-intent");
        await checkpoint();

        const persisted = await store.recover(projectId);
        expect(persisted.getMap("generator-product-test").get("phase")).toBe(
          "public-intent",
        );
        expect(peer.getMap("generator-product-test").get("phase")).toBe(
          "public-intent",
        );
        doc.getMap("generator-product-test").set("phase", "private-created");
        return "done";
      },
    );

    const finalPersisted = await store.recover(projectId);
    expect(finalPersisted.getMap("generator-product-test").get("phase")).toBe(
      "private-created",
    );
    expect(peer.getMap("generator-product-test").get("phase")).toBe(
      "private-created",
    );
    await hub.close();
  });

  it("replays a pending public intent after crashing before private task creation", async () => {
    const directory = await dataDir();
    const durableJournal = createSqliteDurableRunJournal(directory);
    let crashBeforeCreate = true;
    const crashingJournal = {
      ...durableJournal,
      async create(
        run: Parameters<typeof durableJournal.create>[0],
      ): Promise<void> {
        if (crashBeforeCreate) {
          crashBeforeCreate = false;
          throw new Error("simulated crash before private journal create");
        }
        await durableJournal.create(run);
      },
    };
    const firstHub = new LocalLoroRoomHub(directory, undefined, null);
    const firstAuthority = {
      inspect: <T>(
        projectId: string,
        read: (project: LoroDoc) => T | Promise<T>,
      ) => firstHub.inspectProject(projectId, read),
      mutate: <T>(
        projectId: string,
        mutation: (
          project: LoroDoc,
          checkpoint: () => Promise<void>,
        ) => T | Promise<T>,
      ) => firstHub.mutateProjectWithCheckpoint(projectId, mutation),
    };
    const firstHost = createLocalGeneratorProductService({
      authority: firstAuthority,
      resolveDefinition: async () => definition,
      ownerId: "host-1",
      journal: crashingJournal,
      actor: { kind: "user", id: "local-user" },
    });
    await firstHost.create("project-1", {
      generatorId: "imagegen-replay",
      generatorRevisionId: "imagegen-replay:r1",
      pluginId: definition.pluginId,
      definitionId: definition.definitionId,
      state: { prompt: "a resilient lighthouse" },
      persistentInputRefs: [],
    });

    const submission = {
      actionRunId: "run-imagegen-replay",
      generatorRevisionId: "imagegen-replay:r1",
      parameters: {},
      invocationInputRefs: [],
    };
    await expect(
      firstHost.submit("project-1", "imagegen-replay", "generate", submission),
    ).rejects.toThrow(/simulated crash/);
    await firstHub.close();

    const persistedAfterCrash = await new FileReplicaStore(
      join(directory, "projects"),
    ).recover("project-1");
    expect(
      readProjectActionRun(persistedAfterCrash, submission.actionRunId)?.status,
    ).toBe("pending");
    await expect(
      durableJournal.load({
        actionRunId: submission.actionRunId,
        outputSlot: "image",
      }),
    ).resolves.toBeUndefined();

    const recoveredHub = new LocalLoroRoomHub(directory, undefined, null);
    const recoveredHost = createLocalGeneratorProductService({
      authority: {
        inspect: (projectId, read) =>
          recoveredHub.inspectProject(projectId, read),
        mutate: (projectId, mutation) =>
          recoveredHub.mutateProjectWithCheckpoint(projectId, mutation),
      },
      resolveDefinition: async () => definition,
      ownerId: "host-1",
      journal: durableJournal,
      actor: { kind: "user", id: "local-user" },
    });
    const recovered = await recoveredHost.submit(
      "project-1",
      "imagegen-replay",
      "generate",
      submission,
    );

    expect(recovered.status).toBe("running");
    await expect(
      durableJournal.load({
        actionRunId: submission.actionRunId,
        outputSlot: "image",
      }),
    ).resolves.toMatchObject({
      actionRunId: submission.actionRunId,
      phase: "queued",
      executorInput: {
        targetKind: "generator-action",
        binding: { exportId: "generate-image" },
      },
    });
    await recoveredHub.close();
  });

  it("freezes the Host-selected Provider route into the Run request and durable executor input", async () => {
    const directory = await dataDir();
    const journal = createSqliteDurableRunJournal(directory);
    const hub = new LocalLoroRoomHub(directory, undefined, null);
    const authority = {
      inspect: <T>(projectId: string, read: (project: LoroDoc) => T | Promise<T>) =>
        hub.inspectProject(projectId, read),
      mutate: <T>(
        projectId: string,
        mutation: (project: LoroDoc, checkpoint: () => Promise<void>) => T | Promise<T>,
      ) => hub.mutateProjectWithCheckpoint(projectId, mutation),
    };
    const consumerDefinition: GeneratorDefinition = {
      pluginId: "dummy.consumer",
      definitionId: "inspect",
      version: "0.1.0",
      schemaHash: `sha256:${"d".repeat(64)}`,
      stateSchema: { type: "object", additionalProperties: false },
      editPolicy: "advance-head",
      persistentInputs: [],
      actions: [
        {
          id: "inspect",
          executorExportId: "execute",
          selectOutputsByParameter: "categories",
          modelConsumer: { semanticShape: "dummy_analysis", sourceInputSlot: "source" },
          parametersSchema: {
            type: "object",
            properties: { categories: { type: "array", items: { type: "string" } } },
            required: ["categories"],
            additionalProperties: false,
          },
          invocationInputs: [
            {
              slot: "source",
              accepts: [{ kind: "media", mediaKind: "image" }],
              cardinality: { minItems: 1, maxItems: 1 },
            },
          ],
          outputs: [
            {
              slot: "description",
              prompt: "Describe.",
              promptVersion: "v1",
              sourceMediaKinds: ["image"],
              assetType: {
                kind: "document",
                documentKind: "media.analysis.description",
                schemaVersion: 1,
              },
              cardinality: { minItems: 0, maxItems: 1 },
            },
          ],
        },
      ],
    };
    const frozenRoute = {
      providerId: "dummy-provider",
      accountId: "dummy-account",
      upstreamId: "dummy-upstream",
      upstreamModel: "dummy/upstream-model",
      apiShape: "dummy-shape",
      executorPluginId: "dummy.provider",
      executorExportId: "execute",
    };
    const resolveModelConsumer = vi.fn(async () => ({
      modelId: "dummy-card",
      route: frozenRoute,
    }));
    const host = createLocalGeneratorProductService({
      authority,
      resolveDefinition: async () => consumerDefinition,
      ownerId: "host-1",
      journal,
      actor: { kind: "agent", id: "agent-1" },
      resolveModelConsumer,
    });
    await authority.mutate("project-route", async (doc, checkpoint) => {
      expect(
        createProjectAsset(doc, {
          id: "source-image",
          kind: "image",
          source: { kind: "owned", resourceId: `sha256:${"c".repeat(64)}` },
          lifecycle: { state: "active" },
          metadata: { contentType: "image/png" },
        }),
      ).toMatchObject({ ok: true });
      await checkpoint();
    });
    await host.create("project-route", {
      generatorId: "inspector",
      generatorRevisionId: "inspector:r1",
      pluginId: consumerDefinition.pluginId,
      definitionId: consumerDefinition.definitionId,
      state: {},
      persistentInputRefs: [],
    });
    const run = await host.submit("project-route", "inspector", "inspect", {
      actionRunId: "run-route",
      generatorRevisionId: "inspector:r1",
      parameters: { categories: ["description"] },
      invocationInputRefs: [
        { slot: "source", target: { kind: "media", projectAssetId: "source-image" } },
      ],
    });
    expect(run.status).toBe("running");
    expect(resolveModelConsumer).toHaveBeenCalledWith({
      projectId: "project-route",
      consumer: {
        pluginId: "dummy.consumer",
        definitionId: "inspect",
        actionId: "inspect",
      },
      semanticShape: "dummy_analysis",
      sourceKind: "image",
    });
    const persisted = await host.readRun("project-route", "run-route");
    expect(persisted?.modelSelection).toEqual({
      semanticShape: "dummy_analysis",
      modelId: "dummy-card",
      route: frozenRoute,
    });
    const task = await journal.load({
      actionRunId: "run-route",
      outputSlot: "description",
    });
    expect(task?.executorInput).toMatchObject({
      input: {
        values: {
          modelId: "dummy-card",
          modelRoute: frozenRoute,
        },
      },
    });
    await hub.close();
  });
});

describe("buildLocalGeneratorDurableRunCommand", () => {
  it("creates one durable task per selected output and narrows each plugin invocation", () => {
    const doc = new LoroDoc();
    expect(createProjectAsset(doc, {
      id: "source",
      kind: "video",
      source: { kind: "owned", resourceId: "resource-source" },
      lifecycle: { state: "active" },
      metadata: { contentType: "video/mp4" },
    })).toMatchObject({ ok: true });
    const outputs = ["description", "tags"].map((slot) => ({
      slot,
      assetType: { kind: "document" as const, documentKind: `media.analysis.${slot}`, schemaVersion: 1 },
      cardinality: { minItems: 1, maxItems: 1 },
    }));
    const built = {
      definition: {} as GeneratorDefinition,
      revision: {
        id: "analysis:r1",
        generatorId: "analysis",
        definitionRef: { pluginId: "clash.media-analysis", definitionId: "media-analysis", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` },
        state: { modelId: "vlm" },
        persistentInputRefs: [],
      },
      action: {
        id: "analyze",
        executorExportId: "analyze",
        selectOutputsByParameter: "categories",
        parametersSchema: {},
        invocationInputs: [],
        outputs,
      },
      request: {
        actionRunId: "analysis-run",
        generatorRevision: { generatorId: "analysis", generatorRevisionId: "analysis:r1" },
        actionId: "analyze",
        executor: { pluginId: "clash.media-analysis", version: "0.1.0", exportId: "analyze", schemaHash: `sha256:${"a".repeat(64)}` },
        invocationFingerprint: `sha256:${"b".repeat(64)}`,
        parameters: {
          categories: ["description", "tags"],
          source: { projectAssetId: "source", resourceHash: `sha256:${"c".repeat(64)}`, kind: "video" },
          generatorRevisionId: "analysis:r1",
          actionRunId: "analysis-run",
        },
        invocationInputRefs: [{ slot: "source", target: { kind: "media" as const, projectAssetId: "source" } }],
        outputContract: outputs,
      },
    } as BuiltLocalGeneratorActionRun;
    const commands = buildLocalGeneratorDurableRunCommands({
      doc, projectId: "project-1", built, actor: { kind: "agent", id: "agent-1" }, deadlineAt: Date.now() + 1_000,
    });
    expect(commands.map((command) => command.outputSlot)).toEqual(["description", "tags"]);
    expect(commands.map((command) => command.executor.input.values.categories)).toEqual([["description"], ["tags"]]);
    expect(commands.every((command) => command.executor.generatorOutputContract === built.request.outputContract)).toBe(true);
  });

  it("derives model/source/run lineage from frozen authorities rather than caller parameters", () => {
    const doc = new LoroDoc();
    expect(createProjectAsset(doc, {
      id: "source",
      kind: "video",
      source: { kind: "owned", resourceId: `sha256:${"c".repeat(64)}` },
      lifecycle: { state: "active" },
      metadata: { contentType: "video/mp4" },
    })).toMatchObject({ ok: true });
    const output = {
      slot: "description",
      prompt: "Describe.",
      promptVersion: "v1",
      sourceMediaKinds: ["video" as const],
      assetType: { kind: "document" as const, documentKind: "media.analysis.description", schemaVersion: 1 },
      cardinality: { minItems: 1, maxItems: 1 },
    };
    const built = {
      definition: {} as GeneratorDefinition,
      revision: {
        id: "analysis:r1",
        generatorId: "analysis",
        definitionRef: { pluginId: "dummy.consumer", definitionId: "inspect", version: "0.1.0", schemaHash: `sha256:${"a".repeat(64)}` },
        state: {},
        persistentInputRefs: [],
      },
      action: {
        id: "inspect",
        executorExportId: "execute",
        selectOutputsByParameter: "categories",
        modelConsumer: { semanticShape: "media_analysis", sourceInputSlot: "source" },
        parametersSchema: {},
        invocationInputs: [],
        outputs: [output],
      },
      request: {
        actionRunId: "analysis-run",
        generatorRevision: { generatorId: "analysis", generatorRevisionId: "analysis:r1" },
        actionId: "inspect",
        executor: { pluginId: "dummy.consumer", version: "0.1.0", exportId: "execute", schemaHash: `sha256:${"a".repeat(64)}` },
        invocationFingerprint: `sha256:${"b".repeat(64)}`,
        parameters: { categories: ["description"] },
        invocationInputRefs: [{ slot: "source", target: { kind: "media" as const, projectAssetId: "source" } }],
        outputContract: [output],
      },
    } as BuiltLocalGeneratorActionRun;

    const [command] = buildLocalGeneratorDurableRunCommands({
      doc,
      projectId: "project-1",
      built,
      actor: { kind: "agent", id: "agent-1" },
      deadlineAt: Date.now() + 1_000,
      modelId: "settings-card",
    });
    expect(command?.executor.input.values).toMatchObject({
      modelId: "settings-card",
      source: {
        projectAssetId: "source",
        resourceHash: `sha256:${"c".repeat(64)}`,
        kind: "video",
      },
      generatorRevisionId: "analysis:r1",
      actionRunId: "analysis-run",
    });
    const question = "Which shot should I use to establish the location?";
    built.action.outputs[0]!.promptParameter = "prompt";
    built.request.parameters = { categories: ["description"], prompt: question };
    const [freeform] = buildLocalGeneratorDurableRunCommands({
      doc, projectId: "project-1", built, actor: { kind: "agent", id: "agent-1" },
      deadlineAt: Date.now() + 1_000, modelId: "settings-card",
    });
    expect(freeform?.executor.input.values.modelConsumer).toMatchObject({
      outputs: [{ slot: "description", prompt: question, responseFormat: "text" }],
    });
  });

  it("gives a model media output a GLB delivery name", () => {
    const built = {
      definition: {} as GeneratorDefinition,
      revision: {
        id: "humanoid-retarget:r1",
        generatorId: "humanoid-retarget",
        definitionRef: {
          pluginId: "clash.tripo",
          definitionId: "humanoid-retarget",
          version: "0.1.0",
          schemaHash: `sha256:${"a".repeat(64)}`,
        },
        state: {},
        persistentInputRefs: [],
      },
      action: {
        id: "retarget",
        executorExportId: "retarget",
        parametersSchema: {},
        invocationInputs: [],
        outputs: [
          {
            slot: "model",
            assetType: { kind: "media" as const, mediaKind: "model" as const },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
      request: {
        actionRunId: "run-model-output",
        generatorRevision: {
          generatorId: "humanoid-retarget",
          generatorRevisionId: "humanoid-retarget:r1",
        },
        actionId: "retarget",
        executor: {
          pluginId: "clash.tripo",
          version: "0.1.0",
          exportId: "retarget",
          schemaHash: `sha256:${"b".repeat(64)}`,
        },
        invocationFingerprint: `sha256:${"c".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [],
        outputContract: [
          {
            slot: "model",
            assetType: { kind: "media" as const, mediaKind: "model" as const },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
      },
    } as BuiltLocalGeneratorActionRun;

    const command = buildLocalGeneratorDurableRunCommand({
      doc: new LoroDoc(),
      projectId: "project-1",
      built,
      actor: { kind: "system" },
      deadlineAt: Date.now() + 1_000,
    });

    expect(command.executor.delivery).toMatchObject({
      name: "humanoid-retarget-run-model-output.glb",
    });
    expect(command.executor.delivery?.name).not.toMatch(/\.wav$/);
  });

  it("encodes a generic collection item ref's itemKey into the plugin reference slot", () => {
    const doc = new LoroDoc();
    expect(
      createProjectAsset(doc, {
        id: "asset:clip-1",
        kind: "video",
        source: { kind: "owned", resourceId: "resource:clip-1" },
        lifecycle: { state: "active" },
        metadata: { contentType: "video/mp4" },
      }),
    ).toMatchObject({ ok: true });

    const timelineDefinition: GeneratorDefinition = {
      pluginId: "clash.remotion",
      definitionId: "timeline",
      version: "0.1.0",
      schemaHash: `sha256:${"b".repeat(64)}`,
      stateSchema: {
        type: "object",
        properties: { timeline: { type: "object" } },
        required: ["timeline"],
        additionalProperties: false,
      },
      editPolicy: "advance-head",
      persistentInputs: [
        {
          slot: "timeline:item",
          accepts: [
            { kind: "media", mediaKind: "video" },
            { kind: "media", mediaKind: "image" },
            { kind: "media", mediaKind: "audio" },
          ],
          cardinality: { minItems: 0, maxItems: null },
        },
      ],
      actions: [
        {
          id: "render",
          executorExportId: "render-timeline",
          parametersSchema: { type: "object", additionalProperties: false },
          invocationInputs: [],
          outputs: [
            {
              slot: "render:output",
              assetType: { kind: "media", mediaKind: "video" },
              cardinality: { minItems: 1, maxItems: 1 },
            },
          ],
        },
      ],
      projectionSurface: {
        id: "clash.timeline",
        stateKey: "timeline",
        mediaInputSlot: "timeline:item",
        primaryActionId: "render",
      },
    };

    const timelineEnvelope = {
      name: "Timeline",
      owner: { kind: "project" as const },
      state: { tracks: [] },
    };
    const built: BuiltLocalGeneratorActionRun = {
      definition: timelineDefinition,
      revision: {
        id: "timeline-1:r1",
        generatorId: "timeline-1",
        definitionRef: {
          pluginId: timelineDefinition.pluginId,
          definitionId: timelineDefinition.definitionId,
          version: timelineDefinition.version,
          schemaHash: timelineDefinition.schemaHash,
        },
        state: { timeline: timelineEnvelope },
        persistentInputRefs: [
          {
            slot: "timeline:item",
            itemKey: "clip-1",
            target: { kind: "media", projectAssetId: "asset:clip-1" },
          },
        ],
      },
      action: timelineDefinition.actions[0]!,
      request: {
        actionRunId: "run-timeline-1",
        generatorRevision: {
          generatorId: "timeline-1",
          generatorRevisionId: "timeline-1:r1",
        },
        actionId: "render",
        executor: {
          pluginId: timelineDefinition.pluginId,
          version: timelineDefinition.version,
          exportId: "render-timeline",
          schemaHash: timelineDefinition.schemaHash,
        },
        invocationFingerprint: `sha256:${"c".repeat(64)}`,
        parameters: {},
        invocationInputRefs: [],
        outputContract: timelineDefinition.actions[0]!.outputs,
      },
    };

    const command = buildLocalGeneratorDurableRunCommand({
      doc,
      projectId: "project-1",
      built,
      actor: { kind: "system" },
      deadlineAt: Date.now() + 1000,
    });

    expect(command.executor.input).toMatchObject({
      values: { timeline: timelineEnvelope },
      references: [
        {
          slot: "timeline:item:clip-1",
          index: 0,
          asset: { assetId: "asset:clip-1" },
        },
      ],
    });
  });
});
