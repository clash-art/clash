import { createClashUserConfigStore } from "../../../user-config.js";
import { defaultLocalApiDataDir } from "../../../local-paths.js";
/**
 * Per-project workspace management.
 *
 * Each spawned ACP agent runs with cwd
 *   `~/.clash/projects/<encoded-project-id>/`
 * — never the user's shell pwd and never a per-session directory.
 * The path segment is URI-encoded to avoid collisions; `.clash/project.toml`
 * stores the canonical project id.
 *
 * Each agent template has its own chosen ACP runtime (claude-agent-acp by default; could be
 * custom ACP agents per `dist/agents/<id>/runtime.json`).
 *
 * Per-project directories keep project files, local artifacts, agent tool
 * state, and transcripts pointed at the same stable root. Sessions remain
 * separate local DB rows and ACP session ids; they do not create separate cwd.
 *
 * Project directories are not GC'd on session end. Deleting a project should
 * be an explicit product action.
 */

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";
import {
  projectIdPathSegment,
  projectWorkspaceId,
} from "@clash/shared-runtime";
import { resolveHarnessProjectSkillDirectory } from "./agent-skills.js";
import { paths } from "./platform.js";
import { ensureProjectAgentInstructions } from "./project-agent-instructions.js";
import { ensureProjectSkillLinks } from "./project-skill-links.js";
import { resolveHostProjectSkills } from "../../../host-skill-config.js";
import {
  PROJECT_WORKSPACE_PREPARE_FAILED,
  ProjectWorkspacePrepareError,
} from "../../../workspace-prepare-error.js";

export {
  PROJECT_WORKSPACE_PREPARE_FAILED,
  ProjectWorkspacePrepareError,
} from "../../../workspace-prepare-error.js";

/** Used when the caller doesn't supply a project id (e.g. Quick connect). */
const DEFAULT_PROJECT = "_default";

/** Clash CLI's bundled `dist/agents/` root. */
export function resolveBundledAgentsDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const externalRoot = env.CLASH_AGENT_BUNDLE_ROOT?.trim();
  if (externalRoot) return resolve(externalRoot);

  // After tsup bundles, this module lives in `dist/<chunk>.js`, so the
  // agent tree is the SIBLING `dist/agents/` — i.e. ./agents/ from here.
  // Source-tree callers run from `src/lib/*`, so look at the built
  // dist/agents folder too. The package build emits it before publish, and
  // Packaging supplies the bundled agent root explicitly.
  // without needing to bundle TS first.
  const candidates = [
    new URL("./agents/", import.meta.url),
    new URL("../../../../dist/agents/", import.meta.url),
    new URL("../../../../../../packages/cli/assets/agents/", import.meta.url),
    new URL("../../../../assets/agents/", import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  return fileURLToPath(candidates[0]);
}

function bundledAgentsDir(): string {
  return resolveBundledAgentsDir();
}

export interface AgentTemplateManifest {
  id: string;
  label: string;
  summary: string;
  agent_id: string;
}

export interface AgentRuntimeConfig {
  agent_id: string;
  plugins?: string[];
}

export interface AgentWorkspaceCapabilities {
  /**
   * ACP harness selected for this session. Its native project Skill directory
   * is resolved through the skills compatibility adapter. No default is
   * intentional: an unknown harness must not inherit another harness's
   * filesystem contract.
   */
  harnessId?: string;
}

/** Read the bundled agent manifest. Used by daemon hello + picker. */
export async function listBundledAgents(): Promise<AgentTemplateManifest[]> {
  try {
    const text = await readFile(
      join(bundledAgentsDir(), "manifest.json"),
      "utf-8",
    );
    const json = JSON.parse(text) as { agents?: AgentTemplateManifest[] };
    return json.agents ?? [];
  } catch {
    return [];
  }
}

/**
 * Resolve an agent template id to its bundled `runtime.json` (which ACP
 * CLI to spawn). Returns null when the id isn't a known bundled agent
 * template — caller should treat that as a 404-equivalent error.
 */
export async function readAgentRuntime(
  agentTemplateId: string,
): Promise<AgentRuntimeConfig | null> {
  try {
    const text = await readFile(
      join(bundledAgentsDir(), agentTemplateId, "runtime.json"),
      "utf-8",
    );
    return JSON.parse(text) as AgentRuntimeConfig;
  } catch {
    return null;
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInside(root: string, candidate: string, label: string): string {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`${label} must stay inside the bundled plugin`);
  }
  return candidate;
}

function resolvePluginPath(
  pluginRoot: string,
  base: string,
  value: string,
): string {
  if (!value.startsWith("./") && !value.startsWith("../")) return value;
  return assertInside(
    pluginRoot,
    resolve(base, value),
    `plugin path '${value}'`,
  );
}

function configuredEnv(value: unknown): Array<{ name: string; value: string }> {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      typeof entry.value === "string"
        ? [{ name: entry.name, value: entry.value }]
        : [],
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([name, entry]) =>
    typeof entry === "string" ? [{ name, value: entry }] : [],
  );
}

