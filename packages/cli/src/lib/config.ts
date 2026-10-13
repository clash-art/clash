import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { isLocalHostDiscoveryRecord } from "@clash/shared-runtime";
import { resolveClashProfile } from "@clash/shared-runtime/local-paths";
import { resolveClashRoot } from "./clash-home";
import { getHostDiscoveryPath } from "./host-discovery";

export function configDir(env: Record<string, string | undefined> = process.env): string {
  return resolveClashRoot(env);
}

export function configFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "config.yaml");
}

export function credentialsFilePath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "credentials.json");
}

export interface ClashConfig {
  apiKey?: string;
  serverUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function atomicWrite(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withConfigLock<T>(dir: string, task: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lockPath = join(dir, ".config.lock");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(
        join(lockPath, "owner"),
        `pid=${process.pid}\ncreated_at=${new Date().toISOString()}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > 30_000;
      } catch {
        continue;
      }
      if (stale) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Clash configuration lock: ${lockPath}`);
      }
      wait(25);
    }
  }
  try {
    return task();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function updateYamlServerUrl(path: string, serverUrl: string | undefined): void {
  const document = parseDocument(existsSync(path) ? readFileSync(path, "utf8") : "");
  if (document.errors.length > 0) {
    throw new Error(`Cannot update config.yaml: ${document.errors[0]?.message ?? "invalid YAML"}`);
  }
  document.set("version", 1);
  if (serverUrl) {
    if (isMap(document.get("server", true))) document.setIn(["server", "url"], serverUrl);
    else document.set("server", { url: serverUrl });
  } else if (document.hasIn(["server", "url"])) {
    document.deleteIn(["server", "url"]);
  }
  atomicWrite(path, document.toString({ lineWidth: 0 }));
}

function updateCliCredential(path: string, apiKey: string | undefined): void {
  const credentials = readObject(path);
  if (apiKey) credentials.cliApiKey = apiKey;
  else delete credentials.cliApiKey;
  atomicWrite(path, `${JSON.stringify(credentials, null, 2)}\n`);
}

function migrateLegacyConfig(env: Record<string, string | undefined> = process.env): void {
  const dir = configDir(env);
  const legacyPath = join(dir, "config.json");
  if (!existsSync(legacyPath)) return;
  const legacy = readObject(legacyPath);
  const configPath = configFilePath(env);
  const credentialsPath = credentialsFilePath(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  withConfigLock(dir, () => {
    const existing = loadConfigFiles(env);
    updateYamlServerUrl(
      configPath,
      existing.serverUrl ?? (typeof legacy.serverUrl === "string" ? legacy.serverUrl : undefined),
    );
    updateCliCredential(
      credentialsPath,
      existing.apiKey ?? (typeof legacy.apiKey === "string" ? legacy.apiKey : undefined),
    );
    unlinkSync(legacyPath);
  });
}

function loadConfigFiles(env: Record<string, string | undefined> = process.env): ClashConfig {
  let serverUrl: string | undefined;
  const configPath = configFilePath(env);
  if (existsSync(configPath)) {
    try {
      const document = parseDocument(readFileSync(configPath, "utf8"));
      const root = document.toJS() as unknown;
      if (isRecord(root) && isRecord(root.server) && typeof root.server.url === "string") {
        serverUrl = root.server.url;
      }
    } catch {
      // Invalid user configuration is reported by write paths; reads remain non-fatal.
    }
  }
  const credentials = readObject(credentialsFilePath(env));
  return {
    ...(typeof credentials.cliApiKey === "string" ? { apiKey: credentials.cliApiKey } : {}),
    ...(serverUrl ? { serverUrl } : {}),
  };
}

export function loadConfig(): ClashConfig {
  migrateLegacyConfig();
  return loadConfigFiles();
}

export function saveConfig(config: ClashConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  withConfigLock(dir, () => {
    updateYamlServerUrl(configFilePath(), config.serverUrl);
    updateCliCredential(credentialsFilePath(), config.apiKey);
  });
}

/**
 * Get API key from env var (priority) or config file.
 */
export function getApiKey(): string | undefined {
  return process.env.CLASH_API_KEY || loadConfig().apiKey;
}

function discoveredServerUrl(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(getHostDiscoveryPath(), "utf8")) as unknown;
    if (!isLocalHostDiscoveryRecord(value)) return undefined;
    if ((value.profile ?? "prod") !== resolveClashProfile()) return undefined;
    try {
      process.kill(value.pid, 0);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EPERM")) {
        return undefined;
      }
    }
    return value.endpoint;
  } catch {
    return undefined;
  }
}

/**
 * Get server URL from env var or config file. Defaults to localhost for dev.
 */
export function getServerUrl(): string {
  return (
    process.env.CLASH_API_URL ||
    discoveredServerUrl() ||
    loadConfig().serverUrl ||
    "http://localhost:8788"
  );
}

export function isLoopbackServerUrl(serverUrl: string): boolean {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]";
  } catch {
    return false;
  }
}

export function requireApiKey(serverUrl = getServerUrl()): string {
  const key = getApiKey();
  if (!key && isLoopbackServerUrl(serverUrl)) return "";
  if (!key) {
    console.error(
      "Error: Cloud sync requires authentication.\n" +
      "Run: clash auth login\n" +
      "Pure local projects work through a loopback local-api without cloud login."
    );
    process.exit(1);
  }
  return key;
}
