import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import type { BenchmarkSubjectRecord } from "./backend-types";
import { hashRegularTree } from "./environment-lock";

const execFileAsync = promisify(execFile);

/**
 * The product build a benchmark run measures. It is selected explicitly so two
 * runs are comparable only when their locked subject records agree.
 */
export type BenchmarkSubjectSpec =
  | {
      /** The checked-out working tree, including uncommitted changes. */
      kind: "working-tree";
      repoRoot: string;
      /** Rebuild the plugin runtime from the tree before locking it. */
      build?: BenchmarkSubjectBuild;
    }
  | {
      /** One exact commit, checked out into a private worktree and built there. */
      kind: "commit";
      repoRoot: string;
      rev: string;
      workRoot: string;
      build: BenchmarkSubjectBuild;
    }
  | {
      /**
       * An already-released package: a `.tgz`, an installed package directory,
       * or an npm spec that is fetched and extracted.
       */
      kind: "release";
      artifact:
        | { kind: "tarball"; path: string }
        | { kind: "installed-directory"; path: string }
        | { kind: "npm"; spec: string };
      workRoot: string;
      /** Refuse the artifact unless its manifest declares this version. */
      expectedVersion?: string;
      /** Refuse the artifact unless its tarball or tree hashes to this digest. */
      expectedSha256?: string;
    };

export type BenchmarkSubjectBuild = {
  /** Each entry is one argv, run in order from the checkout root. */
  commands: string[][];
};

export const DEFAULT_SUBJECT_BUILD: BenchmarkSubjectBuild = {
  commands: [
    ["pnpm", "install", "--frozen-lockfile"],
    ["pnpm", "build:package", "clash"],
  ],
};

export type ResolvedBenchmarkSubject = {
  record: BenchmarkSubjectRecord;
  /** Runner-private. It is never written into a portable record. */
  pluginRoot: string;
  dispose(): Promise<void>;
};

export type SubjectCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string }>;

const defaultRunner: SubjectCommandRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout };
};

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((done, fail) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", fail);
    stream.on("end", done);
  });
  return hash.digest("hex");
}

function buildCommandsSha256(build: BenchmarkSubjectBuild): string {
  return sha256Text(JSON.stringify(build.commands));
}

async function readPluginVersion(pluginRoot: string): Promise<string> {
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
  } catch (error) {
    throw new Error(
      `Subject is not a Clash plugin package: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("Subject plugin manifest does not declare a version");
  }
  return manifest.version;
}

async function runtimeTree(pluginRoot: string) {
  try {
    return await hashRegularTree(join(pluginRoot, "runtime"));
  } catch (error) {
    throw new Error(
      `Subject has no built plugin runtime (${error instanceof Error ? error.message : String(error)}); build it first or select a release artifact`,
    );
  }
}

async function git(
  run: SubjectCommandRunner,
  repoRoot: string,
  args: string[],
): Promise<string> {
  return (await run("git", ["-C", repoRoot, ...args], { cwd: repoRoot }))
    .stdout;
}

async function resolveCommit(
  run: SubjectCommandRunner,
  repoRoot: string,
  rev: string,
): Promise<string> {
  if (rev.startsWith("-")) throw new Error("Subject revision is invalid");
  const commit = (
    await git(run, repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`])
  ).trim();
  if (!FULL_SHA.test(commit)) {
    throw new Error(`Subject revision did not resolve to a commit: ${rev}`);
  }
  return commit;
}

/**
 * Digest of everything that differs from HEAD: the binary diff of tracked
 * files plus the path and content hash of each untracked, non-ignored file.
 */
