import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  };
});

const { ensureAgentCwd } = await import("./session-cwd");

const roots: string[] = [];
let previousHome: string | undefined;
let previousClashHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  previousClashHome = process.env.CLASH_HOME;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousClashHome === undefined) delete process.env.CLASH_HOME;
  else process.env.CLASH_HOME = previousClashHome;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  vi.mocked(readdir).mockClear();
  vi.mocked(readFile).mockClear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clash-session-cwd-cache-"));
  roots.push(root);
  process.env.HOME = root;
  process.env.CLASH_HOME = root;
  const agents = join(root, "agents");
  const plugin = join(root, "plugin");
  await mkdir(join(agents, "clash"), { recursive: true });
  await writeFile(
    join(agents, "clash", "runtime.json"),
    JSON.stringify({ agent_id: "codex-acp", plugins: ["clash"] }),
  );
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true });
  const manifestPath = join(plugin, ".codex-plugin", "plugin.json");
  await writeFile(manifestPath, JSON.stringify({ skills: ["./skills"] }));
  await mkdir(join(plugin, "skills", "clash"), { recursive: true });
  await writeFile(
    join(plugin, "skills", "clash", "SKILL.md"),
    "# Clash skill\n",
  );
  return {
    manifestPath,
    env: {
      ...process.env,
      CLASH_AGENT_BUNDLE_ROOT: agents,
      CLASH_BUILTIN_PLUGIN_ROOT: plugin,
    },
  };
}

it("reuses the scanned Skill plan for an unchanged template/plugin version", async () => {
  const { env } = await fixture();
  const cwd = await ensureAgentCwd(
    "clash",
    "cache-project",
    { harnessId: "codex-acp" },
    env,
  );
  expect(
    (await readdir(join(cwd, ".agents", "skills"))).includes("clash"),
  ).toBe(true);

  vi.mocked(readdir).mockClear();
  vi.mocked(readFile).mockClear();
  await ensureAgentCwd(
    "clash",
    "cache-project",
    { harnessId: "codex-acp" },
    env,
  );

  // A repeat spawn revalidates manifests with stat, not a Skill scan.
  expect(vi.mocked(readdir)).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(readFile)
      .mock.calls.some(([path]) => String(path).endsWith("plugin.json")),
  ).toBe(false);
});

it("repairs a deleted managed Skill link on the next spawn without a rescan", async () => {
  const { env } = await fixture();
  const cwd = await ensureAgentCwd(
    "clash",
    "repair-project",
    { harnessId: "codex-acp" },
    env,
  );
  const link = join(cwd, ".agents", "skills", "clash");
  expect((await lstat(link)).isSymbolicLink()).toBe(true);

  await unlink(link);
  vi.mocked(readdir).mockClear();
  vi.mocked(readFile).mockClear();
  await ensureAgentCwd(
    "clash",
    "repair-project",
    { harnessId: "codex-acp" },
    env,
  );

  // The cached plan repaired the link from its target, without a Skill scan.
  expect((await lstat(link)).isSymbolicLink()).toBe(true);
  expect((await stat(join(link, "SKILL.md"))).isFile()).toBe(true);
  expect(vi.mocked(readdir)).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(readFile)
      .mock.calls.some(([path]) => String(path).endsWith("plugin.json")),
  ).toBe(false);
});

it("rescans when the plugin manifest version changes", async () => {
  const { manifestPath, env } = await fixture();
  await ensureAgentCwd(
    "clash",
    "version-project",
    { harnessId: "codex-acp" },
    env,
  );
  vi.mocked(readdir).mockClear();
  await writeFile(
    manifestPath,
    JSON.stringify({ version: "2.0.0", skills: ["./skills"] }),
  );

  await ensureAgentCwd(
    "clash",
    "version-project",
    { harnessId: "codex-acp" },
    env,
  );
  expect(vi.mocked(readdir)).toHaveBeenCalled();
});
