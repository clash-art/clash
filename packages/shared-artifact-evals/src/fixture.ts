import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type {
  BenchmarkFixtureFile,
  BenchmarkFixtureManifest,
  BenchmarkInputFixture,
  BenchmarkInputFixtureProvenance,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FIXTURE_PATH_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const RUNNER_OWNED_TOP_LEVEL_PATHS = new Set([
  ".agents",
  ".claude",
  ".clash",
  ".git",
  "outcome.json",
  "outcome.md",
  "submission.json",
]);

function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function collectFixtureFiles(
  directory: string,
  prefix = "",
): Promise<BenchmarkFixtureFile[]> {
  const files: BenchmarkFixtureFile[] = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => compareNames(left.name, right.name),
  );
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const fixturePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Benchmark input fixture contains a symbolic link: ${fixturePath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFixtureFiles(absolutePath, fixturePath)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Benchmark input fixture contains a non-regular entry: ${fixturePath}`,
      );
    }
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(
        `Benchmark input fixture changed while scanning: ${fixturePath}`,
      );
    }
    files.push({
      path: fixturePath,
      bytes: metadata.size,
      sha256: await sha256File(absolutePath),
    });
  }
  return files;
}

function manifestSha256(files: BenchmarkFixtureFile[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, files }))
    .digest("hex");
}

export type BenchmarkFixtureIntegrityReport = {
  status: "pass" | "fail";
  changedFiles: string[];
  missingFiles: string[];
  detail: string;
};

function missingPath(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

/**
 * Rechecks the immutable public inputs after the agent exits. Agent-created
 * outputs elsewhere in the workspace are intentionally ignored.
 */
export async function verifyBenchmarkInputFixture(
  workspace: string,
  installed: BenchmarkFixtureManifest,
): Promise<BenchmarkFixtureIntegrityReport> {
  const changedFiles: string[] = [];
  const missingFiles: string[] = [];
  for (const expected of installed.files) {
    if (
      !FIXTURE_PATH_PATTERN.test(expected.path) ||
      expected.path
        .split("/")
        .some((segment) => segment === "." || segment === "..")
    ) {
      throw new Error(
        `Installed benchmark fixture contains an unsafe file path: ${expected.path}`,
      );
    }
    const segments = expected.path.split("/");
    let current = workspace;
    let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
    let invalid = false;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      try {
        metadata = await lstat(current);
      } catch (error) {
        if (missingPath(error)) {
          missingFiles.push(expected.path);
          invalid = true;
          break;
        }
        throw error;
      }
      const isFile = index === segments.length - 1;
      if (
        metadata.isSymbolicLink() ||
        (isFile ? !metadata.isFile() : !metadata.isDirectory())
      ) {
        changedFiles.push(expected.path);
        invalid = true;
        break;
      }
    }
    if (invalid || !metadata) continue;
    if (
      metadata.size !== expected.bytes ||
      (await sha256File(current)) !== expected.sha256
    ) {
      changedFiles.push(expected.path);
    }
  }
  const status =
    changedFiles.length === 0 && missingFiles.length === 0 ? "pass" : "fail";
  return {
    status,
    changedFiles,
    missingFiles,
    detail:
      status === "pass"
        ? `Verified ${installed.files.length} benchmark input fixture file(s) match the installed manifest at this check.`
        : `Benchmark input fixture changed after installation: ${[
            ...(changedFiles.length > 0
              ? [`changed ${changedFiles.join(", ")}`]
              : []),
            ...(missingFiles.length > 0
              ? [`missing ${missingFiles.join(", ")}`]
              : []),
          ].join("; ")}.`,
  };
}

export async function createBenchmarkFixtureManifest(
  directory: string,
): Promise<BenchmarkFixtureManifest> {
  const directoryMetadata = await lstat(directory);
  if (directoryMetadata.isSymbolicLink()) {
    throw new Error(
      "Benchmark input fixture directory must not be a symbolic link",
    );
  }
  if (!directoryMetadata.isDirectory()) {
    throw new Error("Benchmark input fixture path must be a directory");
  }
  const files = await collectFixtureFiles(directory);
  return {
    schemaVersion: 1,
    files,
    manifestSha256: manifestSha256(files),
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

function assertSafeFixturePath(path: string): void {
  if (
    isAbsolute(path) ||
    !FIXTURE_PATH_PATTERN.test(path) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      "Benchmark input fixture path must be a safe relative directory beneath suiteRoot",
    );
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const local = relative(root, candidate);
  if (
    !local ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  ) {
    throw new Error(`${label} must remain beneath suiteRoot`);
  }
}

async function assertPathSegmentsAreNotSymlinks(
  suiteRoot: string,
  fixturePath: string,
): Promise<void> {
  let current = suiteRoot;
  for (const segment of fixturePath.split("/")) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) {
      throw new Error(
        `Benchmark input fixture path contains a symbolic link: ${fixturePath}`,
      );
    }
  }
}

function assertNoRunnerOwnedPaths(manifest: BenchmarkFixtureManifest): void {
  for (const file of manifest.files) {
    const topLevel = file.path.split("/", 1)[0]?.toLowerCase();
    if (topLevel && RUNNER_OWNED_TOP_LEVEL_PATHS.has(topLevel)) {
      throw new Error(
        `Benchmark input fixture uses runner-owned path: ${file.path}`,
      );
    }
  }
}

async function assertNoRunnerOwnedTopLevelEntries(
  source: string,
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (RUNNER_OWNED_TOP_LEVEL_PATHS.has(entry.name.toLowerCase())) {
      throw new Error(
        `Benchmark input fixture uses runner-owned path: ${entry.name}`,
      );
    }
  }
}

async function copyFixtureContents(
  source: string,
  workspace: string,
  manifest: BenchmarkFixtureManifest,
): Promise<void> {
  for (const file of manifest.files) {
    const destination = join(workspace, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(source, file.path), destination, {
      recursive: false,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  }
}

export async function writeBenchmarkInputFixtureReceipt(
  workspace: string,
  provenance: BenchmarkInputFixtureProvenance,
): Promise<void> {
  const receiptPath = join(workspace, provenance.receiptPath);
  await mkdir(join(workspace, ".clash"), { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify(provenance, null, 2)}\n`,
    "utf8",
  );
}

