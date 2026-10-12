import { expect, it, vi } from "vitest";
import type { ClashBrowser } from "@clash/shared-runtime/render-browser";
import { createCliProgram } from "../program";
import {
  runBrowserEnsure,
  runBrowserStatus,
  type BrowserCommandDependencies,
} from "./browser";

const cached: ClashBrowser = {
  executablePath: "/home/clash/cache/browser/headless-shell-1.2.3.4/chrome-headless-shell",
  version: "1.2.3.4",
  cacheDir: "/home/clash/cache/browser/headless-shell-1.2.3.4",
  source: "cache",
};

function dependencies(
  overrides: Partial<BrowserCommandDependencies> = {},
): BrowserCommandDependencies {
  return {
    pinnedVersion: () => "1.2.3.4",
    cacheDir: () => cached.cacheDir!,
    resolve: () => undefined,
    ensure: async () => cached,
    findMissingLibraries: async () => [],
    ...overrides,
  };
}

it("browser ensure prints the path, version and cache directory", async () => {
  const lines: string[] = [];
  const output = await runBrowserEnsure({
    stdout: (line) => lines.push(line),
    dependencies: dependencies(),
  });

  expect(output).toEqual({
    status: "ready",
    source: "cache",
    executablePath: cached.executablePath,
    version: "1.2.3.4",
    cacheDir: cached.cacheDir,
    missingLibraries: [],
  });
  expect(lines).toEqual([
    "Browser: ready",
    `Path: ${cached.executablePath}`,
    "Version: 1.2.3.4",
    `Cache: ${cached.cacheDir}`,
  ]);
});

it("browser ensure --json emits the same object and keeps progress off stdout", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const output = await runBrowserEnsure({
    json: true,
    stdout: (line) => lines.push(line),
    stderr: (line) => errors.push(line),
    dependencies: dependencies({
      ensure: async ({ onProgress }) => {
        onProgress?.({ percent: 0.5, downloadedBytes: 5, totalSizeInBytes: 10 });
        return cached;
      },
    }),
  });

  expect(JSON.parse(lines.join("\n"))).toEqual(output);
  expect(errors).toEqual([]);
});

it("browser ensure reports download progress on stderr once per step", async () => {
  const errors: string[] = [];
  await runBrowserEnsure({
    stdout: () => {},
    stderr: (line) => errors.push(line),
    dependencies: dependencies({
      ensure: async ({ onProgress }) => {
        for (const percent of [0.5, 0.51, 1]) {
          onProgress?.({ percent, downloadedBytes: 0, totalSizeInBytes: 10 });
        }
        return cached;
      },
    }),
  });

  expect(errors).toEqual([
    "Downloading Chrome Headless Shell: 50%",
    "Downloading Chrome Headless Shell: 100%",
  ]);
});

it("browser ensure fails with the cause, the overrides and the Linux library hint", async () => {
  const failure = runBrowserEnsure({
    stdout: () => {},
    dependencies: dependencies({
      ensure: async () => {
        throw new Error("getaddrinfo ENOTFOUND storage.googleapis.com");
      },
    }),
  });

  await expect(failure).rejects.toThrow(/ENOTFOUND storage\.googleapis\.com/);
  await expect(failure).rejects.toThrow(/CLASH_BROWSER_EXECUTABLE/);
  await expect(failure).rejects.toThrow(/CLASH_BROWSER_CACHE_DIR/);
  await expect(failure).rejects.toThrow(/linux-dependencies/);
  await expect(failure).rejects.toThrow(cached.cacheDir!);
});

it("browser ensure fails when the downloaded browser cannot load its libraries", async () => {
  const errors: string[] = [];
  await expect(
    runBrowserEnsure({
      stdout: () => {},
      stderr: (line) => errors.push(line),
      dependencies: dependencies({
        findMissingLibraries: async () => ["libnss3.so", "libgbm.so.1"],
      }),
    }),
  ).rejects.toThrow(/cannot start until those libraries are installed/);
  expect(errors.join("\n")).toMatch(/libnss3\.so, libgbm\.so\.1/);
  expect(errors.join("\n")).toMatch(/linux-dependencies/);
});

it("browser status reports a missing browser without downloading", async () => {
  const ensure = vi.fn();
  const lines: string[] = [];
  const output = await runBrowserStatus({
    json: true,
    stdout: (line) => lines.push(line),
    dependencies: dependencies({ ensure }),
  });

  expect(output).toEqual({
    status: "missing",
    version: "1.2.3.4",
    cacheDir: cached.cacheDir,
    missingLibraries: [],
  });
  expect(JSON.parse(lines.join("\n"))).toEqual(output);
  expect(ensure).not.toHaveBeenCalled();
});

it("browser status names CLASH_BROWSER_EXECUTABLE as the source of an override", async () => {
  const lines: string[] = [];
  await runBrowserStatus({
    stdout: (line) => lines.push(line),
    dependencies: dependencies({
      resolve: () => ({
        executablePath: "/usr/bin/chromium",
        version: null,
        cacheDir: null,
        source: "override",
      }),
    }),
  });

  expect(lines).toEqual([
    "Browser: ready",
    "Path: /usr/bin/chromium",
    "Source: CLASH_BROWSER_EXECUTABLE",
  ]);
});

it("browser commands run without invoking the Host bootstrap hook", async () => {
  const beforeAction = vi.fn(() => {
    throw new Error("Host is unavailable");
  });
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("CLASH_BROWSER_EXECUTABLE", process.execPath);
  try {
    const program = createCliProgram({ beforeAction });
    await program.parseAsync(["node", "clash", "browser", "status", "--json"]);
    expect(beforeAction).not.toHaveBeenCalled();
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({
      status: "ready",
      source: "override",
      executablePath: process.execPath,
    });
  } finally {
    output.mockRestore();
    vi.unstubAllEnvs();
  }
});

it("browser ensure fails and names the libraries when the downloaded browser cannot start", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  await expect(
    runBrowserEnsure({
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
      dependencies: dependencies({
        findMissingLibraries: async () => ["libnss3.so", "libexpat.so.1"],
      }),
    }),
  ).rejects.toThrow(/cannot start until those libraries are installed/);

  expect(lines[0]).toBe("Browser: downloaded, but missing system libraries");
  expect(errors[0]).toBe(
    `Missing shared libraries for ${cached.executablePath}: libnss3.so, libexpat.so.1`,
  );
});
