import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_ASSET_READ_RECEIPT_HEADER,
  createProjectAssetHostClient,
  resolveAssetImportFileType,
} from "./project-asset-client.js";
import * as projectAssetClients from "./project-asset-client.js";
import { createProjectHostClient } from "./project-host-client.js";

/** Reads a streaming import-file request back as the command it carries. */
function importForm(input: unknown, init?: RequestInit): FormData {
  const query = new URL(String(input), "http://host.test").searchParams;
  const form = new FormData();
  for (const [name, value] of query) {
    if (name !== "fileName" && name !== "byteLength") form.set(name, value);
  }
  form.set(
    "file",
    new File([init?.body as Blob], query.get("fileName") ?? "", {
      type: new Headers(init?.headers).get("content-type") ?? "",
    }),
  );
  return form;
}

const readyAsset = {
  id: "asset:one",
  kind: "image" as const,
  lifecycle: { state: "active" as const },
  name: "frame.png",
  metadata: { bytes: 4, contentType: "image/png" },
  provenance: { kind: "import" as const },
  status: "ready" as const,
  url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone/media",
};

describe("Project Asset Host client", () => {
  it("advertises only model formats with a byte-verifying Local probe", () => {
    expect(resolveAssetImportFileType("horse.glb")).toEqual({
      kind: "model",
      contentType: "model/gltf-binary",
    });
    expect(() => resolveAssetImportFileType("horse.fbx")).toThrow(
      /unsupported/i,
    );
  });

  it("normalizes the M4V extension to the decoded MP4 media type", () => {
    expect(resolveAssetImportFileType("clip.m4v")).toEqual({
      kind: "video",
      contentType: "video/mp4",
    });
  });

  it("shares the exact discovered Host connection used by the MCP command client", async () => {
    const requests: string[] = [];
    let connections = 0;
    const hostClient = createProjectHostClient({
      env: { CLASH_PROJECT_ID: "project-a" },
      resolveConnection: async () => {
        connections += 1;
        return { endpoint: "http://127.0.0.1:49321", token: "host-token" };
      },
    });
    const client = createProjectAssetHostClient({
      env: { CLASH_API_URL: "http://wrong-host.invalid" },
      hostClient,
      fetch: async (input, init) => {
        requests.push(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer host-token",
        );
        return new Response(JSON.stringify(readyAsset), {
          headers: {
            "content-type": "application/json",
            [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-shared-host",
          },
        });
      },
    });

    await expect(client.get({ assetId: "asset:one" })).resolves.toMatchObject({
      projectId: "project-a",
      receipt: "receipt-shared-host",
    });
    expect(connections).toBe(1);
    expect(requests).toEqual([
      "http://127.0.0.1:49321/api/v1/projects/project-a/assets/asset%3Aone",
    ]);
  });

  it("uses only Project-scoped ResolvedAsset routes and keeps Host receipts out of values", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (init?.method === "DELETE") {
          return new Response(
            JSON.stringify({
              ...readyAsset,
              lifecycle: {
                state: "trashed",
                deleteOperationId: "delete:test",
                deletedAt: "2026-08-13T00:00:00.000Z",
                purgeAfter: "2026-09-12T00:00:00.000Z",
              },
              status: "unavailable",
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-after-trash",
              },
            },
          );
        }
        return new Response(JSON.stringify(readyAsset), {
          status: 200,
          headers: {
            "content-type": "application/json",
            [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-before-trash",
          },
        });
      },
    );
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789/",
      env: {},
      fetch,
    });

    const read = await client.get({
      projectId: "project-a",
      assetId: "asset:one",
    });
    expect(read).toEqual({
      projectId: "project-a",
      value: readyAsset,
      receipt: "receipt-before-trash",
    });
    const trashed = await client.trash({
      projectId: "project-a",
      assetId: "asset:one",
      deleteOperationId: "delete:test",
      actorClientType: "mcp",
      receipt: read.receipt,
    });
    expect(trashed).toEqual({
      projectId: "project-a",
      value: {
        ...readyAsset,
        lifecycle: {
          state: "trashed",
          deleteOperationId: "delete:test",
          deletedAt: "2026-08-13T00:00:00.000Z",
          purgeAfter: "2026-09-12T00:00:00.000Z",
        },
        status: "unavailable",
      },
      receipt: "receipt-after-trash",
    });
    expect(JSON.stringify(trashed.value)).not.toMatch(
      /receipt|readToken|ifMatch/i,
    );
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone",
        init: { method: "GET", headers: {} },
      },
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone",
        init: {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            "x-clash-client-type": "mcp",
            "x-clash-if-match": "receipt-before-trash",
          },
          body: JSON.stringify({ deleteOperationId: "delete:test" }),
        },
      },
    ]);
  });

  it("reuses one delete operation id when the same Host command retries an unknown result", async () => {
    const operationIds: string[] = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          deleteOperationId: string;
        };
        operationIds.push(body.deleteOperationId);
        if (operationIds.length === 1) throw new TypeError("connection lost");
        return new Response(
          JSON.stringify({
            ...readyAsset,
            lifecycle: {
              state: "trashed",
              deleteOperationId: body.deleteOperationId,
              deletedAt: "2026-08-13T00:00:00.000Z",
              purgeAfter: "2026-09-12T00:00:00.000Z",
            },
            status: "unavailable",
          }),
          {
            headers: {
              "content-type": "application/json",
              [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-after-trash",
            },
          },
        );
      },
    });
    const command = {
      projectId: "project-a",
      assetId: "asset:one",
      actorClientType: "mcp",
      receipt: "receipt-before-trash",
    };

    await expect(client.trash(command)).rejects.toThrow("connection lost");
    await client.trash(command);

    expect(typeof operationIds[0]).toBe("string");
    expect(operationIds[0]).not.toBe("");
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it("uploads the workspace file as the body of the single import-file route", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      client.importFile({
        projectId: "project-a",
        file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
        fileName: "frame.png",
        kind: "image",
        projectAssetId: "asset:multipart-command",
      }),
    ).resolves.toEqual({ projectId: "project-a", value: readyAsset });
    expect(requests[0]?.url.split("?")[0]).toBe(
      "http://127.0.0.1:8789/api/v1/projects/project-a/assets/import-file",
    );
    expect(requests[0]?.init?.method).toBe("POST");
    const form = importForm(requests[0]?.url, requests[0]?.init);
    expect(form.get("kind")).toBe("image");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("frame.png");
    expect(
      Array.from(new Uint8Array(await (file as File).arrayBuffer())),
    ).toEqual([1, 2, 3, 4]);
  });

  it("replays one preassigned Project Asset id when the same import command retries an unknown result", async () => {
    const importedIds: string[] = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        const form = importForm(input, init);
        importedIds.push(String(form.get("projectAssetId") ?? ""));
        if (importedIds.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const command = {
      projectId: "project-a",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image" as const,
      projectAssetId: "asset:retry-command",
    };

    await expect(client.importFile(command)).rejects.toThrow("connection lost");
    await client.importFile(command);

    expect(importedIds[0]).toBe("asset:retry-command");
    expect(importedIds[1]).toBe(importedIds[0]);
  });

  it("replays the first Project import snapshot when its command object is mutated after an unknown result", async () => {
    const requests: Array<{
      fileName: string;
      kind: string;
      bytes: number[];
    }> = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        const form = importForm(input, init);
        const file = form.get("file") as File;
        requests.push({
          fileName: file.name,
          kind: String(form.get("kind")),
          bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
        });
        if (requests.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const command: Parameters<typeof client.importFile>[0] = {
      projectId: "project-a",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image",
      projectAssetId: "asset:original-command",
    };

    await expect(client.importFile(command)).rejects.toThrow("connection lost");
    command.file = new Blob([new Uint8Array([9, 9, 9, 9])], {
      type: "video/mp4",
    });
    command.fileName = "changed.mp4";
    command.kind = "video";
    await client.importFile(command);

    expect(requests).toEqual([
      { fileName: "frame.png", kind: "image", bytes: [1, 2, 3, 4] },
      { fileName: "frame.png", kind: "image", bytes: [1, 2, 3, 4] },
    ]);
  });

  it("keeps separately preassigned Project import commands distinct even when their bytes match", async () => {
    const importedIds: string[] = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        importedIds.push(
          String(importForm(input, init).get("projectAssetId") ?? ""),
        );
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const file = {
      projectId: "project-a",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image" as const,
      projectAssetId: "asset:first-command",
    };

    await client.importFile({ ...file });
    await client.importFile({
      ...file,
      projectAssetId: "asset:second-command",
    });

    expect(importedIds).toEqual([
      "asset:first-command",
      "asset:second-command",
    ]);
  });

  it("preserves an explicitly assigned Project Asset import id", async () => {
    let importedId: FormDataEntryValue | null = null;
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        importedId = importForm(input, init).get("projectAssetId");
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.importFile({
      projectId: "project-a",
      projectAssetId: "asset:caller-command",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image",
    });

    expect(importedId).toBe("asset:caller-command");
  });

  it("requires a Project Asset id from the Host command boundary before I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not send an unnamed import");
    });
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch,
    });

    await expect(
      client.importFile({
        projectId: "project-a",
        file: new Blob([new Uint8Array([1])], { type: "image/png" }),
        fileName: "frame.png",
        kind: "image",
      } as never),
    ).rejects.toThrow("project asset id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("admits one Global Asset through the discovered Project Host", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    }) as ReturnType<typeof createProjectAssetHostClient> & {
      admit(input: {
        projectId: string;
        globalAssetId: string;
      }): Promise<{ projectId: string; value: typeof readyAsset }>;
    };

    await expect(
      client.admit({
        projectId: "project-a",
        globalAssetId: "global:one",
      }),
    ).resolves.toEqual({ projectId: "project-a", value: readyAsset });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/admit",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ globalAssetId: "global:one" }),
        },
      },
    ]);
  });

  it("uses the discovered Host for personal Global Asset list and read", async () => {
    const globalAsset = {
      ...readyAsset,
      id: "global:one",
      url: "http://127.0.0.1:49321/api/v1/libraries/personal/assets/global%3Aone/media",
    };
    const requests: string[] = [];
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as
      | undefined
      | ((options: Record<string, unknown>) => {
          list(): Promise<(typeof globalAsset)[]>;
          get(input: { globalAssetId: string }): Promise<typeof globalAsset>;
        });

    expect(createGlobalClient).toBeTypeOf("function");
    if (!createGlobalClient) return;
    const client = createGlobalClient({
      resolveConnection: async () => ({
        endpoint: "http://127.0.0.1:49321",
        token: "host-token",
      }),
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(String(input));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer host-token",
        );
        return String(input).endsWith("/assets")
          ? new Response(JSON.stringify({ assets: [globalAsset] }))
          : new Response(JSON.stringify(globalAsset));
      },
    });

    await expect(client.list()).resolves.toEqual([globalAsset]);
    await expect(client.get({ globalAssetId: "global:one" })).resolves.toEqual(
      globalAsset,
    );
    expect(requests).toEqual([
      "http://127.0.0.1:49321/api/v1/libraries/personal/assets",
      "http://127.0.0.1:49321/api/v1/libraries/personal/assets/global%3Aone",
    ]);
  });

  it("uses the personal Global Host client for trash and observed-operation restore", async () => {
    const active = {
      ...readyAsset,
      id: "global:one",
      lifecycle: { state: "active" as const },
    };
    const trashed = {
      ...active,
      lifecycle: {
        state: "trashed" as const,
        deleteOperationId: "delete:one",
        deletedAt: "2026-08-13T00:00:00.000Z",
        purgeAfter: "2026-08-20T00:00:00.000Z",
      },
      status: "unavailable" as const,
      url: undefined,
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as (
      options: Record<string, unknown>,
    ) => {
      trash(input: {
        globalAssetId: string;
        deleteOperationId: string;
      }): Promise<typeof trashed>;
      restore(input: {
        globalAssetId: string;
        deleteOperationId: string;
      }): Promise<typeof active>;
    };
    const client = createGlobalClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return Response.json(init?.method === "DELETE" ? trashed : active);
      },
    });

    await expect(
      client.trash({
        globalAssetId: "global:one",
        deleteOperationId: "delete:one",
      }),
    ).resolves.toEqual(trashed);
    await expect(
      client.restore({
        globalAssetId: "global:one",
        deleteOperationId: "delete:one",
      }),
    ).resolves.toEqual(active);
    expect(
      requests.map(({ url, init }) => ({
        url,
        method: init?.method,
        body: init?.body,
      })),
    ).toEqual([
      {
        url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone",
        method: "DELETE",
        body: JSON.stringify({ deleteOperationId: "delete:one" }),
      },
      {
        url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/restore",
        method: "POST",
        body: JSON.stringify({ deleteOperationId: "delete:one" }),
      },
    ]);
  });

  it("uses one personal Global Asset client for import and Project publication", async () => {
    const globalAsset = {
      ...readyAsset,
      id: "global:one",
      url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/media",
    };
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as
      | undefined
      | ((options: Record<string, unknown>) => {
          importFile(input: {
            globalAssetId: string;
            file: Blob;
            fileName: string;
            kind: "image";
          }): Promise<typeof globalAsset>;
          publish(input: {
            projectId: string;
            projectAssetId: string;
          }): Promise<typeof globalAsset>;
        });

    expect(createGlobalClient).toBeTypeOf("function");
    if (!createGlobalClient) return;
    const client = createGlobalClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(JSON.stringify(globalAsset), { status: 201 });
      },
    });

    await expect(
      client.importFile({
        globalAssetId: "global:multipart-command",
        file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
        fileName: "frame.png",
        kind: "image",
      }),
    ).resolves.toEqual(globalAsset);
    await expect(
      client.publish({
        projectId: "project-a",
        projectAssetId: "asset:one",
      }),
    ).resolves.toEqual(globalAsset);

    expect(
      requests.map(({ url, init }) => ({
        url: url.split("?")[0],
        method: init?.method,
      })),
    ).toEqual([
      {
        url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/import-file",
        method: "POST",
      },
      {
        url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/publish",
        method: "POST",
      },
    ]);
    const form = importForm(requests[0]?.url, requests[0]?.init);
    expect(form.get("kind")).toBe("image");
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("frame.png");
    expect(
      Array.from(new Uint8Array(await (file as File).arrayBuffer())),
    ).toEqual([1, 2, 3, 4]);
    expect(requests[1]?.init?.body).toBe(
      JSON.stringify({ projectId: "project-a", projectAssetId: "asset:one" }),
    );
  });

  it("replays one preassigned Global Asset id when the same import command retries an unknown result", async () => {
    const globalAsset = {
      ...readyAsset,
      id: "global:one",
      url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/media",
    };
    const importedIds: string[] = [];
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as (
      options: Record<string, unknown>,
    ) => {
      importFile(input: {
        globalAssetId: string;
        file: Blob;
        fileName: string;
        kind: "image";
      }): Promise<typeof globalAsset>;
    };
    const client = createGlobalClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        importedIds.push(
          String(importForm(input, init).get("globalAssetId") ?? ""),
        );
        if (importedIds.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(globalAsset), { status: 201 });
      },
    });
    const command = {
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image" as const,
      globalAssetId: "global:retry-command",
    };

    await expect(client.importFile(command)).rejects.toThrow("connection lost");
    await client.importFile(command);

    expect(importedIds[0]).toBe("global:retry-command");
    expect(importedIds[1]).toBe(importedIds[0]);
  });

  it("replays the first Global import snapshot when its command object is mutated after an unknown result", async () => {
    const globalAsset = {
      ...readyAsset,
      id: "global:one",
      url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/media",
    };
    const requests: Array<{
      fileName: string;
      kind: string;
      bytes: number[];
    }> = [];
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as (
      options: Record<string, unknown>,
    ) => {
      importFile(input: {
        globalAssetId: string;
        file: Blob;
        fileName: string;
        kind: "image" | "video";
      }): Promise<typeof globalAsset>;
    };
    const client = createGlobalClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const form = importForm(input, init);
        const file = form.get("file") as File;
        requests.push({
          fileName: file.name,
          kind: String(form.get("kind")),
          bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
        });
        if (requests.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(globalAsset), { status: 201 });
      },
    });
    const command = {
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image" as "image" | "video",
      globalAssetId: "global:original-command",
    };

    await expect(client.importFile(command)).rejects.toThrow("connection lost");
    command.file = new Blob([new Uint8Array([9, 9, 9, 9])], {
      type: "video/mp4",
    });
    command.fileName = "changed.mp4";
    command.kind = "video";
    await client.importFile(command);

    expect(requests).toEqual([
      { fileName: "frame.png", kind: "image", bytes: [1, 2, 3, 4] },
      { fileName: "frame.png", kind: "image", bytes: [1, 2, 3, 4] },
    ]);
  });

  it("preserves an explicitly assigned Global Asset import id", async () => {
    const globalAsset = {
      ...readyAsset,
      id: "global:one",
      url: "http://127.0.0.1:8789/api/v1/libraries/personal/assets/global%3Aone/media",
    };
    let importedId: FormDataEntryValue | null = null;
    const createGlobalClient = (projectAssetClients as Record<string, unknown>)
      .createPersonalGlobalAssetHostClient as (
      options: Record<string, unknown>,
    ) => {
      importFile(input: {
        globalAssetId: string;
        file: Blob;
        fileName: string;
        kind: "image";
      }): Promise<typeof globalAsset>;
    };
    const client = createGlobalClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        importedId = importForm(input, init).get("globalAssetId");
        return new Response(JSON.stringify(globalAsset), { status: 201 });
      },
    });

    await client.importFile({
      globalAssetId: "global:caller-command",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image",
    });

    expect(importedId).toBe("global:caller-command");
  });

  it("requires a Global Asset id from the Host command boundary before I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not send an unnamed import");
    });
    const client = projectAssetClients.createPersonalGlobalAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch,
    });

    await expect(
      client.importFile({
        file: new Blob([new Uint8Array([1])], { type: "image/png" }),
        fileName: "frame.png",
        kind: "image",
      } as never),
    ).rejects.toThrow("global asset id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists and reads references, then restores through the same Project scope", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/references")) {
          return new Response(
            JSON.stringify({
              projectAssetId: "asset:one",
              references: [],
            }),
            {
              headers: {
                "content-type": "application/json",
                [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-references",
              },
            },
          );
        }
        if (url.endsWith("/restore")) {
          return new Response(JSON.stringify(readyAsset), {
            headers: {
              "content-type": "application/json",
              [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-restored",
            },
          });
        }
        return new Response(JSON.stringify({ assets: [readyAsset] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(client.list({ projectId: "project-a" })).resolves.toEqual({
      projectId: "project-a",
      value: [readyAsset],
    });
    const references = await client.references({
      projectId: "project-a",
      assetId: "asset:one",
    });
    expect(references).toEqual({
      projectId: "project-a",
      value: [],
      receipt: "receipt-references",
    });
    await expect(
      client.restore({
        projectId: "project-a",
        assetId: "asset:one",
        actorClientType: "mcp",
        receipt: references.receipt,
      }),
    ).resolves.toEqual({
      projectId: "project-a",
      value: readyAsset,
      receipt: "receipt-restored",
    });
    expect(
      requests.map(({ url, init }) => ({
        url,
        method: init?.method,
        headers: init?.headers,
      })),
    ).toEqual([
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets",
        method: "GET",
        headers: {},
      },
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone/references",
        method: "GET",
        headers: {},
      },
      {
        url: "http://127.0.0.1:8789/api/v1/projects/project-a/assets/asset%3Aone/restore",
        method: "POST",
        headers: {
          "x-clash-client-type": "mcp",
          "x-clash-if-match": "receipt-references",
        },
      },
    ]);
  });

  it("rejects a storage-shaped Host response instead of widening ResolvedAsset", async () => {
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...readyAsset,
            storageKey: "blobs/private/original.png",
          }),
          {
            headers: {
              "content-type": "application/json",
              [PROJECT_ASSET_READ_RECEIPT_HEADER]: "receipt-invalid",
            },
          },
        ),
    });

    await expect(
      client.get({ projectId: "project-a", assetId: "asset:one" }),
    ).rejects.toThrow(/unrecognized key.*storageKey/i);
  });

  it("answers an id the Project does not have with the ids it does have", async () => {
    const requests: string[] = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        return url.pathname.endsWith("/assets")
          ? new Response(
              JSON.stringify({
                assets: [
                  readyAsset,
                  { ...readyAsset, id: "asset:two", name: "other.png" },
                ],
              }),
              { headers: { "content-type": "application/json" } },
            )
          : new Response(
              JSON.stringify({
                code: "PROJECT_ASSET_NOT_FOUND",
                error: "Project Asset not found",
              }),
              { status: 404, headers: { "content-type": "application/json" } },
            );
      },
    });

    // The id was copied without its prefix, as the benchmark agent did.
    for (const call of [
      () => client.get({ projectId: "project-a", assetId: "one" }),
      () => client.references({ projectId: "project-a", assetId: "one" }),
      () => client.trash({ projectId: "project-a", assetId: "one" }),
      () => client.restore({ projectId: "project-a", assetId: "one" }),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        status: 404,
        body: {
          code: "PROJECT_ASSET_NOT_FOUND",
          projectAssetId: "one",
          suggestedProjectAssetIds: ["asset:one"],
        },
      });
      const recovery = projectAssetClients.projectAssetRecovery(failure);
      expect(recovery?.steps).toEqual([
        expect.objectContaining({ operation: "get", assetId: "asset:one" }),
        expect.objectContaining({ operation: "list" }),
      ]);
    }
    expect(
      requests.filter((request) => request.endsWith("/assets")),
    ).toHaveLength(4);
  });

  it("turns each Host import and lifecycle rejection into the operations that resolve it", () => {
    const recovery = (body: Record<string, unknown>) =>
      projectAssetClients.projectAssetRecovery({ body });

    const duplicate = recovery({
      code: "PROJECT_ASSET_DUPLICATE_CONTENT",
      projectAssetId: "preassigned",
      existingProjectAssetIds: ["asset:minted"],
    });
    expect(duplicate?.problem).toContain("asset:minted");
    expect(duplicate?.steps).toEqual([
      expect.objectContaining({ operation: "get", assetId: "asset:minted" }),
      expect.objectContaining({ operation: "trash", assetId: "asset:minted" }),
      expect.objectContaining({
        operation: "import",
        projectAssetId: "preassigned",
      }),
      expect.objectContaining({
        operation: "import",
        projectAssetId: "preassigned",
        allowDuplicate: true,
      }),
    ]);

    expect(
      recovery({ code: "PROJECT_ASSET_TRASHED", projectAssetId: "asset:one" })
        ?.steps,
    ).toEqual([
      expect.objectContaining({ operation: "get", assetId: "asset:one" }),
      expect.objectContaining({ operation: "restore", assetId: "asset:one" }),
    ]);
    expect(
      recovery({
        code: "PROJECT_ASSET_ID_COLLISION",
        projectAssetId: "asset:one",
      })?.steps[0],
    ).toMatchObject({ operation: "get", assetId: "asset:one" });
    expect(
      recovery({ code: "ASSET_IN_USE", projectAssetId: "asset:one" })?.steps,
    ).toEqual([
      expect.objectContaining({
        operation: "references",
        assetId: "asset:one",
      }),
    ]);
    // A failure raised before any Host call still gets its step.
    expect(
      projectAssetClients.projectAssetRecovery(new Error("READ_REQUIRED"), {
        code: "READ_REQUIRED",
        projectAssetId: "asset:one",
      })?.steps,
    ).toEqual([
      expect.objectContaining({ operation: "get", assetId: "asset:one" }),
    ]);
    expect(recovery({ code: "SOMETHING_ELSE" })).toBeUndefined();
  });

  it("forwards the duplicate-content policy only when a caller sets one", async () => {
    const policies: Array<FormDataEntryValue | null> = [];
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async (input, init) => {
        policies.push(importForm(input, init).get("duplicateContent"));
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const file = {
      projectId: "project-a",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image" as const,
      projectAssetId: "asset:one",
    };
    await client.importFile({ ...file });
    await client.importFile({ ...file, duplicateContent: "reject" });
    expect(policies).toEqual([null, "reject"]);
  });

  it("preserves the Host error code and message for CLI and MCP peers", async () => {
    const client = createProjectAssetHostClient({
      endpoint: "http://127.0.0.1:8789",
      env: {},
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: "ASSET_IN_USE",
            error: "Project Asset has downstream Action inputs",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
    });

    await expect(
      client.get({ projectId: "project-a", assetId: "asset:one" }),
    ).rejects.toThrow(
      /ASSET_IN_USE: Project Asset has downstream Action inputs.*HTTP 409/i,
    );
  });
});
