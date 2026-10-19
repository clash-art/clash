import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileReplicaStore } from "./file-replica-store";

/**
 * Windows opens `"a"` with FILE_APPEND_DATA but without FILE_WRITE_DATA;
 * `FileHandle.truncate` needs the latter and fails with EPERM. POSIX permits
 * ftruncate on an O_APPEND descriptor, so only a simulated write-access rule
 * can reproduce the defect on Linux. The wrapper models just that: truncating
 * a handle opened append-only or read-only is rejected, while `"r+"`, `"w"`,
 * and `"wx"` handles keep their real behavior.
 */
const mocks = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mocks.open.mockImplementation(
    async (
      path: Parameters<typeof actual.open>[0],
      flags: Parameters<typeof actual.open>[1],
      mode?: Parameters<typeof actual.open>[2],
    ) => {
      const handle = await actual.open(path, flags, mode);
      if (typeof flags !== "string" || !/^(?:a\+?|r)$/u.test(flags)) {
        return handle;
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "truncate") {
            return async () => {
              throw Object.assign(
                new Error("EPERM: operation not permitted, ftruncate"),
                { code: "EPERM" },
              );
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  );
  return { ...actual, open: mocks.open };
});

let rootDir = "";

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "clash-file-replica-store-win-"));
  mocks.open.mockClear();
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

function projectDir(projectId: string): string {
  return join(rootDir, encodeURIComponent(projectId), "loro");
}

function logPathFor(projectId: string): string {
  return join(projectDir(projectId), "updates.log");
}

function header(length: number): Buffer {
  const value = Buffer.alloc(4);
  value.writeUInt32BE(length, 0);
  return value;
}

describe("FileReplicaStore Windows update-log truncation", () => {
  it("truncates through an r+ handle with write-data access, not an append-only handle", async () => {
    const store = new FileReplicaStore(rootDir);
    const projectId = "project/windows-truncate";
    await store.appendUpdate(projectId, new Uint8Array([1, 2, 3]));
    await store.appendUpdate(projectId, new Uint8Array([4, 5, 6]));
    const logPath = logPathFor(projectId);
    expect((await stat(logPath)).size).toBeGreaterThan(0);
    mocks.open.mockClear();

    await expect(
      store.truncateReplicaEventLog(projectId),
    ).resolves.toBeUndefined();

    const logOpens = mocks.open.mock.calls.filter(([path]) => path === logPath);
    expect(logOpens.map(([, flags]) => flags)).toContain("r+");
    expect(logOpens.map(([, flags]) => flags)).not.toContain("a");
    expect(logOpens.map(([, flags]) => flags)).not.toContain("w");
    expect((await stat(logPath)).size).toBe(0);
  });

  it("creates a missing update log empty and syncs its directory", async () => {
    const projectId = "project/windows-missing-log";
    const syncedDirectories: string[] = [];
    const syncUpdateLog = vi.fn(async () => undefined);
    const store = new FileReplicaStore(rootDir, {
      syncDirectory: async (path) => {
        syncedDirectories.push(path);
      },
      syncUpdateLog,
    });

    await expect(
      store.truncateReplicaEventLog(projectId),
    ).resolves.toBeUndefined();

    const logPath = logPathFor(projectId);
    expect((await stat(logPath)).size).toBe(0);
    const logOpens = mocks.open.mock.calls.filter(([path]) => path === logPath);
    expect(logOpens.map(([, flags]) => flags)).toEqual(["r+", "wx"]);
    expect(syncedDirectories).toEqual([projectDir(projectId)]);

    await store.appendUpdate(projectId, new Uint8Array([7, 8, 9]));
    expect(syncUpdateLog).toHaveBeenCalledTimes(1);
    expect(await store.loadUpdateLog(projectId)).toEqual([
      new Uint8Array([7, 8, 9]),
    ]);
  });

  it("truncates an existing log with records and still accepts later appends", async () => {
    const projectId = "project/windows-existing-log";
    const dir = projectDir(projectId);
    await mkdir(dir, { recursive: true });
    const logPath = logPathFor(projectId);
    const first = new Uint8Array([10, 11]);
    const second = new Uint8Array([12, 13, 14]);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      logPath,
      Buffer.concat([
        header(first.byteLength),
        Buffer.from(first),
        header(second.byteLength),
        Buffer.from(second),
      ]),
      { mode: 0o600 },
    );
    const store = new FileReplicaStore(rootDir);

    expect(await store.loadUpdateLog(projectId)).toHaveLength(2);
    await expect(
      store.truncateReplicaEventLog(projectId),
    ).resolves.toBeUndefined();
    expect((await stat(logPath)).size).toBe(0);
    expect(await store.loadUpdateLog(projectId)).toEqual([]);

    const later = new Uint8Array([15, 16, 17]);
    await store.appendUpdate(projectId, later);
    expect(await store.loadUpdateLog(projectId)).toEqual([later]);
  });

  it("retries the r+ path once when creating loses an EEXIST race", async () => {
    const projectId = "project/windows-create-race";
    const dir = projectDir(projectId);
    await mkdir(dir, { recursive: true });
    const logPath = logPathFor(projectId);
    const real =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const store = new FileReplicaStore(rootDir);
    const original = mocks.open.getMockImplementation();
    let attempts = 0;
    mocks.open.mockImplementation(async (path, flags, mode) => {
      if (path === logPath && flags === "r+" && attempts === 0) {
        attempts += 1;
        throw Object.assign(new Error("ENOENT: no such file or directory"), {
          code: "ENOENT",
        });
      }
      if (path === logPath && flags === "wx") {
        await real.writeFile(
          logPath,
          Buffer.concat([header(5), Buffer.from("race!")]),
        );
        throw Object.assign(new Error("EEXIST: file already exists"), {
          code: "EEXIST",
        });
      }
      return original!(path, flags, mode);
    });

    try {
      await expect(
        store.truncateReplicaEventLog(projectId),
      ).resolves.toBeUndefined();
    } finally {
      mocks.open.mockImplementation(original!);
    }

    expect(attempts).toBe(1);
    expect((await stat(logPath)).size).toBe(0);
  });

  it("surfaces a non-ENOENT open failure instead of treating it as a missing log", async () => {
    const projectId = "project/windows-open-failure";
    const dir = projectDir(projectId);
    await mkdir(dir, { recursive: true });
    const logPath = logPathFor(projectId);
    const store = new FileReplicaStore(rootDir);
    const original = mocks.open.getMockImplementation();
    mocks.open.mockImplementation(async (path, flags, mode) => {
      if (path === logPath && flags === "r+") {
        throw Object.assign(new Error("EACCES: permission denied, open"), {
          code: "EACCES",
        });
      }
      return original!(path, flags, mode);
    });

    try {
      await expect(
        store.truncateReplicaEventLog(projectId),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      mocks.open.mockImplementation(original!);
    }

    // No create fallback may run for a non-ENOENT failure.
    expect(
      mocks.open.mock.calls.filter(
        ([path, flags]) => path === logPath && flags === "wx",
      ),
    ).toEqual([]);
  });
});
