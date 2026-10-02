/**
 * Catalog of ACP agents Clash can present in local settings.
 *
 * The user-facing concept is just "agent". Clash-managed installs come from
 * the public ACP registry; non-registry agents are detected from local commands.
 */

import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { AgentSpec } from "@openma/common/acp-runtime";

export interface KnownAgentConfigSelectValue {
  value: string;
  name: string;
  description?: string | null;
}

export interface KnownAgentConfigOption {
  id: string;
  name: string;
  type: "select" | "boolean" | "string";
  category?: string | null;
  description?: string | null;
  currentValue?: string;
  options?: KnownAgentConfigSelectValue[];
}

export interface KnownAgentEntry {
  /** Canonical id used by hosts and dropdowns. Slug-only, no spaces. */
  id: string;
  /** Human-readable name for UI. */
  label: string;
  /** Spec used when this agent is selected. */
  spec: AgentSpec;
  /** User-defined custom ACP agent server. */
  custom?: boolean;
  /** Native ACP CLI supplied by the user's system PATH. */
  systemPath?: boolean;
  /** Known macOS app bundle names that may carry the native ACP executable. */
  macAppBundleNames?: string[];
  /** Executable names to try inside a known macOS app bundle. */
  macAppExecutableNames?: string[];
  /** Public ACP registry id. Used for app-managed installs. */
  registryId?: string;
  /** Latest version observed from the public ACP registry. */
  registryVersion?: string;
  /** Underlying npm package for an npx-distributed ACP runtime. */
  registryNpmPackage?: string;
  /** Install source for entries Clash can install into its managed bin dir. */
  installSource?: "registry" | "adapter";
  /** Clash-hosted executable URL for app-managed adapter installs. */
  downloadUrl?: string;
  /** Only lightweight ACP adapters/shims may be app-managed downloads. */
  downloadKind?: "adapter";
  /** Where to learn more / file bugs. */
  homepage?: string;
  /** Initial UI seed. Live ACP session config_options override this. */
  configOptions?: KnownAgentConfigOption[];
  probe?: (
    command: string,
    options?: ResolveAgentCommandOptions,
  ) => Promise<boolean>;
  resolveSpec?: (
    command: string,
    options?: ResolveAgentCommandOptions,
  ) => AgentSpec | Promise<AgentSpec>;
}

function registryShimName(id: string): string {
  return `clash-acp-${id}`;
}

export const KNOWN_ACP_AGENTS: KnownAgentEntry[] = [
  {
    id: "codex-acp",
    label: "Codex",
    spec: { command: "codex-acp" },
    registryId: "codex-acp",
    installSource: "registry",
    homepage: "https://github.com/zed-industries/codex-acp",
  },
  {
    id: "claude-acp",
    label: "Claude",
    spec: { command: "claude-agent-acp" },
    registryId: "claude-acp",
    installSource: "registry",
    homepage: "https://github.com/agentclientprotocol/claude-agent-acp",
  },
  {
    id: "gemini",
    label: "Gemini",
    spec: { command: registryShimName("gemini"), args: ["--acp"] },
    registryId: "gemini",
    installSource: "registry",
    homepage: "https://github.com/google-gemini/gemini-cli",
  },
  {
    id: "opencode",
    label: "OpenCode",
    spec: { command: registryShimName("opencode"), args: ["acp"] },
    registryId: "opencode",
    installSource: "registry",
    homepage: "https://opencode.ai/",
  },
  {
    id: "cursor",
    label: "Cursor",
    spec: { command: registryShimName("cursor"), args: ["acp"] },
    registryId: "cursor",
    installSource: "registry",
    homepage: "https://cursor.com/docs/cli/acp",
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    spec: {
      command: registryShimName("qwen-code"),
      args: ["--acp", "--experimental-skills"],
    },
    registryId: "qwen-code",
    installSource: "registry",
    homepage: "https://github.com/QwenLM/qwen-code",
  },
  {
    id: "github-copilot-cli",
    label: "GitHub Copilot",
    spec: { command: registryShimName("github-copilot-cli"), args: ["--acp"] },
    registryId: "github-copilot-cli",
    installSource: "registry",
    homepage: "https://github.com/github/copilot-cli",
  },
  {
    id: "kilo",
    label: "Kilo",
    spec: { command: registryShimName("kilo"), args: ["acp"] },
    registryId: "kilo",
    installSource: "registry",
    homepage: "https://kilo.ai/",
  },
  {
    id: "grok-build",
    label: "Grok Build",
    spec: { command: registryShimName("grok-build"), args: ["agent", "stdio"] },
    registryId: "grok-build",
    installSource: "registry",
    homepage: "https://github.com/xai-org/grok-cli",
  },
  {
    id: "amp-acp",
    label: "Amp",
    spec: { command: registryShimName("amp-acp") },
    registryId: "amp-acp",
    installSource: "registry",
    homepage: "https://github.com/tao12345666333/amp-acp",
  },
  {
    id: "goose",
    label: "Goose",
    spec: { command: registryShimName("goose"), args: ["acp"] },
    registryId: "goose",
    installSource: "registry",
    homepage: "https://block.github.io/goose/",
  },
  {
    id: "cline",
    label: "Cline",
    spec: { command: registryShimName("cline"), args: ["--acp"] },
    registryId: "cline",
    installSource: "registry",
    homepage: "https://cline.bot/",
  },
  {
    id: "auggie",
    label: "Auggie CLI",
    spec: { command: registryShimName("auggie"), args: ["--acp"] },
    registryId: "auggie",
    installSource: "registry",
    homepage: "https://www.augmentcode.com/",
  },
];

