import type { S3Client } from "@aws-sdk/client-s3";
import { createHostLazyModule } from "./host-lazy-module.js";
import {
  createClashUserConfigStore,
  type ClashUserConfigStore,
} from "./user-config.js";

// The S3 SDK is the largest dependency in the Host bundle and only BYOS public storage uses it,
// so it is imported on the first storage operation instead of at Host startup.
const loadS3Sdk = createHostLazyModule("@aws-sdk/client-s3", async () => {
  const [s3, presigner] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner"),
  ]);
  return {
    S3Client: s3.S3Client,
    HeadBucketCommand: s3.HeadBucketCommand,
    PutObjectCommand: s3.PutObjectCommand,
    GetObjectCommand: s3.GetObjectCommand,
    DeleteObjectCommand: s3.DeleteObjectCommand,
    getSignedUrl: presigner.getSignedUrl,
  };
});

export type PublicAssetStorageMode = "disabled" | "byos" | "managed";
export type PublicAssetStorageProvider =
  | "r2"
  | "aws-s3"
  | "tos"
  | "custom-s3";

export interface PublicAssetStorageBackendConfig {
  provider: PublicAssetStorageProvider;
  endpoint?: string;
  bucket: string;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface PublicAssetStoragePublishedAsset {
  key: string;
  url: string;
  expiresAt: string;
}

export interface PublicAssetStorageBackend {
  testConnection(): Promise<void>;
  publish(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    expiresInSeconds: number;
  }): Promise<PublicAssetStoragePublishedAsset>;
  delete(key: string): Promise<void>;
}

export interface PublicAssetStoragePublicConfig {
  capability: "public-asset-storage";
  mode: PublicAssetStorageMode;
  available: boolean;
  provider: PublicAssetStorageProvider | null;
  account_id: string | null;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  key_prefix: string;
  force_path_style: boolean;
  has_access_key_id: boolean;
  has_secret_access_key: boolean;
  has_session_token: boolean;
  managed: {
    available: boolean;
    authenticated: boolean;
  };
}

export interface PublicAssetStorageService {
  getPublicConfig(): Promise<PublicAssetStoragePublicConfig>;
  updateFromRequest(
    input: Record<string, unknown>,
  ): Promise<PublicAssetStoragePublicConfig>;
  testConnection(): Promise<void>;
  publish(input: {
    key: string;
    bytes: Uint8Array;
    contentType?: string;
    expiresInSeconds?: number;
  }): Promise<PublicAssetStoragePublishedAsset>;
  delete(key: string): Promise<void>;
}

export class PublicAssetStorageConfigError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface StoredPublicAssetStorageConfig {
  mode: PublicAssetStorageMode;
  provider: PublicAssetStorageProvider | null;
  accountId: string | null;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  keyPrefix: string;
  forcePathStyle: boolean;
}

interface StoredPublicAssetStorageCredentials {
  accessKeyId: string | null;
  secretAccessKey: string | null;
  sessionToken: string | null;
}

export interface ManagedPublicAssetStorage {
  available: boolean;
  authenticated: boolean;
  backend?: PublicAssetStorageBackend;
}

export interface PublicAssetStorageServiceOptions {
  dataDir: string;
  configStore?: ClashUserConfigStore;
  managed?:
    | ManagedPublicAssetStorage
    | (() => ManagedPublicAssetStorage | Promise<ManagedPublicAssetStorage>);
  createByosBackend?: (
    config: PublicAssetStorageBackendConfig,
  ) => PublicAssetStorageBackend;
}

const DEFAULT_KEY_PREFIX = "clash-temporary";
const DEFAULT_SIGNED_URL_TTL_SECONDS = 60 * 60;
const CREDENTIALS_KEY = "publicAssetStorage";

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function modeOrDisabled(value: unknown): PublicAssetStorageMode {
  if (value === "byos" || value === "managed" || value === "disabled") {
    return value;
  }
  return "disabled";
}

function providerOrNull(value: unknown): PublicAssetStorageProvider | null {
  if (
    value === "r2" ||
    value === "aws-s3" ||
    value === "tos" ||
    value === "custom-s3"
  ) {
    return value;
  }
  return null;
}

function cleanKeyPart(value: string): string {
  return value
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function normalizeEndpoint(value: string | null): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicAssetStorageConfigError("endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new PublicAssetStorageConfigError("endpoint must use http or https");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeStoredConfig(value: unknown): StoredPublicAssetStorageConfig {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const provider = providerOrNull(record.provider);
  const region = stringOrNull(record.region);
  return {
    mode: modeOrDisabled(record.mode),
    provider,
    accountId: stringOrNull(record.account_id),
    endpoint: stringOrNull(record.endpoint),
    bucket: stringOrNull(record.bucket),
    region: provider === "r2" ? "auto" : region,
    keyPrefix: cleanKeyPart(stringOrNull(record.key_prefix) ?? DEFAULT_KEY_PREFIX),
    forcePathStyle: booleanOr(record.force_path_style, provider === "custom-s3"),
  };
}

function normalizeStoredCredentials(
  root: Record<string, unknown>,
): StoredPublicAssetStorageCredentials {
  const value = root[CREDENTIALS_KEY];
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    accessKeyId: stringOrNull(record.accessKeyId),
    secretAccessKey: stringOrNull(record.secretAccessKey),
    sessionToken: stringOrNull(record.sessionToken),
  };
}

