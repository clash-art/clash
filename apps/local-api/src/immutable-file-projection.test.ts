import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveImmutableFileProjection } from "./immutable-file-projection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clash-file-projection-"));
  tempDirs.push(dir);
  return join(dir, name);
}

async function digits(): Promise<string> {
  const path = await tempFile("digits.bin");
  await writeFile(path, "0123456789");
  return path;
}

/** A sparse file: its length is real, but it occupies no disk or memory. */
async function sparseFile(byteLength: number): Promise<string> {
  const path = await tempFile("sparse.mp4");
  const handle = await open(path, "w");
  try {
    await handle.truncate(byteLength);
  } finally {
    await handle.close();
  }
  return path;
}

describe("serveImmutableFileProjection", () => {
  it("streams the whole file with 200 when no Range is requested", async () => {
    const response = await serveImmutableFileProjection({
      path: await digits(),
      contentType: "audio/mpeg",
      expectedByteLength: 10,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.body).toBeInstanceOf(ReadableStream);
    await expect(response.text()).resolves.toBe("0123456789");
  });

  it.each([
    { range: "bytes=0-", contentRange: "bytes 0-9/10", body: "0123456789" },
    { range: "bytes=7-", contentRange: "bytes 7-9/10", body: "789" },
    { range: "bytes=2-5", contentRange: "bytes 2-5/10", body: "2345" },
    { range: "bytes=0-0", contentRange: "bytes 0-0/10", body: "0" },
    { range: "bytes=8-99", contentRange: "bytes 8-9/10", body: "89" },
    { range: "bytes=-3", contentRange: "bytes 7-9/10", body: "789" },
    { range: "bytes=-99", contentRange: "bytes 0-9/10", body: "0123456789" },
  ])("serves $range as 206 $contentRange", async (expected) => {
    const response = await serveImmutableFileProjection({
      path: await digits(),
      contentType: "audio/mpeg",
      rangeHeader: expected.range,
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe(expected.contentRange);
    expect(response.headers.get("content-length")).toBe(
      String(expected.body.length),
    );
    await expect(response.text()).resolves.toBe(expected.body);
  });

  it.each([
    "bytes=10-",
    "bytes=20-30",
    "bytes=7-2",
    "bytes=-0",
    "bytes=-",
    "items=0-1",
  ])("rejects %s with 416 and the full length", async (rangeHeader) => {
    const response = await serveImmutableFileProjection({
      path: await digits(),
      contentType: "audio/mpeg",
      rangeHeader,
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-range")).toBe("bytes */10");
    expect(response.body).toBeNull();
  });

  it("answers a satisfiable multi-range request with the full 200 resource", async () => {
    const response = await serveImmutableFileProjection({
      path: await digits(),
      contentType: "audio/mpeg",
      rangeHeader: "bytes=0-1, 4-5",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    expect(response.headers.get("content-length")).toBe("10");
    await expect(response.text()).resolves.toBe("0123456789");
  });

  it("keeps 416 for a multi-range request with an unsatisfiable part", async () => {
    const response = await serveImmutableFileProjection({
      path: await digits(),
      contentType: "audio/mpeg",
      rangeHeader: "bytes=0-1, 20-30",
    });

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */10");
  });

  it("sends strong content-digest validators on 200 and 206 responses", async () => {
    const path = await digits();
    const digest = "a".repeat(64);
    const lastModified = Date.UTC(2025, 0, 2, 3, 4, 5);
    const full = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      contentDigest: digest,
      lastModified,
    });
    const partial = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      rangeHeader: "bytes=2-5",
      contentDigest: digest,
      lastModified,
    });

    for (const response of [full, partial]) {
      expect(response.headers.get("etag")).toBe(`"${digest}"`);
      expect(response.headers.get("last-modified")).toBe(
        new Date(lastModified).toUTCString(),
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, max-age=31536000, immutable",
      );
    }
  });

  it("returns 304 without a body when If-None-Match names the current digest", async () => {
    const digest = "b".repeat(64);
    for (const ifNoneMatch of [
      `"${digest}"`,
      `W/"${digest}"`,
      `"other", "${digest}"`,
      "*",
    ]) {
      const response = await serveImmutableFileProjection({
        path: await digits(),
        contentType: "audio/mpeg",
        contentDigest: digest,
        lastModified: Date.UTC(2025, 0, 2),
        ifNoneMatch,
      });

      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(response.headers.get("etag")).toBe(`"${digest}"`);
      expect(response.headers.get("content-length")).toBeNull();
    }
  });

  it("serves 206 only when If-Range matches the current validator", async () => {
    const path = await digits();
    const digest = "c".repeat(64);
    const lastModified = Date.UTC(2025, 0, 2, 3, 4, 5);
    const matchingTag = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      rangeHeader: "bytes=2-5",
      contentDigest: digest,
      lastModified,
      ifRange: `"${digest}"`,
    });
    const staleTag = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      rangeHeader: "bytes=2-5",
      contentDigest: digest,
      lastModified,
      ifRange: '"bogus-etag"',
    });
    const matchingDate = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      rangeHeader: "bytes=2-5",
      contentDigest: digest,
      lastModified,
      ifRange: new Date(lastModified).toUTCString(),
    });
    const staleDate = await serveImmutableFileProjection({
      path,
      contentType: "audio/mpeg",
      rangeHeader: "bytes=2-5",
      contentDigest: digest,
      lastModified,
      ifRange: new Date(lastModified - 60_000).toUTCString(),
    });

    expect(matchingTag.status).toBe(206);
    await expect(matchingTag.text()).resolves.toBe("2345");
    expect(matchingDate.status).toBe(206);
    await expect(matchingDate.text()).resolves.toBe("2345");
    expect(staleTag.status).toBe(200);
    await expect(staleTag.text()).resolves.toBe("0123456789");
    expect(staleDate.status).toBe(200);
    await expect(staleDate.text()).resolves.toBe("0123456789");
  });

  it("serves an empty file without a body", async () => {
    const path = await tempFile("empty.bin");
    await writeFile(path, "");

    const response = await serveImmutableFileProjection({
      path,
      contentType: "application/octet-stream",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("0");
    await expect(response.text()).resolves.toBe("");
  });

  it("rejects a file whose length no longer matches its Resource facts", async () => {
    await expect(
      serveImmutableFileProjection({
        path: await digits(),
        contentType: "audio/mpeg",
        expectedByteLength: 11,
      }),
    ).rejects.toThrow(/no longer matches/);
  });

  // 3 GiB exceeds what one fs.readFile call can return, so a response that
  // buffered the file could not produce these headers and a first chunk.
  const largeByteLength = 3 * 1024 ** 3;

  it.each([
    { name: "no Range", rangeHeader: undefined, status: 200 },
    { name: "the open range bytes=0-", rangeHeader: "bytes=0-", status: 206 },
  ])(
    "streams a multi-gigabyte file in bounded chunks for $name",
    async ({ rangeHeader, status }) => {
      const response = await serveImmutableFileProjection({
        path: await sparseFile(largeByteLength),
        contentType: "video/mp4",
        expectedByteLength: largeByteLength,
        ...(rangeHeader ? { rangeHeader } : {}),
      });

      expect(response.status).toBe(status);
      expect(response.headers.get("content-length")).toBe(
        String(largeByteLength),
      );
      if (rangeHeader) {
        expect(response.headers.get("content-range")).toBe(
          `bytes 0-${largeByteLength - 1}/${largeByteLength}`,
        );
      }
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value!.byteLength).toBeGreaterThan(0);
      expect(first.value!.byteLength).toBeLessThan(1024 ** 2);
      await reader.cancel();
    },
  );
});