function pluginMcpEnv(
  runtimeEnv: Record<string, string | undefined>,
  pluginEnv: unknown,
  usesElectronNode: boolean,
): Array<{ name: string; value: string }> {
  const merged = new Map<string, string>();
  for (const [name, value] of Object.entries(runtimeEnv)) {
    if (
      value &&
      (name.startsWith("CLASH_") || name === "PATH" || name === "NODE_PATH")
    ) {
      merged.set(name, value);
    }
  }
  for (const entry of configuredEnv(pluginEnv))
    merged.set(entry.name, entry.value);
  if (usesElectronNode) merged.set("ELECTRON_RUN_AS_NODE", "1");
  return [...merged].map(([name, value]) => ({ name, value }));
}

async function resolvePluginMcpServers(
  pluginRoot: string,
  runtimeEnv: Record<string, string | undefined>,
): Promise<McpServer[]> {
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ) as JsonRecord;
  const pluginName =
    typeof manifest.name === "string" ? manifest.name : "plugin";
  const mcpManifestPath = manifest.mcpServers;
  if (
    typeof mcpManifestPath !== "string" ||
    !mcpManifestPath.startsWith("./")
  ) {
    throw new Error(
      `built-in plugin '${pluginName}' has no valid mcpServers manifest`,
    );
  }
  const mcpPath = resolvePluginPath(pluginRoot, pluginRoot, mcpManifestPath);
  const mcpConfig = JSON.parse(await readFile(mcpPath, "utf8")) as JsonRecord;
  const wrapped = isRecord(mcpConfig.mcpServers)
    ? mcpConfig.mcpServers
    : isRecord(mcpConfig.mcp_servers)
      ? mcpConfig.mcp_servers
      : mcpConfig;
  const servers: McpServer[] = [];

  for (const [serverName, rawServer] of Object.entries(wrapped)) {
    if (!isRecord(rawServer) || rawServer.enabled === false) continue;
    if (typeof rawServer.command !== "string") {
      throw new Error(`built-in MCP '${serverName}' must use stdio`);
    }
    const cwd =
      rawServer.cwd === undefined || rawServer.cwd === "."
        ? pluginRoot
        : typeof rawServer.cwd === "string"
          ? resolvePluginPath(pluginRoot, pluginRoot, rawServer.cwd)
          : pluginRoot;
    const configuredArgs = Array.isArray(rawServer.args)
      ? rawServer.args.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const nodeCommand = rawServer.command === "node";
    const command = nodeCommand
      ? runtimeEnv.CLASH_NODE_EXEC_PATH || process.execPath
      : resolvePluginPath(pluginRoot, cwd, rawServer.command);
    const usesElectronNode =
      nodeCommand && command === runtimeEnv.CLASH_NODE_EXEC_PATH;
    servers.push({
      name: serverName,
      command,
      args: configuredArgs.map((arg) =>
        resolvePluginPath(pluginRoot, cwd, arg),
      ),
      env: pluginMcpEnv(runtimeEnv, rawServer.env, usesElectronNode),
      _meta: {
        "io.modelcontextprotocol/ui": {
          host: pluginName,
          mimeTypes: ["text/html;profile=mcp-app"],
        },
        ...(pluginName === "clash"
          ? {
              "clash.plugin": "builtin",
              "clash.renderer": "product",
            }
          : {}),
      },
    });
  }
  return servers;
}

/**
 * Resolve built-in Codex-compatible plugins into ACP session/new MCP
 * descriptors. The ACP harness owns the MCP subprocess; Clash only supplies
 * the packaged plugin entrypoint and host environment.
 */
