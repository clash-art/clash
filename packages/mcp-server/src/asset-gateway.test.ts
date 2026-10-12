import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ProjectAssetHostClient,
  ProjectAssetHostObservation,
  ProjectAssetHostResult,
} from "@clash/shared-runtime/project-asset-client";
import { ProjectHostHttpError } from "@clash/shared-runtime/project-host-client";
import type { ActionAssetBinding, ResolvedAsset } from "@clash/shared-types";

const asset: ResolvedAsset = {
  id: "asset:one",
  kind: "audio",
  name: "voice.mp3",
  metadata: { bytes: 3, contentType: "audio/mpeg" },
  provenance: { kind: "import" },
  lifecycle: { state: "active" },
  status: "ready",
  url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone/media",
};

const trashedAsset: ResolvedAsset = {
  ...asset,
  lifecycle: {
    state: "trashed",
    deleteOperationId: "delete:asset:one",
    deletedAt: "2026-08-13T00:00:00.000Z",
    purgeAfter: "2026-09-12T00:00:00.000Z",
  },
  status: "unavailable",
};

const globalAsset: ResolvedAsset = {
  ...asset,
  id: "global:one",
  url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/media",
};

/** Reads the file-backed Blob an import handed to its client. */
async function sentBytes(file: Blob | undefined): Promise<number[]> {
  return file ? Array.from(new Uint8Array(await file.arrayBuffer())) : [];
}

function fakeClient(
  calls: Array<{ method: string; input: unknown }>,
): ProjectAssetHostClient {
  const result = <T>(value: T): ProjectAssetHostResult<T> => ({
    projectId: "project-a",
    value,
  });
  const observed = <T>(
    value: T,
    receipt: string,
  ): ProjectAssetHostObservation<T> => ({
    ...result(value),
    receipt,
  });
  return {
    resolveContext: async ({ cwd } = {}) => ({
      projectId: "project-a",
      source: "marker",
      ...(cwd ? { workspaceRoot: cwd } : {}),
    }),
    async list(input) {
      calls.push({ method: "list", input });
      return result([asset]);
    },
    async batch(input) {
      calls.push({ method: "batch", input });
      return result(input.assetIds.includes(asset.id) ? [asset] : []);
    },
    async get(input) {
      calls.push({ method: "get", input });
      return observed(asset, "receipt-read");
    },
    async references(input) {
      calls.push({ method: "references", input });
      return observed([] as ActionAssetBinding[], "receipt-references");
    },
    async importFile(input) {
      calls.push({ method: "importFile", input });
      return result(asset);
    },
    async admit(input) {
      calls.push({ method: "admit", input });
      return result(asset);
    },
    async trash(input) {
      calls.push({ method: "trash", input });
      return observed(trashedAsset, "receipt-trashed");
    },
    async restore(input) {
      calls.push({ method: "restore", input });
      return observed(asset, "receipt-restored");
    },
  };
}

test("MCP Project Asset mutations consume an internal Host receipt and never expose it", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const calls: Array<{ method: string; input: any }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient(calls));

  assert.deepEqual(
    await gateway.invoke("clash_assets_get", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    asset,
  );
  assert.deepEqual(
    await gateway.invoke("clash_assets_trash", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    trashedAsset,
  );
  assert.deepEqual(calls[0], {
    method: "get",
    input: { projectId: "project-a", assetId: "asset:one" },
  });
  assert.equal(calls[1]?.method, "trash");
  assert.equal(typeof calls[1]?.input.deleteOperationId, "string");
  assert.ok(calls[1]?.input.deleteOperationId.length > 0);
  const { deleteOperationId: _operationId, ...trashInput } = calls[1]!.input;
  assert.deepEqual(trashInput, {
    projectId: "project-a",
    assetId: "asset:one",
    actorClientType: "mcp",
    receipt: "receipt-read",
  });
  assert.doesNotMatch(
    JSON.stringify(
      await gateway.invoke("clash_assets_get", {
        projectId: "project-a",
        assetId: "asset:one",
      }),
    ),
    /receipt|readToken|ifMatch/i,
  );
});

