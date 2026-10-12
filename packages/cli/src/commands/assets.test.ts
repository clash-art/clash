import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  lstat,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetsCommand,
  fetchProjectAssetRecord,
  fetchProjectAssetReferences,
  importAssetFile,
  linkAssetIntoProject,
  listProjectAssetRecords,
  replaceAssetFile,
  resolveAssetLinkName,
  restoreProjectAsset,
  trashProjectAsset,
  preassignImportAssetId,
} from "./assets";
import * as assetCommands from "./assets";
import type {
  AssetImportFile,
  PersonalGlobalAssetHostClient,
  ProjectAssetHostClient,
} from "@clash/shared-runtime/project-asset-client";
import { initProject } from "./projects";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "clash-assets-link-"));
}

test("assets command registers link subcommand", () => {
  assert.equal(assetsCommand.name(), "assets");
  assert.deepEqual(
    assetsCommand.commands.map((command) => command.name()),
    [
      "list",
      "get",
      "link",
      "import",
      "replace",
      "refs",
      "admit",
      "publish",
      "delete",
      "restore",
      "global",
      "metadata",
    ],
  );
  const global = assetsCommand.commands.find(
    (command) => command.name() === "global",
  );
  assert.ok(global);
  assert.deepEqual(
    global.commands.map((command) => command.name()),
    ["list", "get", "import", "delete", "restore"],
  );
  const globalImport = global.commands.find(
    (command) => command.name() === "import",
  );
  assert.ok(globalImport);
  assert.ok(
    globalImport.options.some((option) => option.long === "--asset-id"),
  );
  const get = assetsCommand.commands.find(
    (command) => command.name() === "get",
  );
  assert.ok(get);
  assert.ok(get.options.some((option) => option.long === "--asset"));
  assert.ok(get.options.some((option) => option.long === "--project"));
  const replace = assetsCommand.commands.find(
    (command) => command.name() === "replace",
  );
  assert.ok(replace);
  assert.ok(!replace.options.some((option) => option.long === "--if-match"));
  assert.ok(!replace.options.some((option) => option.long === "--force"));
  const importFile = assetsCommand.commands.find(
    (command) => command.name() === "import",
  );
  assert.ok(importFile);
  assert.ok(importFile.options.some((option) => option.long === "--asset-id"));
  const refs = assetsCommand.commands.find(
    (command) => command.name() === "refs",
  );
  assert.ok(refs);
  assert.ok(refs.options.some((option) => option.long === "--asset"));
  assert.ok(refs.options.some((option) => option.long === "--project"));
  assert.ok(!refs.options.some((option) => option.long === "--refresh"));
  const remove = assetsCommand.commands.find(
    (command) => command.name() === "delete",
  );
  assert.ok(remove);
  assert.ok(remove.options.some((option) => option.long === "--yes"));
  assert.ok(!remove.options.some((option) => option.long === "--force"));
  assert.ok(!remove.options.some((option) => option.long === "--if-match"));
  assert.ok(!remove.options.some((option) => option.long === "--read-token"));
  const restore = assetsCommand.commands.find(
    (command) => command.name() === "restore",
  );
  assert.ok(restore);
  assert.ok(!restore.options.some((option) => option.long === "--force"));
  assert.ok(!restore.options.some((option) => option.long === "--if-match"));
  assert.ok(!restore.options.some((option) => option.long === "--read-token"));
});

test("CLI preserves an explicit import identity for an unknown-result replay", () => {
  assert.equal(
    preassignImportAssetId(" asset:retry-command ", "asset"),
    "asset:retry-command",
  );
  assert.equal(
    preassignImportAssetId(" global:retry-command ", "global"),
    "global:retry-command",
  );
});

test("global asset list and read use the personal-library client without Project scope", async () => {
  const calls: unknown[] = [];
  const globalAsset = {
    id: "global:one",
    kind: "image" as const,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
    metadata: { bytes: 4, contentType: "image/png" },
  };
  const module = assetCommands as unknown as {
    listPersonalGlobalAssetRecords?: (options: {
      client: {
        list(): Promise<(typeof globalAsset)[]>;
      };
    }) => Promise<(typeof globalAsset)[]>;
    fetchPersonalGlobalAssetRecord?: (options: {
      globalAssetId: string;
      client: {
        get(input: { globalAssetId: string }): Promise<typeof globalAsset>;
      };
    }) => Promise<typeof globalAsset>;
  };

  assert.equal(typeof module.listPersonalGlobalAssetRecords, "function");
  assert.equal(typeof module.fetchPersonalGlobalAssetRecord, "function");
  if (
    !module.listPersonalGlobalAssetRecords ||
    !module.fetchPersonalGlobalAssetRecord
  )
    return;
  const client = {
    async list() {
      calls.push({ method: "list" });
      return [globalAsset];
    },
    async get(input: { globalAssetId: string }) {
      calls.push({ method: "get", input });
      return globalAsset;
    },
  };

  assert.deepEqual(await module.listPersonalGlobalAssetRecords({ client }), [
    globalAsset,
  ]);
  assert.deepEqual(
    await module.fetchPersonalGlobalAssetRecord({
      globalAssetId: "global:one",
      client,
    }),
    globalAsset,
  );
  assert.deepEqual(calls, [
    { method: "list" },
    { method: "get", input: { globalAssetId: "global:one" } },
  ]);
});

