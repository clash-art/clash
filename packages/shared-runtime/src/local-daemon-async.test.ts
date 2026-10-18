import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Wrap the sync fs API so the test can prove the Desktop path never enters it.
// The wrappers keep the real behaviour for the sync variant exercised below.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    existsSync: vi.fn(actual.existsSync),
    mkdirSync: vi.fn(actual.mkdirSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

import {
  resolveLocalDaemonRuntimeFingerprint,
  resolveLocalDaemonRuntimeFingerprintAsync,
} from "./local-daemon.js";
import { writeLocalDaemonRuntimeManifest } from "./local-daemon-manifest.js";

const SYNC_FS_FUNCTIONS = [
  "closeSync",
  "existsSync",
  "mkdirSync",
  "openSync",
  "readFileSync",
  "readdirSync",
  "statSync",
] as const;

type SyncFsFunction = (typeof SYNC_FS_FUNCTIONS)[number];

function mockCalls(name: SyncFsFunction): unknown[][] {
  return (fs[name] as unknown as ReturnType<typeof vi.fn>).mock.calls;
}

function clearSyncFsCalls(): void {
  for (const name of SYNC_FS_FUNCTIONS) {
    (fs[name] as unknown as ReturnType<typeof vi.fn>).mockClear();
  }
}

function calledSyncFsFunctions(): SyncFsFunction[] {
  return SYNC_FS_FUNCTIONS.filter((name) => mockCalls(name).length > 0);
}

describe("async runtime fingerprint", () => {
  it("does the manifest-path file I/O without calling the synchronous fs API", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-manifest-async-"));
    try {
      const runtime = join(root, "runtime");
      await mkdir(join(runtime, "bundled-plugins", "asset-edit"), {
        recursive: true,
      });
      await mkdir(join(runtime, "project-ui", "_app"), { recursive: true });
      const entry = join(runtime, "local-api.cjs");
      await writeFile(entry, "module.exports = 'host entry';\n");
      await writeFile(
        join(runtime, "bundled-plugins", "asset-edit", "index.mjs"),
        "export const adapter = 'old';\n",
      );
      await writeFile(
        join(runtime, "project-ui", "_app", "editor.js"),
        "old();\n",
      );
      await writeLocalDaemonRuntimeManifest({ runtimeDir: runtime });

      clearSyncFsCalls();
      const sync = resolveLocalDaemonRuntimeFingerprint(entry);
      // Prove the wrapper actually intercepts this module's sync imports.
      expect(calledSyncFsFunctions()).toEqual(
        expect.arrayContaining([
          "existsSync",
          "readFileSync",
          "readdirSync",
          "statSync",
        ]),
      );

      clearSyncFsCalls();
      await expect(
        resolveLocalDaemonRuntimeFingerprintAsync(entry),
      ).resolves.toBe(sync);
      expect(calledSyncFsFunctions()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