test("MCP retries an unknown Project Asset trash result with one stable operation id", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const calls: Array<{ method: string; input: any }> = [];
  const client = fakeClient(calls);
  let attempts = 0;
  client.trash = async (input) => {
    calls.push({ method: "trash", input });
    attempts += 1;
    if (attempts === 1) throw new Error("connection closed after commit");
    return {
      projectId: "project-a",
      value: {
        ...trashedAsset,
        lifecycle: {
          ...trashedAsset.lifecycle,
          deleteOperationId: input.deleteOperationId!,
        },
      },
      receipt: "receipt-trashed",
    };
  };
  const gateway = createAssetProjectHostGateway(client);

  await gateway.invoke("clash_assets_get", {
    projectId: "project-a",
    assetId: "asset:one",
  });
  await assert.rejects(
    gateway.invoke("clash_assets_trash", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    /connection closed after commit/,
  );
  await gateway.invoke("clash_assets_trash", {
    projectId: "project-a",
    assetId: "asset:one",
  });

  const operationIds = calls
    .filter(({ method }) => method === "trash")
    .map(({ input }) => input.deleteOperationId);
  assert.equal(operationIds.length, 2);
  assert.equal(typeof operationIds[0], "string");
  assert.ok(operationIds[0].length > 0);
  assert.equal(operationIds[1], operationIds[0]);
});

test("MCP Project Asset mutation fails locally until get or references observed that Asset", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const calls: Array<{ method: string; input: unknown }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient(calls));

  await assert.rejects(
    gateway.invoke("clash_assets_restore", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    /READ_REQUIRED.*clash_assets_(?:get|references)/i,
  );
  assert.deepEqual(calls, []);
});

test("MCP references authorizes restore and rotates the private observation", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const calls: Array<{ method: string; input: any }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient(calls));

  assert.deepEqual(
    await gateway.invoke("clash_assets_references", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    { projectAssetId: "asset:one", references: [] },
  );
  assert.deepEqual(
    await gateway.invoke("clash_assets_restore", {
      projectId: "project-a",
      assetId: "asset:one",
    }),
    asset,
  );
  assert.deepEqual(calls, [
    {
      method: "references",
      input: { projectId: "project-a", assetId: "asset:one" },
    },
    {
      method: "restore",
      input: {
        projectId: "project-a",
        assetId: "asset:one",
        actorClientType: "mcp",
        receipt: "receipt-references",
      },
    },
  ]);
});

test("MCP imports a local workspace file through Host import-file without CLI execution", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-assets-"));
  const filePath = join(workspace, "voice.mp3");
  await writeFile(filePath, new Uint8Array([4, 5, 6]));
  const calls: Array<{ method: string; input: any }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient(calls));

  assert.deepEqual(
    await gateway.invoke("clash_assets_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
      projectAssetId: "asset:mcp-command",
    }),
    asset,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "importFile");
  assert.deepEqual(
    {
      projectId: calls[0]?.input.projectId,
      kind: calls[0]?.input.kind,
      fileName: calls[0]?.input.fileName,
      contentType: calls[0]?.input.file?.type,
      projectAssetId: calls[0]?.input.projectAssetId,
      bytes: await sentBytes(calls[0]?.input.file),
    },
    {
      projectId: "project-a",
      kind: "audio",
      fileName: "voice.mp3",
      contentType: "audio/mpeg",
      projectAssetId: "asset:mcp-command",
      bytes: [4, 5, 6],
    },
  );
});

test("MCP imports hand the Host client the file itself, never a copy of its bytes", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-import-blob-"));
  const filePath = join(workspace, "voice.mp3");
  await writeFile(filePath, new Uint8Array([4, 5, 6]));
  const sent: Array<Record<string, unknown> & { file: Blob }> = [];
  const client = fakeClient([]);
  client.importFile = async (input) => {
    sent.push(input);
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(client, {
    async importFile(input: Record<string, unknown> & { file: Blob }) {
      sent.push(input);
      return globalAsset;
    },
  } as never);

  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });
  await gateway.invoke("clash_assets_global_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });

  assert.equal(sent.length, 2);
  for (const input of sent) {
    assert.equal("bytes" in input, false);
    assert.ok(input.file instanceof Blob);
    assert.equal(input.file.size, 3);
    assert.equal(input.file.type, "audio/mpeg");
  }
  // The Blob reads from disk on demand: with the source gone short there is
  // no in-memory copy left to send.
  await truncate(filePath, 0);
  for (const input of sent) await assert.rejects(input.file.arrayBuffer());
});

