import { getLocalReplicaId } from "./local-replica-identity.js";
import {
  createHttpRemoteLoroPersistence,
  type RemoteLoroPersistence,
  type RemoteLoroPersistenceEnv,
} from "./sync.js";
import {
  createSqliteLocalConfigStore,
  type SqliteLocalConfigStore,
} from "./local-config-store.js";
import {
  createClashUserConfigStore,
  type ClashUserConfigStore,
} from "./user-config.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import type { ProjectCloudAdmission } from "@clash/shared-types";

export type LocalSyncMode = "local-only" | "cloud-sync";
export type RemoteLoroSource = "none" | "env" | "config";

export interface LocalSyncCapabilities {
  canvas: boolean;
  asset_metadata: boolean;
  revision_content: boolean;
  /** Project name/description/lifecycle metadata; disabled until explicitly opted in. */
  project_metadata: boolean;
}

export interface PublicLocalSyncConfig {
  mode: LocalSyncMode;
  remote_loro: {
    enabled: boolean;
    url: string | null;
    has_token: boolean;
    source: RemoteLoroSource;
  };
  capabilities: LocalSyncCapabilities;
}

export type LocalSyncConfigReadState = PublicLocalSyncConfig & {
  updated_at: string;
};

export interface LocalSyncConfigStore {
  getPublicConfig(): Promise<PublicLocalSyncConfig>;
  getReadState?(): Promise<LocalSyncConfigReadState>;
  updateFromRequest(
    input: Record<string, unknown>,
  ): Promise<PublicLocalSyncConfig>;
  resolveRemotePersistence(
    projectId?: string,
  ): Promise<RemoteLoroPersistence | undefined>;
  getProjectCloudAdmission?(projectId: string): Promise<ProjectCloudAdmission | null>;
}

export class LocalSyncConfigError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface LocalSyncConfigFile {
  version: 1;
  mode: LocalSyncMode;
  remoteLoroUrl: string | null;
  remoteLoroToken: string | null;
  capabilities: LocalSyncCapabilities;
  updatedAt: string;
}

interface EffectiveLocalSyncConfig {
  mode: LocalSyncMode;
  remoteLoroUrl: string | null;
  remoteLoroToken: string | null;
  capabilities: LocalSyncCapabilities;
  source: RemoteLoroSource;
  updatedAt: string;
}

interface LocalSyncConfigStoreOptions {
  dataDir: string;
  env?: RemoteLoroPersistenceEnv;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
const LOCAL_SYNC_CONFIG_KEY = "local-sync-config";

function trimToNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeRemoteUrl(value: unknown): string | null {
  const raw = trimToNull(value);
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalSyncConfigError("remote_loro_url must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LocalSyncConfigError("remote_loro_url must use http or https");
  }
  return raw.replace(/\/+$/, "");
}

function normalizeMode(value: unknown): LocalSyncMode {
  if (value === undefined || value === null) return "local-only";
  if (value === "local-only" || value === "cloud-sync") return value;
  throw new LocalSyncConfigError("mode must be local-only or cloud-sync");
}

function defaultSyncCapabilities(): LocalSyncCapabilities {
  return {
    canvas: false,
    asset_metadata: false,
    revision_content: false,
    project_metadata: false,
  };
}

function normalizeCapabilities(
  value: unknown,
  fallback: LocalSyncCapabilities = defaultSyncCapabilities(),
): LocalSyncCapabilities {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new LocalSyncConfigError("capabilities must be an object");
  }
  const record = value as Record<string, unknown>;
  return {
    canvas:
      record.canvas === undefined ? fallback.canvas : record.canvas === true,
    asset_metadata:
      record.asset_metadata === undefined
        ? fallback.asset_metadata
        : record.asset_metadata === true,
    revision_content:
      record.revision_content === undefined
        ? fallback.revision_content
        : record.revision_content === true,
    project_metadata:
      record.project_metadata === undefined
        ? fallback.project_metadata
        : record.project_metadata === true,
  };
}

function envConfig(
  env: RemoteLoroPersistenceEnv | undefined,
): EffectiveLocalSyncConfig {
  const url = normalizeRemoteUrl(env?.CLASH_REMOTE_LORO_URL);
  return {
    mode: url ? "cloud-sync" : "local-only",
    remoteLoroUrl: url,
    remoteLoroToken: trimToNull(env?.CLASH_REMOTE_LORO_TOKEN),
    capabilities: defaultSyncCapabilities(),
    source: url ? "env" : "none",
    updatedAt: "env",
  };
}