export async function installBenchmarkInputFixture(input: {
  suiteRoot: string;
  workspace: string;
  fixture: BenchmarkInputFixture;
  /** The product Workspace was imported first; fixture paths must still be new. */
  allowExistingWorkspace?: true;
}): Promise<BenchmarkInputFixtureProvenance> {
  assertSafeFixturePath(input.fixture.path);
  if (!SHA256_PATTERN.test(input.fixture.manifestSha256)) {
    throw new Error(
      "Benchmark input fixture manifestSha256 must be a lowercase SHA-256 digest",
    );
  }
  const workspaceEntries = await readdir(input.workspace);
  if (!input.allowExistingWorkspace && workspaceEntries.length > 0) {
    throw new Error(
      "Benchmark input fixture must be installed into a fresh empty workspace",
    );
  }
  await assertPathSegmentsAreNotSymlinks(input.suiteRoot, input.fixture.path);
  const sourceCandidate = resolve(input.suiteRoot, input.fixture.path);
  assertContained(input.suiteRoot, sourceCandidate, "Benchmark input fixture");
  const source = await realpath(sourceCandidate);
  assertContained(input.suiteRoot, source, "Benchmark input fixture");
  if (!(await stat(source)).isDirectory()) {
    throw new Error("Benchmark input fixture path must be a directory");
  }

  await assertNoRunnerOwnedTopLevelEntries(source);
  const sourceManifest = await createBenchmarkFixtureManifest(source);
  if (sourceManifest.manifestSha256 !== input.fixture.manifestSha256) {
    throw new Error(
      `Benchmark input fixture manifest sha256 mismatch: expected ${input.fixture.manifestSha256}, received ${sourceManifest.manifestSha256}`,
    );
  }
  assertNoRunnerOwnedPaths(sourceManifest);

  await copyFixtureContents(source, input.workspace, sourceManifest);
  // Recheck the source first: a source change can also corrupt the copy, and
  // the copied-result checks below would otherwise report the wrong cause.
  const sourceAfterCopy = await createBenchmarkFixtureManifest(source);
  if (sourceAfterCopy.manifestSha256 !== sourceManifest.manifestSha256) {
    throw new Error(
      `Benchmark input fixture source changed during installation: expected ${sourceManifest.manifestSha256}, received ${sourceAfterCopy.manifestSha256}`,
    );
  }
  const copiedManifest = input.allowExistingWorkspace
    ? sourceManifest
    : await createBenchmarkFixtureManifest(input.workspace);
  if (input.allowExistingWorkspace) {
    const integrity = await verifyBenchmarkInputFixture(
      input.workspace,
      sourceManifest,
    );
    if (integrity.status !== "pass") {
      throw new Error(
        `Copied benchmark input fixture failed verification: ${integrity.detail}`,
      );
    }
  } else if (copiedManifest.manifestSha256 !== input.fixture.manifestSha256) {
    throw new Error(
      `Copied benchmark input fixture manifest sha256 mismatch: expected ${input.fixture.manifestSha256}, received ${copiedManifest.manifestSha256}`,
    );
  }

  const provenance: BenchmarkInputFixtureProvenance = {
    ...copiedManifest,
    sourcePath: input.fixture.path,
    workspacePath: ".",
    receiptPath: ".clash/benchmark-input-fixture.json",
  };
  await writeBenchmarkInputFixtureReceipt(input.workspace, provenance);
  return provenance;
}
