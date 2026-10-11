import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultClashHome } from "./local-paths.js";

/**
 * Chrome Headless Shell for Remotion renders, kept outside the installation.
 *
 * Remotion picks the browser version (`TESTED_VERSION`) and owns the download; Clash only decides
 * where it lands. Upstream derives that location from `process.cwd()` -- the nearest
 * `package.json`'s `node_modules/.remotion`, with no option or environment override -- which in a
 * self-contained install is the (possibly read-only) archive and in a plugin process is the plugin
 * directory. So `ensureBrowser()` runs in a child process whose cwd is a Clash-owned cache
 * directory holding a stub `package.json`, and every render is then handed the resulting
 * `browserExecutable` explicitly.
 */

type Env = Record<string, string | undefined>;

export const CLASH_BROWSER_CHROME_MODE = "headless-shell";

/** Remotion's own pin plus the module the child process loads to honour it. */
export type RemotionBrowserPin = {
  /** `TESTED_VERSION` of the installed `@remotion/renderer`. Never chosen by Clash. */
  testedVersion: string;
  /** Absolute CommonJS entry of the installed `@remotion/renderer`. */
  rendererEntry: string;
};

export type ClashBrowser = {
  executablePath: string;
  /** Pinned Chrome version; `null` for a user-supplied executable, which is not inspected. */
  version: string | null;
  /** Versioned cache directory; `null` for a user-supplied executable. */
  cacheDir: string | null;
  source: "cache" | "override";
};

export type ClashBrowserDownloadProgress = {
  percent: number;
  downloadedBytes: number;
  totalSizeInBytes: number;
};

export type ClashBrowserDownloadRequest = {
  cacheDir: string;
  rendererEntry: string;
  env: Env;
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (progress: ClashBrowserDownloadProgress) => void;
};

export type ClashBrowserOptions = {
  env?: Env;
  /** Injectable for tests; defaults to reading the installed `@remotion/renderer`. */
  remotion?: RemotionBrowserPin | (() => RemotionBrowserPin);
};