test("MCP Project import keeps one pending Asset id until the Host confirms success", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-import-retry-"));
  await writeFile(join(workspace, "voice.mp3"), new Uint8Array([4, 5, 6]));
  const importedIds: string[] = [];
  const client = fakeClient([]);
  client.importFile = async (input) => {
    importedIds.push(input.projectAssetId ?? "");
    if (importedIds.length === 1) throw new TypeError("connection lost");
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(client);

  await assert.rejects(
    gateway.invoke("clash_assets_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
    }),
    /connection lost/,
  );
  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });
  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });

  assert.notEqual(importedIds[0], "");
  assert.equal(importedIds[1], importedIds[0]);
  assert.notEqual(importedIds[2], importedIds[1]);
});

test("MCP Project import asks the Host to reject duplicate content unless a copy is requested", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-import-dup-"));
  await writeFile(join(workspace, "voice.mp3"), new Uint8Array([4, 5, 6]));
  const policies: unknown[] = [];
  const client = fakeClient([]);
  client.importFile = async (input) => {
    policies.push(input.duplicateContent);
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(client);

  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });
  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
    allowDuplicate: true,
  });

  assert.deepEqual(policies, ["reject", "allow"]);
});

test("MCP Project import releases its pending id after a known Host rejection", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-import-reject-"));
  await writeFile(join(workspace, "voice.mp3"), new Uint8Array([4, 5, 6]));
  const importedIds: string[] = [];
  const client = fakeClient([]);
  client.importFile = async (input) => {
    importedIds.push(input.projectAssetId ?? "");
    if (importedIds.length === 1) {
      throw new ProjectHostHttpError(409, { code: "ID_CONFLICT" });
    }
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(client);

  await assert.rejects(
    gateway.invoke("clash_assets_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
    }),
    /409/,
  );
  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });

  assert.notEqual(importedIds[0], "");
  assert.notEqual(importedIds[1], importedIds[0]);
});

test("MCP Project import keeps a caller-assigned id across an unknown result and reads the file per attempt", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-explicit-retry-"));
  const filePath = join(workspace, "voice.mp3");
  await writeFile(filePath, new Uint8Array([4, 5, 6]));
  const requests: Array<{ id: string; bytes: number[] }> = [];
  const client = fakeClient([]);
  client.importFile = async (input) => {
    requests.push({
      id: input.projectAssetId ?? "",
      bytes: await sentBytes(input.file),
    });
    if (requests.length === 1) throw new TypeError("connection lost");
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(client);

  await assert.rejects(
    gateway.invoke("clash_assets_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
      projectAssetId: "asset:caller-command",
    }),
    /connection lost/,
  );
  await writeFile(filePath, new Uint8Array([9, 9, 9]));
  await gateway.invoke("clash_assets_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
    projectAssetId: "asset:caller-command",
  });

  assert.deepEqual(requests, [
    { id: "asset:caller-command", bytes: [4, 5, 6] },
    // No copy of the first attempt is held in memory; the Host, not the
    // gateway, decides whether this id may now name the rewritten file.
    { id: "asset:caller-command", bytes: [9, 9, 9] },
  ]);
});

test("MCP lists and reads the personal Global library without requiring Project context", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const projectCalls: Array<{ method: string; input: unknown }> = [];
  const globalCalls: Array<{ method: string; input?: unknown }> = [];
  const projectClient = fakeClient(projectCalls);
  projectClient.resolveContext = async () => {
    throw new Error("Global library reads must not resolve a Project");
  };
  const gateway = createAssetProjectHostGateway(projectClient, {
    async list() {
      globalCalls.push({ method: "list" });
      return [globalAsset];
    },
    async get(input: { globalAssetId: string }) {
      globalCalls.push({ method: "get", input });
      return globalAsset;
    },
  } as never) as unknown as {
    invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
  };

  assert.deepEqual(await gateway.invoke("clash_assets_global_list", {}), [
    globalAsset,
  ]);
  assert.deepEqual(
    await gateway.invoke("clash_assets_global_get", {
      globalAssetId: "global:one",
    }),
    globalAsset,
  );
  assert.deepEqual(projectCalls, []);
  assert.deepEqual(globalCalls, [
    { method: "list" },
    { method: "get", input: { globalAssetId: "global:one" } },
  ]);
});

