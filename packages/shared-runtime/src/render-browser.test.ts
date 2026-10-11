import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clashBrowserEnvironment,
  clashBrowserWarmupEnabled,
  ensureClashBrowser,
  findMissingBrowserLibraries,
  resolveClashBrowserCacheDir,
  resolveClashBrowserCacheRoot,
  resolveClashBrowserExecutable,
  resolveClashBrowserGl,
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
const remotion = { testedVersion: "1.2.3.4", rendererEntry: "/unused.js" };
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

describe("resolveClashBrowserGl", () => {
  const withGpu = () => true;
  const withoutGpu = () => false;

  it("renders in software only on Linux without a GPU", () => {
    const env = {};
    expect(
      resolveClashBrowserGl({ env, platform: "linux", hasGpu: withoutGpu }),
    ).toBe("swangle");
    expect(
      resolveClashBrowserGl({ env, platform: "linux", hasGpu: withGpu }),
    ).toBe("angle");
    // Off Linux the GPU is not probed: /dev/dri says nothing about macOS or Windows.
    const hasGpu = vi.fn(withoutGpu);
    expect(resolveClashBrowserGl({ env, platform: "darwin", hasGpu })).toBe(
      "angle",
    );
    expect(resolveClashBrowserGl({ env, platform: "win32", hasGpu })).toBe(
      "angle",
    );
    expect(hasGpu).not.toHaveBeenCalled();
  });

  it("passes CLASH_BROWSER_GL through on every platform", () => {
    const hasGpu = vi.fn(withoutGpu);
    for (const platform of ["linux", "darwin"] as const) {
      expect(
        resolveClashBrowserGl({
          env: { CLASH_BROWSER_GL: " angle-egl " },
          platform,
          hasGpu,
        }),
      ).toBe("angle-egl");
    }
    expect(hasGpu).not.toHaveBeenCalled();
    expect(
      resolveClashBrowserGl({
        env: { CLASH_BROWSER_GL: "  " },
        platform: "linux",
        hasGpu,
      }),
    ).toBe("swangle");
  });

  it("agrees with this machine's DRM render nodes by default", () => {
    let renderNode = false;
    try {
      renderNode = readdirSync("/dev/dri").some((name) =>
        name.startsWith("renderD"),
      );
    } catch {
      // No /dev/dri: no GPU.
    }
    expect(resolveClashBrowserGl({ env: {}, platform: "linux" })).toBe(
      renderNode ? "angle" : "swangle",
    );
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
          remotion.testedVersion,
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
        remotion.testedVersion,
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

  it("forgets a cached browser whose executable was deleted", async () => {
    const env = { CLASH_BROWSER_CACHE_DIR: temporaryDirectory() };
    const download = async (request: ClashBrowserDownloadRequest) => ({
      executablePath: installFakeBrowser(
        request.cacheDir,
        remotion.testedVersion,
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
          remotion.testedVersion,
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
        remotion.testedVersion,
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
        fs.writeFileSync(path.join(root, "VERSION"), ${JSON.stringify(remotion.testedVersion)});
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
        fs.writeFileSync(path.join(root, "VERSION"), ${JSON.stringify(remotion.testedVersion)});
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