export async function resolveAgentMcpServers(
  agentTemplateId: string,
  runtimeEnv: Record<string, string | undefined>,
): Promise<McpServer[]> {
  const runtime = await readAgentRuntime(agentTemplateId);
  if (!runtime) return [];
  const agentRoot = join(bundledAgentsDir(), sanitize(agentTemplateId));
  const pluginResolutionEnv = { ...process.env, ...runtimeEnv };
  // The Clash MCP belongs to the host, not to an agent template. Always
  // inject it into ACP session setup; template-declared plugins are additive.
  const pluginIds = [
    "clash",
    ...(runtime.plugins ?? []).filter((pluginId) => pluginId !== "clash"),
  ];
  const resolved = await Promise.all(
    pluginIds.map((pluginId) =>
      resolvePluginMcpServers(
        resolveAgentPluginRoot(agentRoot, pluginId, pluginResolutionEnv),
        runtimeEnv,
      ),
    ),
  );
  return resolved.flat();
}

interface ManagedSkillLink {
  path: string;
  /** Absolute source the link must resolve to. */
  target: string;
}

interface PreparedProjectWorkspace {
  planKey: string;
  cwd: string;
  /**
   * The Skill/link projection created by the last full pass. A repeat spawn
   * only `lstat`s these entries; it never rescans manifests or directories.
   */
  managedSkillLinks: ManagedSkillLink[];
}

const preparedProjectWorkspaces = new Map<string, PreparedProjectWorkspace>();

interface SkillPlanFileCheck {
  path: string;
  mtimeMs: number;
  size: number;
}

interface SkillPlan {
  signature: string;
  checks: SkillPlanFileCheck[];
  initialSkills: Map<string, string>;
}

const skillPlans = new Map<string, SkillPlan>();

interface HostSkillPlan {
  signature: string;
  skills: Map<string, string>;
}

const hostSkillPlans = new Map<string, HostSkillPlan>();

/**
 * Create only the project identity marker on the create request path.
 *
 * The full agent layout (projections, timelines, sessions, Skill links,
 * AGENTS.md) is materialized by `ensureAgentCwd` on the first agent session.
 * A failure removes the partial directory before surfacing a coded error, so a
 * project id is never left behind as a marker-less or empty workspace.
 */
export async function writeProjectWorkspaceMarker(
  projectId: string,
): Promise<string> {
  const canonicalProjectId =
    projectId && projectId.length > 0 ? projectId : DEFAULT_PROJECT;
  const cwd = join(
    paths().projectsDir,
    projectIdPathSegment(canonicalProjectId),
  );
  try {
    await mkdir(cwd, { recursive: true });
    await writeProjectMarker(cwd, canonicalProjectId);
    return cwd;
  } catch (error) {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw new ProjectWorkspacePrepareError(
      canonicalProjectId,
      "project marker",
      error,
    );
  }
}

/**
 * Ensure the project workspace exists and return its absolute path.
 * Idempotent — safe to call on every spawn.
 *
 * Layout:
 *   ~/.clash/projects/<encoded-project-id>/
 *     .clash/project.toml
 *     AGENTS.md (seeded once; user edits are preserved)
 *     harness-native Skill links when explicitly supported
 *
 * A repeated call for the same project, template, plugin versions and Host
 * Skill configuration only revalidates the plan signature, the marker and the
 * managed Skill links; it does not rescan plugin manifests or Skill directories.
 * A deleted or dangling managed link is recreated before the spawn continues.
 */
export async function ensureAgentCwd(
  agentTemplateId: string,
  projectId?: string,
  capabilities: AgentWorkspaceCapabilities = {},
  runtimeEnv: Record<string, string | undefined> = process.env,
): Promise<string> {
  const canonicalProjectId =
    projectId && projectId.length > 0 ? projectId : DEFAULT_PROJECT;
  const projectPathSegment = projectIdPathSegment(canonicalProjectId);
  const cwd = join(paths().projectsDir, projectPathSegment);
  try {
    await assertAgentTemplate(agentTemplateId);
    const harnessId = capabilities.harnessId ?? "";
    const workspaceSkillDirectory =
      resolveHarnessProjectSkillDirectory(harnessId);
    const env = { ...process.env, ...runtimeEnv };
    const skillPlan = workspaceSkillDirectory
      ? await loadSkillPlan(agentTemplateId, workspaceSkillDirectory, env)
      : null;
    const hostSkills = skillPlan
      ? await cachedHostProjectSkills(canonicalProjectId, env)
      : null;
    const planKey = [
      agentTemplateId,
      harnessId,
      skillPlan?.signature ?? "",
      hostSkills?.signature ?? "",
    ].join("\0");
    const prepared = preparedProjectWorkspaces.get(cwd);
    if (prepared?.planKey === planKey) {
      const marker = await lstat(join(cwd, ".clash", "project.toml")).catch(
        () => null,
      );
      if (
        marker?.isFile() &&
        (await revalidateManagedSkillLinks(prepared.managedSkillLinks))
      ) {
        return cwd;
      }
    }
    await mkdir(cwd, { recursive: true });
    await ensureProjectWorkspaceLayout(cwd);
    if (skillPlan && hostSkills) {
      await installNativeAgentSkills(
        skillPlan,
        workspaceSkillDirectory!,
        cwd,
        hostSkills.skills,
        env,
      );
    }
    await writeProjectMarker(cwd, canonicalProjectId);
    await ensureProjectAgentInstructions(cwd);
    const managedSkillLinks =
      skillPlan && hostSkills
        ? await collectManagedSkillLinks(
            cwd,
            workspaceSkillDirectory!,
            skillPlan.initialSkills,
            hostSkills.skills,
          )
        : [];
    preparedProjectWorkspaces.set(cwd, {
      planKey,
      cwd,
      managedSkillLinks,
    });
    return cwd;
  } catch (error) {
    if (error instanceof ProjectWorkspacePrepareError) throw error;
    throw new ProjectWorkspacePrepareError(
      canonicalProjectId,
      "agent workspace",
      error,
    );
  }
}