test("MCP restores a Global Asset only from the delete operation observed by Global get", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const globalTrashed: ResolvedAsset = {
    ...globalAsset,
    lifecycle: {
      state: "trashed",
      deleteOperationId: "delete:global:one",
      deletedAt: "2026-08-13T00:00:00.000Z",
      purgeAfter: "2026-08-20T00:00:00.000Z",
    },
    status: "unavailable",
  };
  const globalCalls: Array<{ method: string; input?: unknown }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async get(input: { globalAssetId: string }) {
      globalCalls.push({ method: "get", input });
      return globalTrashed;
    },
    async restore(input: { globalAssetId: string; deleteOperationId: string }) {
      globalCalls.push({ method: "restore", input });
      return globalAsset;
    },
  } as never);

  await gateway.invoke("clash_assets_global_get", {
    globalAssetId: "global:one",
  });
  assert.deepEqual(
    await gateway.invoke("clash_assets_global_restore", {
      globalAssetId: "global:one",
    }),
    globalAsset,
  );
  assert.deepEqual(globalCalls, [
    {
      method: "get",
      input: { globalAssetId: "global:one" },
    },
    {
      method: "restore",
      input: {
        globalAssetId: "global:one",
        deleteOperationId: "delete:global:one",
      },
    },
  ]);
  await assert.rejects(
    gateway.invoke("clash_assets_global_restore", {
      globalAssetId: "global:one",
    }),
    /READ_REQUIRED/,
  );
});

test("MCP retries an unknown Global Asset trash result with one stable operation id", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const operationIds: string[] = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async trash(input: { globalAssetId: string; deleteOperationId?: string }) {
      operationIds.push(input.deleteOperationId ?? "");
      if (operationIds.length === 1) {
        throw new TypeError("connection lost after commit");
      }
      return {
        ...globalAsset,
        lifecycle: {
          state: "trashed" as const,
          deleteOperationId: input.deleteOperationId!,
          deletedAt: "2026-08-13T00:00:00.000Z",
          purgeAfter: "2026-08-20T00:00:00.000Z",
        },
        status: "unavailable" as const,
      };
    },
  } as never);

  await assert.rejects(
    gateway.invoke("clash_assets_global_trash", {
      globalAssetId: "global:one",
    }),
    /connection lost after commit/,
  );
  await gateway.invoke("clash_assets_global_trash", {
    globalAssetId: "global:one",
  });

  assert.notEqual(operationIds[0], "");
  assert.equal(operationIds[1], operationIds[0]);
});

test("MCP imports a local file directly into the personal Global library", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-global-assets-"));
  const filePath = join(workspace, "voice.mp3");
  await writeFile(filePath, new Uint8Array([7, 8, 9]));
  const globalCalls: Array<{ method: string; input: any }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async importFile(input: any) {
      globalCalls.push({ method: "importFile", input });
      return globalAsset;
    },
  } as never) as unknown as {
    invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
  };

  assert.deepEqual(
    await gateway.invoke("clash_assets_global_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
      globalAssetId: "global:mcp-command",
    }),
    globalAsset,
  );
  assert.equal(globalCalls.length, 1);
  assert.deepEqual(
    {
      method: globalCalls[0]?.method,
      kind: globalCalls[0]?.input.kind,
      fileName: globalCalls[0]?.input.fileName,
      contentType: globalCalls[0]?.input.file?.type,
      globalAssetId: globalCalls[0]?.input.globalAssetId,
      bytes: await sentBytes(globalCalls[0]?.input.file),
    },
    {
      method: "importFile",
      kind: "audio",
      fileName: "voice.mp3",
      contentType: "audio/mpeg",
      globalAssetId: "global:mcp-command",
      bytes: [7, 8, 9],
    },
  );
});