/**
 * A file past 4 GiB that occupies no disk, or null where the filesystem cannot
 * make one. `fs.openAsBlob` reports such a file's size modulo 2^32.
 */
async function sparseFileOver4GiB(path: string): Promise<number | null> {
  const byteLength = 4608 * 1024 * 1024;
  try {
    await writeFile(path, "");
    await truncate(path, byteLength);
    const info = await stat(path);
    if (info.size === byteLength && info.blocks * 512 < byteLength) {
      return byteLength;
    }
  } catch {
    // Fall through: no sparse file here.
  }
  await rm(path, { force: true });
  return null;
}

/** Reads the file-backed source an import handed to its client back as plain facts. */
async function sentFile<T extends { file: AssetImportFile }>(input: T) {
  const { file, ...command } = input;
  return {
    ...command,
    contentType: file.type,
    bytes: Array.from(
      new Uint8Array(await new Response(file.stream()).arrayBuffer()),
    ),
  };
}

test("global asset import sends local bytes through the personal-library client", async () => {
  const source = join(await tempDir(), "voice.mp3");
  await writeFile(source, new Uint8Array([4, 5, 6]));
  const calls: unknown[] = [];
  const globalAsset = {
    id: "global:voice",
    kind: "audio" as const,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
    metadata: { bytes: 3, contentType: "audio/mpeg" },
  };
  const importGlobal = (
    assetCommands as unknown as {
      importPersonalGlobalAssetFile?: (options: {
        filePath: string;
        globalAssetId?: string;
        client: {
          importFile(input: {
            globalAssetId?: string;
            file: AssetImportFile;
            fileName: string;
            kind: "audio";
          }): Promise<typeof globalAsset>;
        };
      }) => Promise<typeof globalAsset>;
    }
  ).importPersonalGlobalAssetFile;

  assert.equal(typeof importGlobal, "function");
  if (!importGlobal) return;
  const result = await importGlobal({
    filePath: source,
    globalAssetId: "global:voice-command",
    client: {
      async importFile(input) {
        calls.push(await sentFile(input));
        return globalAsset;
      },
    },
  });

  assert.deepEqual(result, globalAsset);
  assert.deepEqual(calls, [
    {
      bytes: [4, 5, 6],
      fileName: "voice.mp3",
      contentType: "audio/mpeg",
      kind: "audio",
      globalAssetId: "global:voice-command",
    },
  ]);
});

test("CLI Global import reuses its Asset id when the same command object retries an unknown result", async () => {
  const source = join(await tempDir(), "voice.mp3");
  await writeFile(source, new Uint8Array([4, 5, 6]));
  const imports: Array<{ id: string; bytes: number[] }> = [];
  const command = {
    filePath: source,
    client: {
      async importFile(input: {
        globalAssetId?: string;
        file: AssetImportFile;
        fileName: string;
        kind: "audio";
      }) {
        imports.push({
          id: input.globalAssetId ?? "",
          bytes: (await sentFile(input)).bytes,
        });
        if (imports.length === 1) throw new TypeError("connection lost");
        return {
          id: input.globalAssetId!,
          kind: "audio" as const,
          lifecycle: { state: "active" as const },
          status: "ready" as const,
          metadata: { bytes: 3, contentType: "audio/mpeg" },
        };
      },
    } as PersonalGlobalAssetHostClient,
  };

  await assert.rejects(
    assetCommands.importPersonalGlobalAssetFile(command),
    /connection lost/,
  );
  await assetCommands.importPersonalGlobalAssetFile(command);

  assert.notEqual(imports[0]?.id, "");
  assert.equal(imports[1]?.id, imports[0]?.id);
  assert.deepEqual(imports[1]?.bytes, imports[0]?.bytes);
});

