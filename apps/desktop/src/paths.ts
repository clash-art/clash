import { delimiter, dirname, join, resolve } from "node:path";
import { clashHomeForLocalDataDir } from "@clash/shared-runtime/local-paths";

export interface WebDistPathInput {
  envWebDistDir?: string;
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}

export interface ClashCliEntryPathInput {
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}

export type AgentBundlePathInput = ClashCliEntryPathInput;
export type ClashHostEntryPathInput = ClashCliEntryPathInput;

export interface ClashSdkPythonPathInput {
  envPythonSdkPath?: string;
  isPackaged: boolean;
  moduleDir: string;
  resourcesPath: string;
}

export interface DesktopStatePaths {
  root: string;
  userData: string;
  sessionData: string;
  logs: string;
  crashDumps: string;
}

export function resolveDesktopStatePaths(
  localApiDataDir: string,
): DesktopStatePaths {
  const clashHome = dirname(resolve(localApiDataDir));
  const root = join(clashHome, "desktop");
  return {
    root,
    userData: join(root, "user-data"),
    sessionData: join(root, "session-data"),
    logs: join(clashHomeForLocalDataDir(localApiDataDir), "logs", "desktop"),
    crashDumps: join(root, "crash-dumps"),
  };
}

export function resolveWebDistDir(input: WebDistPathInput): string {
  if (input.envWebDistDir) return input.envWebDistDir;
  if (input.isPackaged) return join(input.resourcesPath, "web-dist");
  return resolve(input.moduleDir, "../.vite/renderer/main_window");
}

export function resolveAcpBinDir(dataDir: string): string {
  return join(dataDir, "acp-bin");
}

export function resolveAgentBundleRoot(input: AgentBundlePathInput): string {
  if (input.isPackaged)
    return join(input.resourcesPath, "clash-runtime", "agents");
  return resolve(input.moduleDir, "../../../packages/cli/assets/agents");
}

export function resolveClashCliEntryPath(
  input: ClashCliEntryPathInput,
): string {
  if (input.isPackaged)
    return join(input.resourcesPath, "clash-runtime", "dispatcher.js");
  return resolve(input.moduleDir, "../../../packages/cli/src/index.ts");
}

export function resolveClashCliNodePath(
  input: ClashCliEntryPathInput,
): string | undefined {
  if (input.isPackaged)
    return join(input.resourcesPath, "clash-runtime", "node_modules");
  return resolve(input.moduleDir, "../../../node_modules");
}

export function resolveClashHostEntryPath(
  input: ClashHostEntryPathInput,
): string {
  if (input.isPackaged)
    return join(input.resourcesPath, "clash-runtime", "local-api.cjs");
  return resolve(
    input.moduleDir,
    "../../../plugins/clash/src/local-api-entry.ts",
  );
}

export function resolveClashDevTsconfigPath(moduleDir: string): string {
  return resolve(moduleDir, "../../../plugins/clash/tsconfig.dev.json");
}

export function resolveClashBuiltinPluginRoot(moduleDir: string): string {
  return resolve(moduleDir, "../../../plugins/clash");
}

export function resolveClashSdkPythonPath(
  input: ClashSdkPythonPathInput,
): string {
  if (input.envPythonSdkPath) return input.envPythonSdkPath;
  if (input.isPackaged) return join(input.resourcesPath, "clash-sdk", "python");
  return resolve(input.moduleDir, "../../../packages/clash-sdk/python");
}

export function prependPythonPath(
  existing: string | undefined,
  sdkPath: string,
): string {
  return [sdkPath, ...(existing?.split(delimiter) ?? [])]
    .filter(
      (entry, index, entries) => entry && entries.indexOf(entry) === index,
    )
    .join(delimiter);
}
