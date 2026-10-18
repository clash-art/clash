import { execFile, execFileSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

export interface ResolveMacGuiPathInput {
  env: Record<string, string | undefined>;
  homeDir: string;
  platform: NodeJS.Platform | string;
  readLoginShellPath?: () => string;
}

const FINDER_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The login shell is useful for GUI PATH, but never worth blocking a launch on. */
export const DEFAULT_MAC_LOGIN_SHELL_TIMEOUT_MS = 500;

const MAC_GUI_PATH_CACHE_SCHEMA_VERSION = 1;

export interface MacGuiPathCacheRecord {
  schemaVersion: 1;
  path: string;
  updatedAt: string;
}

export interface MacLoginShellPathResult {
  path: string;
  timedOut: boolean;
  error?: string;
}

export type MacGuiPathSource =
  | "platform"
  | "login-shell"
  | "cache"
  | "fallback";

export interface MacGuiPathHydrationResult {
  path: string;
  source: MacGuiPathSource;
  timedOut: boolean;
  error?: string;
}

export interface MacGuiPathHydration {
  /** PATH applied synchronously, so the Host can launch without waiting. */
  currentPath: string;
  /** Settles after the login shell succeeds or the timeout/failure fallback is chosen. */
  pathReady: Promise<MacGuiPathHydrationResult>;
}

export interface StartMacGuiPathHydrationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  timeoutMs?: number;
  /** Last-good PATH cache under the desktop userData directory. */
  cachePath?: string;
  onWarning?: (event: string, context: Record<string, unknown>) => void;
}

function commonMacUserPaths(homeDir: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    `${homeDir}/.local/bin`,
    `${homeDir}/.npm-global/bin`,
    `${homeDir}/.pnpm`,
    `${homeDir}/.bun/bin`,
    `${homeDir}/.cargo/bin`,
  ];
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "")
    .split(":")
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniquePath(parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out.join(":");
}

export function readMacLoginShellPath(env: Record<string, string | undefined> = process.env): string {
  const shell = env.SHELL || "/bin/zsh";
  try {
    return execFileSync(shell, ["-lc", "printf %s \"$PATH\""], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function resolveMacGuiPath(input: ResolveMacGuiPathInput): string {
  const current = input.env.PATH ?? "";
  if (input.platform !== "darwin") return current;

  const loginShellPath = input.readLoginShellPath?.() ?? readMacLoginShellPath(input.env);
  return uniquePath([
    ...splitPath(loginShellPath),
    ...commonMacUserPaths(input.homeDir),
    ...splitPath(current),
    ...splitPath(FINDER_DEFAULT_PATH),
  ]);
}

export function hydrateMacGuiPath(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;
  env.PATH = resolveMacGuiPath({
    env,
    homeDir: homedir(),
    platform: process.platform,
  });
}

/** Same login-shell lookup as readMacLoginShellPath, without blocking the main process. */
export function readMacLoginShellPathResultAsync(
  env: Record<string, string | undefined> = process.env,
  timeoutMs: number = DEFAULT_MAC_LOGIN_SHELL_TIMEOUT_MS,
): Promise<MacLoginShellPathResult> {
  const shell = env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-lc", "printf %s \"$PATH\""],
      {
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: timeoutMs,
      },
      (error, stdout) => {
        if (!error) {
          resolve({ path: String(stdout).trim(), timedOut: false });
          return;
        }
        resolve({
          path: "",
          timedOut:
            (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true,
          error: error.message,
        });
      },
    );
  });
}

export function readMacGuiPathCache(
  cachePath: string | undefined,
): string | undefined {
  if (!cachePath) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as
      | Partial<MacGuiPathCacheRecord>
      | undefined;
    if (
      parsed?.schemaVersion !== MAC_GUI_PATH_CACHE_SCHEMA_VERSION ||
      typeof parsed.path !== "string" ||
      parsed.path.trim().length === 0
    ) {
      return undefined;
    }
    return parsed.path.trim();
  } catch {
    return undefined;
  }
}

export async function writeMacGuiPathCache(
  cachePath: string,
  path: string,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify(
      {
        schemaVersion: MAC_GUI_PATH_CACHE_SCHEMA_VERSION,
        path,
        updatedAt: new Date().toISOString(),
      } satisfies MacGuiPathCacheRecord,
      null,
      2,
    )}\n`,
    "utf8",
  );
  await rename(temporary, cachePath);
}

/**
 * Starts the macOS login-shell PATH lookup and applies the best PATH known
 * immediately (cache, fallback, or the previous PATH). The caller does not
 * await `pathReady` before launching the Host; it just keeps the promise so the
 * hydrated PATH can be handed to later agent/tool spawns.
 */
export function startMacGuiPathHydration(
  options: StartMacGuiPathHydrationOptions = {},
): MacGuiPathHydration {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    const path = env.PATH ?? "";
    return {
      currentPath: path,
      pathReady: Promise.resolve({ path, source: "platform", timedOut: false }),
    };
  }
  const homeDir = options.homeDir ?? homedir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_MAC_LOGIN_SHELL_TIMEOUT_MS;
  const cachedPath = readMacGuiPathCache(options.cachePath);
  const fallbackPath = resolveMacGuiPath({
    env,
    homeDir,
    platform,
    readLoginShellPath: () => cachedPath ?? "",
  });
  env.PATH = fallbackPath;

  const pathReady = (async (): Promise<MacGuiPathHydrationResult> => {
    const lookup = await readMacLoginShellPathResultAsync(env, timeoutMs);
    if (lookup.path) {
      const hydrated = resolveMacGuiPath({
        env,
        homeDir,
        platform,
        readLoginShellPath: () => lookup.path,
      });
      env.PATH = hydrated;
      if (options.cachePath) {
        await writeMacGuiPathCache(options.cachePath, hydrated).catch((error) => {
          options.onWarning?.("DESKTOP_SHELL_PATH_CACHE_WRITE_FAILED", {
            cachePath: options.cachePath,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      return { path: hydrated, source: "login-shell", timedOut: false };
    }
    options.onWarning?.(
      lookup.timedOut
        ? "DESKTOP_SHELL_PATH_TIMEOUT"
        : "DESKTOP_SHELL_PATH_FAILED",
      {
        fallbackPath,
        shell: env.SHELL || "/bin/zsh",
        timeoutMs,
        ...(lookup.error ? { error: lookup.error } : {}),
      },
    );
    return {
      path: fallbackPath,
      source: cachedPath ? "cache" : "fallback",
      timedOut: lookup.timedOut,
      ...(lookup.error ? { error: lookup.error } : {}),
    };
  })();

  return { currentPath: fallbackPath, pathReady };
}

/**
 * Starts the lookup and waits for it. Kept for synchronous callers and tests;
 * desktop startup uses `startMacGuiPathHydration` so it never blocks.
 */
export async function hydrateMacGuiPathAsync(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await startMacGuiPathHydration({ env, platform }).pathReady;
}
