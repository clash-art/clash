import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, watch } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { clashHomeForLocalDataDir } from "./local-paths.js";
import { HostSkillInstallationsSchema } from "@clash/shared-types";

export interface ClashUserConfigStore {
  readonly clashHome: string;
  readonly configPath: string;
  readonly credentialsPath: string;
  getSection<T>(name: string): Promise<T | null>;
  setSection(name: string, value: unknown): Promise<void>;
  updateSection(name: string, update: (current: unknown) => unknown): Promise<void>;
  getCredentials(): Promise<Record<string, unknown>>;
  updateCredentials(
    update: (current: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

export interface ClashUserConfigWatcherOptions {
  debounceMs?: number;
  onChange(
    config: Record<string, unknown>,
    previousConfig: Record<string, unknown> | null,
  ): Promise<void> | void;
  onError?(error: Error): void;
}

const writes = new Map<string, Promise<void>>();
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function optionalRecord(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = root[key];
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error(`${key} must be a mapping`);
  return value;
}

function validateStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new Error(`${path}.${key} must be a string`);
  }
}

function validateNullableStringField(
  record: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (
    record[key] !== undefined &&
    record[key] !== null &&
    typeof record[key] !== "string"
  ) {
    throw new Error(`${path}.${key} must be a string or null`);
  }
}

export function validateClashUserConfig(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("config.yaml root must be a mapping");
  if (value.version !== undefined && value.version !== 1) {
    throw new Error("config.yaml version must be 1");
  }
  const server = optionalRecord(value, "server");
  if (value.skills !== undefined) HostSkillInstallationsSchema.parse(value.skills);
  if (server) validateStringField(server, "url", "server");

  const harnesses = optionalRecord(value, "harnesses");
  if (
    harnesses?.enabled !== undefined &&
    (!Array.isArray(harnesses.enabled) ||
      !harnesses.enabled.every((id) => typeof id === "string"))
  ) {
    throw new Error("harnesses.enabled must be a string list");
  }
  if (harnesses?.agents !== undefined && !isRecord(harnesses.agents)) {
    throw new Error("harnesses.agents must be a mapping");
  }

  const audio = optionalRecord(value, "audio");
  for (const key of ["asr", "tts"]) {
    const section = audio ? optionalRecord(audio, key) : null;
    if (!section) continue;
    if (section.enabled !== undefined && typeof section.enabled !== "boolean") {
      throw new Error(`audio.${key}.enabled must be a boolean`);
    }
    validateStringField(section, "provider", `audio.${key}`);
    validateStringField(section, "model", `audio.${key}`);
  }

  const mediaAnalysis = optionalRecord(value, "media_analysis");
  if (mediaAnalysis) {
    if (
      mediaAnalysis.video_enabled !== undefined &&
      typeof mediaAnalysis.video_enabled !== "boolean"
    ) {
      throw new Error("media_analysis.video_enabled must be a boolean");
    }
    validateNullableStringField(mediaAnalysis, "model_id", "media_analysis");
    if (
      mediaAnalysis.allowed_categories !== undefined &&
      mediaAnalysis.allowed_categories !== null &&
      (!Array.isArray(mediaAnalysis.allowed_categories) ||
        !mediaAnalysis.allowed_categories.every(
          (category) => typeof category === "string",
        ))
    ) {
      throw new Error(
        "media_analysis.allowed_categories must be a string list or null",
      );
    }
    const video = optionalRecord(mediaAnalysis, "video");
    if (video) {
      if (video.fps !== undefined && typeof video.fps !== "number") {
        throw new Error("media_analysis.video.fps must be a number");
      }
      if (
        video.media_resolution !== undefined &&
        video.media_resolution !== "low" &&
        video.media_resolution !== "medium" &&
        video.media_resolution !== "high"
      ) {
        throw new Error(
          "media_analysis.video.media_resolution must be low, medium or high",
        );
      }
      const refinement = optionalRecord(video, "boundary_refinement");
      if (refinement) {
        if (
          refinement.enabled !== undefined &&
          typeof refinement.enabled !== "boolean"
        ) {
          throw new Error(
            "media_analysis.video.boundary_refinement.enabled must be a boolean",
          );
        }
        for (const key of ["fps", "safety_margin_seconds"]) {
          if (
            refinement[key] !== undefined &&
            typeof refinement[key] !== "number"
          ) {
            throw new Error(
              `media_analysis.video.boundary_refinement.${key} must be a number`,
            );
          }
        }
      }
    }
  }

  const sync = optionalRecord(value, "sync");
  if (sync) {
    if (
      sync.mode !== undefined &&
      sync.mode !== "local-only" &&
      sync.mode !== "cloud-sync"
    ) {
      throw new Error("sync.mode must be local-only or cloud-sync");
    }
    const remote = optionalRecord(sync, "remote_loro");
    if (
      remote &&
      remote.url !== undefined &&
      remote.url !== null &&
      typeof remote.url !== "string"
    ) {
      throw new Error("sync.remote_loro.url must be a string or null");
    }
    const capabilities = optionalRecord(sync, "capabilities");
    if (capabilities) {
      for (const key of [
        "canvas",
        "asset_metadata",
        "revision_content",
        "project_metadata",
      ]) {
        if (
          capabilities[key] !== undefined &&
          typeof capabilities[key] !== "boolean"
        ) {
          throw new Error(`sync.capabilities.${key} must be a boolean`);
        }
      }
    }
  }

  const publicStorage = optionalRecord(value, "public_storage");
  if (publicStorage) {
    if (
      publicStorage.mode !== undefined &&
      publicStorage.mode !== "disabled" &&
      publicStorage.mode !== "byos" &&
      publicStorage.mode !== "managed"
    ) {
      throw new Error("public_storage.mode must be disabled, byos or managed");
    }
    if (
      publicStorage.provider !== undefined &&
      publicStorage.provider !== null &&
      publicStorage.provider !== "r2" &&
      publicStorage.provider !== "aws-s3" &&
      publicStorage.provider !== "tos" &&
      publicStorage.provider !== "custom-s3"
    ) {
      throw new Error(
        "public_storage.provider must be r2, aws-s3, tos, custom-s3 or null",
      );
    }
    for (const key of [
      "account_id",
      "endpoint",
      "bucket",
      "region",
      "key_prefix",
    ]) {
      validateNullableStringField(publicStorage, key, "public_storage");
    }
    if (
      publicStorage.force_path_style !== undefined &&
      typeof publicStorage.force_path_style !== "boolean"
    ) {
      throw new Error("public_storage.force_path_style must be a boolean");
    }
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withConfigLock<T>(
  clashHome: string,
  task: () => Promise<T>,
): Promise<T> {
  await mkdir(clashHome, { recursive: true, mode: 0o700 });
  await chmod(clashHome, 0o700);
  const lockPath = join(clashHome, ".config.lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner"),
        `pid=${process.pid}\ncreated_at=${new Date().toISOString()}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for Clash configuration lock: ${lockPath}`,
        );
      }
      await wait(25);
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function serializeYamlSection(
  source: string | null,
  name: string,
  value: unknown,
): string {
  const document = parseDocument(source ?? "");
  if (document.errors.length > 0) {
    throw new Error(
      `Cannot update config.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`,
    );
  }
  const current = document.toJS() as unknown;
  if (source?.trim() && !isRecord(current)) {
    throw new Error(
      "Cannot update config.yaml: config.yaml root must be a mapping",
    );
  }
  if (!isRecord(current)) {
    document.contents = null;
  }
  document.set("version", 1);
  document.set(name, value);
  return document.toString({ lineWidth: 0 });
}

async function serializeCredentials(
  path: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<string> {
  const source = await readText(path);
  let current: Record<string, unknown> = {};
  if (source) {
    try {
      const parsed = JSON.parse(source) as unknown;
      if (isRecord(parsed)) current = parsed;
    } catch {
      throw new Error("Cannot update credentials.json: invalid JSON");
    }
  }
  return `${JSON.stringify(update(current), null, 2)}\n`;
}

async function serializedWrite(
  path: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writes.set(path, next);
  try {
    await next;
  } finally {
    if (writes.get(path) === next) writes.delete(path);
  }
}

export function createClashUserConfigStore(
  localDataDir: string,
): ClashUserConfigStore {
  const clashHome = clashHomeForLocalDataDir(localDataDir);
  const configPath = join(clashHome, "config.yaml");
  const credentialsPath = join(clashHome, "credentials.json");
  const legacyConfigPath = join(clashHome, "config.json");
  let rootMigration: Promise<void> | null = null;

  const ensureRootMigrated = () => {
    rootMigration ??= (async () => {
      const legacySource = await readText(legacyConfigPath);
      if (!legacySource) return;
      let legacy: Record<string, unknown>;
      try {
        const value = JSON.parse(legacySource) as unknown;
        if (!isRecord(value)) return;
        legacy = value;
      } catch {
        return;
      }
      await withConfigLock(clashHome, async () => {
        const source = await readText(configPath);
        const document = parseDocument(source ?? "");
        if (document.errors.length > 0) {
          throw new Error(
            `Cannot migrate config.json: ${document.errors[0]?.message ?? "invalid config.yaml"}`,
          );
        }
        document.set("version", 1);
        const root = document.toJS() as unknown;
        const server =
          isRecord(root) && isRecord(root.server) ? root.server : {};
        if (
          typeof server.url !== "string" &&
          typeof legacy.serverUrl === "string"
        ) {
          document.setIn(["server", "url"], legacy.serverUrl);
        }
        await atomicWrite(configPath, document.toString({ lineWidth: 0 }));
        if (typeof legacy.apiKey === "string") {
          await atomicWrite(
            credentialsPath,
            await serializeCredentials(credentialsPath, (current) => ({
              ...current,
              ...(typeof current.cliApiKey === "string"
                ? {}
                : { cliApiKey: legacy.apiKey }),
            })),
          );
        }
        await unlink(legacyConfigPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      });
    })();
    return rootMigration;
  };

  return {
    clashHome,
    configPath,
    credentialsPath,

    async getSection<T>(name: string) {
      await ensureRootMigrated();
      const source = await readText(configPath);
      if (!source) return null;
      const document = parseDocument(source);
      if (document.errors.length > 0) {
        throw new Error(
          `Cannot read config.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`,
        );
      }
      const root = document.toJS() as unknown;
      validateClashUserConfig(root);
      if (!(name in root)) return null;
      return root[name] as T;
    },

    async setSection(name, value) {
      await ensureRootMigrated();
      await serializedWrite(configPath, async () => {
        await withConfigLock(clashHome, async () => {
          const source = await readText(configPath);
          await atomicWrite(
            configPath,
            serializeYamlSection(source, name, value),
          );
        });
      });
    },

    async updateSection(name, update) {
      await ensureRootMigrated();
      await serializedWrite(configPath, async () => {
        await withConfigLock(clashHome, async () => {
          const source = await readText(configPath);
          const document = parseDocument(source ?? "");
          if (document.errors.length) throw new Error(`Cannot update config.yaml: ${document.errors[0]?.message}`);
          const root = document.toJS() ?? {};
          validateClashUserConfig(root);
          const value = update(root[name]);
          validateClashUserConfig({ ...root, [name]: value });
          await atomicWrite(configPath, serializeYamlSection(source, name, value));
        });
      });
    },

    async getCredentials() {
      await ensureRootMigrated();
      const source = await readText(credentialsPath);
      if (!source) return {};
      try {
        const parsed = JSON.parse(source) as unknown;
        return isRecord(parsed) ? parsed : {};
      } catch {
        throw new Error("Cannot read credentials.json: invalid JSON");
      }
    },

    async updateCredentials(update) {
      await ensureRootMigrated();
      await serializedWrite(credentialsPath, async () => {
        await withConfigLock(clashHome, async () => {
          await atomicWrite(
            credentialsPath,
            await serializeCredentials(credentialsPath, update),
          );
        });
      });
    },
  };
}

export function watchClashUserConfig(
  localDataDir: string,
  options: ClashUserConfigWatcherOptions,
): () => void {
  const store = createClashUserConfigStore(localDataDir);
  mkdirSync(store.clashHome, { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let lastAppliedHash: string | null;
  let lastAppliedConfig: Record<string, unknown> | null = null;
  try {
    const initialSource = readFileSync(store.configPath, "utf8");
    lastAppliedHash = sourceHash(initialSource);
    const initialDocument = parseDocument(initialSource);
    if (initialDocument.errors.length === 0) {
      const initialValue = initialDocument.toJS() as unknown;
      validateClashUserConfig(initialValue);
      lastAppliedConfig = initialValue;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    lastAppliedHash = null;
  }

  const applyLatest = async () => {
    const source = await readText(store.configPath);
    if (source === null) {
      throw new Error(
        "config.yaml was removed; keeping the last known-good configuration",
      );
    }
    const hash = sourceHash(source);
    if (hash === lastAppliedHash) return;
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw new Error(
        `Cannot reload config.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`,
      );
    }
    const value = document.toJS() as unknown;
    validateClashUserConfig(value);
    await options.onChange(value, lastAppliedConfig);
    lastAppliedHash = hash;
    lastAppliedConfig = value;
  };

  const watcher = watch(store.clashHome, (eventType, filename) => {
    if (closed || filename?.toString() !== "config.yaml") return;
    if (eventType !== "change" && eventType !== "rename") return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void applyLatest().catch((error) => {
        options.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }, options.debounceMs ?? 120);
  });

  watcher.on("error", (error) => {
    options.onError?.(error);
  });

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