function resolveEndpoint(config: StoredPublicAssetStorageConfig): string | null {
  if (config.provider === "r2" && config.accountId) {
    return `https://${config.accountId}.r2.cloudflarestorage.com`;
  }
  if (config.provider === "tos" && config.region) {
    return `https://tos-s3-${config.region}.volces.com`;
  }
  return config.endpoint;
}

function completeByosConfig(
  config: StoredPublicAssetStorageConfig,
  credentials: StoredPublicAssetStorageCredentials,
): boolean {
  if (config.mode !== "byos" || !config.provider || !config.bucket) return false;
  if (!credentials.accessKeyId || !credentials.secretAccessKey) return false;
  if (config.provider === "r2") return !!config.accountId;
  if (!config.region) return false;
  if (config.provider === "custom-s3") return !!config.endpoint;
  return true;
}

function backendConfig(
  config: StoredPublicAssetStorageConfig,
  credentials: StoredPublicAssetStorageCredentials,
): PublicAssetStorageBackendConfig {
  if (!completeByosConfig(config, credentials)) {
    throw new PublicAssetStorageConfigError(
      "Public storage is not fully configured.",
      409,
    );
  }
  return {
    provider: config.provider!,
    ...(resolveEndpoint(config) ? { endpoint: resolveEndpoint(config)! } : {}),
    bucket: config.bucket!,
    region: config.region!,
    forcePathStyle:
      config.provider === "tos" ? false : config.forcePathStyle,
    accessKeyId: credentials.accessKeyId!,
    secretAccessKey: credentials.secretAccessKey!,
    ...(credentials.sessionToken
      ? { sessionToken: credentials.sessionToken }
      : {}),
  };
}

function publicConfig(
  config: StoredPublicAssetStorageConfig,
  credentials: StoredPublicAssetStorageCredentials,
  managed: ManagedPublicAssetStorage,
): PublicAssetStoragePublicConfig {
  const available =
    completeByosConfig(config, credentials) ||
    (config.mode === "managed" &&
      managed.available &&
      managed.authenticated &&
      !!managed.backend);
  return {
    capability: "public-asset-storage",
    mode: config.mode,
    available,
    provider: config.provider,
    account_id: config.accountId,
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region,
    key_prefix: config.keyPrefix,
    force_path_style: config.forcePathStyle,
    has_access_key_id: !!credentials.accessKeyId,
    has_secret_access_key: !!credentials.secretAccessKey,
    has_session_token: !!credentials.sessionToken,
    managed: {
      available: managed.available,
      authenticated: managed.authenticated,
    },
  };
}

export function createS3PublicAssetStorageBackend(
  config: PublicAssetStorageBackendConfig,
): PublicAssetStorageBackend {
  let client: S3Client | undefined;
  const connect = async () => {
    const sdk = await loadS3Sdk();
    client ??= new sdk.S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      },
    });
    return { sdk, client };
  };

  return {
    async testConnection() {
      const { sdk, client } = await connect();
      await client.send(new sdk.HeadBucketCommand({ Bucket: config.bucket }));
    },
    async publish({ key, bytes, contentType, expiresInSeconds }) {
      const { sdk, client } = await connect();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: bytes,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      );
      const url = await sdk.getSignedUrl(
        client,
        new sdk.GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { expiresIn: expiresInSeconds },
      );
      return {
        key,
        url,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      };
    },
    async delete(key) {
      const { sdk, client } = await connect();
      await client.send(
        new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
      );
    },
  };
}

