import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clashBrowserEnvironment,
  clashBrowserWarmupEnabled,
  ensureClashBrowser,
  findMissingBrowserLibraries,
  resolveClashBrowserCacheDir,
  resolveClashBrowserCacheRoot,
  readRemotionBrowserPin,
  resolveClashBrowserExecutable,
  resolveClashBrowserGlOverride,
  type ClashBrowserCacheRejection,
  type ClashBrowserDownloadRequest,
} from "./render-browser.js";

const roots: string[] = [];
function temporaryDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clash-browser-")));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// Stand-in for Remotion's pin: the module only ever forwards it, so any version string works.
const remotion = {
  testedVersion: "1.2.3.4",
  cacheVersion: "1.2.3.4-remotion-v3",
  rendererEntry: "/unused.js",
};
const VERSION_FILE = join(
  "node_modules",
  ".remotion",
  "chrome-headless-shell",
  "VERSION",
);

/** What Remotion leaves behind after a download into `cacheDir`. */
function installFakeBrowser(cacheDir: string, version: string): string {
  const executablePath = join(
    cacheDir,
    "node_modules",
    ".remotion",
    "chrome-headless-shell",
    "fake-platform",
    "chrome-headless-shell",
  );
  mkdirSync(dirname(executablePath), { recursive: true });
  writeFileSync(executablePath, "");
  writeFileSync(join(cacheDir, VERSION_FILE), version);
  return executablePath;
}

describe("browser cache location", () => {
  it("defaults to the Clash home and honours CLASH_BROWSER_CACHE_DIR", () => {
    expect(resolveClashBrowserCacheRoot({ CLASH_HOME: "/tmp/clash-home" })).toBe(
      resolve("/tmp/clash-home", "cache", "browser"),
    );
    expect(
      resolveClashBrowserCacheRoot({
        CLASH_HOME: "/tmp/clash-home",
        CLASH_BROWSER_CACHE_DIR: "/tmp/elsewhere",
      }),
    ).toBe(resolve("/tmp/elsewhere"));
  });

  it("keys the cache directory by Remotion's pinned version", () => {
    const env = { CLASH_BROWSER_CACHE_DIR: "/tmp/browser-cache" };
    const first = resolveClashBrowserCacheDir({ env, remotion });
    const upgraded = resolveClashBrowserCacheDir({
      env,
      remotion: { ...remotion, testedVersion: "5.6.7.8" },
    });
    expect(dirname(first)).toBe(resolve("/tmp/browser-cache"));
    expect(first).toContain(remotion.testedVersion);
    expect(upgraded).not.toBe(first);
  });

  it("hands a scrubbed renderer process the resolved cache root and any override", () => {
    expect(clashBrowserEnvironment({ CLASH_HOME: "/tmp/clash-home" })).toEqual({
      CLASH_BROWSER_CACHE_DIR: resolve("/tmp/clash-home", "cache", "browser"),
    });
    expect(
      clashBrowserEnvironment({
        CLASH_HOME: "/tmp/clash-home",
        CLASH_BROWSER_EXECUTABLE: "/opt/chrome",
      }).CLASH_BROWSER_EXECUTABLE,
    ).toBe(resolve("/opt/chrome"));
  });
});

describe("warm-up switch", () => {
  it("is on by default and off for explicit negatives", () => {
    expect(clashBrowserWarmupEnabled({})).toBe(true);
    expect(clashBrowserWarmupEnabled({ CLASH_BROWSER_WARMUP: "1" })).toBe(true);
    expect(clashBrowserWarmupEnabled({ CLASH_BROWSER_WARMUP: "0" })).toBe(false);
    expect(clashBrowserWarmupEnabled({ CLASH_BROWSER_WARMUP: "false" })).toBe(
      false,
    );
  });
});