test("CLI Global import accepts the same OGG audio representation as MCP", async () => {
  const source = join(await tempDir(), "voice.ogg");
  await writeFile(source, new Uint8Array([10, 11, 12]));
  const imports: unknown[] = [];

  await assetCommands.importPersonalGlobalAssetFile({
    filePath: source,
    globalAssetId: "global:ogg-command",
    client: {
      async importFile(input) {
        imports.push(await sentFile(input));
        return {
          id: "global:ogg",
          kind: "audio",
          lifecycle: { state: "active" },
          status: "ready",
          metadata: { bytes: 3, contentType: "audio/ogg" },
        };
      },
      async list() {
        return [];
      },
      async get() {
        throw new Error("not used");
      },
      async publish() {
        throw new Error("not used");
      },
      async trash() {
        throw new Error("not used");
      },
      async restore() {
        throw new Error("not used");
      },
    },
  });

  assert.deepEqual(imports, [
    {
      bytes: [10, 11, 12],
      fileName: "voice.ogg",
      contentType: "audio/ogg",
      kind: "audio",
      globalAssetId: "global:ogg-command",
    },
  ]);
});

test("CLI Global lifecycle uses the observed delete operation for restore and stable trash retries", async () => {
  const module = assetCommands as unknown as {
    trashPersonalGlobalAsset?: (options: {
      globalAssetId: string;
      client: PersonalGlobalAssetHostClient;
      onObservation?: (deleteOperationId: string) => void | Promise<void>;
    }) => Promise<unknown>;
    restorePersonalGlobalAsset?: (options: {
      globalAssetId: string;
      observedDeleteOperationId?: string;
      client: PersonalGlobalAssetHostClient;
      onObservation?: (deleteOperationId: string) => void | Promise<void>;
    }) => Promise<unknown>;
  };
  assert.equal(typeof module.trashPersonalGlobalAsset, "function");
  assert.equal(typeof module.restorePersonalGlobalAsset, "function");
  if (!module.trashPersonalGlobalAsset || !module.restorePersonalGlobalAsset)
    return;
  const calls: unknown[] = [];
  const observations: string[] = [];
  const trashed = {
    id: "global:one",
    kind: "image" as const,
    lifecycle: {
      state: "trashed" as const,
      deleteOperationId: "delete:observed",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    },
    status: "unavailable" as const,
    metadata: { bytes: 4, contentType: "image/png" },
  };
  const active = {
    ...trashed,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
  };
  let trashAttempts = 0;
  const client: PersonalGlobalAssetHostClient = {
    async list() {
      return [];
    },
    async get(input) {
      calls.push({ method: "get", input });
      return trashed;
    },
    async importFile() {
      throw new Error("not used");
    },
    async publish() {
      throw new Error("not used");
    },
    async trash(input) {
      calls.push({ method: "trash", input });
      trashAttempts += 1;
      if (trashAttempts === 1) throw new TypeError("connection lost");
      return {
        ...trashed,
        lifecycle: {
          ...trashed.lifecycle,
          deleteOperationId: input.deleteOperationId!,
        },
      };
    },
    async restore(input) {
      calls.push({ method: "restore", input });
      return active;
    },
  };
  const trashCommand = {
    globalAssetId: "global:one",
    client,
    onObservation: (deleteOperationId: string) => {
      observations.push(deleteOperationId);
    },
  };

  await assert.rejects(
    module.trashPersonalGlobalAsset(trashCommand),
    /connection lost/,
  );
  await module.trashPersonalGlobalAsset(trashCommand);
  const trashCalls = calls.filter(
    (
      call,
    ): call is { method: "trash"; input: { deleteOperationId?: string } } =>
      (call as { method?: string }).method === "trash",
  );
  assert.ok(trashCalls[0]?.input.deleteOperationId);
  assert.equal(
    trashCalls[1]?.input.deleteOperationId,
    trashCalls[0]?.input.deleteOperationId,
  );

  await module.restorePersonalGlobalAsset({
    globalAssetId: "global:one",
    observedDeleteOperationId: "delete:observed",
    client,
    onObservation: (deleteOperationId) => {
      observations.push(deleteOperationId);
    },
  });
  assert.deepEqual(calls.at(-1), {
    method: "restore",
    input: {
      globalAssetId: "global:one",
      deleteOperationId: "delete:observed",
    },
  });
  assert.deepEqual(observations, [
    trashCalls[1]?.input.deleteOperationId,
    "delete:observed",
  ]);
});