describe("immutable file projection descriptors", () => {
  const openDescriptors = async () =>
    (await import("node:fs")).readdirSync("/proc/self/fd").length;

  it.runIf(process.platform === "linux")(
    "holds no descriptor for a response whose body is never read (client gone before the write)",
    async () => {
      const path = await sparseFile(8 * 1024 * 1024);
      const before = await openDescriptors();
      const responses = await Promise.all(
        Array.from({ length: 20 }, () =>
          serveImmutableFileProjection({
            path,
            contentType: "video/mp4",
            rangeHeader: "bytes=0-",
          }),
        ),
      );
      expect(responses.every((response) => response.status === 206)).toBe(true);
      expect(await openDescriptors()).toBeLessThanOrEqual(before);
    },
  );

  it.runIf(process.platform === "linux")(
    "closes the descriptor when a partly read body is cancelled",
    async () => {
      const path = await sparseFile(8 * 1024 * 1024);
      const before = await openDescriptors();
      const response = await serveImmutableFileProjection({
        path,
        contentType: "video/mp4",
      });
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      expect(await openDescriptors()).toBe(before + 1);
      await reader.cancel();
      expect(await openDescriptors()).toBe(before);
    },
  );

  it("fails the body if the file was replaced after the headers were sent", async () => {
    const path = await digits();
    const response = await serveImmutableFileProjection({
      path,
      contentType: "application/octet-stream",
    });
    // Write the replacement beside the original and rename it over, so the
    // two files exist at once and cannot share an inode.
    await writeFile(`${path}.next`, "0123456789");
    await rename(`${path}.next`, path);
    await expect(response.arrayBuffer()).rejects.toThrow(
      "changed while it was being served",
    );
  });
});