test("MCP Global import keeps one pending Asset id until the Host confirms success", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-global-retry-"));
  await writeFile(join(workspace, "voice.mp3"), new Uint8Array([7, 8, 9]));
  const importedIds: string[] = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async importFile(input: any) {
      importedIds.push(input.globalAssetId ?? "");
      if (importedIds.length === 1) throw new TypeError("connection lost");
      return globalAsset;
    },
  } as never);

  await assert.rejects(
    gateway.invoke("clash_assets_global_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
    }),
    /connection lost/,
  );
  await gateway.invoke("clash_assets_global_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });
  await gateway.invoke("clash_assets_global_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });

  assert.notEqual(importedIds[0], "");
  assert.equal(importedIds[1], importedIds[0]);
  assert.notEqual(importedIds[2], importedIds[1]);
});

test("MCP Global import releases its pending id after a known Host rejection", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-global-reject-"));
  await writeFile(join(workspace, "voice.mp3"), new Uint8Array([7, 8, 9]));
  const importedIds: string[] = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async importFile(input: any) {
      importedIds.push(input.globalAssetId ?? "");
      if (importedIds.length === 1) {
        throw new ProjectHostHttpError(422, { code: "INVALID_ASSET" });
      }
      return globalAsset;
    },
  } as never);

  await assert.rejects(
    gateway.invoke("clash_assets_global_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
    }),
    /422/,
  );
  await gateway.invoke("clash_assets_global_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
  });

  assert.notEqual(importedIds[0], "");
  assert.notEqual(importedIds[1], importedIds[0]);
});

test("MCP Global import keeps a caller-assigned id across an unknown result and reads the file per attempt", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const workspace = await mkdtemp(join(tmpdir(), "clash-mcp-global-explicit-"));
  const filePath = join(workspace, "voice.mp3");
  await writeFile(filePath, new Uint8Array([7, 8, 9]));
  const requests: Array<{ id: string; bytes: number[] }> = [];
  const gateway = createAssetProjectHostGateway(fakeClient([]), {
    async importFile(input: any) {
      requests.push({
        id: input.globalAssetId ?? "",
        bytes: await sentBytes(input.file),
      });
      if (requests.length === 1) throw new TypeError("connection lost");
      return globalAsset;
    },
  } as never);

  await assert.rejects(
    gateway.invoke("clash_assets_global_import_file", {
      cwd: workspace,
      filePath: "voice.mp3",
      globalAssetId: "global:caller-command",
    }),
    /connection lost/,
  );
  await writeFile(filePath, new Uint8Array([9, 9, 9]));
  await gateway.invoke("clash_assets_global_import_file", {
    cwd: workspace,
    filePath: "voice.mp3",
    globalAssetId: "global:caller-command",
  });

  assert.deepEqual(requests, [
    { id: "global:caller-command", bytes: [7, 8, 9] },
    { id: "global:caller-command", bytes: [9, 9, 9] },
  ]);
});

test("MCP admits Global Assets and publishes Project Assets through the shared Host clients", async () => {
  const { createAssetProjectHostGateway } = await import("./asset-gateway");
  const calls: Array<{ method: string; input: unknown }> = [];
  const projectClient = fakeClient(calls) as ProjectAssetHostClient & {
    admit(input: unknown): Promise<ProjectAssetHostResult<ResolvedAsset>>;
  };
  projectClient.admit = async (input) => {
    calls.push({ method: "admit", input });
    return { projectId: "project-a", value: asset };
  };
  const gateway = createAssetProjectHostGateway(projectClient, {
    async publish(input: unknown) {
      calls.push({ method: "publish", input });
      return globalAsset;
    },
  } as never) as unknown as {
    invoke(name: string, input: Record<string, unknown>): Promise<unknown>;
  };

  assert.deepEqual(
    await gateway.invoke("clash_assets_admit", {
      projectId: "project-a",
      globalAssetId: "global:one",
    }),
    asset,
  );
  assert.deepEqual(
    await gateway.invoke("clash_assets_publish", {
      projectId: "project-a",
      projectAssetId: "asset:one",
    }),
    globalAsset,
  );
  assert.deepEqual(calls, [
    {
      method: "admit",
      input: { projectId: "project-a", globalAssetId: "global:one" },
    },
    {
      method: "publish",
      input: { projectId: "project-a", projectAssetId: "asset:one" },
    },
  ]);
});
