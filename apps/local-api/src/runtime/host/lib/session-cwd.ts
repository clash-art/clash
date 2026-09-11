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
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

/**
 * Ensure the project workspace exists and return its absolute path.
 * Idempotent — safe to call on every spawn.
 *
 * Layout:
 *   ~/.clash/projects/<encoded-project-id>/
 *     .clash/project.toml
 *     AGENTS.md (seeded once; user edits are preserved)
 *     harness-native Skill links when explicitly supported
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
  await mkdir(cwd, { recursive: true });
  await ensureProjectWorkspaceLayout(cwd);
  await assertAgentTemplate(agentTemplateId);
  await installNativeAgentSkills(
    agentTemplateId,
    resolveHarnessProjectSkillDirectory(capabilities.harnessId ?? ""),
    cwd,
    { ...process.env, ...runtimeEnv },
    canonicalProjectId,
  );
  await writeProjectMarker(cwd, canonicalProjectId);
  await ensureProjectAgentInstructions(cwd);
  return cwd;
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
  agentTemplateId: string,
  workspaceSkillDirectory: string | undefined,
  cwd: string,
  runtimeEnv: Record<string, string | undefined>,
  projectId: string,
): Promise<void> {
  const root = resolveWorkspaceSkillRoot(cwd, workspaceSkillDirectory);
  if (!root) return;
  const runtime = await readAgentRuntime(agentTemplateId);
  if (!runtime?.plugins?.length) return;
  const initialSkills = new Map<string, string>();

  for (const pluginId of runtime.plugins) {
    const agentRoot = join(bundledAgentsDir(), sanitize(agentTemplateId));
    const pluginRoot = resolveAgentPluginRoot(agentRoot, pluginId, runtimeEnv);
    const manifest = JSON.parse(
      await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
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
        initialSkills.set(entry.name, existsSync(join(globalSource, "SKILL.md"))
          ? globalSource
          : join(skillRoot, entry.name));
      }
    }
  }
  await ensureProjectSkillLinks({
    cwd,
    nativeDirectories: [".claude/skills", workspaceSkillDirectory!],
    initialSkills,
    installedSkills: await resolveHostProjectSkills(projectId, runtimeEnv),
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