export type EnsureClashBrowserOptions = ClashBrowserOptions & {
  /** Injectable for tests; defaults to `ensureBrowser()` in a child process. */
  download?: (
    request: ClashBrowserDownloadRequest,
  ) => Promise<{ executablePath: string }>;
  onProgress?: (progress: ClashBrowserDownloadProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const RECEIPT_FILE = "browser.json";
// Where Remotion's BrowserFetcher records the version it unpacked, relative to the cwd package.
const REMOTION_VERSION_FILE = join(
  "node_modules",
  ".remotion",
  "chrome-headless-shell",
  "VERSION",
);
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

function moduleRequire(): NodeJS.Require {
  // The CLI also ships as a plain CJS bundle where `import.meta.url` is empty.
  const url = typeof import.meta !== "undefined" ? import.meta.url : undefined;
  return createRequire(
    typeof url === "string" && url ? url : (process.argv[1] ?? process.cwd()),
  );
}

let installedPin: RemotionBrowserPin | undefined;

/**
 * Read the Chrome version the installed `@remotion/renderer` was tested with.
 *
 * `TESTED_VERSION` is not part of the package's public exports, so it is loaded from the file that
 * defines it. That is an internal path of an exactly pinned dependency; when a Remotion upgrade
 * moves it, this fails loudly rather than letting Clash substitute a version of its own.
 */
export function readRemotionBrowserPin(
  requireFrom: NodeJS.Require = moduleRequire(),
): RemotionBrowserPin {
  const packageRoot = dirname(
    requireFrom.resolve("@remotion/renderer/package.json"),
  );
  const pinModule = join(
    packageRoot,
    "dist",
    "browser",
    "get-chrome-download-url.js",
  );
  let testedVersion: unknown;
  try {
    testedVersion = (requireFrom(pinModule) as { TESTED_VERSION?: unknown })
      .TESTED_VERSION;
  } catch (error) {
    throw new Error(
      `Cannot read Remotion's pinned Chrome version from ${pinModule}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof testedVersion !== "string" || !/^[\w.-]+$/.test(testedVersion)) {
    throw new Error(
      `Remotion's pinned Chrome version is missing from ${pinModule}.`,
    );
  }
  return {
    testedVersion,
    rendererEntry: requireFrom.resolve("@remotion/renderer"),
  };
}

function resolvePin(options: ClashBrowserOptions): RemotionBrowserPin {
  if (typeof options.remotion === "function") return options.remotion();
  if (options.remotion) return options.remotion;
  return (installedPin ??= readRemotionBrowserPin());
}

/** `CLASH_BROWSER_EXECUTABLE`: a user-supplied Chrome that bypasses the cache entirely. */
export function clashBrowserExecutableOverride(
  env: Env = process.env,
): string | undefined {
  const explicit = env.CLASH_BROWSER_EXECUTABLE?.trim();
  return explicit ? resolve(explicit) : undefined;
}

/** `CLASH_BROWSER_CACHE_DIR`, else `$CLASH_HOME/cache/browser`. */
export function resolveClashBrowserCacheRoot(env: Env = process.env): string {
  const explicit = env.CLASH_BROWSER_CACHE_DIR?.trim();
  return explicit
    ? resolve(explicit)
    : join(defaultClashHome(env), "cache", "browser");
}

/** The Chrome version the installed Remotion renders with. */
export function clashBrowserPinnedVersion(
  options: ClashBrowserOptions = {},
): string {
  return resolvePin(options).testedVersion;
}

/** One directory per Remotion-pinned browser, so a Remotion upgrade never reuses an old Chrome. */
export function resolveClashBrowserCacheDir(
  options: ClashBrowserOptions = {},
): string {
  return join(
    resolveClashBrowserCacheRoot(options.env ?? process.env),
    `${CLASH_BROWSER_CHROME_MODE}-${resolvePin(options).testedVersion}`,
  );
}

/** Background warm-up is on unless `CLASH_BROWSER_WARMUP` is `0`, `false`, or `off`. */
export function clashBrowserWarmupEnabled(env: Env = process.env): boolean {
  const value = env.CLASH_BROWSER_WARMUP?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off");
}

/**
 * Browser settings a Host forwards to a renderer process whose environment it otherwise scrubs.
 * The cache root is resolved here because such a process does not inherit `CLASH_HOME`.
 */
export function clashBrowserEnvironment(env: Env = process.env): Env {
  const override = clashBrowserExecutableOverride(env);
  return {
    CLASH_BROWSER_CACHE_DIR: resolveClashBrowserCacheRoot(env),
    ...(override ? { CLASH_BROWSER_EXECUTABLE: override } : {}),
  };
}

/** A DRM render node is what Chrome's hardware GL needs on Linux; a bare VM or container has none. */
function hasLinuxRenderNode(): boolean {
  try {
    return readdirSync("/dev/dri").some((name) => name.startsWith("renderD"));
  } catch {
    return false;
  }
}

/**
 * The Remotion `gl` backend for a browser that must create a WebGL context (Director capture).
 *
 * `CLASH_BROWSER_GL` wins and is passed through for Remotion to validate. Otherwise this is
 * `angle`, except on Linux without a GPU: there `--use-gl=angle` alone leaves Chrome with no
 * WebGL at all, while `swangle` (ANGLE on SwiftShader) renders in software.
 */
export function resolveClashBrowserGl(
  options: {
    env?: Env;
    platform?: NodeJS.Platform;
    /** Injectable for tests; defaults to looking for a DRM render node. */
    hasGpu?: () => boolean;
  } = {},
): string {
  const explicit = (options.env ?? process.env).CLASH_BROWSER_GL?.trim();
  if (explicit) return explicit;
  if ((options.platform ?? process.platform) !== "linux") return "angle";
  return (options.hasGpu ?? hasLinuxRenderNode)() ? "angle" : "swangle";
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function cachedBrowser(
  cacheDir: string,
  testedVersion: string,
): ClashBrowser | undefined {
  if (readTrimmed(join(cacheDir, REMOTION_VERSION_FILE)) !== testedVersion) {
    return undefined;
  }
  let recorded: unknown;
  try {
    recorded = JSON.parse(readFileSync(join(cacheDir, RECEIPT_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const executable = (recorded as { executable?: unknown } | null)?.executable;
  if (typeof executable !== "string" || !executable) return undefined;
  const executablePath = resolve(cacheDir, executable);
  if (!existsSync(executablePath)) return undefined;
  return {
    executablePath,
    version: testedVersion,
    cacheDir,
    source: "cache",
  };
}

/**
 * The browser a render can use right now, without downloading or spawning anything.
 *
 * Returns the cached headless shell only when Remotion's `VERSION` file beside it equals the
 * installed Remotion's `TESTED_VERSION`; `undefined` means `ensureClashBrowser()` must run first.
 * `CLASH_BROWSER_EXECUTABLE` is returned as given and is validated by `ensureClashBrowser()`.
 */
export function resolveClashBrowserExecutable(
  options: ClashBrowserOptions = {},
): ClashBrowser | undefined {
  const override = clashBrowserExecutableOverride(options.env ?? process.env);
  if (override) {
    return {
      executablePath: override,
      version: null,
      cacheDir: null,
      source: "override",
    };
  }
  return cachedBrowser(
    resolveClashBrowserCacheDir(options),
    resolvePin(options).testedVersion,
  );
}

// Runs with cwd = the cache directory, which is the only way to steer Remotion's download location.
const ENSURE_BROWSER_SCRIPT = `
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
(async () => {
  const { ensureBrowser } = require(process.argv[1]);
  const status = await ensureBrowser({
    chromeMode: ${JSON.stringify(CLASH_BROWSER_CHROME_MODE)},
    logLevel: "error",
    onBrowserDownload: () => ({
      version: null,
      onProgress: ({ percent, downloadedBytes, totalSizeInBytes }) =>
        emit({ type: "progress", percent, downloadedBytes, totalSizeInBytes }),
    }),
  });
  if (!status || typeof status.path !== "string") {
    throw new Error("Remotion did not report a browser executable (" + (status && status.type) + ").");
  }
  emit({ type: "result", executablePath: status.path });
})().catch((error) => {
  process.stderr.write(String((error && error.stack) || error) + "\\n");
  process.exit(1);
});
`;

/** Default download: Remotion's `ensureBrowser()` in a child Node whose cwd is the cache directory. */
export function downloadClashBrowserInChildProcess(
  request: ClashBrowserDownloadRequest,
): Promise<{ executablePath: string }> {
  return new Promise((resolveDownload, rejectDownload) => {
    const child = spawn(
      process.execPath,
      ["-e", ENSURE_BROWSER_SCRIPT, request.rendererEntry],
      {
        cwd: request.cacheDir,
        // Harmless for Node; required when the Host's execPath is Electron.
        env: { ...request.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal: request.signal,
        timeout: request.timeoutMs,
      },
    );
    let executablePath: string | undefined;
    let pending = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message?.type === "progress") {
          request.onProgress?.(
            message as unknown as ClashBrowserDownloadProgress,
          );
        } else if (
          message?.type === "result" &&
          typeof message.executablePath === "string"
        ) {
          executablePath = message.executablePath;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.once("error", rejectDownload);
    child.once("close", (code, signal) => {
      if (code === 0 && executablePath) {
        resolveDownload({ executablePath });
        return;
      }
      const reason = signal
        ? `was terminated by ${signal}`
        : `exited with code ${code}`;
      // Remotion's network failures surface as an uncaught exception dump; keep the error line.
      const output = stderr.trim();
      const detail = /^\w*Error: .+$/m.exec(output)?.[0] ?? output;
      rejectDownload(
        new Error(
          `Chrome Headless Shell download ${reason}${detail ? `: ${detail}` : "."}`,
        ),
      );
    });
  });
}

/** The path with symlinks resolved, or unchanged while it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function writeFileAtomically(path: string, contents: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
}

async function ensureCachedBrowser(
  options: EnsureClashBrowserOptions,
  env: Env,
): Promise<ClashBrowser> {
  const pin = resolvePin(options);
  const cacheDir = resolveClashBrowserCacheDir(options);
  const cached = cachedBrowser(cacheDir, pin.testedVersion);
  if (cached) return cached;

  mkdirSync(cacheDir, { recursive: true });
  const stubPackage = join(cacheDir, "package.json");
  if (!existsSync(stubPackage)) {
    // Remotion downloads below the nearest package.json; this pins that to the cache directory.
    writeFileAtomically(
      stubPackage,
      `${JSON.stringify({ name: "clash-browser-cache", private: true }, null, 2)}\n`,
    );
  }
  const download = options.download ?? downloadClashBrowserInChildProcess;
  const { executablePath } = await download({
    cacheDir,
    rendererEntry: pin.rendererEntry,
    env,
    timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  // Remotion reports the physical path of its cwd, so a cache reached through a symlink
  // (`CLASH_HOME` on another volume) has to be compared by real path on both sides.
  const recorded = relative(realPath(cacheDir), realPath(executablePath));
  if (recorded.startsWith("..") || isAbsolute(recorded)) {
    throw new Error(
      `Remotion installed Chrome Headless Shell outside the Clash browser cache: ${executablePath}`,
    );
  }
  writeFileAtomically(
    join(cacheDir, RECEIPT_FILE),
    `${JSON.stringify({ executable: recorded, version: pin.testedVersion, chromeMode: CLASH_BROWSER_CHROME_MODE }, null, 2)}\n`,
  );
  const installed = cachedBrowser(cacheDir, pin.testedVersion);
  if (!installed) {
    throw new Error(
      `Chrome Headless Shell ${pin.testedVersion} is not usable in ${cacheDir} after download.`,
    );
  }
  return installed;
}

const inFlight = new Map<string, Promise<ClashBrowser>>();

/**
 * Make the Remotion-pinned Chrome Headless Shell available and return it.
 *
 * Fast when the cache is already current. Otherwise Remotion downloads its pinned version into the
 * cache directory; concurrent callers in this process share one download, and Remotion's own lock
 * file serialises downloads across processes.
 */
export async function ensureClashBrowser(
  options: EnsureClashBrowserOptions = {},
): Promise<ClashBrowser> {
  const env = options.env ?? process.env;
  const override = clashBrowserExecutableOverride(env);
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `CLASH_BROWSER_EXECUTABLE points to ${override}, which does not exist.`,
      );
    }
    return {
      executablePath: override,
      version: null,
      cacheDir: null,
      source: "override",
    };
  }
  const cacheDir = resolveClashBrowserCacheDir(options);
  const running = inFlight.get(cacheDir);
  if (running) return running;
  const started = ensureCachedBrowser(options, env).finally(() => {
    inFlight.delete(cacheDir);
  });
  inFlight.set(cacheDir, started);
  return started;
}

/**
 * Shared libraries the dynamic loader cannot find for a browser executable (Linux only).
 *
 * Downloading succeeds on a bare image; launching does not. `ldd` names every missing library at
 * once, where a failed launch names only the first. An empty list means "nothing known to be
 * missing", including when `ldd` itself is unavailable.
 */
export async function findMissingBrowserLibraries(
  executablePath: string,
  options: {
    platform?: NodeJS.Platform;
    ldd?: (executablePath: string) => Promise<string>;
  } = {},
): Promise<string[]> {
  if ((options.platform ?? process.platform) !== "linux") return [];
  const ldd =
    options.ldd ??
    ((path: string) =>
      new Promise<string>((resolveOutput, rejectOutput) => {
        execFile("ldd", [path], { timeout: 10_000 }, (error, stdout) =>
          error ? rejectOutput(error) : resolveOutput(stdout),
        );
      }));
  let output: string;
  try {
    output = await ldd(executablePath);
  } catch {
    return [];
  }
  const missing = new Set<string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\S+)\s+=>\s+not found/.exec(line);
    if (match?.[1]) missing.add(match[1]);
  }
  return [...missing];
}
