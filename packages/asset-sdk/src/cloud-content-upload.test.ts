import { expect, it } from "vitest";
import { uploadCloudContent } from "./cloud-content-upload.js";
import { PROJECT_CLOUD_CONTENT_PART_BYTES } from "./content-transfer.js";

it("transfers the requested 512 MiB in bounded requests before completing", async () => {
  const byteLength = 512 * 1024 * 1024;
  const chunk = new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES);
  let sent = 0;
  let readOffset = 0;
  let uploadId: string | null = null;
  let completed = false;
  await uploadCloudContent({
    url: "https://cloud.invalid/content?existing=value",
    headers: { authorization: "fixture", "x-local-replica-id": "replica" },
    source: {
      byteLength,
      async readPart(offset, length) {
        expect(offset).toBe(readOffset);
        readOffset += length;
        return chunk.subarray(0, length);
      },
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("existing")).toBe("value");
      expect(init?.method).toBe("PUT");
      expect(new Headers(init?.headers).get("authorization")).toBe("fixture");
      const action = url.searchParams.get("upload");
      if (action === "begin") {
        uploadId = url.searchParams.get("uploadId");
        return Response.json({
          uploadId,
          partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
        });
      }
      expect(url.searchParams.get("uploadId")).toBe(uploadId);
      if (action === "part") {
        const bytes = init?.body as Uint8Array;
        expect(bytes.byteLength).toBeLessThanOrEqual(
          PROJECT_CLOUD_CONTENT_PART_BYTES,
        );
        expect(Number(url.searchParams.get("partNumber"))).toBe(
          sent / PROJECT_CLOUD_CONTENT_PART_BYTES + 1,
        );
        sent += bytes.byteLength;
      } else if (action === "complete") {
        expect(sent).toBe(byteLength);
        completed = true;
      } else throw new Error(`Unexpected action: ${action}`);
      return new Response(null, { status: 204 });
    },
  });
  expect(completed).toBe(true);
});

it("aborts a failed part without issuing completion and preserves structured limits", async () => {
  const actions: string[] = [];
  await expect(
    uploadCloudContent({
      url: "https://cloud.invalid/content",
      source: { byteLength: 3, readPart: async () => new Uint8Array(3) },
      fetch: async (input) => {
        const url = new URL(String(input));
        const action = url.searchParams.get("upload")!;
        actions.push(action);
        if (action === "begin")
          return Response.json({
            uploadId: url.searchParams.get("uploadId"),
            partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
          });
        if (action === "part")
          return Response.json(
            { code: "CLOUD_CONTENT_TOO_LARGE", maxBytes: 2 },
            { status: 413 },
          );
        return new Response(null, { status: 204 });
      },
    }),
  ).rejects.toMatchObject({ code: "CLOUD_CONTENT_TOO_LARGE", maxBytes: 2 });
  expect(actions).toEqual(["begin", "part", "abort"]);
});

it("rejects changed protocol or truncated local reads before publishing", async () => {
  for (const invalidProtocol of [true, false]) {
    const actions: string[] = [];
    await expect(
      uploadCloudContent({
        url: "https://cloud.invalid/content",
        source: { byteLength: 3, readPart: async () => new Uint8Array(2) },
        fetch: async (input) => {
          const url = new URL(String(input));
          const action = url.searchParams.get("upload")!;
          actions.push(action);
          if (action === "begin")
            return Response.json({
              uploadId: url.searchParams.get("uploadId"),
              partSize: invalidProtocol
                ? 512 * 1024 * 1024
                : PROJECT_CLOUD_CONTENT_PART_BYTES,
            });
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow();
    expect(actions).not.toContain("part");
    expect(actions).not.toContain("complete");
    expect(actions).toContain("abort");
  }
});
