import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveBenchmarkSubject,
  subjectIdentity,
  type SubjectCommandRunner,
} from "./subject";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clash-subject-"));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

async function writePlugin(
  pluginRoot: string,
  version: string,
  runtime: string | undefined,
): Promise<void> {
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "clash", version }),
  );
  if (runtime !== undefined) {
    await mkdir(join(pluginRoot, "runtime"), { recursive: true });
    await writeFile(join(pluginRoot, "runtime", "index.js"), runtime);
  }
}

async function createRepo(): Promise<string> {
  const repo = await scratch();
  git(repo, "init", "-q", "-b", "main");
  await writePlugin(join(repo, "plugins", "clash"), "1.2.3", undefined);
  await writeFile(join(repo, ".gitignore"), "runtime/\n");
  await writeFile(join(repo, "plugins", "clash", ".gitignore"), "runtime/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return repo;
}

const BUILD = {
  commands: [
    [
      "sh",
      "-c",
      "mkdir -p plugins/clash/runtime && git rev-parse HEAD > plugins/clash/runtime/index.js",
    ],
  ],
};

describe("benchmark subject selection", () => {
  it("records a clean working tree as its commit plus the runtime tree digest", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "plugins", "clash", "runtime"));
    await writeFile(join(repo, "plugins", "clash", "runtime", "index.js"), "a");
    const subject = await resolveBenchmarkSubject({
      kind: "working-tree",
      repoRoot: repo,
    });
    expect(subject.record).toMatchObject({
      kind: "working-tree",
      commit: git(repo, "rev-parse", "HEAD"),
      dirty: false,
      version: "1.2.3",
      build: { performed: false },
    });
    expect(subject.record.dirtyDigest).toBeUndefined();
    expect(subject.record.artifact.sha256).toBe(subject.record.runtimeSha256);
  });

  it("makes a dirty tree a distinct, content-addressed identity", async () => {
    const repo = await createRepo();
    await mkdir(join(repo, "plugins", "clash", "runtime"));
    await writeFile(join(repo, "plugins", "clash", "runtime", "index.js"), "a");
    const clean = await resolveBenchmarkSubject({
      kind: "working-tree",
      repoRoot: repo,
    });
    await writeFile(join(repo, "plugins", "clash", "notes.md"), "one");
    const dirtyOne = await resolveBenchmarkSubject({
      kind: "working-tree",
      repoRoot: repo,
    });
    await writeFile(join(repo, "plugins", "clash", "notes.md"), "two");
    const dirtyTwo = await resolveBenchmarkSubject({
      kind: "working-tree",
      repoRoot: repo,
    });
    expect(dirtyOne.record.dirty).toBe(true);
    expect(dirtyOne.record.commit).toBe(clean.record.commit);
    const identities = [clean, dirtyOne, dirtyTwo].map((subject) =>
      subjectIdentity(subject.record),
    );
    expect(new Set(identities).size).toBe(3);
  });

  it("refuses a working tree whose plugin runtime was never built", async () => {
    const repo = await createRepo();
    await expect(
      resolveBenchmarkSubject({ kind: "working-tree", repoRoot: repo }),
    ).rejects.toThrow(/no built plugin runtime/u);
  });

  it("builds an exact commit in a private worktree and leaves the checkout alone", async () => {
    const repo = await createRepo();
    const first = git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "later.txt"), "later");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    const workRoot = await scratch();
    const subject = await resolveBenchmarkSubject({
      kind: "commit",
      repoRoot: repo,
      rev: first,
      workRoot,
      build: BUILD,
    });
    try {
      expect(subject.record.commit).toBe(first);
      expect(subject.record.build?.performed).toBe(true);
      // The build ran inside the worktree at the requested commit.
      expect(
        (
          await readFile(
            join(subject.pluginRoot, "runtime", "index.js"),
            "utf8",
          )
        ).trim(),
      ).toBe(first);
      expect(git(repo, "rev-parse", "HEAD")).not.toBe(first);
    } finally {
      await subject.dispose();
    }
    expect(git(repo, "worktree", "list")).not.toContain(first.slice(0, 7));
  });

  it("removes the worktree when the build fails", async () => {
    const repo = await createRepo();
    const workRoot = await scratch();
    await expect(
      resolveBenchmarkSubject({
        kind: "commit",
        repoRoot: repo,
        rev: "HEAD",
        workRoot,
        build: { commands: [["sh", "-c", "exit 3"]] },
      }),
    ).rejects.toThrow();
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("rejects a revision that could be parsed as a git option", async () => {
    const repo = await createRepo();
    await expect(
      resolveBenchmarkSubject({
        kind: "commit",
        repoRoot: repo,
        rev: "--output=x",
        workRoot: await scratch(),
        build: BUILD,
      }),
    ).rejects.toThrow(/invalid/u);
  });
});