function toPublicConfig(
  config: EffectiveLocalSyncConfig,
): PublicLocalSyncConfig {
  const enabled = config.mode === "cloud-sync" && !!config.remoteLoroUrl;
  return {
    mode: enabled ? "cloud-sync" : "local-only",
    remote_loro: {
      enabled,
      url: enabled ? config.remoteLoroUrl : null,
      has_token: enabled && !!config.remoteLoroToken,
      source: enabled ? config.source : "none",
    },
    capabilities: enabled ? config.capabilities : defaultSyncCapabilities(),
  };
}

function toReadState(
  config: EffectiveLocalSyncConfig,
): LocalSyncConfigReadState {
  return {
    ...toPublicConfig(config),
    updated_at: config.updatedAt,
  };
}

async function readLegacyConfig(
  store: SqliteLocalConfigStore,
): Promise<LocalSyncConfigFile | null> {
  const data = await store.getJson<Partial<LocalSyncConfigFile>>(
    LOCAL_SYNC_CONFIG_KEY,
  );
  if (!data) return null;
  return {
    version: 1,
    mode: normalizeMode(data.mode),
    remoteLoroUrl: normalizeRemoteUrl(data.remoteLoroUrl),
    remoteLoroToken: trimToNull(data.remoteLoroToken),
    capabilities: normalizeCapabilities(data.capabilities),
    updatedAt:
      typeof data.updatedAt === "string"
        ? data.updatedAt
        : new Date(0).toISOString(),
  };
}

async function readConfig(
  store: ClashUserConfigStore,
): Promise<LocalSyncConfigFile | null> {
  const value = await store.getSection<unknown>("sync");
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const remote =
    record.remote_loro &&
    typeof record.remote_loro === "object" &&
    !Array.isArray(record.remote_loro)
      ? (record.remote_loro as Record<string, unknown>)
      : {};
  const credentials = await store.getCredentials();
  return {
    version: 1,
    mode: normalizeMode(record.mode),
    remoteLoroUrl: normalizeRemoteUrl(remote.url),
    // A signed-in local-only host may only have the CLI API token. Reuse it
    // for the project-scoped admission/Loro transport without changing the
    // process-wide sync mode.
    remoteLoroToken: trimToNull(
      credentials.syncRemoteLoroToken ?? credentials.cliApiKey,
    ),
    capabilities: normalizeCapabilities(record.capabilities),
    updatedAt:
      typeof record.updated_at === "string"
        ? record.updated_at
        : new Date(0).toISOString(),
  };
}

async function writeConfig(
  store: ClashUserConfigStore,
  config: LocalSyncConfigFile,
): Promise<void> {
  await store.updateCredentials((current) => {
    const next = { ...current };
    if (config.remoteLoroToken) {
      next.syncRemoteLoroToken = config.remoteLoroToken;
    } else {
      delete next.syncRemoteLoroToken;
    }
    return next;
  });
  await store.setSection("sync", {
    mode: config.mode,
    remote_loro: {
      url: config.remoteLoroUrl,
    },
    capabilities: config.capabilities,
    updated_at: config.updatedAt,
  });
}

