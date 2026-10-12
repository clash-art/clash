import { describe, expect, it, vi } from "vitest";

import { createPersonalGlobalAssetHttpClient } from "./personal-global-asset-http-client.js";

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
  id: "global:one",
  kind: "image" as const,
  name: "frame.png",
  metadata: { bytes: 4, contentType: "image/png" },
  provenance: { kind: "import" as const },
  lifecycle: { state: "active" as const },
  status: "ready" as const,
  url: "https://media.clash.test/api/v1/libraries/personal/assets/global%3Aone/media",
};

describe("Personal Global Asset HTTP client", () => {
  it("owns personal-library URLs, authorization, and canonical response validation", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.endsWith("/assets")
        ? Response.json({ assets: [readyAsset] })
        : Response.json(readyAsset);
    });
    const client = createPersonalGlobalAssetHttpClient({
      endpoint: "https://host.clash.test/",
      token: "host-token",
      fetch,
    });

    await expect(client.list()).resolves.toEqual([readyAsset]);
    await expect(client.get({ globalAssetId: "global:one" })).resolves.toEqual(
      readyAsset,
    );

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://host.clash.test/api/v1/libraries/personal/assets",
      "https://host.clash.test/api/v1/libraries/personal/assets/global%3Aone",
    ]);
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer host-token");
  });

  it("owns import and Project-to-Global publish request shapes", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json(readyAsset, { status: 201 }),
    );
    const client = createPersonalGlobalAssetHttpClient({ fetch });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
      type: "image/png",
    });

    await client.importFile({
      file,
      kind: "image",
      globalAssetId: "global:shape-command",
    });
    await client.publish({
      projectId: "project/one",
      projectAssetId: "asset:one",
    });

    expect(String(fetch.mock.calls[0]?.[0]).split("?")[0]).toBe(
      "/api/v1/libraries/personal/assets/import-file",
    );
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(file);
    const form = importForm(...fetch.mock.calls[0]!);
    expect((form.get("file") as File).name).toBe("frame.png");
    expect(form.get("kind")).toBe("image");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        projectId: "project/one",
        projectAssetId: "asset:one",
      }),
    });
  });

  it("preserves the caller's Global Asset id in the import", async () => {
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json(readyAsset, { status: 201 }),
    );
    const client = createPersonalGlobalAssetHttpClient({ fetch });
    const file = new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
      type: "image/png",
    });

    await client.importFile({
      file,
      kind: "image",
      globalAssetId: "global:caller-operation",
    });

    const form = importForm(...fetch.mock.calls[0]!);
    expect(form.get("globalAssetId")).toBe("global:caller-operation");
  });

  it("rejects an import without the command's preassigned Global Asset id before I/O", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("must not send an unnamed import");
    });
    const client = createPersonalGlobalAssetHttpClient({ fetch });

    await expect(
      client.importFile({
        file: new File([new Uint8Array([1])], "frame.png", {
          type: "image/png",
        }),
        kind: "image",
      } as never),
    ).rejects.toThrow("global asset id is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("replays its preassigned Global Asset id when the same failed import is retried", async () => {
    const requests: FormData[] = [];
    const fetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const form = importForm(input, init);
        requests.push(form);
        if (requests.length === 1) throw new TypeError("connection lost");
        return Response.json(
          { ...readyAsset, id: String(form.get("globalAssetId")) },
          { status: 201 },
        );
      },
    );
    const client = createPersonalGlobalAssetHttpClient({ fetch });
    const operation = {
      file: new File([new Uint8Array([1, 2, 3, 4])], "frame.png", {
        type: "image/png",
      }),
      kind: "image" as const,
      globalAssetId: "global:retry-command",
    };

    await expect(client.importFile(operation)).rejects.toThrow(
      "connection lost",
    );
    await client.importFile(operation);

    const firstId = requests[0]?.get("globalAssetId");
    const retryId = requests[1]?.get("globalAssetId");
    expect(firstId).toBe("global:retry-command");
    expect(retryId).toBe(firstId);
  });

  it("preserves the caller's delete operation id in the trash request", async () => {
    const requests: RequestInit[] = [];
    const client = createPersonalGlobalAssetHttpClient({
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        return Response.json(readyAsset);
      },
    });

    await client.trash({
      globalAssetId: "global:one",
      deleteOperationId: "delete:caller-operation",
    });

    expect(requests[0]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ deleteOperationId: "delete:caller-operation" }),
    });
    expect(new Headers(requests[0]?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("reuses its generated delete operation id when the same failed trash is retried", async () => {
    const requests: RequestInit[] = [];
    const client = createPersonalGlobalAssetHttpClient({
      fetch: async (_input, init) => {
        requests.push(init ?? {});
        if (requests.length === 1) throw new TypeError("connection lost");
        return Response.json(readyAsset);
      },
    });
    const operation = { globalAssetId: "global:one" };

    await expect(client.trash(operation)).rejects.toThrow("connection lost");
    await client.trash(operation);

    expect(requests.map(({ body }) => body)).toEqual([
      expect.any(String),
      expect.any(String),
    ]);
    const firstPayload = JSON.parse(String(requests[0]?.body)) as {
      deleteOperationId?: unknown;
    };
    const retryPayload = JSON.parse(String(requests[1]?.body)) as {
      deleteOperationId?: unknown;
    };
    expect(typeof firstPayload.deleteOperationId).toBe("string");
    expect(firstPayload.deleteOperationId).not.toBe("");
    expect(retryPayload.deleteOperationId).toBe(firstPayload.deleteOperationId);
  });

  it("owns trash and restore routes", async () => {
    const fetch = vi.fn(async () => Response.json(readyAsset));
    const client = createPersonalGlobalAssetHttpClient({ fetch });

    await client.trash({ globalAssetId: "global:one" });
    await client.restore({
      globalAssetId: "global:one",
      deleteOperationId: "delete:observed",
    });

    expect(fetch.mock.calls).toEqual([
      [
        "/api/v1/libraries/personal/assets/global%3Aone",
        expect.objectContaining({ method: "DELETE" }),
      ],
      [
        "/api/v1/libraries/personal/assets/global%3Aone/restore",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ deleteOperationId: "delete:observed" }),
        }),
      ],
    ]);
  });
});
