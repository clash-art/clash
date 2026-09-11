/**
 * Client-side wrappers around the web app's HTTP API.
 *
 * These replace Next.js "use server" server actions. Each function fetches
 * a route under /api/... that returns JSON. Routes live in
 * apps/web-vite/app/routes/api.*.ts.
 *
 * Keeping this module in @clash/web-ui means the same code can be used by a
 * future Electron app (which will hit the same HTTP endpoints).
 */
import { runtimeApiUrl } from "./runtimeConfig";
import type {
  ExecutablePluginProviderDefinition,
  ModelCatalogEntry,
  ProviderAccountAvailability,
  UserModelCardConfig,
} from "@clash/shared-types";

// ───────── Types (mirror server-side shapes) ─────────

export type CommandType =
  "ADD_NODE" | "ADD_EDGE" | "UPDATE_NODE" | "DELETE_NODE";
export interface Command {
  type: CommandType;
  payload: unknown;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date | null;
}

export interface VariableInfo {
  id: string;
  key: string;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface InstalledActionInfo {
  id: string;
  actionId: string;
  name: string;
  description: string | null;
  runtime: string;
  version: string | null;
  author: string | null;
  repository: string | null;
  workerUrl: string | null;
  icon: string | null;
  color: string | null;
  tags: string | null;
  manifest: string;
  createdAt: Date | null;
}

export interface InstalledSkillInfo {
  id: string;
  skillId: string;
  name: string;
  description: string | null;
  repository: string | null;
  version: string | null;
  author: string | null;
  icon: string | null;
  tags: string | null;
  linkedActionId: string | null;
  createdAt: Date | null;
}

export type ModelProviderAccountInfo = ProviderAccountAvailability & {
  id?: string;
  label?: string;
  credentials?: Record<string, string>;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
  pluginProvider?: PluginProviderInfo;
};
export type ModelCatalogEntryInfo = ModelCatalogEntry;
export type ModelCardConfigInfo = UserModelCardConfig;

export interface ProviderOAuthInfo {
  providerId: string;
  accountId?: string;
  status: "pending" | "authorized" | "expired" | "revoked" | "error";
  verificationUri?: string;
  userCode?: string;
  deviceCode?: string;
  expiresAt?: string;
  intervalSeconds?: number;
  accountLabel?: string;
  error?: string;
  flow?: "browser";
  callbackScheme?: string;
  importedFrom?: string;
  hasAccessToken: boolean;
}

export type PluginProviderInfo = ExecutablePluginProviderDefinition & {
  pluginId: string;
  pluginVersion: string;
  schemaHash: `sha256:${string}`;
};

export interface RegistryItem {
  id: string;
  name: string;
  type: "action" | "skill" | "plugin";
  description?: string;
  repository?: string;
  runtime?: string;
  outputType?: string;
  model?: {
    id: string;
    provider: string;
    name?: string;
    secretId?: string;
    baseUrl?: string;
    endpoint?: string;
    [key: string]: unknown;
  };
  workerUrl?: string;
  version?: string;
  author?: string;
  icon?: string;
  cover?: {
    src: string;
    alt?: string;
  };
  artwork?: {
    src: string;
    alt?: string;
  };
  color?: string;
  tags?: string[];
  secrets?: Array<{ id: string; label: string; required?: boolean }>;
  linkedActionId?: string;
  packageId?: string;
  source?: string;
  sourceVersion?: string;
  curation?: { collection: "official-picks"; curator: string };
  attribution?: {
    sourceUrl: string;
    license?: string;
    licenseUrl?: string;
    repositoryStars?: number;
    checkedAt?: string;
    notes?: string;
  };
  kind?: string;
  executionContract?: string;
  inputs?: unknown[];
  outputs?: unknown[];
  requiredSystemCapabilities?: string[];
  promptModalities?: string[];
}

// ───────── Helpers ─────────

async function jsonFetch<T>(input: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(runtimeApiUrl(input), {
    credentials: "include",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body || input}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ───────── Projects ─────────

export interface CreateProjectOptions {
  startFromPrompt?: boolean;
}

export interface ProjectListItem {
  id: string;
  name: string;
  deletedAt?: string;
  updatedAt?: string;
}

export interface RuntimeRunPreferenceUpdate {
  agentId: string;
  configValues?: Record<string, string | boolean>;
  modeId?: string;
}

export async function persistRuntimeRunPreferences(
  runtimeId: string,
  update: RuntimeRunPreferenceUpdate,
): Promise<void> {
  await jsonFetch(
    `/api/v1/runtimes/${encodeURIComponent(runtimeId)}/preferences`,
    {
      method: "PUT",
      body: JSON.stringify({
        agent_id: update.agentId,
        ...(update.configValues ? { config_values: update.configValues } : {}),
        ...(update.modeId ? { mode_id: update.modeId } : {}),
      }),
    },
  );
}

export async function createProjectRecord(
  name: string,
): Promise<{ id: string }> {
  return jsonFetch<{ id: string }>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const data = await jsonFetch<{
    projects?: Array<{ id?: unknown; name?: unknown }>;
  }>("/api/v1/projects");
  if (!Array.isArray(data.projects)) return [];
  return data.projects.flatMap((project) => {
    if (typeof project.id !== "string") return [];
    return [
      {
        id: project.id,
        name:
          typeof project.name === "string" && project.name.trim()
            ? project.name
            : "Untitled",
      },
    ];
  });
}

export async function listArchivedProjects(): Promise<ProjectListItem[]> {
  const data = await jsonFetch<{
    projects?: Array<{
      id?: unknown;
      name?: unknown;
      deletedAt?: unknown;
      updatedAt?: unknown;
    }>;
  }>("/api/v1/projects?archived=only");
  if (!Array.isArray(data.projects)) return [];
  return data.projects.flatMap((project) => {
    if (typeof project.id !== "string") return [];
    return [
      {
        id: project.id,
        name:
          typeof project.name === "string" && project.name.trim()
            ? project.name
            : "Untitled",
        ...(typeof project.deletedAt === "string"
          ? { deletedAt: project.deletedAt }
          : {}),
        ...(typeof project.updatedAt === "string"
          ? { updatedAt: project.updatedAt }
          : {}),
      },
    ];
  });
}

export async function restoreProject(id: string): Promise<void> {
  await jsonFetch(`/api/v1/projects/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
}

export async function purgeProject(id: string): Promise<void> {
  await jsonFetch(`/api/v1/projects/${encodeURIComponent(id)}/purge`, {
    method: "DELETE",
    body: JSON.stringify({ confirm: "purge" }),
  });
}

export async function createProject(
  prompt: string,
  options: CreateProjectOptions = {},
): Promise<void> {
  const { id } = await createProjectRecord(prompt);
  if (typeof window !== "undefined") {
    const shouldStartFromPrompt = options.startFromPrompt ?? true;
    const suffix = shouldStartFromPrompt
      ? `?prompt=${encodeURIComponent(prompt)}`
      : "";
    window.location.assign(`/projects/${id}${suffix}`);
  }
}

export async function updateProjectName(
  id: string,
  name: string,
): Promise<void> {
  await jsonFetch(`/api/v1/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function archiveProject(id: string): Promise<void> {
  await jsonFetch(`/api/v1/projects/${id}`, { method: "DELETE" });
}

// ───────── Settings: API tokens ─────────

export async function createApiToken(
  name: string,
): Promise<{ token: string; info: ApiTokenInfo }> {
  return jsonFetch("/api/settings/tokens", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function listApiTokens(): Promise<ApiTokenInfo[]> {
  return jsonFetch("/api/settings/tokens");
}

export async function revokeApiToken(tokenId: string): Promise<void> {
  await jsonFetch(`/api/settings/tokens/${tokenId}`, { method: "DELETE" });
}

// ───────── Settings: User variables ─────────

export async function setVariable(
  varKey: string,
  value: string,
): Promise<VariableInfo> {
  return jsonFetch("/api/settings/variables", {
    method: "POST",
    body: JSON.stringify({ key: varKey, value }),
  });
}

export async function listVariables(): Promise<VariableInfo[]> {
  return jsonFetch("/api/settings/variables");
}

export async function deleteVariable(id: string): Promise<void> {
  await jsonFetch(`/api/settings/variables/${id}`, { method: "DELETE" });
}

// ───────── Settings: Model providers ─────────

export async function listModelProviders(): Promise<
  ModelProviderAccountInfo[]
> {
  const data = await jsonFetch<{ providers: ModelProviderAccountInfo[] }>(
    "/api/v1/model-providers",
  );
  return data.providers;
}

export async function updateModelProviders(
  providers: ModelProviderAccountInfo[],
): Promise<ModelProviderAccountInfo[]> {
  const data = await jsonFetch<{ providers: ModelProviderAccountInfo[] }>(
    "/api/v1/model-providers",
    {
      method: "PATCH",
      body: JSON.stringify({ providers }),
    },
  );
  return data.providers;
}

export async function deleteModelProvider(accountId: string): Promise<void> {
  await jsonFetch(`/api/v1/model-providers/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

export async function listModelCatalog(): Promise<ModelCatalogEntryInfo[]> {
  const data = await jsonFetch<{ models: ModelCatalogEntryInfo[] }>(
    "/api/v1/models/catalog",
  );
  return data.models;
}

export async function saveModelCardConfig(
  modelId: string,
  config: Omit<UserModelCardConfig, "modelId">,
): Promise<UserModelCardConfig> {
  const data = await jsonFetch<{ config: UserModelCardConfig }>(
    `/api/v1/model-cards/${encodeURIComponent(modelId)}`,
    {
      method: "PUT",
      body: JSON.stringify(config),
    },
  );
  return data.config;
}

export async function deleteModelCardConfig(modelId: string): Promise<void> {
  await jsonFetch(`/api/v1/model-cards/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export interface ModelProviderTestResult {
  ok: boolean;
  providerId: string;
  upstreamId?: string;
  region?: string;
  modelId: string;
  message: string;
  provider?: string;
  requestId?: string;
  modelEndpoint?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  disabled?: boolean;
  missingCredentials?: string[];
  missingOAuth?: string[];
  unsupported?: boolean;
  skipped?: boolean;
}

export async function testModelProvider(input: {
  provider: ModelProviderAccountInfo;
  modelId: string;
  live?: boolean;
}): Promise<ModelProviderTestResult> {
  return jsonFetch("/api/v1/model-providers/test", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listProviderOAuth(): Promise<ProviderOAuthInfo[]> {
  const data = await jsonFetch<{ providers: ProviderOAuthInfo[] }>(
    "/api/v1/provider-oauth",
  );
  return data.providers;
}

export async function listPluginProviders(): Promise<PluginProviderInfo[]> {
  const data = await jsonFetch<{ providers: PluginProviderInfo[] }>(
    "/api/v1/plugin-providers",
  );
  return data.providers;
}

export async function startProviderOAuth(
  providerId: string,
  accountId?: string,
  accountLabel?: string,
): Promise<ProviderOAuthInfo> {
  return jsonFetch(
    `/api/v1/provider-oauth/${encodeURIComponent(providerId)}/start`,
    {
      method: "POST",
      body: JSON.stringify({ accountId, accountLabel }),
    },
  );
}

export async function completeProviderOAuth(
  providerId: string,
  deviceCode?: string,
  accountId?: string,
  callbackUrl?: string,
): Promise<ProviderOAuthInfo> {
  return jsonFetch(
    `/api/v1/provider-oauth/${encodeURIComponent(providerId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({ accountId, deviceCode, callbackUrl }),
    },
  );
}

export async function importLocalProviderToken(
  providerId: string,
  accountId?: string,
  accountLabel?: string,
): Promise<ProviderOAuthInfo> {
  return jsonFetch(
    `/api/v1/provider-oauth/${encodeURIComponent(providerId)}/import-local`,
    {
      method: "POST",
      body: JSON.stringify({ accountId, accountLabel }),
    },
  );
}

// ───────── Settings: Installed actions ─────────

export async function listInstalledActions(): Promise<InstalledActionInfo[]> {
  return jsonFetch("/api/settings/actions");
}

export async function installAction(
  manifest: Record<string, unknown>,
): Promise<InstalledActionInfo> {
  return jsonFetch("/api/settings/actions", {
    method: "POST",
    body: JSON.stringify({ manifest }),
  });
}

export async function uninstallAction(actionId: string): Promise<void> {
  await jsonFetch(`/api/settings/actions/${encodeURIComponent(actionId)}`, {
    method: "DELETE",
  });
}

// ───────── Settings: Installed skills ─────────

export async function listInstalledSkills(): Promise<InstalledSkillInfo[]> {
  return jsonFetch("/api/settings/skills");
}

export async function installSkill(
  def: Record<string, unknown>,
): Promise<InstalledSkillInfo> {
  return jsonFetch("/api/settings/skills", {
    method: "POST",
    body: JSON.stringify({ skill: def }),
  });
}

export async function uninstallSkill(skillId: string): Promise<void> {
  await jsonFetch(`/api/settings/skills/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
  });
}

// ───────── Marketplace ─────────

export interface RegistryData {
  version: number;
  actions: RegistryItem[];
  skills: RegistryItem[];
  plugins: RegistryItem[];
}

export async function fetchRegistry(): Promise<RegistryData> {
  return jsonFetch("/api/marketplace/registry");
}

export async function marketplaceInstallAction(
  item: RegistryItem,
): Promise<void> {
  if (item.packageId) {
    await jsonFetch(
      `/api/marketplace/actions/${encodeURIComponent(item.packageId)}/install`,
      {
        method: "POST",
      },
    );
    return;
  }
  await installAction({
    id: item.id,
    name: item.name,
    description: item.description,
    runtime: item.runtime || "worker",
    outputType: item.outputType || "image",
    workerUrl: item.workerUrl,
    model: item.model,
    version: item.version,
    author: item.author,
    repository: item.repository,
    icon: item.icon,
    color: item.color,
    tags: item.tags,
    secrets: item.secrets,
    packageId: item.packageId,
    parameters: [],
  });
}

export async function marketplaceUninstallAction(
  item: RegistryItem,
): Promise<void> {
  if (item.packageId) {
    await jsonFetch(
      `/api/marketplace/actions/${encodeURIComponent(item.packageId)}/install`,
      {
        method: "DELETE",
      },
    );
    return;
  }
  await uninstallAction(item.id);
}

export async function marketplaceInstallSkill(
  item: RegistryItem,
): Promise<void> {
  await jsonFetch(
    `/api/marketplace/skills/${encodeURIComponent(item.id)}/install`,
    {
      method: "POST",
    },
  );
}

export async function marketplaceInstallPlugin(
  item: RegistryItem,
): Promise<void> {
  await jsonFetch(
    `/api/marketplace/plugins/${encodeURIComponent(item.packageId ?? item.id)}/install`,
    { method: "POST" },
  );
}

export async function marketplaceUninstallSkill(
  skillId: string,
): Promise<void> {
  await jsonFetch(
    `/api/marketplace/skills/${encodeURIComponent(skillId)}/install`,
    {
      method: "DELETE",
    },
  );
}