export function createLocalSyncConfigStore(
  options: LocalSyncConfigStoreOptions,
): LocalSyncConfigStore {
  const configStore = createClashUserConfigStore(options.dataDir);
  const legacyStore = createSqliteLocalConfigStore(options.dataDir);
  const metadataStore = createLocalMetadataStore(options.dataDir);
  const env = options.env ?? {};
  let migration: Promise<void> | null = null;

  async function ensureMigrated(): Promise<void> {
    migration ??= (async () => {
      if (await readConfig(configStore)) return;
      const legacy = await readLegacyConfig(legacyStore);
      if (!legacy) return;
      await writeConfig(configStore, legacy);
      await legacyStore.delete(LOCAL_SYNC_CONFIG_KEY);
    })();
    return migration;
  }

  async function effective(): Promise<EffectiveLocalSyncConfig> {
    await ensureMigrated();
    const file = await readConfig(configStore);
    if (!file) return envConfig(env);
    return {
      mode: file.mode,
      remoteLoroUrl: file.remoteLoroUrl,
      remoteLoroToken: file.remoteLoroToken,
      capabilities:
        file.mode === "cloud-sync"
          ? file.capabilities
          : defaultSyncCapabilities(),
      source: file.remoteLoroUrl ? "config" : "none",
      updatedAt: file.updatedAt,
    };
  }

  return {
    async getPublicConfig() {
      return toPublicConfig(await effective());
    },

    async getReadState() {
      return toReadState(await effective());
    },

    async getProjectCloudAdmission(projectId: string) {
      return metadataStore.getProjectCloudAdmission(projectId, await getLocalReplicaId(options.dataDir));
    },

    async updateFromRequest(input) {
      await ensureMigrated();
      const current = (await readConfig(configStore)) ?? {
        version: 1 as const,
        mode: envConfig(env).mode,
        remoteLoroUrl: envConfig(env).remoteLoroUrl,
        remoteLoroToken: null,
        capabilities: envConfig(env).capabilities,
        updatedAt: new Date(0).toISOString(),
      };

      const mode =
        input.mode === undefined ? current.mode : normalizeMode(input.mode);
      const remoteLoroUrl = Object.prototype.hasOwnProperty.call(
        input,
        "remote_loro_url",
      )
        ? normalizeRemoteUrl(input.remote_loro_url)
        : current.remoteLoroUrl;
      const remoteLoroToken = Object.prototype.hasOwnProperty.call(
        input,
        "remote_loro_token",
      )
        ? trimToNull(input.remote_loro_token)
        : current.remoteLoroToken;

      if (mode === "cloud-sync" && !remoteLoroUrl) {
        throw new LocalSyncConfigError(
          "remote_loro_url is required for cloud-sync mode",
        );
      }
      const capabilities =
        mode === "cloud-sync"
          ? normalizeCapabilities(input.capabilities, current.capabilities)
          : defaultSyncCapabilities();

      const next: LocalSyncConfigFile = {
        version: 1,
        mode,
        remoteLoroUrl: mode === "cloud-sync" ? remoteLoroUrl : null,
        remoteLoroToken: mode === "cloud-sync" ? remoteLoroToken : null,
        capabilities,
        updatedAt: new Date().toISOString(),
      };
      await writeConfig(configStore, next);
      return toPublicConfig({
        mode: next.mode,
        remoteLoroUrl: next.remoteLoroUrl,
        remoteLoroToken: next.remoteLoroToken,
        capabilities: next.capabilities,
        source: next.remoteLoroUrl ? "config" : "none",
        updatedAt: next.updatedAt,
      });
    },

    async resolveRemotePersistence(projectId?: string) {
      const config = await effective();
      if (!projectId) return undefined;
      const replicaId = await getLocalReplicaId(options.dataDir);
      const admission = await metadataStore.getProjectCloudAdmission(projectId, replicaId);
      if (!admission || admission.status === "local-only" || !admission.capabilities.canvas) return undefined;
      const assertAdmitted = async () => {
        const current = await metadataStore.getProjectCloudAdmission(projectId, replicaId);
        if (!current || current.status === "local-only" || current.syncBaseUrl !== admission.syncBaseUrl || !current.capabilities.canvas) {
          throw new Error("Project cloud admission was revoked or changed");
        }
      };
      const credentials = await configStore.getCredentials();
      const token =
        config.remoteLoroToken ??
        trimToNull(credentials.syncRemoteLoroToken ?? credentials.cliApiKey);
      const remote = createHttpRemoteLoroPersistence({
        baseUrl: admission.syncBaseUrl,
        token: token ?? undefined,
        fetch: async (input, init) => {
          await assertAdmitted();
          return (options.fetch ?? fetch)(input, init);
        },
      });
      return {
        ...remote,
        createLink(input) {
          const link = remote.createLink!({ ...input, commit: async (...args) => {
            await assertAdmitted();
            await input.commit(...args);
          } });
          return {
            start: async () => { await assertAdmitted(); await link.start(); },
            publish: async (update) => {
              try { await assertAdmitted(); await link.publish(update); }
              catch (error) { await link.close(); throw error; }
            },
            close: () => link.close(),
          };
        },
      };
    },
  };
}