export interface ResolveAgentCommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fromUrl?: string;
  platform?: NodeJS.Platform;
  systemPathFallbackDirs?: string[];
  applicationDirs?: string[];
}

async function isExecutable(
  path: string,
  platform = process.platform,
): Promise<boolean> {
  try {
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitBinPath(value: string | undefined): string[] {
  return value?.split(delimiter).filter(Boolean) ?? [];
}

function candidateBinDirs(options: ResolveAgentCommandOptions): string[] {
  const env = options.env ?? process.env;
  const dirs: string[] = [];
  dirs.push(...splitBinPath(env.CLASH_ACP_BIN_DIR));
  return [...new Set(dirs)];
}

function candidateSystemDirs(options: ResolveAgentCommandOptions): string[] {
  const env = options.env ?? process.env;
  const dirs = splitBinPath(env.PATH);
  const home = env.HOME ?? env.USERPROFILE;

  if (options.systemPathFallbackDirs) {
    dirs.push(...options.systemPathFallbackDirs);
  } else {
    if (process.platform === "darwin") {
      dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin");
    }
    dirs.push("/usr/bin", "/bin");
  }

  if (env.PNPM_HOME) dirs.push(env.PNPM_HOME);
  if (env.VOLTA_HOME) dirs.push(join(env.VOLTA_HOME, "bin"));

  if (home) {
    dirs.push(
      join(home, ".volta", "bin"),
      join(home, ".asdf", "shims"),
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".mise", "shims"),
      join(home, ".local", "bin"),
      join(home, "Library", "pnpm"),
      join(home, ".bun", "bin"),
    );
  }

  return [...new Set(dirs)];
}

async function candidateNodeVersionDirs(
  root: string,
  suffix: string[],
): Promise<string[]> {
  const dirs: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      dirs.push(join(root, entry.name, ...suffix));
    }
  } catch {
    // Toolchain managers are optional; absence just means no extra bins.
  }
  return dirs;
}

async function candidateSystemBinDirs(
  options: ResolveAgentCommandOptions,
): Promise<string[]> {
  const env = options.env ?? process.env;
  const dirs = candidateSystemDirs(options);
  const home = env.HOME ?? env.USERPROFILE;

  const nvmDir = env.NVM_DIR ?? (home ? join(home, ".nvm") : undefined);
  if (nvmDir) {
    dirs.push(
      ...(await candidateNodeVersionDirs(join(nvmDir, "versions", "node"), [
        "bin",
      ])),
    );
  }

  const fnmDir = env.FNM_DIR ?? (home ? join(home, ".fnm") : undefined);
  if (fnmDir) {
    dirs.push(
      ...(await candidateNodeVersionDirs(join(fnmDir, "node-versions"), [
        "installation",
        "bin",
      ])),
    );
  }

  return [...new Set(dirs)];
}

