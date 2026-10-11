import { Command } from "commander";
import {
  clashBrowserPinnedVersion,
  ensureClashBrowser,
  findMissingBrowserLibraries,
  resolveClashBrowserCacheDir,
  resolveClashBrowserExecutable,
  type ClashBrowser,
  type EnsureClashBrowserOptions,
} from "@clash/shared-runtime/render-browser";

const LINUX_LIBRARIES_HINT =
  "On Linux, Chrome Headless Shell needs system libraries that minimal images omit: " +
  "https://www.remotion.dev/docs/miscellaneous/linux-dependencies";

export interface BrowserStatusOutput {
  status: "ready" | "missing";
  /** `cache`: the headless shell Remotion pins; `override`: CLASH_BROWSER_EXECUTABLE. */
  source?: ClashBrowser["source"];
  executablePath?: string;
  /** Chrome version pinned by the installed Remotion; not inspected for an override. */
  version: string;
  cacheDir: string;
  /** Shared libraries the loader cannot find for the executable (Linux only). */
  missingLibraries: string[];
}

export type BrowserCommandDependencies = {
  pinnedVersion: () => string;
  cacheDir: () => string;
  resolve: () => ClashBrowser | undefined;
  ensure: (
    options: Pick<EnsureClashBrowserOptions, "onProgress">,
  ) => Promise<ClashBrowser>;
  findMissingLibraries: (executablePath: string) => Promise<string[]>;
};

const defaultDependencies: BrowserCommandDependencies = {
  pinnedVersion: () => clashBrowserPinnedVersion(),
  cacheDir: () => resolveClashBrowserCacheDir(),
  resolve: () => resolveClashBrowserExecutable(),
  ensure: (options) => ensureClashBrowser(options),
  findMissingLibraries: (executablePath) =>
    findMissingBrowserLibraries(executablePath),
};

type BrowserCommandOptions = {
  json?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  dependencies?: Partial<BrowserCommandDependencies>;
};

async function describeBrowser(
  browser: ClashBrowser | undefined,
  dependencies: BrowserCommandDependencies,
): Promise<BrowserStatusOutput> {
  const base = {
    version: dependencies.pinnedVersion(),
    cacheDir: dependencies.cacheDir(),
  };
  if (!browser) return { status: "missing", ...base, missingLibraries: [] };
  return {
    status: "ready",
    source: browser.source,
    executablePath: browser.executablePath,
    ...base,
    missingLibraries: await dependencies.findMissingLibraries(
      browser.executablePath,
    ),
  };
}

function printBrowser(
  output: BrowserStatusOutput,
  options: BrowserCommandOptions,
): void {
  const stdout = options.stdout ?? console.log;
  if (options.json) {
    stdout(JSON.stringify(output, null, 2));
    return;
  }
  if (output.status === "missing") {
    stdout("Browser: missing");
    stdout(`Version: ${output.version}`);
    stdout(`Cache: ${output.cacheDir}`);
    stdout("Run `clash browser ensure` to download it.");
    return;
  }
  stdout(
    output.missingLibraries.length > 0
      ? "Browser: downloaded, but missing system libraries"
      : "Browser: ready",
  );
  stdout(`Path: ${output.executablePath}`);
  if (output.source === "override") {
    stdout("Source: CLASH_BROWSER_EXECUTABLE");
  } else {
    stdout(`Version: ${output.version}`);
    stdout(`Cache: ${output.cacheDir}`);
  }
}

function reportMissingLibraries(
  output: BrowserStatusOutput,
  options: BrowserCommandOptions,
): void {
  if (output.missingLibraries.length === 0) return;
  const stderr = options.stderr ?? console.error;
  stderr(
    `Missing shared libraries for ${output.executablePath}: ${output.missingLibraries.join(", ")}`,
  );
  stderr(LINUX_LIBRARIES_HINT);
}

export async function runBrowserStatus(
  options: BrowserCommandOptions = {},
): Promise<BrowserStatusOutput> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const output = await describeBrowser(dependencies.resolve(), dependencies);
  printBrowser(output, options);
  reportMissingLibraries(output, options);
  return output;
}

/** Downloads the Remotion-pinned Chrome Headless Shell if needed; throws when renders cannot use it. */
export async function runBrowserEnsure(
  options: BrowserCommandOptions = {},
): Promise<BrowserStatusOutput> {
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const stderr = options.stderr ?? console.error;
  let reported = -1;
  let browser: ClashBrowser;
  try {
    browser = await dependencies.ensure({
      onProgress: ({ percent }) => {
        const step = Math.floor(percent * 10);
        if (options.json || step <= reported) return;
        reported = step;
        stderr(`Downloading Chrome Headless Shell: ${step * 10}%`);
      },
    });
  } catch (error) {
    throw new Error(
      [
        `Could not prepare Chrome Headless Shell ${dependencies.pinnedVersion()} in ${dependencies.cacheDir()}.`,
        error instanceof Error ? error.message : String(error),
        "The download needs network access and a writable cache; set CLASH_BROWSER_CACHE_DIR to move it, " +
          "or CLASH_BROWSER_EXECUTABLE to render with a Chrome that is already installed.",
        LINUX_LIBRARIES_HINT,
      ].join("\n"),
    );
  }
  const output = await describeBrowser(browser, dependencies);
  printBrowser(output, options);
  if (output.missingLibraries.length > 0) {
    reportMissingLibraries(output, options);
    throw new Error(
      "Chrome Headless Shell is downloaded but cannot start until those libraries are installed.",
    );
  }
  return output;
}

export const browserCommand = new Command("browser")
  .description("Prepare the Chrome Headless Shell used for rendering")
  .addHelpText(
    "after",
    `
Renders download this browser on demand and the Host warms it in the background;
run ensure ahead of time for offline use or while building a container image.

Environment variables:
  CLASH_BROWSER_CACHE_DIR    Download location (default: $CLASH_HOME/cache/browser)
  CLASH_BROWSER_EXECUTABLE   Render with this Chrome instead; nothing is downloaded
  CLASH_BROWSER_WARMUP=0     Stop the Host from downloading it in the background`,
  );

browserCommand
  .command("ensure")
  .description("Download the pinned Chrome Headless Shell if it is missing")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await runBrowserEnsure({ json: options.json });
  });

browserCommand
  .command("status")
  .description("Show whether the render browser is available, without downloading")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await runBrowserStatus({ json: options.json });
  });