test("global admission and publication preserve the two independent Asset identities", async () => {
  const calls: unknown[] = [];
  const projectAsset = {
    id: "asset:admitted",
    kind: "image" as const,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
    metadata: { bytes: 4, contentType: "image/png" },
  };
  const globalAsset = { ...projectAsset, id: "global:published" };
  const module = assetCommands as unknown as {
    admitPersonalGlobalAsset?: (options: {
      projectId: string;
      globalAssetId: string;
      client: {
        admit(input: {
          projectId: string;
          globalAssetId: string;
        }): Promise<{ value: typeof projectAsset }>;
      };
    }) => Promise<typeof projectAsset>;
    publishProjectAssetToPersonalGlobal?: (options: {
      projectId: string;
      projectAssetId: string;
      client: {
        publish(input: {
          projectId: string;
          projectAssetId: string;
        }): Promise<typeof globalAsset>;
      };
    }) => Promise<typeof globalAsset>;
  };

  assert.equal(typeof module.admitPersonalGlobalAsset, "function");
  assert.equal(typeof module.publishProjectAssetToPersonalGlobal, "function");
  if (
    !module.admitPersonalGlobalAsset ||
    !module.publishProjectAssetToPersonalGlobal
  )
    return;
  assert.deepEqual(
    await module.admitPersonalGlobalAsset({
      projectId: "project-a",
      globalAssetId: "global:source",
      client: {
        async admit(input) {
          calls.push({ method: "admit", input });
          return { value: projectAsset };
        },
      },
    }),
    projectAsset,
  );
  assert.deepEqual(
    await module.publishProjectAssetToPersonalGlobal({
      projectId: "project-a",
      projectAssetId: "asset:source",
      client: {
        async publish(input) {
          calls.push({ method: "publish", input });
          return globalAsset;
        },
      },
    }),
    globalAsset,
  );
  assert.deepEqual(calls, [
    {
      method: "admit",
      input: { projectId: "project-a", globalAssetId: "global:source" },
    },
    {
      method: "publish",
      input: { projectId: "project-a", projectAssetId: "asset:source" },
    },
  ]);
});

test("asset link names must stay inside the project asset links directory", () => {
  assert.equal(
    resolveAssetLinkName("asset-1", "/tmp/source.png"),
    "source.png",
  );
  assert.equal(
    resolveAssetLinkName("asset-1", "/tmp/source.png", "hero:1.png"),
    "hero_1.png",
  );
  assert.throws(
    () => resolveAssetLinkName("asset-1", "/tmp/source.png", "../bad.png"),
    /single file name/,
  );
  assert.throws(
    () => resolveAssetLinkName("asset-1", "/tmp/source.png", "nested/bad.png"),
    /single file name/,
  );
});

test("links an immutable asset into the project asset links root", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const source = join(await tempDir(), "asset.png");
  await writeFile(source, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });

  const result = await linkAssetIntoProject({
    assetId: "asset-1",
    cwd,
    env: {},
    homeDir,
    download: async (assetId, projectId) => {
      assert.equal(assetId, "asset-1");
      assert.equal(projectId, "asset_project");
      return source;
    },
  });

  assert.equal(result.projectId, "asset_project");
  assert.equal(result.method, "symlink");
  assert.equal(result.linkPath, join(cwd, "assets", "links", "asset.png"));
  assert.equal((await lstat(result.linkPath)).isSymbolicLink(), true);
  assert.equal(await readFile(result.linkPath, "utf8"), "asset-bytes");
});

test("asset links refuse accidental overwrite", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const source = join(await tempDir(), "asset.txt");
  await writeFile(source, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });

  await linkAssetIntoProject({
    assetId: "asset-1",
    cwd,
    env: {},
    homeDir,
    download: async () => source,
  });

  await assert.rejects(
    () =>
      linkAssetIntoProject({
        assetId: "asset-1",
        cwd,
        env: {},
        homeDir,
        download: async () => source,
      }),
    /already exists/,
  );
});

test("asset link copy fallback is read-only", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const source = join(await tempDir(), "asset-copy.txt");
  await writeFile(source, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });

  const result = await linkAssetIntoProject({
    assetId: "asset-1",
    cwd,
    env: {},
    homeDir,
    download: async () => source,
    createSymlink: () => {
      const error = new Error("symlink disabled") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    },
  });

  assert.equal(result.method, "copy");
  assert.equal(await readFile(result.linkPath, "utf8"), "asset-bytes");
  assert.equal((await stat(result.linkPath)).mode & 0o777, 0o444);
});