/**
 * Revalidate the links projected into the workspace by the last full pass.
 *
 * This is the repeat-spawn fast path: one `lstat` per managed link plus a
 * follow-up `stat` for symlinks (a dangling link still passes lstat). It never
 * reads a manifest or lists a Skill directory. A missing link is recreated; a
 * conflicted entry returns false so the caller runs the full reconcile, which
 * raises the existing coded conflict error.
 */
async function revalidateManagedSkillLinks(
  links: readonly ManagedSkillLink[],
): Promise<boolean> {
  for (const link of links) {
    const current = await lstat(link.path).catch(() => null);
    if (!current) {
      try {
        await symlink(link.target, link.path, "dir");
      } catch {
        return false;
      }
      continue;
    }
    if (!current.isSymbolicLink()) return false;
    const actual = resolve(
      dirname(link.path),
      await readlink(link.path).catch(() => ""),
    );
    if (actual !== link.target) return false;
    // lstat is satisfied by a dangling symlink; follow it once to detect a
    // broken target and repair the entry instead of spawning with no Skill.
    if (!(await stat(link.path).catch(() => null))) {
      await unlink(link.path).catch(() => undefined);
      try {
        await symlink(link.target, link.path, "dir");
      } catch {
        return false;
      }
    }
  }
  return true;
}

async function collectManagedSkillLinks(
  cwd: string,
  workspaceSkillDirectory: string,
  initialSkills: ReadonlyMap<string, string>,
  installedSkills: ReadonlyMap<string, string>,
): Promise<ManagedSkillLink[]> {
  const root = resolveWorkspaceSkillRoot(cwd, workspaceSkillDirectory);
  if (!root) return [];
  const canonical = join(cwd, ".agents", "skills");
  const links = new Map<string, string>();
  for (const [name, source] of installedSkills) {
    links.set(join(canonical, name), resolve(source));
  }
  // Defaults only materialize into a brand-new Skill directory. Only remember
  // the ones the last pass actually created, so a deliberate removal of an
  // existing project Skill is not resurrected by a repeat spawn.
  for (const [name, source] of initialSkills) {
    const path = join(canonical, name);
    const current = await lstat(path).catch(() => null);
    if (!current?.isSymbolicLink()) continue;
    const target = resolve(dirname(path), await readlink(path).catch(() => ""));
    if (target === resolve(source)) links.set(path, target);
  }
  for (const directory of new Set([
    ".claude/skills",
    workspaceSkillDirectory,
  ])) {
    const alias = join(cwd, directory);
    if (alias === canonical) continue;
    links.set(alias, canonical);
  }
  return Array.from(links, ([path, target]) => ({ path, target }));
}

async function loadSkillPlan(
  agentTemplateId: string,
  workspaceSkillDirectory: string,
  runtimeEnv: Record<string, string | undefined>,
): Promise<SkillPlan | null> {
  const cacheKey = [
    agentTemplateId,
    workspaceSkillDirectory,
    homedir(),
    runtimeEnv.CLASH_BUILTIN_PLUGIN_ROOT ?? "",
    runtimeEnv.CLASH_AGENT_BUNDLE_ROOT ?? "",
  ].join("\0");
  const cached = skillPlans.get(cacheKey);
  if (cached && (await skillPlanUnchanged(cached))) return cached;
  const scanned = await scanSkillPlan(
    agentTemplateId,
    workspaceSkillDirectory,
    runtimeEnv,
  );
  if (scanned) skillPlans.set(cacheKey, scanned);
  else skillPlans.delete(cacheKey);
  return scanned;
}