async function packRelease(
  root: string,
  version: string,
  options: { link?: boolean } = {},
): Promise<{ tarball: string; sha256: string }> {
  const stage = join(root, `stage-${version}`);
  await writePlugin(join(stage, "package"), version, `runtime ${version}`);
  if (options.link) {
    await symlink("/etc/passwd", join(stage, "package", "evil"));
  }
  const tarball = join(root, `clash-${version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "-C", stage, "package"]);
  return {
    tarball,
    sha256: createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex"),
  };
}

describe("released-version subjects", () => {
  it("hashes the tarball and the unpacked runtime, and reports the declared version", async () => {
    const root = await scratch();
    const { tarball, sha256 } = await packRelease(root, "0.4.0");
    const subject = await resolveBenchmarkSubject({
      kind: "release",
      artifact: { kind: "tarball", path: tarball },
      workRoot: join(root, "work"),
      expectedVersion: "0.4.0",
      expectedSha256: sha256,
    });
    try {
      expect(subject.record).toMatchObject({
        kind: "release",
        version: "0.4.0",
        source: "local-tarball",
        artifact: { kind: "release-tarball", sha256 },
      });
      expect(subject.record.commit).toBeUndefined();
      expect(subject.record.runtimeSha256).not.toBe(sha256);
    } finally {
      await subject.dispose();
    }
  });

  it("refuses a tarball that is not the pinned digest before unpacking it", async () => {
    const root = await scratch();
    const { tarball } = await packRelease(root, "0.4.0");
    const workRoot = join(root, "work");
    await expect(
      resolveBenchmarkSubject({
        kind: "release",
        artifact: { kind: "tarball", path: tarball },
        workRoot,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/does not match the expected digest/u);
    await expect(
      readFile(join(workRoot, "release", "unpacked", "package", "runtime")),
    ).rejects.toThrow();
  });

  it("refuses an artifact that declares a different version", async () => {
    const root = await scratch();
    const { tarball } = await packRelease(root, "0.4.0");
    await expect(
      resolveBenchmarkSubject({
        kind: "release",
        artifact: { kind: "tarball", path: tarball },
        workRoot: join(root, "work"),
        expectedVersion: "0.5.0",
      }),
    ).rejects.toThrow(/declares version 0.4.0/u);
  });

  it("refuses archives that contain links", async () => {
    const root = await scratch();
    const { tarball } = await packRelease(root, "0.4.0", { link: true });
    await expect(
      resolveBenchmarkSubject({
        kind: "release",
        artifact: { kind: "tarball", path: tarball },
        workRoot: join(root, "work"),
      }),
    ).rejects.toThrow(/links/u);
  });

  it("hashes an installed release directory in place", async () => {
    const root = await scratch();
    const installed = join(root, "node_modules", "clash");
    await writePlugin(installed, "0.4.0", "installed");
    const subject = await resolveBenchmarkSubject({
      kind: "release",
      artifact: { kind: "installed-directory", path: installed },
      workRoot: join(root, "work"),
    });
    expect(subject.record).toMatchObject({
      kind: "release",
      version: "0.4.0",
      source: "installed-directory",
      artifact: { kind: "installed-release-tree" },
    });
    await subject.dispose();
    // An installed release is never deleted by disposal.
    await expect(
      readFile(join(installed, "runtime", "index.js"), "utf8"),
    ).resolves.toBe("installed");
  });

  it("fetches a pinned npm spec through the package manager and hashes what came back", async () => {
    const root = await scratch();
    const { tarball, sha256 } = await packRelease(root, "0.4.0");
    const calls: string[][] = [];
    const run: SubjectCommandRunner = async (command, args, options) => {
      calls.push([command, ...args]);
      if (command !== "npm") {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve, reject) =>
          execFile(command, args, { cwd: options.cwd }, (error, stdout) =>
            error ? reject(error) : resolve({ stdout }),
          ),
        );
      }
      const destination = args[args.indexOf("--pack-destination") + 1]!;
      await copyFile(tarball, join(destination, "clash-0.4.0.tgz"));
      return { stdout: JSON.stringify([{ filename: "clash-0.4.0.tgz" }]) };
    };
    const subject = await resolveBenchmarkSubject(
      {
        kind: "release",
        artifact: { kind: "npm", spec: "clash@0.4.0" },
        workRoot: join(root, "work"),
        expectedSha256: sha256,
      },
      run,
    );
    expect(calls[0]?.slice(0, 3)).toEqual(["npm", "pack", "clash@0.4.0"]);
    expect(subject.record).toMatchObject({
      source: "npm-registry",
      artifact: { kind: "release-tarball", sha256 },
    });
    await subject.dispose();
  });
});