test("asset import sends workspace bytes through the shared Host client and links its immutable projection", async () => {
  const homeDir = await tempDir();
  const cwd = await tempDir();
  const source = join(await tempDir(), "hero.png");
  const projection = join(await tempDir(), "immutable-hero.png");
  await writeFile(source, "asset-bytes", "utf8");
  await writeFile(projection, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });
  const imports: unknown[] = [];

  const result = await importAssetFile({
    filePath: source,
    projectAssetId: "asset:hero-command",
    cwd,
    env: {},
    homeDir,
    kind: "image",
    client: {
      async importFile(input) {
        imports.push(await sentFile(input));
        return {
          projectId: "asset_project",
          value: {
            id: "asset:host-import",
            kind: "image",
            status: "ready",
            metadata: { bytes: 11, contentType: "image/png" },
          },
        };
      },
    } as ProjectAssetHostClient,
    download: async (assetId, projectId) => {
      assert.equal(assetId, "asset:host-import");
      assert.equal(projectId, "asset_project");
      return projection;
    },
  });

  assert.equal(result.assetId, "asset:host-import");
  assert.equal(
    result.linkPath,
    join(cwd, "assets", "links", "asset_host-import.png"),
  );
  assert.equal(result.linkMethod, "symlink");
  assert.equal((await lstat(result.linkPath!)).isSymbolicLink(), true);
  assert.equal(await readFile(result.linkPath!, "utf8"), "asset-bytes");
  assert.deepEqual(imports, [
    {
      projectId: "asset_project",
      bytes: Array.from(Buffer.from("asset-bytes")),
      fileName: "hero.png",
      contentType: "image/png",
      kind: "image",
      projectAssetId: "asset:hero-command",
    },
  ]);
  assert.equal(JSON.stringify(imports).includes("localBlobKey"), false);
});

test("CLI imports hand the Host client the file itself, never a copy of its bytes", async () => {
  const cwd = await tempDir();
  const source = join(await tempDir(), "hero.png");
  await writeFile(source, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });
  const sent: Array<Record<string, unknown> & { file: AssetImportFile }> = [];
  const value = {
    id: "asset:host-import",
    kind: "image" as const,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
    metadata: { bytes: 11, contentType: "image/png" },
  };

  await importAssetFile({
    filePath: source,
    cwd,
    env: {},
    link: false,
    client: {
      async importFile(input) {
        sent.push(input);
        return { projectId: "asset_project", value };
      },
    } as ProjectAssetHostClient,
  });
  await assetCommands.importPersonalGlobalAssetFile({
    filePath: source,
    client: {
      async importFile(input) {
        sent.push(input);
        return value;
      },
    } as PersonalGlobalAssetHostClient,
  });

  assert.equal(sent.length, 2);
  for (const input of sent) {
    assert.equal("bytes" in input, false);
    assert.equal(input.file.size, 11);
    assert.equal(input.file.type, "image/png");
  }
  // The source reads from disk on demand: with the file emptied there is no
  // in-memory copy left to send.
  await truncate(source, 0);
  for (const input of sent) {
    const body = await new Response(input.file.stream()).arrayBuffer();
    assert.equal(body.byteLength, 0);
  }
});

test("CLI imports declare the stat size of a file past 4 GiB", async (t) => {
  const cwd = await tempDir();
  const source = join(await tempDir(), "long.mp4");
  const byteLength = await sparseFileOver4GiB(source);
  if (byteLength === null) {
    t.skip("filesystem cannot hold a sparse file past 4 GiB");
    return;
  }
  t.after(() => rm(source, { force: true }));
  await initProject({ cwd, projectId: "asset_project" });
  const sent: AssetImportFile[] = [];
  const value = {
    id: "asset:long",
    kind: "video" as const,
    lifecycle: { state: "active" as const },
    status: "ready" as const,
    metadata: { bytes: byteLength, contentType: "video/mp4" },
  };

  await importAssetFile({
    filePath: source,
    cwd,
    env: {},
    link: false,
    client: {
      async importFile(input) {
        sent.push(input.file);
        return { projectId: "asset_project", value };
      },
    } as ProjectAssetHostClient,
  });
  await assetCommands.importPersonalGlobalAssetFile({
    filePath: source,
    client: {
      async importFile(input) {
        sent.push(input.file);
        return value;
      },
    } as PersonalGlobalAssetHostClient,
  });

  // The Host client declares `file.size` as byteLength; nothing is uploaded.
  assert.deepEqual(
    sent.map((file) => file.size),
    [byteLength, byteLength],
  );
});