async function skillPlanUnchanged(plan: SkillPlan): Promise<boolean> {
  for (const check of plan.checks) {
    const current = await stat(check.path).catch(() => null);
    if (
      !current ||
      current.mtimeMs !== check.mtimeMs ||
      current.size !== check.size
    ) {
      return false;
    }
  }
  return true;
}

async function scanSkillPlan(
  agentTemplateId: string,
  workspaceSkillDirectory: string,
  runtimeEnv: Record<string, string | undefined>,
): Promise<SkillPlan | null> {
  // Validate before reading: an unknown template must not create a directory.
  const agentRoot = join(bundledAgentsDir(), sanitize(agentTemplateId));
  const runtimePath = join(agentRoot, "runtime.json");
  const runtimeStat = await stat(runtimePath);
  const runtime = await readAgentRuntime(agentTemplateId);
  if (!runtime?.plugins?.length) return null;
  const checks: SkillPlanFileCheck[] = [
    {
      path: runtimePath,
      mtimeMs: runtimeStat.mtimeMs,
      size: runtimeStat.size,
    },
  ];
  const initialSkills = new Map<string, string>();
  for (const pluginId of runtime.plugins) {
    const pluginRoot = resolveAgentPluginRoot(agentRoot, pluginId, runtimeEnv);
    const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
    const manifestStat = await stat(manifestPath);
    checks.push({
      path: manifestPath,
      mtimeMs: manifestStat.mtimeMs,
      size: manifestStat.size,
    });
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as JsonRecord;
    const configuredRoots =
      typeof manifest.skills === "string"
        ? [manifest.skills]
        : Array.isArray(manifest.skills)
          ? manifest.skills.filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
    for (const configuredRoot of configuredRoots) {
      const skillRoot = resolvePluginPath(
        pluginRoot,
        pluginRoot,
        configuredRoot,
      );
      const entries = await readdir(skillRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name !== "clash") continue;
        const globalSource = join(homedir(), ".agents", "skills", entry.name);
        const globalSkill = await lstat(join(globalSource, "SKILL.md")).catch(
          () => null,
        );
        initialSkills.set(
          entry.name,
          globalSkill?.isFile() ? globalSource : join(skillRoot, entry.name),
        );
      }
    }
  }
  return {
    signature: checks
      .map((check) => `${check.path}:${check.mtimeMs}:${check.size}`)
      .join("|"),
    checks,
    initialSkills,
  };
}

async function cachedHostProjectSkills(
  projectId: string,
  runtimeEnv: Record<string, string | undefined>,
): Promise<HostSkillPlan> {
  const dataDir = defaultLocalApiDataDir(runtimeEnv);
  const cacheKey = `${dataDir}\0${projectId}`;
  const store = createClashUserConfigStore(dataDir);
  const configStat = await stat(store.configPath).catch(() => null);
  const signature = configStat
    ? `${configStat.mtimeMs}:${configStat.size}`
    : "missing";
  const cached = hostSkillPlans.get(cacheKey);
  if (cached?.signature === signature) return cached;
  const skills = await resolveHostProjectSkills(projectId, runtimeEnv);
  const entry = { signature, skills };
  hostSkillPlans.set(cacheKey, entry);
  return entry;
}

async function ensureProjectWorkspaceLayout(cwd: string): Promise<void> {
  await Promise.all([
    mkdir(join(cwd, "drafts"), { recursive: true }),
    mkdir(join(cwd, "projections", "text"), { recursive: true }),
    mkdir(join(cwd, "projections", "timelines"), { recursive: true }),
    mkdir(join(cwd, "projections", "storyboards"), { recursive: true }),
    mkdir(join(cwd, "projections", "prompts"), { recursive: true }),
    mkdir(join(cwd, "projections", "metadata"), { recursive: true }),
    mkdir(join(cwd, "timelines"), { recursive: true }),
    mkdir(join(cwd, "sessions"), { recursive: true }),
    mkdir(join(cwd, "assets", "links"), { recursive: true }),
    mkdir(join(cwd, "runtime"), { recursive: true }),
  ]);
}

/** Filesystem-safe form of an agent template id (no slashes, no leading dots). */
function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
}