export function createPublicAssetStorageService(
  options: PublicAssetStorageServiceOptions,
): PublicAssetStorageService {
  const store =
    options.configStore ?? createClashUserConfigStore(options.dataDir);
  const resolveManaged = async (): Promise<ManagedPublicAssetStorage> => {
    const managed = typeof options.managed === "function"
      ? await options.managed()
      : options.managed;
    return managed ?? { available: false, authenticated: false };
  };
  const createByosBackend =
    options.createByosBackend ?? createS3PublicAssetStorageBackend;

  async function read(): Promise<{
    config: StoredPublicAssetStorageConfig;
    credentials: StoredPublicAssetStorageCredentials;
  }> {
    const [config, credentials] = await Promise.all([
      store.getSection<unknown>("public_storage"),
      store.getCredentials(),
    ]);
    return {
      config: normalizeStoredConfig(config),
      credentials: normalizeStoredCredentials(credentials),
    };
  }

  async function activeBackend(): Promise<{
    backend: PublicAssetStorageBackend;
    keyPrefix: string;
  }> {
    const { config, credentials } = await read();
    const managed = await resolveManaged();
    if (config.mode === "managed") {
      if (!managed.available || !managed.authenticated || !managed.backend) {
        throw new PublicAssetStorageConfigError(
          "Managed Clash storage is not available for this signed-in host.",
          409,
        );
      }
      return { backend: managed.backend, keyPrefix: config.keyPrefix };
    }
    return {
      backend: createByosBackend(backendConfig(config, credentials)),
      keyPrefix: config.keyPrefix,
    };
  }

  return {
    async getPublicConfig() {
      const { config, credentials } = await read();
      return publicConfig(config, credentials, await resolveManaged());
    },

    async updateFromRequest(input) {
      const current = await read();
      const managed = await resolveManaged();
      const mode = Object.prototype.hasOwnProperty.call(input, "mode")
        ? modeOrDisabled(input.mode)
        : current.config.mode;
      if (input.mode !== undefined && mode === "disabled" && input.mode !== "disabled") {
        throw new PublicAssetStorageConfigError(
          "mode must be disabled, byos or managed",
        );
      }
      if (mode === "managed" && (!managed.available || !managed.authenticated || !managed.backend)) {
        throw new PublicAssetStorageConfigError(
          "Managed Clash storage is not available for this signed-in host.",
          409,
        );
      }
      const provider = Object.prototype.hasOwnProperty.call(input, "provider")
        ? providerOrNull(input.provider)
        : current.config.provider;
      if (mode === "byos" && !provider) {
        throw new PublicAssetStorageConfigError(
          "provider is required for BYOS public storage",
        );
      }
      const next: StoredPublicAssetStorageConfig = {
        mode,
        provider,
        accountId: Object.prototype.hasOwnProperty.call(input, "account_id")
          ? stringOrNull(input.account_id)
          : current.config.accountId,
        endpoint: Object.prototype.hasOwnProperty.call(input, "endpoint")
          ? normalizeEndpoint(stringOrNull(input.endpoint))
          : current.config.endpoint,
        bucket: Object.prototype.hasOwnProperty.call(input, "bucket")
          ? stringOrNull(input.bucket)
          : current.config.bucket,
        region:
          provider === "r2"
            ? "auto"
            : Object.prototype.hasOwnProperty.call(input, "region")
              ? stringOrNull(input.region)
              : current.config.region,
        keyPrefix: Object.prototype.hasOwnProperty.call(input, "key_prefix")
          ? cleanKeyPart(stringOrNull(input.key_prefix) ?? DEFAULT_KEY_PREFIX)
          : current.config.keyPrefix,
        forcePathStyle:
          provider === "tos"
            ? false
            : booleanOr(input.force_path_style, current.config.forcePathStyle),
      };
      const nextCredentials: StoredPublicAssetStorageCredentials = {
        accessKeyId: Object.prototype.hasOwnProperty.call(input, "access_key_id")
          ? stringOrNull(input.access_key_id)
          : current.credentials.accessKeyId,
        secretAccessKey: Object.prototype.hasOwnProperty.call(input, "secret_access_key")
          ? stringOrNull(input.secret_access_key)
          : current.credentials.secretAccessKey,
        sessionToken: Object.prototype.hasOwnProperty.call(input, "session_token")
          ? stringOrNull(input.session_token)
          : current.credentials.sessionToken,
      };
      if (mode === "byos" && !completeByosConfig(next, nextCredentials)) {
        throw new PublicAssetStorageConfigError(
          "BYOS requires its bucket, location and access-key credentials.",
        );
      }
      await store.updateCredentials((credentials) => ({
        ...credentials,
        [CREDENTIALS_KEY]: {
          accessKeyId: nextCredentials.accessKeyId,
          secretAccessKey: nextCredentials.secretAccessKey,
          sessionToken: nextCredentials.sessionToken,
        },
      }));
      await store.setSection("public_storage", {
        mode: next.mode,
        provider: next.provider,
        account_id: next.accountId,
        endpoint: next.endpoint,
        bucket: next.bucket,
        region: next.region,
        key_prefix: next.keyPrefix,
        force_path_style: next.forcePathStyle,
      });
      return publicConfig(next, nextCredentials, managed);
    },

    async testConnection() {
      const { backend } = await activeBackend();
      await backend.testConnection();
    },

    async publish(input) {
      const { backend, keyPrefix } = await activeBackend();
      const key = [cleanKeyPart(keyPrefix), cleanKeyPart(input.key)]
        .filter(Boolean)
        .join("/");
      return backend.publish({
        key,
        bytes: input.bytes,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        expiresInSeconds:
          input.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS,
      });
    },

    async delete(key) {
      const { backend } = await activeBackend();
      await backend.delete(cleanKeyPart(key));
    },
  };
}