function candidateApplicationDirs(
  options: ResolveAgentCommandOptions,
): string[] {
  const env = options.env ?? process.env;
  const home = env.HOME ?? env.USERPROFILE;
  if (options.applicationDirs) return [...new Set(options.applicationDirs)];
  if (process.platform !== "darwin") return [];
  return [
    "/Applications",
    "/System/Applications",
    ...(home ? [join(home, "Applications")] : []),
  ];
}

function candidateMacAppExecutables(
  entry: KnownAgentEntry,
  options: ResolveAgentCommandOptions,
): string[] {
  if (process.platform !== "darwin" && !options.applicationDirs) return [];
  const bundleNames = entry.macAppBundleNames ?? [];
  if (bundleNames.length === 0) return [];
  const executableNames = entry.macAppExecutableNames ?? [entry.spec.command];
  const candidates: string[] = [];
  for (const appDir of candidateApplicationDirs(options)) {
    for (const bundleName of bundleNames) {
      for (const executableName of executableNames) {
        candidates.push(
          join(appDir, bundleName, "Contents", "MacOS", executableName),
        );
      }
    }
  }
  return [...new Set(candidates)];
}

function candidateCommandNames(
  command: string,
  options: ResolveAgentCommandOptions,
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" || extname(command)) return [command];
  const env = options.env ?? process.env;
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

async function resolveCommandInDirs(
  command: string,
  dirs: string[],
  options: ResolveAgentCommandOptions,
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  if (isAbsolute(command))
    return (await isExecutable(command, platform)) ? command : null;
  for (const dir of dirs) {
    for (const name of candidateCommandNames(command, options)) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate, platform)) return candidate;
    }
  }
  return null;
}

export async function resolveAgentCommand(
  command: string,
  options: ResolveAgentCommandOptions = {},
): Promise<string | null> {
  return resolveCommandInDirs(command, candidateBinDirs(options), options);
}

async function resolveSystemCommand(
  entry: KnownAgentEntry,
  options: ResolveAgentCommandOptions = {},
): Promise<string | null> {
  const fromBins = await resolveCommandInDirs(
    entry.spec.command,
    await candidateSystemBinDirs(options),
    options,
  );
  if (fromBins) return fromBins;
  for (const candidate of candidateMacAppExecutables(entry, options)) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

export async function detectEntry(
  entry: KnownAgentEntry,
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry | null> {
  const managedCommand = await resolveAgentCommand(entry.spec.command, options);
  const command =
    managedCommand ??
    (entry.systemPath ? await resolveSystemCommand(entry, options) : null);
  if (!command) return null;
  if (entry.probe && !(await entry.probe(command, options))) return null;
  let spec: AgentSpec;
  if (entry.resolveSpec) {
    spec = await entry.resolveSpec(command, options);
  } else if (
    (options.platform ?? process.platform) === "win32" &&
    /\.(?:bat|cmd)$/i.test(command)
  ) {
    const env = options.env ?? process.env;
    spec = {
      ...entry.spec,
      command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
      args: ["/d", "/s", "/c", command, ...(entry.spec.args ?? [])],
    };
  } else {
    spec = {
      ...entry.spec,
      command,
    };
  }
  return {
    ...entry,
    spec,
  };
}

/**
 * Returns the KnownAgentEntry whose binary is available in its allowed paths, else `null`.
 * Intentionally Node-only. A web-ui that wants to render a list can call this
 * server-side or in the local host process.
 */
export async function detect(
  id: string,
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry | null> {
  const entry = KNOWN_ACP_AGENTS.find((e) => e.id === id);
  if (!entry) return null;
  return detectEntry(entry, options);
}

/** Detect every known agent. Useful for "list available agents" UI. */
export async function detectAll(
  options: ResolveAgentCommandOptions = {},
): Promise<KnownAgentEntry[]> {
  const results = await Promise.all(
    KNOWN_ACP_AGENTS.map((e) => detect(e.id, options)),
  );
  return results.filter((e): e is KnownAgentEntry => e !== null);
}