function resolveAgentPluginRoot(
  agentRoot: string,
  pluginId: string,
  runtimeEnv: Record<string, string | undefined>,
): string {
  const packaged = join(agentRoot, "plugins", sanitize(pluginId));
  if (pluginId !== "clash") return packaged;
  return resolveBuiltinClashPluginRoot(runtimeEnv);
}

/** The same shipped skill source is used by agent workspaces and Marketplace. */
export function resolveBuiltinClashPluginRoot(
  runtimeEnv: Record<string, string | undefined> = process.env,
): string {
  if (runtimeEnv.CLASH_BUILTIN_PLUGIN_ROOT) {
    return resolve(runtimeEnv.CLASH_BUILTIN_PLUGIN_ROOT);
  }

  // Clash is host-owned and must never be discovered below an agent template.
  // Source, npm, and flattened Desktop layouts place the canonical plugin at
  // different distances from this module, so accept only candidates that are
  // actual Codex plugin roots.
  const workspaceSource = fileURLToPath(
    new URL("../../../../../../plugins/clash/", import.meta.url),
  );
  for (const candidate of [
    workspaceSource,
    fileURLToPath(new URL("./", import.meta.url)),
    fileURLToPath(new URL("../", import.meta.url)),
  ]) {
    if (existsSync(join(candidate, ".codex-plugin", "plugin.json"))) {
      return candidate;
    }
  }
  throw new Error(
    "CLASH_BUILTIN_PLUGIN_ROOT is required when the canonical Clash plugin is not colocated with the local host",
  );
}

/** Validate the selected runtime without writing repository instructions. */
async function assertAgentTemplate(agentTemplateId: string): Promise<void> {
  const templateId = sanitize(agentTemplateId);
  const runtimePath = join(bundledAgentsDir(), templateId, "runtime.json");
  try {
    const runtime = await lstat(runtimePath);
    if (!runtime.isFile())
      throw new Error(`unknown agent template: ${templateId}`);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`unknown agent template: ${templateId}`);
    }
    throw e;
  }
}

function resolveWorkspaceSkillRoot(
  cwd: string,
  workspaceSkillDirectory: string | undefined,
): string | null {
  if (!workspaceSkillDirectory) return null;
  if (isAbsolute(workspaceSkillDirectory)) {
    throw new Error(
      "workspace Skill directory must be relative to the session cwd",
    );
  }
  const root = resolve(cwd, workspaceSkillDirectory);
  const fromCwd = relative(cwd, root);
  if (
    fromCwd === ".." ||
    fromCwd.startsWith(`..${sep}`) ||
    isAbsolute(fromCwd)
  ) {
    throw new Error(
      "workspace Skill directory must stay inside the session cwd",
    );
  }
  return root;
}

async function installNativeAgentSkills(
  plan: SkillPlan,
  workspaceSkillDirectory: string,
  cwd: string,
  installedSkills: Map<string, string>,
  runtimeEnv: Record<string, string | undefined>,
): Promise<void> {
  const root = resolveWorkspaceSkillRoot(cwd, workspaceSkillDirectory);
  if (!root) return;
  await ensureProjectSkillLinks({
    cwd,
    nativeDirectories: [".claude/skills", workspaceSkillDirectory],
    initialSkills: plan.initialSkills,
    installedSkills,
    managedSkillsRoot: join(
      createClashUserConfigStore(defaultLocalApiDataDir(runtimeEnv)).clashHome,
      "plugin-skills",
    ),
    legacySkillsRoot: join(homedir(), ".agents", "skills"),
  });
}

async function writeProjectMarker(
  cwd: string,
  projectId: string,
): Promise<void> {
  const markerDir = join(cwd, ".clash");
  await mkdir(markerDir, { recursive: true });
  await writeFile(
    join(markerDir, "project.toml"),
    [
      "schema_version = 1",
      `project_id = ${JSON.stringify(projectId)}`,
      `workspace_id = ${JSON.stringify(projectWorkspaceId("managed", projectId, cwd))}`,
      'store = "managed"',
      "",
    ].join("\n"),
    "utf-8",
  );
}

// v1 does not auto-migrate old cwd layouts into a hidden archive directory.
// Project cwd creation is explicit and stable under ~/.clash/projects/<encoded-id>.

/**
 * Project cwd is durable product state. Function name kept for the daemon's
 * existing call site; it intentionally does not delete project directories.
 */
export async function gcOldSessions(): Promise<{ removed: number }> {
  return { removed: 0 };
}
