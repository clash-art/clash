/**
 * OS paths for local host state and per-project cwd.
 *
 * Single convention across platforms: `~/.clash/` is the user-level root,
 * matching every other modern AI tool (`~/.claude`, `~/.codex`, `~/.gemini`,
 * `~/.cursor`). XDG and Library/Application-Support paths were noisier and
 * inconsistent; the one downside (slightly less Linux-purist) is acceptable.
 *
 */

import { execFile } from "node:child_process";
import { homedir, hostname as osHostname, platform } from "node:os";
import { join, resolve } from "node:path";

export interface Paths {
  /** `~/.clash` — root of all local host state on every platform. */
  configDir: string;
  /** Local project roots. ACP agents run here; sessions do not own cwd. */
  projectsDir: string;
}

export function paths(): Paths {
  const home = homedir();
  const clashHome = process.env.CLASH_HOME?.trim();
  const configDir = clashHome ? resolve(clashHome) : join(home, ".clash");
  const projectsDir = join(configDir, "projects");
  return { configDir, projectsDir };
}

/** "darwin/arm64" — advertised as the local runtime's operating-system tag. */
export function osTag(): string {
  return `${platform()}/${process.arch}`;
}

/**
 * The pretty machine name last reported by the OS, or the hostname until the asynchronous
 * probe settles. Never spawns a process: a synchronous `execSync` here used to block the event
 * loop for every `/api/v1/runtimes` request.
 */
let prettyMachineName: string | undefined;

function fallbackMachineName(): string {
  const currentPlatform = platform();
  const hostname = osHostname();
  if (hostname && hostname.toLowerCase() !== "localhost") return hostname;
  const user = process.env.USER || process.env.USERNAME || "user";
  return `${user}'s ${currentPlatform === "darwin" ? "Mac" : currentPlatform === "linux" ? "Linux box" : "computer"}`;
}

/** The synchronous name used on request paths. */
export function machineName(): string {
  return prettyMachineName ?? fallbackMachineName();
}

export type MachineNameProbeResult =
  | { ok: true; name: string }
  | { ok: false; code: "HOST_MACHINE_NAME_UNAVAILABLE"; error: string };

const MACHINE_NAME_PROBE_TIMEOUT_MS = 1000;

/**
 * Ask the platform for its user-facing name off the request path. The caller decides how to
 * report a failure; the Host logs it once at startup and keeps `os.hostname()`.
 */
export function probePrettyMachineName(options: {
  platform?: NodeJS.Platform;
  execFile?: typeof execFile;
} = {}): Promise<MachineNameProbeResult> {
  const currentPlatform = options.platform ?? platform();
  const command = currentPlatform === "darwin"
    ? { file: "scutil", args: ["--get", "ComputerName"] }
    : currentPlatform === "linux"
      ? { file: "hostnamectl", args: ["--pretty"] }
      : null;
  if (!command) {
    return Promise.resolve({ ok: true, name: machineName() });
  }
  const run = options.execFile ?? execFile;
  return new Promise((resolve) => {
    run(
      command.file,
      command.args,
      { encoding: "utf8", timeout: MACHINE_NAME_PROBE_TIMEOUT_MS },
      (error: Error | null, stdout: string) => {
        if (error || typeof stdout !== "string") {
          resolve({
            ok: false,
            code: "HOST_MACHINE_NAME_UNAVAILABLE",
            error: `${command.file}: ${error?.message ?? "no output"}`,
          });
          return;
        }
        const name = stdout.trim();
        if (!name || name.toLowerCase() === "localhost") {
          resolve({
            ok: false,
            code: "HOST_MACHINE_NAME_UNAVAILABLE",
            error: `${command.file}: empty or localhost name`,
          });
          return;
        }
        resolve({ ok: true, name });
      },
    );
  });
}

let machineNameProbe: Promise<MachineNameProbeResult> | undefined;

/**
 * Start the pretty-name probe once per process and cache its result. Resolves without throwing,
 * so an unavailable platform tool never rejects an unawaited startup promise.
 */
export function primeMachineName(): Promise<MachineNameProbeResult> {
  machineNameProbe ??= probePrettyMachineName().then((result) => {
    if (result.ok) prettyMachineName = result.name;
    return result;
  });
  return machineNameProbe;
}
