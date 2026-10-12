import { describe, expect, it, vi } from "vitest";

import { createProjectAssetHttpClient } from "./project-asset-http-client.js";

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
  name: "frame.png",
  metadata: { bytes: 4, contentType: "image/png" },
  provenance: { kind: "import" as const },
  lifecycle: { state: "active" as const },
  status: "ready" as const,
  url: "https://media.clash.test/api/v1/projects/project%2Fone/assets/asset%3Aone/media",
};

describe("Project Asset HTTP client", () => {
  it("owns Project URL, auth, receipt, and ResolvedAsset validation for every consumer", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createProjectAssetHttpClient({
      resolveConnection: async () => ({ endpoint: "", token: "host-token" }),
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/batch")) {
          return new Response(JSON.stringify({ assets: [readyAsset] }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify(readyAsset), {
          headers: {
            "content-type": "application/json",
            "x-clash-read-receipt": "receipt-one",
          },
        });
      },
    });

    await expect(
      client.get({ projectId: "project/one", assetId: "asset:one" }),
    ).resolves.toEqual({ value: readyAsset, receipt: "receipt-one" });
    await expect(
      client.batch({ projectId: "project/one", assetIds: ["asset:one"] }),
    ).resolves.toEqual([readyAsset]);

    expect(requests.map(({ url }) => url)).toEqual([
      "/api/v1/projects/project%2Fone/assets/asset%3Aone",
      "/api/v1/projects/project%2Fone/assets/batch",
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      "Bearer host-token",
    );
    expect(requests[1]?.init).toMatchObject({
      method: "POST",
      body: JSON.stringify({ ids: ["asset:one"] }),
    });
  });

  it("sends the browser File itself as the import-file body and preserves the caller id", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createProjectAssetHttpClient({ fetch });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
      type: "image/png",
    });

    await expect(
      client.importFile({
        projectId: "project/one",
        file,
        kind: "image",
        projectAssetId: "asset:one",
      }),
    ).resolves.toEqual(readyAsset);

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url).split("?")[0]).toBe(
      "/api/v1/projects/project%2Fone/assets/import-file",
    );
    // The File is the body: nothing copies or re-encodes its bytes client-side.
    expect(init?.body).toBe(file);
    const form = importForm(url, init);
    expect((form.get("file") as File).name).toBe("frame.png");
    expect((form.get("file") as File).type).toBe("image/png");
    expect(form.get("kind")).toBe("image");
    expect(form.get("projectAssetId")).toBe("asset:one");
  });

  it("rejects an import without the command's preassigned Project Asset id before I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not send an unnamed import");
    });
    const client = createProjectAssetHttpClient({ fetch });

    await expect(
      client.importFile({
        projectId: "project/one",
        file: new File([new Uint8Array([1])], "frame.png", {
          type: "image/png",
        }),
        kind: "image",
      } as never),
    ).rejects.toThrow("project asset id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays the preassigned Project Asset id when the same import command retries an unknown result", async () => {
    const requests: FormData[] = [];
    const client = createProjectAssetHttpClient({
      fetch: async (input, init) => {
        requests.push(importForm(input, init));
        if (requests.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const operation = {
      projectId: "project/one",
      file: new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
        type: "image/png",
      }),
      kind: "image" as const,
      projectAssetId: "asset:retry-command",
    };

    await expect(client.importFile(operation)).rejects.toThrow(
      "connection lost",
    );
    await client.importFile(operation);

    const firstId = requests[0]?.get("projectAssetId");
    const retryId = requests[1]?.get("projectAssetId");
    expect(firstId).toBe("asset:retry-command");
    expect(retryId).toBe(firstId);
  });

  it("keeps separately preassigned Project import commands distinct even when they share one Blob", async () => {
    const importedIds: FormDataEntryValue[] = [];
    const file = new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
      type: "image/png",
    });
    const client = createProjectAssetHttpClient({
      fetch: async (input, init) => {
        const importedId = importForm(input, init).get("projectAssetId");
        if (importedId !== null) importedIds.push(importedId);
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.importFile({
      projectId: "project/one",
      file,
      kind: "image",
      projectAssetId: "asset:first-command",
    });
    await client.importFile({
      projectId: "project/one",
      file,
      kind: "image",
      projectAssetId: "asset:second-command",
    });

    expect(importedIds).toHaveLength(2);
    expect(importedIds).toEqual([
      "asset:first-command",
      "asset:second-command",
    ]);
  });

  it("replays the first Project import snapshot after an unknown result", async () => {
    const requests: Array<{ url: string; form: FormData }> = [];
    const client = createProjectAssetHttpClient({
      fetch: async (input, init) => {
        requests.push({
          url: String(input).split("?")[0]!,
          form: importForm(input, init),
        });
        if (requests.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const operation: Parameters<typeof client.importFile>[0] = {
      projectId: "project/one",
      file: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" }),
      fileName: "frame.png",
      kind: "image",
      projectAssetId: "asset:original-command",
    };

    await expect(client.importFile(operation)).rejects.toThrow(
      "connection lost",
    );
    operation.projectId = "project/two";
    operation.file = new Blob([new Uint8Array([9, 9])], {
      type: "video/mp4",
    });
    operation.fileName = "changed.mp4";
    operation.kind = "video";
    operation.projectAssetId = "asset:changed";
    await client.importFile(operation);

    expect(requests.map(({ url }) => url)).toEqual([
      "/api/v1/projects/project%2Fone/assets/import-file",
      "/api/v1/projects/project%2Fone/assets/import-file",
    ]);
    expect(requests.map(({ form }) => form.get("kind"))).toEqual([
      "image",
      "image",
    ]);
    const firstId = requests[0]?.form.get("projectAssetId");
    expect(firstId).toBe("asset:original-command");
    expect(requests[1]?.form.get("projectAssetId")).toBe(firstId);
    const firstFile = requests[0]?.form.get("file");
    const retryFile = requests[1]?.form.get("file");
    expect(firstFile).toBeInstanceOf(File);
    expect(retryFile).toBeInstanceOf(File);
    expect((firstFile as File).name).toBe("frame.png");
    expect((retryFile as File).name).toBe("frame.png");
    expect((firstFile as File).type).toBe("image/png");
    expect((retryFile as File).type).toBe("image/png");
    expect(
      Array.from(new Uint8Array(await (firstFile as File).arrayBuffer())),
    ).toEqual([1, 2, 3, 4]);
    expect(
      Array.from(new Uint8Array(await (retryFile as File).arrayBuffer())),
    ).toEqual([1, 2, 3, 4]);
  });

  it("admits one Global Asset through the Project client", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(readyAsset), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createProjectAssetHttpClient({ fetch });

    await expect(
      client.admit({
        projectId: "project/one",
        globalAssetId: "global:one",
      }),
    ).resolves.toEqual(readyAsset);

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/projects/project%2Fone/assets/admit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ globalAssetId: "global:one" }),
      }),
    );
  });

  it("reuses one generated delete operation id when an unknown trash result is retried", async () => {
    const requests: RequestInit[] = [];
    const client = createProjectAssetHttpClient({
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) throw new TypeError("connection lost");
        return new Response(JSON.stringify(readyAsset), {
          headers: {
            "content-type": "application/json",
            "x-clash-read-receipt": "receipt-after-delete",
          },
        });
      },
    });
    const operation = {
      projectId: "project/one",
      assetId: "asset:one",
      receipt: "receipt-before-delete",
    };

    await expect(client.trash(operation)).rejects.toThrow("connection lost");
    await client.trash(operation);

    expect(typeof requests[0]?.body).toBe("string");
    expect(typeof requests[1]?.body).toBe("string");
    const first = JSON.parse(String(requests[0]?.body)) as {
      deleteOperationId?: unknown;
    };
    const retry = JSON.parse(String(requests[1]?.body)) as {
      deleteOperationId?: unknown;
    };
    expect(typeof first.deleteOperationId).toBe("string");
    expect(first.deleteOperationId).not.toBe("");
    expect(retry.deleteOperationId).toBe(first.deleteOperationId);
  });

  it("rejects storage-shaped responses instead of widening the product Asset shape", async () => {
    const client = createProjectAssetHttpClient({
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...readyAsset,
            storageKey: "private/frame.png",
          }),
          {
            headers: {
              "content-type": "application/json",
              "x-clash-read-receipt": "receipt-invalid",
            },
          },
        ),
    });

    await expect(
      client.get({ projectId: "project/one", assetId: "asset:one" }),
    ).rejects.toThrow(/unrecognized key.*storageKey/i);
  });
});