test("CLI Project import reuses its Asset id when the same command object retries an unknown result", async () => {
  const cwd = await tempDir();
  const source = join(await tempDir(), "hero.png");
  await writeFile(source, "asset-bytes", "utf8");
  await initProject({ cwd, projectId: "asset_project" });
  const imports: Array<{ id: string; bytes: number[] }> = [];
  const command = {
    filePath: source,
    cwd,
    env: {},
    link: false,
    client: {
      async importFile(input) {
        imports.push({
          id: input.projectAssetId ?? "",
          bytes: (await sentFile(input)).bytes,
        });
        if (imports.length === 1) throw new TypeError("connection lost");
        return {
          projectId: "asset_project",
          value: {
            id: input.projectAssetId!,
            kind: "image" as const,
            lifecycle: { state: "active" as const },
            status: "ready" as const,
            metadata: { bytes: 11, contentType: "image/png" },
          },
        };
      },
    } as ProjectAssetHostClient,
  };

  await assert.rejects(importAssetFile(command), /connection lost/);
  await importAssetFile(command);

  assert.notEqual(imports[0]?.id, "");
  assert.equal(imports[1]?.id, imports[0]?.id);
  assert.deepEqual(imports[1]?.bytes, imports[0]?.bytes);
});

test("asset import infers Director GLB files and leaves Resource deduplication to the Host", async () => {
  const cwd = await tempDir();
  await initProject({ cwd, projectId: "asset_project" });
  const source = join(await tempDir(), "horse.glb");
  await writeFile(source, "glb-bytes", "utf8");
  let importedKind = "";

  const result = await importAssetFile({
    filePath: source,
    cwd,
    env: {},
    link: false,
    client: {
      async importFile(input) {
        importedKind = input.kind;
        return {
          projectId: "asset_project",
          value: {
            id: "asset:model",
            kind: "model",
            status: "ready",
            metadata: { bytes: 9, contentType: "model/gltf-binary" },
          },
        };
      },
    } as ProjectAssetHostClient,
  });

  assert.equal(result.registered, true);
  assert.equal(result.assetId, "asset:model");
  assert.equal(importedKind, "model");
});

test("asset replace imports a file then calls copy-on-write canvas replacement with read proof", async () => {
  const source = join(await tempDir(), "replacement.png");
  await writeFile(source, "replacement-bytes", "utf8");
  const calls: unknown[] = [];

  const result = await replaceAssetFile({
    filePath: source,
    nodeId: "node-source",
    project: "project-replace",
    kind: "image",
    ifMatch: "node-v1:read",
    newNode: "node-copy",
    label: "Replacement",
    importFile: async (options) => {
      calls.push({ importFile: options });
      return {
        projectId: "project-replace",
        assetId: "local:sha256:replacement",
        kind: "image",
        sourcePath: source,
        registered: true,
        registration: {
          id: "local:sha256:replacement",
          kind: "image",
          lifecycle: { state: "active" },
          status: "ready",
          metadata: { bytes: 17, contentType: "image/png" },
        },
      };
    },
    replaceAsset: async (options) => {
      calls.push({ replaceAsset: options });
      return {
        replaced: true,
        newNodeId: options.newNode,
        assetId: options.assetId,
      };
    },
  });

  assert.deepEqual(result, {
    importedAssetId: "local:sha256:replacement",
    replaced: true,
    replaceResult: {
      replaced: true,
      newNodeId: "node-copy",
      assetId: "local:sha256:replacement",
    },
  });
  assert.deepEqual(calls, [
    {
      importFile: {
        filePath: source,
        project: "project-replace",
        cwd: undefined,
        env: undefined,
        homeDir: undefined,
        kind: "image",
        link: true,
      },
    },
    {
      replaceAsset: {
        project: "project-replace",
        nodeId: "node-source",
        assetId: "local:sha256:replacement",
        ifMatch: "node-v1:read",
        newNode: "node-copy",
        label: "Replacement",
      },
    },
  ]);
});

test("asset get reads a ResolvedAsset from the cwd-selected Project", async () => {
  const calls: string[] = [];
  const observations: string[] = [];

  const result = await fetchProjectAssetRecord({
    projectId: "project 1",
    assetId: "local:sha256:abc/needs encoding",
    onObservation: async (receipt) => {
      observations.push(receipt);
    },
    request: async (path) => {
      calls.push(path);
      return new Response(
        JSON.stringify({
          id: "local:sha256:abc/needs encoding",
          kind: "image",
          lifecycle: { state: "active" },
          status: "ready",
          metadata: { bytes: 11, contentType: "image/png" },
        }),
        {
          status: 200,
          headers: { "x-clash-read-receipt": "project-asset:receipt:get" },
        },
      );
    },
  });

  assert.deepEqual(calls, [
    "/api/v1/projects/project%201/assets/local%3Asha256%3Aabc%2Fneeds%20encoding",
  ]);
  assert.equal(result.status, "ready");
  assert.deepEqual(observations, ["project-asset:receipt:get"]);
  assert.equal("readToken" in result, false);
});