describe("resolveClashBrowserGlOverride", () => {
  // Stand-in for Remotion's list: the helper only compares against what it is handed.
  const backends = ["first-backend", "second-backend"] as const;

  it("is absent, and does not load Remotion, while CLASH_BROWSER_GL is unset or blank", async () => {
    const load = vi.fn(() => backends);
    await expect(resolveClashBrowserGlOverride(load, {})).resolves.toBeUndefined();
    await expect(
      resolveClashBrowserGlOverride(load, { CLASH_BROWSER_GL: "  " }),
    ).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it("returns a backend Remotion accepts", async () => {
    await expect(
      resolveClashBrowserGlOverride(async () => backends, {
        CLASH_BROWSER_GL: " second-backend ",
      }),
    ).resolves.toBe("second-backend");
  });

  it("rejects any other value, naming the variable and the accepted values", async () => {
    const failure = await resolveClashBrowserGlOverride(() => backends, {
      CLASH_BROWSER_GL: "Second-Backend",
    }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("CLASH_BROWSER_GL");
    expect(message).toContain("Second-Backend");
    for (const backend of backends) expect(message).toContain(backend);
  });
});

describe("resolveClashBrowserExecutable", () => {
  it("returns nothing for an empty cache or a browser of another version", () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    expect(resolveClashBrowserExecutable({ env, remotion })).toBeUndefined();
  });

  it("passes CLASH_BROWSER_EXECUTABLE straight through without touching the cache", () => {
    const pin = vi.fn(() => remotion);
    expect(
      resolveClashBrowserExecutable({
        env: { CLASH_BROWSER_EXECUTABLE: "/opt/chrome" },
        remotion: pin,
      }),
    ).toEqual({
      executablePath: resolve("/opt/chrome"),
      version: null,
      cacheDir: null,
      source: "override",
    });
    expect(pin).not.toHaveBeenCalled();
  });
});

describe("ensureClashBrowser", () => {
  it("downloads into the versioned cache directory once and then resolves from disk", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const requests: ClashBrowserDownloadRequest[] = [];
    const download = vi.fn(async (request: ClashBrowserDownloadRequest) => {
      requests.push(request);
      // Remotion locates its download below the nearest package.json of the child's cwd.
      expect(existsSync(join(request.cacheDir, "package.json"))).toBe(true);
      return {
        executablePath: installFakeBrowser(
          request.cacheDir,
          remotion.cacheVersion,
        ),
      };
    });

    const browser = await ensureClashBrowser({ env, remotion, download });
    const cacheDir = resolveClashBrowserCacheDir({ env, remotion });
    expect(requests[0]).toMatchObject({
      cacheDir,
      rendererEntry: remotion.rendererEntry,
    });
    expect(browser).toMatchObject({
      version: remotion.testedVersion,
      cacheDir,
      source: "cache",
    });
    expect(browser.executablePath.startsWith(cacheDir)).toBe(true);
    expect(resolveClashBrowserExecutable({ env, remotion })).toEqual(browser);

    await expect(ensureClashBrowser({ env, remotion, download })).resolves.toEqual(
      browser,
    );
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("does not trust a cached browser whose VERSION differs from Remotion's pin", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const download = async (request: ClashBrowserDownloadRequest) => ({
      executablePath: installFakeBrowser(
        request.cacheDir,
        remotion.cacheVersion,
      ),
    });
    const browser = await ensureClashBrowser({ env, remotion, download });
    writeFileSync(join(browser.cacheDir!, VERSION_FILE), "0.0.0.1");
    expect(resolveClashBrowserExecutable({ env, remotion })).toBeUndefined();

    // A Remotion upgrade changes the pin: the old directory is simply not consulted.
    expect(
      resolveClashBrowserExecutable({
        env,
        remotion: { ...remotion, testedVersion: "5.6.7.8" },
      }),
    ).toBeUndefined();
  });

  it("accepts the real cache layout with a VERSION written by the installed Remotion", () => {
    const requireFromHere = createRequire(import.meta.url);
    // The package's exports map hides dist/ subpaths, so resolve the internal file by path.
    const fetcher = requireFromHere(
      join(
        dirname(requireFromHere.resolve("@remotion/renderer/package.json")),
        "dist/browser/BrowserFetcher.js",
      ),
    ) as {
      getExpectedVersion(options: {
        version: null;
        chromeMode: "headless-shell";
        platform: string;
      }): string;
      getPlatform(): string;
    };
    // The exact value BrowserFetcher writes into <cache>/node_modules/.remotion/.../VERSION.
    const recordedVersion = fetcher.getExpectedVersion({
      version: null,
      chromeMode: "headless-shell",
      platform: fetcher.getPlatform(),
    });
    expect(readRemotionBrowserPin().cacheVersion).toBe(recordedVersion);
    expect(recordedVersion).not.toBe(readRemotionBrowserPin().testedVersion);

    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const cacheDir = resolveClashBrowserCacheDir({ env });
    const executable = join(
      cacheDir,
      "node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell",
    );
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, "");
    writeFileSync(join(cacheDir, VERSION_FILE), recordedVersion);
    writeFileSync(
      join(cacheDir, "browser.json"),
      JSON.stringify({ executable: relative(cacheDir, executable) }),
    );

    expect(resolveClashBrowserExecutable({ env })).toMatchObject({
      executablePath: executable,
      cacheDir,
      source: "cache",
    });
  });

  it("reports one coded reason and replaces a cache VERSION Remotion did not write", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const download = vi.fn(async (request: ClashBrowserDownloadRequest) => ({
      executablePath: installFakeBrowser(
        request.cacheDir,
        remotion.cacheVersion,
      ),
    }));
    const browser = await ensureClashBrowser({ env, remotion, download });
    writeFileSync(join(browser.cacheDir!, VERSION_FILE), "0.0.0.1");
    const rejections: ClashBrowserCacheRejection[] = [];

    const repaired = await ensureClashBrowser({
      env,
      remotion,
      download,
      onCacheRejected: (rejection) => rejections.push(rejection),
    });

    expect(rejections).toEqual([
      expect.objectContaining({
        code: "RENDER_BROWSER_CACHE_VERSION_MISMATCH",
        expectedVersion: remotion.cacheVersion,
        actualVersion: "0.0.0.1",
      }),
    ]);
    expect(download).toHaveBeenCalledTimes(2);
    expect(repaired.executablePath).toBe(browser.executablePath);
  });

  it("forgets a cached browser whose executable was deleted", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const download = async (request: ClashBrowserDownloadRequest) => ({
      executablePath: installFakeBrowser(
        request.cacheDir,
        remotion.cacheVersion,
      ),
    });
    const browser = await ensureClashBrowser({ env, remotion, download });
    rmSync(browser.executablePath);
    expect(resolveClashBrowserExecutable({ env, remotion })).toBeUndefined();
  });

  it("shares one download between concurrent callers", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const download = vi.fn(async (request: ClashBrowserDownloadRequest) => {
      await new Promise((done) => setTimeout(done, 20));
      return {
        executablePath: installFakeBrowser(
          request.cacheDir,
          remotion.cacheVersion,
        ),
      };
    });
    const [first, second] = await Promise.all([
      ensureClashBrowser({ env, remotion, download }),
      ensureClashBrowser({ env, remotion, download }),
    ]);
    expect(second).toEqual(first);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("rejects a download that landed outside the cache and retries after a failure", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const outside = join(temporaryDirectory(), "chrome");
    writeFileSync(outside, "");
    await expect(
      ensureClashBrowser({
        env,
        remotion,
        download: async () => ({ executablePath: outside }),
      }),
    ).rejects.toThrow(/outside the Clash browser cache/);
    await expect(
      ensureClashBrowser({
        env,
        remotion,
        download: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(resolveClashBrowserExecutable({ env, remotion })).toBeUndefined();
  });

  it("accepts a download reported by real path when the cache is reached through a symlink", async () => {
    // CLASH_HOME on another volume: Remotion's child reports process.cwd(), which is physical.
    const physicalRoot = temporaryDirectory();
    const linkedRoot = join(temporaryDirectory(), "browser-cache");
    symlinkSync(physicalRoot, linkedRoot, "dir");
    const env = { CLASH_BROWSER_CACHE_DIR: linkedRoot };
    let reported = "";
    const download = vi.fn(async (request: ClashBrowserDownloadRequest) => {
      reported = installFakeBrowser(
        realpathSync(request.cacheDir),
        remotion.cacheVersion,
      );
      return { executablePath: reported };
    });

    const browser = await ensureClashBrowser({ env, remotion, download });
    expect(reported.startsWith(physicalRoot)).toBe(true);
    expect(browser.cacheDir).toBe(resolveClashBrowserCacheDir({ env, remotion }));
    expect(realpathSync(browser.executablePath)).toBe(reported);
    await expect(ensureClashBrowser({ env, remotion, download })).resolves.toEqual(
      browser,
    );
    expect(download).toHaveBeenCalledTimes(1);
  });

  it("still rejects a download outside a symlinked cache, existing or not", async () => {
    const linkedRoot = join(temporaryDirectory(), "browser-cache");
    symlinkSync(temporaryDirectory(), linkedRoot, "dir");
    const env = { CLASH_BROWSER_CACHE_DIR: linkedRoot };
    const outside = join(temporaryDirectory(), "chrome");
    for (const exists of [false, true]) {
      if (exists) writeFileSync(outside, "");
      await expect(
        ensureClashBrowser({
          env,
          remotion,
          download: async () => ({ executablePath: outside }),
        }),
      ).rejects.toThrow(/outside the Clash browser cache/);
    }
    // A link inside the cache that leads out of it is outside too.
    const cacheDir = resolveClashBrowserCacheDir({ env, remotion });
    const escaping = join(cacheDir, "chrome");
    symlinkSync(outside, escaping);
    await expect(
      ensureClashBrowser({
        env,
        remotion,
        download: async () => ({ executablePath: escaping }),
      }),
    ).rejects.toThrow(/outside the Clash browser cache/);
    expect(resolveClashBrowserExecutable({ env, remotion })).toBeUndefined();
  });

  it("validates CLASH_BROWSER_EXECUTABLE instead of downloading", async () => {
    const download = vi.fn();
    const executable = join(temporaryDirectory(), "chrome");
    await expect(
      ensureClashBrowser({
        env: { CLASH_BROWSER_EXECUTABLE: executable },
        remotion,
        download,
      }),
    ).rejects.toThrow(/CLASH_BROWSER_EXECUTABLE/);
    writeFileSync(executable, "");
    await expect(
      ensureClashBrowser({
        env: { CLASH_BROWSER_EXECUTABLE: executable },
        remotion,
        download,
      }),
    ).resolves.toMatchObject({ executablePath: executable, source: "override" });
    expect(download).not.toHaveBeenCalled();
  });
});

describe("default child-process download", () => {
  /**
   * A renderer entry that behaves like Remotion's: it derives the destination from process.cwd()
   * alone. Running the real spawn against it proves the cwd contract without any network.
   */
  function fakeRenderer(body: string): string {
    const entry = join(temporaryDirectory(), "renderer.cjs");
    writeFileSync(entry, body);
    return entry;
  }

  it("runs ensureBrowser() with cwd set to the cache directory and reports progress", async () => {
    const rendererEntry = fakeRenderer(`
      const fs = require("node:fs");
      const path = require("node:path");
      exports.ensureBrowser = async (options) => {
        const root = path.join(process.cwd(), "node_modules", ".remotion", "chrome-headless-shell");
        const executable = path.join(root, "fake-platform", "chrome-headless-shell");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        const { onProgress, version } = options.onBrowserDownload({ chromeMode: options.chromeMode });
        onProgress({ percent: 1, downloadedBytes: 10, totalSizeInBytes: 10, alreadyAvailable: false });
        fs.writeFileSync(executable, JSON.stringify({ chromeMode: options.chromeMode, version }));
        fs.writeFileSync(path.join(root, "VERSION"), ${JSON.stringify(remotion.cacheVersion)});
        return { type: "local-puppeteer-browser", path: executable };
      };
    `);
    const env = {
      ...process.env,
      CLASH_BROWSER_CACHE_DIR: temporaryDirectory(),
    };
    const onProgress = vi.fn();
    const browser = await ensureClashBrowser({
      env,
      remotion: { ...remotion, rendererEntry },
      onProgress,
    });

    expect(browser.executablePath.startsWith(browser.cacheDir!)).toBe(true);
    // The headless shell at Remotion's own version (null = "use TESTED_VERSION"), never ours.
    expect(JSON.parse(readFileSync(browser.executablePath, "utf8"))).toEqual({
      chromeMode: "headless-shell",
      version: null,
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ percent: 1, totalSizeInBytes: 10 }),
    );
  });

  it("installs through a symlinked CLASH_HOME, where the child's cwd is the real path", async () => {
    const rendererEntry = fakeRenderer(`
      const fs = require("node:fs");
      const path = require("node:path");
      exports.ensureBrowser = async () => {
        const root = path.join(process.cwd(), "node_modules", ".remotion", "chrome-headless-shell");
        const executable = path.join(root, "fake-platform", "chrome-headless-shell");
        fs.mkdirSync(path.dirname(executable), { recursive: true });
        fs.writeFileSync(executable, "");
        fs.writeFileSync(path.join(root, "VERSION"), ${JSON.stringify(remotion.cacheVersion)});
        return { type: "local-puppeteer-browser", path: executable };
      };
    `);
    const physicalHome = temporaryDirectory();
    const linkedHome = join(temporaryDirectory(), "clash-home");
    symlinkSync(physicalHome, linkedHome, "dir");

    const browser = await ensureClashBrowser({
      env: { ...process.env, CLASH_BROWSER_CACHE_DIR: "", CLASH_HOME: linkedHome },
      remotion: { ...remotion, rendererEntry },
    });

    expect(browser.executablePath.startsWith(linkedHome)).toBe(true);
    expect(realpathSync(browser.executablePath).startsWith(physicalHome)).toBe(
      true,
    );
  });

  it("surfaces the child's failure output", async () => {
    const rendererEntry = fakeRenderer(`
      exports.ensureBrowser = async () => { throw new Error("getaddrinfo ENOTFOUND example.invalid"); };
    `);
    await expect(
      ensureClashBrowser({
        env: { ...process.env, CLASH_BROWSER_CACHE_DIR: temporaryDirectory() },
        remotion: { ...remotion, rendererEntry },
      }),
    ).rejects.toThrow(/ENOTFOUND example\.invalid/);
  });
});

describe("findMissingBrowserLibraries", () => {
  it("lists every library ldd cannot resolve", async () => {
    const ldd = async () =>
      [
        "\tlinux-vdso.so.1 (0x00007ffd)",
        "\tlibnss3.so => not found",
        "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)",
        "\tlibgbm.so.1 => not found",
      ].join("\n");
    expect(
      await findMissingBrowserLibraries("/chrome", { platform: "linux", ldd }),
    ).toEqual(["libnss3.so", "libgbm.so.1"]);
  });

  it("reports nothing off Linux or when ldd is unavailable", async () => {
    const ldd = vi.fn(async () => "\tlibnss3.so => not found");
    expect(
      await findMissingBrowserLibraries("/chrome", { platform: "darwin", ldd }),
    ).toEqual([]);
    expect(ldd).not.toHaveBeenCalled();
    expect(
      await findMissingBrowserLibraries("/chrome", {
        platform: "linux",
        ldd: async () => {
          throw new Error("spawn ldd ENOENT");
        },
      }),
    ).toEqual([]);
  });
});