async function workingTreeDirtyDigest(
  run: SubjectCommandRunner,
  repoRoot: string,
): Promise<string | undefined> {
  const status = await git(run, repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (!status.trim()) return undefined;
  const diff = await git(run, repoRoot, ["diff", "HEAD", "--binary"]);
  const untracked = (
    await git(run, repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const parts = [`diff:${sha256Text(diff)}`];
  for (const path of untracked) {
    const info = await lstat(join(repoRoot, path));
    parts.push(
      `${path}:${info.isFile() ? await sha256File(join(repoRoot, path)) : "non-file"}`,
    );
  }
  return sha256Text(parts.join("\n"));
}

async function runBuild(
  run: SubjectCommandRunner,
  cwd: string,
  build: BenchmarkSubjectBuild,
): Promise<void> {
  for (const argv of build.commands) {
    const [command, ...args] = argv;
    if (!command) throw new Error("Subject build command must not be empty");
    await run(command, args, { cwd });
  }
}

async function resolveWorkingTree(
  spec: Extract<BenchmarkSubjectSpec, { kind: "working-tree" }>,
  run: SubjectCommandRunner,
): Promise<ResolvedBenchmarkSubject> {
  const repoRoot = await realpath(resolve(spec.repoRoot));
  const commit = await resolveCommit(run, repoRoot, "HEAD");
  if (spec.build) await runBuild(run, repoRoot, spec.build);
  // Read the tree state after any build so build outputs that are tracked are
  // part of the recorded diff rather than silently omitted.
  const dirtyDigest = await workingTreeDirtyDigest(run, repoRoot);
  const pluginRoot = join(repoRoot, "plugins", "clash");
  const [version, tree] = await Promise.all([
    readPluginVersion(pluginRoot),
    runtimeTree(pluginRoot),
  ]);
  return {
    pluginRoot,
    record: {
      kind: "working-tree",
      version,
      commit,
      dirty: dirtyDigest !== undefined,
      ...(dirtyDigest ? { dirtyDigest } : {}),
      artifact: { kind: "built-runtime-tree", sha256: tree.sha256 },
      runtimeSha256: tree.sha256,
      build: spec.build
        ? { performed: true, commandsSha256: buildCommandsSha256(spec.build) }
        : { performed: false },
    },
    dispose: async () => {},
  };
}

async function resolveCommitSubject(
  spec: Extract<BenchmarkSubjectSpec, { kind: "commit" }>,
  run: SubjectCommandRunner,
): Promise<ResolvedBenchmarkSubject> {
  const repoRoot = await realpath(resolve(spec.repoRoot));
  const commit = await resolveCommit(run, repoRoot, spec.rev);
  await mkdir(spec.workRoot, { recursive: true });
  const checkout = join(await realpath(spec.workRoot), `subject-${commit}`);
  await run(
    "git",
    ["-C", repoRoot, "worktree", "add", "--detach", checkout, commit],
    { cwd: repoRoot },
  );
  const dispose = async () => {
    await run(
      "git",
      ["-C", repoRoot, "worktree", "remove", "--force", checkout],
      {
        cwd: repoRoot,
      },
    ).catch(() => rm(checkout, { recursive: true, force: true }));
  };
  try {
    await runBuild(run, checkout, spec.build);
    const pluginRoot = join(checkout, "plugins", "clash");
    const [version, tree] = await Promise.all([
      readPluginVersion(pluginRoot),
      runtimeTree(pluginRoot),
    ]);
    return {
      pluginRoot,
      record: {
        kind: "commit",
        version,
        commit,
        artifact: { kind: "built-runtime-tree", sha256: tree.sha256 },
        runtimeSha256: tree.sha256,
        build: {
          performed: true,
          commandsSha256: buildCommandsSha256(spec.build),
        },
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function extractTarball(
  run: SubjectCommandRunner,
  tarball: string,
  destination: string,
): Promise<void> {
  // Reject links and escaping paths before anything is written to disk.
  const cwd = resolve(tarball, "..");
  const verbose = (await run("tar", ["-tzvf", tarball], { cwd })).stdout
    .split("\n")
    .filter(Boolean);
  const names = (await run("tar", ["-tzf", tarball], { cwd })).stdout
    .split("\n")
    .filter(Boolean);
  for (const line of verbose) {
    if (/^[lh]/u.test(line)) {
      throw new Error("Release tarball must not contain links");
    }
  }
  for (const name of names) {
    const segments = name.split("/");
    if (
      isAbsolute(name) ||
      segments.includes("..") ||
      segments[0] !== "package"
    ) {
      throw new Error(`Release tarball entry escapes package/: ${name}`);
    }
  }
  await mkdir(destination, { recursive: true });
  await run("tar", ["-xzf", tarball, "-C", destination], {
    cwd: destination,
  });
}

function assertExpectedDigest(expected: string | undefined, actual: string) {
  if (expected === undefined) return;
  if (!SHA256.test(expected)) {
    throw new Error("Expected release digest must be 64 lowercase hex digits");
  }
  if (expected !== actual) {
    throw new Error("Release artifact hash does not match the expected digest");
  }
}

async function resolveRelease(
  spec: Extract<BenchmarkSubjectSpec, { kind: "release" }>,
  run: SubjectCommandRunner,
): Promise<ResolvedBenchmarkSubject> {
  await mkdir(spec.workRoot, { recursive: true });
  const workRoot = await realpath(spec.workRoot);
  const dispose = async () => {
    await rm(join(workRoot, "release"), { recursive: true, force: true });
  };
  let pluginRoot: string;
  let artifact: BenchmarkSubjectRecord["artifact"];
  let source: NonNullable<BenchmarkSubjectRecord["source"]>;
  const extractRoot = join(workRoot, "release");
  await rm(extractRoot, { recursive: true, force: true });
  if (spec.artifact.kind === "installed-directory") {
    pluginRoot = await realpath(resolve(spec.artifact.path));
    if (!(await stat(pluginRoot)).isDirectory()) {
      throw new Error("Installed release must be a directory");
    }
    const tree = await hashRegularTree(pluginRoot);
    artifact = { kind: "installed-release-tree", sha256: tree.sha256 };
    source = "installed-directory";
  } else {
    let tarball: string;
    if (spec.artifact.kind === "npm") {
      const download = join(extractRoot, "download");
      await mkdir(download, { recursive: true });
      const packed = (
        await run(
          "npm",
          [
            "pack",
            spec.artifact.spec,
            "--pack-destination",
            download,
            "--json",
          ],
          { cwd: download },
        )
      ).stdout;
      const filename = (JSON.parse(packed) as Array<{ filename?: unknown }>)[0]
        ?.filename;
      if (typeof filename !== "string" || filename.includes("/")) {
        throw new Error("npm pack did not report a tarball filename");
      }
      tarball = join(download, filename);
      source = "npm-registry";
    } else {
      tarball = await realpath(resolve(spec.artifact.path));
      source = "local-tarball";
    }
    artifact = { kind: "release-tarball", sha256: await sha256File(tarball) };
    // Verify the pin before a single byte of the archive is unpacked.
    try {
      assertExpectedDigest(spec.expectedSha256, artifact.sha256);
    } catch (error) {
      await dispose();
      throw error;
    }
    await extractTarball(run, tarball, join(extractRoot, "unpacked"));
    pluginRoot = join(extractRoot, "unpacked", "package");
  }
  try {
    assertExpectedDigest(spec.expectedSha256, artifact.sha256);
    const [version, tree] = await Promise.all([
      readPluginVersion(pluginRoot),
      runtimeTree(pluginRoot),
    ]);
    if (spec.expectedVersion && spec.expectedVersion !== version) {
      throw new Error(
        `Release artifact declares version ${version}, not ${spec.expectedVersion}`,
      );
    }
    return {
      pluginRoot,
      record: {
        kind: "release",
        version,
        artifact,
        runtimeSha256: tree.sha256,
        source,
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export async function resolveBenchmarkSubject(
  spec: BenchmarkSubjectSpec,
  run: SubjectCommandRunner = defaultRunner,
): Promise<ResolvedBenchmarkSubject> {
  if (spec.kind === "working-tree") return resolveWorkingTree(spec, run);
  if (spec.kind === "commit") return resolveCommitSubject(spec, run);
  return resolveRelease(spec, run);
}

/**
 * Two subjects measure the same product only when these agree. The dirty
 * digest is part of identity: a dirty tree is never comparable to its commit.
 */
export function subjectIdentity(record: BenchmarkSubjectRecord): string {
  return sha256Text(
    JSON.stringify([
      record.kind,
      record.version,
      record.commit ?? null,
      record.dirtyDigest ?? null,
      record.artifact.kind,
      record.artifact.sha256,
      record.runtimeSha256,
    ]),
  );
}