test("asset list reads the same Project-scoped ResolvedAsset collection", async () => {
  const calls: string[] = [];
  const result = await listProjectAssetRecords({
    projectId: "project 1",
    request: async (path) => {
      calls.push(path);
      return new Response(
        JSON.stringify({
          assets: [
            {
              id: "asset:one",
              kind: "image",
              lifecycle: { state: "active" },
              status: "ready",
              metadata: { bytes: 11, contentType: "image/png" },
            },
          ],
        }),
      );
    },
  });

  assert.deepEqual(calls, ["/api/v1/projects/project%201/assets"]);
  assert.deepEqual(
    result.map(({ id }) => id),
    ["asset:one"],
  );
});

test("asset refs reads authoritative Action Asset bindings from one Project", async () => {
  const calls: string[] = [];
  const observations: string[] = [];

  const result = await fetchProjectAssetReferences({
    projectId: "project 1",
    assetId: "asset/one",
    onObservation: (receipt) => {
      observations.push(receipt);
    },
    request: async (path) => {
      calls.push(path);
      return new Response(
        JSON.stringify({
          projectAssetId: "asset/one",
          references: [
            {
              id: "binding-1",
              owner: { kind: "draft", actionId: "action-1" },
              direction: "input",
              slot: "image:0",
              projectAssetId: "asset/one",
              role: "reference",
            },
          ],
        }),
        {
          status: 200,
          headers: { "x-clash-read-receipt": "project-asset:receipt:refs" },
        },
      );
    },
  });

  assert.deepEqual(calls, [
    "/api/v1/projects/project%201/assets/asset%2Fone/references",
  ]);
  assert.equal(result.references[0]?.owner.actionId, "action-1");
  assert.deepEqual(observations, ["project-asset:receipt:refs"]);
  assert.equal("readToken" in result, false);
});

