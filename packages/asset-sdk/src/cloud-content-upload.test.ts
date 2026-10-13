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

/** In-memory cloud staging: sessions hold parts by number until aborted or expired. */
function resumableCloud() {
  const sessions = new Map<string, Map<number, Uint8Array>>();
  const sent: { uploadId: string; partNumber: number }[] = [];
  /** Digests only: deep-comparing multi-part byte arrays is prohibitively slow. */
  const completed: string[] = [];
  const state = { failPart: 0, expired: new Set<string>() };
  const sha256 = async (bytes: Uint8Array) =>
    Buffer.from(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ).toString("hex");
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const action = url.searchParams.get("upload");
    const uploadId = url.searchParams.get("uploadId")!;
    if (state.expired.has(uploadId)) return new Response(null, { status: 410 });
    if (action === "begin") {
      if (!sessions.has(uploadId)) sessions.set(uploadId, new Map());
      return Response.json({
        uploadId,
        partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
        parts: await Promise.all(
          [...sessions.get(uploadId)!].map(async ([partNumber, bytes]) => ({
            partNumber,
            sha256: await sha256(bytes),
          })),
        ),
      });
    }
    const session = sessions.get(uploadId);
    if (!session) return new Response(null, { status: 410 });
    if (action === "part") {
      const partNumber = Number(url.searchParams.get("partNumber"));
      if (partNumber === state.failPart) throw new TypeError("fetch failed");
      session.set(partNumber, init?.body as Uint8Array);
      sent.push({ uploadId, partNumber });
    } else if (action === "complete") {
      completed.push(
        await sha256(
          Buffer.concat(
            [...session].sort(([a], [b]) => a - b).map(([, bytes]) => bytes),
          ),
        ),
      );
    } else if (action === "abort") sessions.delete(uploadId);
    return new Response(null, { status: 204 });
  };
  return { fetcher, sessions, sent, completed, state, sha256 };
}
function memorySession() {
  let uploadId: string | undefined;
  return {
    current: () => uploadId,
    load: async () => uploadId,
    save: async (value: string) => void (uploadId = value),
    clear: async () => void (uploadId = undefined),
  };
}
const threeParts = () => {
  const bytes = new Uint8Array(2 * PROJECT_CLOUD_CONTENT_PART_BYTES + 5);
  bytes.fill(1, 0, PROJECT_CLOUD_CONTENT_PART_BYTES);
  bytes.fill(2, PROJECT_CLOUD_CONTENT_PART_BYTES);
  bytes.fill(3, 2 * PROJECT_CLOUD_CONTENT_PART_BYTES);
  return bytes;
};
const sourceOf = (bytes: Uint8Array) => ({
  byteLength: bytes.byteLength,
  readPart: async (offset: number, length: number) =>
    bytes.subarray(offset, offset + length),
});

it("resumes an interrupted upload by sending only the parts the cloud session lacks", async () => {
  const cloud = resumableCloud();
  const session = memorySession();
  const bytes = threeParts();
  const upload = () =>
    uploadCloudContent({
      url: "https://cloud.invalid/content",
      source: sourceOf(bytes),
      fetch: cloud.fetcher,
      session,
    });
  cloud.state.failPart = 2;
  await expect(upload()).rejects.toThrow("fetch failed");
  const interrupted = session.current()!;
  expect(cloud.sent).toEqual([{ uploadId: interrupted, partNumber: 1 }]);
  expect(cloud.sessions.has(interrupted)).toBe(true);

  cloud.state.failPart = 0;
  cloud.sent.length = 0;
  await upload();
  expect(cloud.sent).toEqual([
    { uploadId: interrupted, partNumber: 2 },
    { uploadId: interrupted, partNumber: 3 },
  ]);
  expect(cloud.completed).toEqual([await cloud.sha256(bytes)]);
  expect(session.current()).toBeUndefined();
});

it("falls back to a fresh full upload when the remembered session expired", async () => {
  const cloud = resumableCloud();
  const session = memorySession();
  const bytes = threeParts();
  await session.save("expired-session-id");
  cloud.state.expired.add("expired-session-id");
  await uploadCloudContent({
    url: "https://cloud.invalid/content",
    source: sourceOf(bytes),
    fetch: cloud.fetcher,
    session,
  });
  expect(cloud.sent.map((part) => part.partNumber)).toEqual([1, 2, 3]);
  expect(new Set(cloud.sent.map((part) => part.uploadId)).size).toBe(1);
  expect(cloud.sent[0]!.uploadId).not.toBe("expired-session-id");
  expect(cloud.completed).toEqual([await cloud.sha256(bytes)]);
});

it("discards a session whose held part does not match the local bytes", async () => {
  const cloud = resumableCloud();
  const session = memorySession();
  const bytes = threeParts();
  await session.save("stale-session-id");
  cloud.sessions.set(
    "stale-session-id",
    new Map([[1, new Uint8Array(PROJECT_CLOUD_CONTENT_PART_BYTES)]]),
  );
  await expect(
    uploadCloudContent({
      url: "https://cloud.invalid/content",
      source: sourceOf(bytes),
      fetch: cloud.fetcher,
      session,
    }),
  ).rejects.toThrow("conflicting part");
  expect(cloud.completed).toEqual([]);
  expect(cloud.sessions.has("stale-session-id")).toBe(false);
  expect(session.current()).toBeUndefined();
});