test("asset delete returns the opaque receipt through client glue and sends agent CAS headers", async () => {
  const calls: Array<{
    path: string;
    method?: string;
    headers?: RequestInit["headers"];
    body?: RequestInit["body"];
  }> = [];
  const observations: string[] = [];

  const result = await trashProjectAsset({
    projectId: "project-a",
    assetId: "asset-live",
    actorClientType: "agent",
    observedVersion: "project-asset:receipt:before-delete",
    onObservation: (receipt) => {
      observations.push(receipt);
    },
    request: async (path, init) => {
      calls.push({
        path,
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
      const deleteOperationId = JSON.parse(String(init?.body))
        .deleteOperationId as string;
      return new Response(
        JSON.stringify({
          id: "asset-live",
          kind: "image",
          lifecycle: {
            state: "trashed",
            deleteOperationId,
            deletedAt: "2026-08-13T00:00:00.000Z",
            purgeAfter: "2026-09-12T00:00:00.000Z",
          },
          status: "unavailable",
          metadata: { bytes: 11 },
        }),
        {
          status: 200,
          headers: {
            "x-clash-read-receipt": "project-asset:receipt:after-delete",
          },
        },
      );
    },
  });

  assert.equal(result.status, "unavailable");
  await trashProjectAsset({
    projectId: "project-a",
    assetId: "asset-live",
    actorClientType: "agent",
    observedVersion: "project-asset:receipt:before-delete",
    request: async (path, init) => {
      calls.push({
        path,
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
      const deleteOperationId = JSON.parse(String(init?.body))
        .deleteOperationId as string;
      return Response.json(
        {
          id: "asset-live",
          kind: "image",
          lifecycle: {
            state: "trashed",
            deleteOperationId,
            deletedAt: "2026-08-13T00:00:00.000Z",
            purgeAfter: "2026-09-12T00:00:00.000Z",
          },
          status: "unavailable",
          metadata: { bytes: 11 },
        },
        {
          headers: {
            "x-clash-read-receipt": "project-asset:receipt:after-delete",
          },
        },
      );
    },
  });
  assert.equal("readToken" in result, false);
  assert.deepEqual(observations, ["project-asset:receipt:after-delete"]);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(
      {
        path: call.path,
        method: call.method,
        headers: call.headers,
      },
      {
        path: "/api/v1/projects/project-a/assets/asset-live",
        method: "DELETE",
        headers: {
          "content-type": "application/json",
          "x-clash-client-type": "agent",
          "x-clash-if-match": "project-asset:receipt:before-delete",
        },
      },
    );
  }
  const firstOperation = JSON.parse(String(calls[0]?.body)).deleteOperationId;
  const retriedOperation = JSON.parse(String(calls[1]?.body)).deleteOperationId;
  assert.equal(typeof firstOperation, "string");
  assert.ok(firstOperation.length > 0);
  assert.equal(retriedOperation, firstOperation);
});

test("asset restore returns the opaque receipt through client glue and sends agent CAS headers", async () => {
  const calls: Array<{
    path: string;
    method?: string;
    headers?: RequestInit["headers"];
    body?: RequestInit["body"];
  }> = [];
  const observations: string[] = [];

  const result = await restoreProjectAsset({
    projectId: "project-a",
    assetId: "asset-live",
    actorClientType: "agent",
    observedVersion: "project-asset:receipt:before-restore",
    onObservation: (receipt) => {
      observations.push(receipt);
    },
    request: async (path, init) => {
      calls.push({
        path,
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
      return new Response(
        JSON.stringify({
          id: "asset-live",
          kind: "image",
          lifecycle: { state: "active" },
          status: "ready",
          metadata: { bytes: 11 },
        }),
        {
          status: 200,
          headers: {
            "x-clash-read-receipt": "project-asset:receipt:after-restore",
          },
        },
      );
    },
  });

  assert.equal(result.status, "ready");
  assert.equal("readToken" in result, false);
  assert.deepEqual(observations, ["project-asset:receipt:after-restore"]);
  assert.deepEqual(calls, [
    {
      path: "/api/v1/projects/project-a/assets/asset-live/restore",
      method: "POST",
      headers: {
        "x-clash-client-type": "agent",
        "x-clash-if-match": "project-asset:receipt:before-restore",
      },
      body: undefined,
    },
  ]);
});

test("a failed asset command says what went wrong and prints the exact commands that fix it", () => {
  const failure = (body: Record<string, unknown>) =>
    Object.assign(new Error(`${body.code}: host`), { body });

  // Duplicate import: imported once without the id, then again with it.
  const duplicate = assetCommands.describeProjectAssetFailure(
    failure({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      projectAssetId: "preassigned",
      existingProjectAssetIds: ["asset:minted"],
    }),
    { assetId: "preassigned", filePath: "inputs/source.svg" },
  );
  for (const command of [
    "clash assets get --asset asset:minted --json",
    "clash assets delete --asset asset:minted --yes",
    "clash assets import --file inputs/source.svg --asset-id preassigned --json",
    "clash assets import --file inputs/source.svg --asset-id preassigned --allow-duplicate --json",
  ]) {
    assert.ok(duplicate.includes(command), duplicate);
  }

  // Wrong id on get/delete/restore.
  const missing = assetCommands.describeProjectAssetFailure(
    failure({
      code: "PROJECT_ASSET_NOT_FOUND",
      projectAssetId: "minted",
      suggestedProjectAssetIds: ["asset:minted"],
    }),
    { assetId: "minted", project: "project a" },
  );
  assert.ok(
    missing.includes(
      "clash assets get --asset asset:minted --project 'project a' --json",
    ),
    missing,
  );
  assert.ok(
    missing.includes("clash assets list --project 'project a' --json"),
    missing,
  );

  // Re-import of a trashed Asset, and a delete/restore without a prior read.
  const trashed = assetCommands.describeProjectAssetFailure(
    failure({ code: "PROJECT_ASSET_TRASHED", projectAssetId: "asset:one" }),
  );
  assert.ok(
    trashed.includes("clash assets restore --asset asset:one"),
    trashed,
  );
  const unread = assetCommands.describeProjectAssetFailure(
    new Error("READ_REQUIRED: read the target first"),
    { assetId: "asset:one" },
  );
  assert.ok(
    unread.includes("clash assets get --asset asset:one --json"),
    unread,
  );

  // A failure without a known recovery is passed through unchanged.
  assert.equal(
    assetCommands.describeProjectAssetFailure(new Error("disk full")),
    "disk full",
  );
});

test("CLI import rejects duplicate content by default and exposes the explicit opt-in", async () => {
  const importCommand = assetsCommand.commands.find(
    (command) => command.name() === "import",
  );
  assert.ok(
    importCommand?.options.some(
      (option) => option.long === "--allow-duplicate",
    ),
  );
  const dir = await tempDir();
  const filePath = join(dir, "clip.mp4");
  await writeFile(filePath, "bytes");
  const policies: unknown[] = [];
  const client = {
    async importFile(input: { duplicateContent?: string }) {
      policies.push(input.duplicateContent);
      return { projectId: "project-a", value: { id: "asset:one" } };
    },
  } as unknown as ProjectAssetHostClient;
  for (const duplicateContent of ["reject", "allow"] as const) {
    await importAssetFile({
      filePath,
      project: "project-a",
      link: false,
      duplicateContent,
      client,
    });
  }
  assert.deepEqual(policies, ["reject", "allow"]);
});
