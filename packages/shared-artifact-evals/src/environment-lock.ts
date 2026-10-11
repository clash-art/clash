import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, existsSync } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceBundleManifest } from "@clash/shared-types";

import {
  lockedQualityJudge,
  type BenchmarkLockedQualityJudge,
} from "./quality-judge-environment";
import type {
  BenchmarkObservedRuntime,
  BenchmarkRuntimeClaim,
  BenchmarkSubjectRecord,
} from "./backend-types";
import type {
  ArtifactBenchmarkCase,
  BenchmarkAgent,
  BenchmarkExecutionTransport,
  BenchmarkQualityReviewer,
} from "./types";

type LockedFile = {
  bytes: number;
  sha256: string;
};

type LockedTree = LockedFile & {
  files: number;
};

export type BenchmarkLockedExecutable = LockedFile & {
  name: string;
  reportedVersion?: string;
};

export type BenchmarkLockedParticipant = {
  adapter: "codex" | "claude" | "pi" | "command";
  provider:
    { kind: "adapter-bound" | "explicit"; id: string } | { kind: "unselected" };
  model: { kind: "explicit"; id: string } | { kind: "unselected" };
  executable?: BenchmarkLockedExecutable;
};

export type BenchmarkLockedSkill =
  | ({ id: string; state: "locked" } & LockedTree)
  | { id: string; state: "declared" };

type BenchmarkResolvedPhasePolicy = {
  process: "native-child-process" | "not-run";
  productInterfaces: {
    clash: {
      policy: BenchmarkExecutionTransport;
      exposed: Array<"mcp" | "cli">;
    };
  };
  network: {
    access: "ambient" | "enabled" | "not-run";
    enforcement: "codex-adapter" | "not-enforced-by-runner" | "not-applicable";
  };
  credentials: {
    source: "inherited-plus-explicit" | "explicit-only" | "not-run";
    filtering: "benchmark-identity-and-package-context" | "not-applicable";
  };
  filesystem: {
    workspace: "read-write" | "not-run";
    hostIsolation:
      | "codex-workspace-write-sandbox"
      | "not-enforced-by-runner"
      | "not-applicable";
  };
};

type RuntimePlatform = {
  os: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
};

/**
 * `native-local` keeps its original shape so earlier locks and digests stay
 * valid. Every other backend records its isolation level, what the dispatcher
 * claimed, and what the worker observed on its own.
 */
export type BenchmarkResolvedRuntime =
  | {
      kind: "native-local";
      platform: RuntimePlatform;
      isolation: {
        container: "none";
        workspace: "fresh-temporary-directory" | "not-materialized";
        clashHome: "fresh-per-case-directory" | "not-materialized";
      };
    }
  | {
      kind: "container" | "claude-cloud";
      platform: RuntimePlatform;
      isolation: {
        level: "container" | "provider-managed-vm";
        workspace: "fresh-temporary-directory" | "not-materialized";
        clashHome: "fresh-per-case-directory" | "not-materialized";
        network: "engine-default" | "none" | "environment-policy";
        hostAccess:
          "read-only-inputs-and-attempt-directory" | "provider-managed";
      };
      backend: BenchmarkRuntimeClaim;
      /**
       * `dispatcher-asserted-worker-observed`: the dispatcher set the isolation
       * flags and the worker corroborated a container marker.
       * `dispatcher-declared`: the runner cannot observe the isolation boundary.
       */
      attestation:
        "dispatcher-asserted-worker-observed" | "dispatcher-declared";
      observed: { containerMarker: boolean };
    };

export type BenchmarkResolvedEnvironment = {
  schemaVersion: 1;
  profile: "clash-agent-environment-v1";
  track: "functional" | "content-effect";
  executionIntent: "execute" | "blocked-no-run";
  initialState: {
    workspace:
      | {
          state: "locked";
          format: "clash-workspace-v1";
          bundleDigest: string;
          materialization: "fresh-directory-import";
        }
      | { state: "undeclared" };
    fixture:
      { state: "locked"; manifestSha256: string } | { state: "undeclared" };
  };
  runtime: BenchmarkResolvedRuntime;
  phases: {
    agent: BenchmarkResolvedPhasePolicy;
  };
  participants: {
    runner: {
      id: string;
      version: string;
      manifestSha256: string;
    };
    agent: BenchmarkLockedParticipant;
    clash?: NonNullable<BenchmarkEnvironmentExecutionLock["clash"]>;
    skills: BenchmarkLockedSkill[];
  };
  evidenceInputs: {
    task: { state: "locked"; sha256: string } | { state: "absent" };
  };
  requirements: BenchmarkEnvironmentExecutionLock["requirements"];
  resolvedEnvironmentDigest: string;
};

export type BenchmarkEnvironmentExecutionLock = {
  schemaVersion: 1;
  kind: "clash.benchmark.environment-lock";
  executionIntent: "execute" | "blocked-no-run";
  agent: BenchmarkLockedParticipant;
  skills: BenchmarkLockedSkill[];
  clash?: {
    id: string;
    version: string;
    manifestSha256: string;
    profile: "dev" | "prod";
    runtime: LockedTree;
    /** The selected build under test; absent for locks that predate subjects. */
    subject?: BenchmarkSubjectRecord;
  };
  requirements: {
    capabilities: string[];
    productOperations: string[];
    generatorDefinitions: WorkspaceBundleManifest["semanticRequirements"]["generatorDefinitions"];
    models: string[];
    plugins: string[];
    providers: string[];
  };
  resolvedEnvironment: BenchmarkResolvedEnvironment;
  /**
   * The configured content-effect judge: variable names and non-secret identity
   * only. It sits outside `resolvedEnvironment` because it is evaluator
   * identity, so one Agent Environment stays comparable across judges.
   */
  qualityJudge?: BenchmarkLockedQualityJudge;
};

/** The lock without its evaluator identity: what an Attempt's Agent actually ran in. */
export function agentEnvironmentLock<T extends object>(
  lock: T,
): Omit<T, "qualityJudge"> {
  const { qualityJudge: _qualityJudge, ...agentEnvironment } = lock as T & {
    qualityJudge?: unknown;
  };
  return agentEnvironment;
}

/** The resolved build under test; `pluginRoot` is runner-private and never serialized. */
export type BenchmarkLockSubject = {
  record: BenchmarkSubjectRecord;
  pluginRoot: string;
};

type LockedSource = {
  path: string;
  evidence: LockedFile;
};

type LockedTreeSource = {
  path: string;
  evidence: LockedTree;
};

export type BenchmarkExecutionLockReceipt = {
  lock: BenchmarkEnvironmentExecutionLock;
  /** Runner-private path. It is never serialized into the public lock. */
  lockFile: string;
  lockSha256: string;
  sources: {
    runnerManifest: LockedSource;
    task?: LockedSource;
    executable?: LockedSource;
    qualityReviewerExecutable?: LockedSource;
    clash?: {
      manifest: LockedSource;
      runtime: LockedTreeSource;
    };
    skills: Array<{ id: string; tree: LockedTreeSource }>;
  };
};

const SAFE_PUBLIC_ID = /^[A-Za-z0-9@][A-Za-z0-9@._+:/-]{0,499}$/u;
const SECRET_LIKE_ID =
  /(?:^|[._:/-])(?:api[._-]?key|credentials?|password|private[._-]?key|secrets?|tokens?)(?:$|[._:/-])/iu;
const KNOWN_TOKEN_PREFIX =
  /(?:^|[._:/-])(?:sk-(?:proj-)?|sk_(?:live|test)_|clsh_|gh[pousr]_|github_pat_|xox[aboprs]-|AIza[0-9A-Za-z_-])/iu;

function safePublicId(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized !== value ||
    !SAFE_PUBLIC_ID.test(normalized) ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(normalized) ||
    /^file:/iu.test(normalized) ||
    /(?:^|\/)\.\.?($|\/)/u.test(normalized) ||
    /(?:^|\/)(?:users|home)\//iu.test(normalized) ||
    SECRET_LIKE_ID.test(normalized) ||
    KNOWN_TOKEN_PREFIX.test(normalized)
  ) {
    throw new Error(`${label} must be a safe public identity`);
  }
  return normalized;
}

function sortedUnique(values: string[], label: string): string[] {
  return [...new Set(values.map((value) => safePublicId(value, label)))].sort(
    compareText,
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Resolved Environment digest accepts only JSON values");
}

export async function hashRegularFile(path: string): Promise<LockedFile> {
  const canonicalPath = await realpath(path);
  const info = await lstat(canonicalPath);
  if (!info.isFile()) {
    throw new Error("Execution lock sources must resolve to regular files");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(canonicalPath);
    stream.on("data", (chunk: string | Buffer) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += data.byteLength;
      hash.update(data);
    });
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  const finalInfo = await stat(canonicalPath);
  if (!finalInfo.isFile() || finalInfo.size !== bytes) {
    throw new Error("Execution lock source changed while it was being hashed");
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function lockRunnerManifest(): Promise<{
  public: BenchmarkResolvedEnvironment["participants"]["runner"];
  source: LockedSource;
}> {
  const manifestPath = fileURLToPath(
    new URL("../package.json", import.meta.url),
  );
  const manifestBytes = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBytes) as Record<string, unknown>;
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("Benchmark runner manifest must declare name and version");
  }
  const evidence = await hashRegularFile(manifestPath);
  return {
    public: {
      id: safePublicId(manifest.name, "Benchmark runner id"),
      version: safePublicId(manifest.version, "Benchmark runner version"),
      manifestSha256: evidence.sha256,
    },
    source: { path: manifestPath, evidence },
  };
}

async function lockOptionalTask(
  caseRoot: string,
): Promise<LockedSource | undefined> {
  const path = join(caseRoot, "task.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Benchmark task evidence must be a regular file");
  }
  return { path, evidence: await hashRegularFile(path) };
}

export async function hashRegularTree(root: string): Promise<LockedTree> {
  const canonicalRoot = await realpath(root);
  if (!(await lstat(canonicalRoot)).isDirectory()) {
    throw new Error("Execution lock tree source must be a directory");
  }
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Execution lock trees must not contain symbolic links");
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Execution lock trees must contain only regular files");
      }
      const evidence = await hashRegularFile(path);
      files.push({
        path: relative(canonicalRoot, path).split(sep).join("/"),
        ...evidence,
      });
    }
  };
  await visit(canonicalRoot);
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    files: files.length,
    bytes,
    sha256: hashText(JSON.stringify(files)),
  };
}

function effectivePath(agent: BenchmarkAgent): string {
  const configured =
    agent.env?.PATH ??
    (agent.inheritEnv === false ? "" : (process.env.PATH ?? ""));
  return configured
    .split(delimiter)
    .filter((entry) => entry && !entry.includes("node_modules/.bin"))
    .join(delimiter);
}

async function resolveExecutable(agent: BenchmarkAgent): Promise<string> {
  const command =
    agent.adapter === undefined || agent.adapter === "command"
      ? agent.command
      : (agent.command ?? agent.adapter);
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const candidate = await realpath(resolve(command));
    await access(candidate, constants.X_OK);
    return candidate;
  }
  for (const directory of effectivePath(agent).split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(`Unable to resolve Agent executable '${command}'`);
}

async function reportedVersion(
  executable: string,
): Promise<string | undefined> {
  const output = await new Promise<string | undefined>((resolveVersion) => {
    execFile(
      executable,
      ["--version"],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          LANG: "C",
          LC_ALL: "C",
        },
        maxBuffer: 64 * 1024,
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolveVersion(undefined);
          return;
        }
        resolveVersion(`${stdout}${stderr}`);
      },
    );
  });
  const match = output?.match(
    /(?:^|\s)v?(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u,
  );
  return match?.[1];
}

function hasNativeSelectionOverride(agent: BenchmarkAgent): boolean {
  if (
    agent.adapter !== "codex" &&
    agent.adapter !== "claude" &&
    agent.adapter !== "pi"
  ) {
    return false;
  }
  const args = agent.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      argument === "--model" ||
      argument.startsWith("--model=") ||
      (agent.adapter === "codex" && argument === "-m") ||
      (agent.adapter === "codex" && argument === "--oss") ||
      (agent.adapter === "codex" && argument.startsWith("--oss=")) ||
      (agent.adapter === "codex" && argument === "--local-provider") ||
      (agent.adapter === "codex" && argument.startsWith("--local-provider=")) ||
      (agent.adapter === "codex" && argument === "--profile") ||
      (agent.adapter === "codex" && argument.startsWith("--profile=")) ||
      (agent.adapter === "codex" && argument === "-p") ||
      (agent.adapter === "pi" && argument === "--provider") ||
      (agent.adapter === "pi" && argument.startsWith("--provider=")) ||
      (agent.adapter === "pi" && argument === "--models") ||
      (agent.adapter === "pi" && argument.startsWith("--models="))
    ) {
      return true;
    }
    if (
      agent.adapter === "codex" &&
      (argument === "-c" || argument === "--config")
    ) {
      const value = args[index + 1] ?? "";
      if (/^(?:model|model_provider)\s*=/iu.test(value)) return true;
    }
    if (
      agent.adapter === "codex" &&
      /^--config=(?:model|model_provider)\s*=/iu.test(argument)
    ) {
      return true;
    }
  }
  return false;
}

function boundProvider(
  agent: BenchmarkAgent,
): BenchmarkLockedParticipant["provider"] {
  if (agent.adapter === "codex") {
    return { kind: "adapter-bound", id: "openai" };
  }
  if (agent.adapter === "claude") {
    return { kind: "adapter-bound", id: "anthropic" };
  }
  if (agent.adapter === "pi" && agent.provider) {
    return {
      kind: "explicit",
      id: safePublicId(agent.provider, "Pi provider"),
    };
  }
  return { kind: "unselected" };
}

function assertAdapterProviderBinding(
  agent: BenchmarkAgent,
  model?: string,
): void {
  if (agent.adapter === "pi" && agent.provider && model?.includes("/")) {
    const modelProvider = model.slice(0, model.indexOf("/"));
    if (modelProvider !== agent.provider) {
      throw new Error(
        "The provider-prefixed Pi model must match the explicit Pi provider",
      );
    }
  }
  if (agent.adapter === "claude") {
    const providerSwitch = Object.keys(agent.env ?? {}).find((key) =>
      /^(?:CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/iu.test(key),
    );
    if (providerSwitch) {
      throw new Error(
        "Claude Agent environment must not switch the adapter-bound provider",
      );
    }
  }
}

async function lockExecutable(
  agent: BenchmarkAgent,
  required: boolean,
): Promise<
  { public: BenchmarkLockedExecutable; source: LockedSource } | undefined
> {
  let path: string;
  try {
    path = await resolveExecutable(agent);
  } catch (error) {
    if (required) throw error;
    return undefined;
  }
  const evidence = await hashRegularFile(path);
  const commandName =
    agent.adapter === undefined || agent.adapter === "command"
      ? basename(agent.command.replaceAll("\\", "/"))
      : basename((agent.command ?? agent.adapter).replaceAll("\\", "/"));
  const version = await reportedVersion(path);
  const afterVersionEvidence = await hashRegularFile(path);
  if (!sameEvidence(afterVersionEvidence, evidence)) {
    throw new Error(
      "Agent executable changed while its reported version was queried",
    );
  }
  return {
    public: {
      name: safePublicId(commandName, "Agent executable name"),
      ...evidence,
      ...(version
        ? { reportedVersion: safePublicId(version, "Agent version") }
        : {}),
    },
    source: { path, evidence },
  };
}

async function lockSkills(input: {
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  suiteRoot: string;
  executionIntent: "execute" | "blocked-no-run";
}): Promise<{
  public: BenchmarkLockedSkill[];
  sources: BenchmarkExecutionLockReceipt["sources"]["skills"];
}> {
  const configured = [
    ...input.benchmark.skills,
    ...(input.agent.adapter === "pi" ? (input.agent.skills ?? []) : []),
  ];
  const names = new Set<string>();
  const publicSkills: BenchmarkLockedSkill[] = [];
  const sources: BenchmarkExecutionLockReceipt["sources"]["skills"] = [];
  for (const configuredPath of configured) {
    const candidate = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(input.suiteRoot, configuredPath);
    const name = safePublicId(
      basename(configuredPath.replaceAll("\\", "/")),
      "Skill id",
    );
    if (names.has(name))
      throw new Error(`Duplicate benchmark skill id: ${name}`);
    names.add(name);
    if (input.executionIntent === "blocked-no-run") {
      publicSkills.push({ id: name, state: "declared" });
      continue;
    }
    const source = await realpath(candidate);
    if (!(await lstat(source)).isDirectory()) {
      throw new Error(`Benchmark skill '${name}' must be a directory`);
    }
    const skillDefinition = join(source, "SKILL.md");
    if (!(await lstat(skillDefinition)).isFile()) {
      throw new Error(`Benchmark skill '${name}' is missing SKILL.md`);
    }
    const evidence = await hashRegularTree(source);
    publicSkills.push({ id: name, state: "locked", ...evidence });
    sources.push({ id: name, tree: { path: source, evidence } });
  }
  publicSkills.sort((left, right) => compareText(left.id, right.id));
  sources.sort((left, right) => compareText(left.id, right.id));
  return { public: publicSkills, sources };
}

async function lockClashPlugin(
  agent: BenchmarkAgent,
  required: boolean,
  subject?: BenchmarkLockSubject,
): Promise<
  | {
      public: NonNullable<BenchmarkEnvironmentExecutionLock["clash"]>;
      source: NonNullable<BenchmarkExecutionLockReceipt["sources"]["clash"]>;
    }
  | undefined
> {
  if (
    agent.adapter !== "codex" &&
    agent.adapter !== "claude" &&
    agent.adapter !== "pi"
  ) {
    if (required) throw new Error("A ready Environment requires Clash Host");
    return undefined;
  }
  if (!agent.clashHost) {
    if (required) {
      throw new Error("A ready Environment requires a locked Clash plugin");
    }
    return undefined;
  }
  const pluginRoot = await realpath(agent.clashHost.pluginRoot);
  const manifestPath = join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifestBytes = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestBytes) as Record<string, unknown>;
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    throw new Error(
      "Clash plugin manifest must declare public name and version",
    );
  }
  const manifestEvidence = await hashRegularFile(manifestPath);
  const runtimePath = join(pluginRoot, "runtime");
  const runtimeEvidence = await hashRegularTree(runtimePath);
  if (subject) {
    if ((await realpath(subject.pluginRoot)) !== pluginRoot) {
      throw new Error(
        "The selected benchmark subject is not the Clash plugin the Agent will run",
      );
    }
    if (
      subject.record.runtimeSha256 !== runtimeEvidence.sha256 ||
      subject.record.version !== manifest.version
    ) {
      throw new Error(
        "The selected benchmark subject does not match the Clash plugin runtime on disk",
      );
    }
  }
  return {
    public: {
      id: safePublicId(manifest.name, "Clash plugin id"),
      version: safePublicId(manifest.version, "Clash plugin version"),
      manifestSha256: manifestEvidence.sha256,
      profile: agent.clashHost.profile,
      runtime: runtimeEvidence,
      ...(subject ? { subject: subject.record } : {}),
    },
    source: {
      manifest: { path: manifestPath, evidence: manifestEvidence },
      runtime: { path: runtimePath, evidence: runtimeEvidence },
    },
  };
}

function publicRequirements(input: {
  benchmark: ArtifactBenchmarkCase;
  inputManifest?: WorkspaceBundleManifest;
  agent: BenchmarkLockedParticipant;
  clash?: NonNullable<BenchmarkEnvironmentExecutionLock["clash"]>;
}): BenchmarkEnvironmentExecutionLock["requirements"] {
  const generatorDefinitions = [
    ...(input.inputManifest?.semanticRequirements.generatorDefinitions ?? []),
  ].map((definition) => ({
    pluginId: safePublicId(definition.pluginId, "Generator plugin id"),
    definitionId: safePublicId(
      definition.definitionId,
      "Generator definition id",
    ),
    version: safePublicId(definition.version, "Generator definition version"),
    schemaHash: definition.schemaHash,
  }));
  generatorDefinitions.sort((left, right) =>
    compareText(
      `${left.pluginId}\0${left.definitionId}\0${left.version}\0${left.schemaHash}`,
      `${right.pluginId}\0${right.definitionId}\0${right.version}\0${right.schemaHash}`,
    ),
  );
  const selectedModel =
    input.agent.model.kind === "explicit" ? [input.agent.model.id] : [];
  const selectedProvider =
    input.agent.provider.kind === "unselected" ? [] : [input.agent.provider.id];
  return {
    capabilities: sortedUnique(
      input.benchmark.execution?.requiredCapabilities ?? [],
      "Required capability",
    ),
    productOperations: sortedUnique(
      [
        ...(input.benchmark.execution?.requiredProductOperations ?? []),
        ...(input.benchmark.execution?.forbiddenProductOperations ?? []),
      ],
      "Exposed product operation",
    ),
    generatorDefinitions,
    models: sortedUnique(
      [
        ...(input.benchmark.execution?.environment?.requirements?.models ?? []),
        ...(
          input.inputManifest?.semanticRequirements.modelReferences ?? []
        ).map(({ modelId }) => modelId),
        ...selectedModel,
      ],
      "Required model",
    ),
    plugins: sortedUnique(
      [
        ...(input.benchmark.execution?.environment?.requirements?.plugins ??
          []),
        ...(input.clash ? [input.clash.id] : []),
        ...generatorDefinitions.map(({ pluginId }) => pluginId),
      ],
      "Required plugin",
    ),
    providers: sortedUnique(
      [
        ...(input.benchmark.execution?.environment?.requirements?.providers ??
          []),
        ...selectedProvider,
      ],
      "Required provider",
    ),
  };
}

function resolvedAgentPhase(
  agent: BenchmarkAgent,
  executionIntent: "execute" | "blocked-no-run",
  transport: BenchmarkExecutionTransport,
): BenchmarkResolvedEnvironment["phases"]["agent"] {
  if (executionIntent === "blocked-no-run") {
    return {
      process: "not-run",
      productInterfaces: { clash: { policy: transport, exposed: [] } },
      network: { access: "not-run", enforcement: "not-applicable" },
      credentials: { source: "not-run", filtering: "not-applicable" },
      filesystem: {
        workspace: "not-run",
        hostIsolation: "not-applicable",
      },
    };
  }
  const adapter = agent.adapter ?? "command";
  return {
    process: "native-child-process",
    productInterfaces: {
      clash: {
        policy: transport,
        exposed: transport === "auto" ? ["mcp", "cli"] : [transport],
      },
    },
    network:
      adapter === "codex"
        ? { access: "enabled", enforcement: "codex-adapter" }
        : { access: "ambient", enforcement: "not-enforced-by-runner" },
    credentials: {
      source:
        agent.inheritEnv === false
          ? "explicit-only"
          : "inherited-plus-explicit",
      filtering: "benchmark-identity-and-package-context",
    },
    filesystem: {
      workspace: "read-write",
      hostIsolation:
        adapter === "codex"
          ? "codex-workspace-write-sandbox"
          : "not-enforced-by-runner",
    },
  };
}

function declaredWorkspace(benchmark: ArtifactBenchmarkCase):
  | {
      format: "clash-workspace-v1";
      path: string;
      bundleDigest: string;
    }
  | undefined {
  const environment = benchmark.execution?.environment;
  if (!environment) return undefined;
  if (environment.profile === "clash-agent-environment-v1") {
    return environment.initialState?.workspace;
  }
  return environment.inputWorkspace
    ? { format: "clash-workspace-v1", ...environment.inputWorkspace }
    : undefined;
}

export function observeLocalRuntime(): BenchmarkObservedRuntime {
  return {
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    containerMarker:
      existsSync("/.dockerenv") || existsSync("/run/.containerenv"),
  };
}

function resolvedRuntime(
  claim: BenchmarkRuntimeClaim,
  executionIntent: "execute" | "blocked-no-run",
  observed: BenchmarkObservedRuntime,
): BenchmarkResolvedRuntime {
  const materialized = executionIntent === "execute";
  const workspace = materialized
    ? ("fresh-temporary-directory" as const)
    : ("not-materialized" as const);
  const clashHome = materialized
    ? ("fresh-per-case-directory" as const)
    : ("not-materialized" as const);
  if (claim.kind === "native-local") {
    return {
      kind: "native-local",
      platform: observed.platform,
      isolation: { container: "none", workspace, clashHome },
    };
  }
  if (claim.kind === "container") {
    if (materialized && !observed.containerMarker) {
      throw new Error(
        "The Attempt was dispatched as container-isolated but the worker observed no container marker",
      );
    }
    return {
      kind: "container",
      platform: observed.platform,
      isolation: {
        level: "container",
        workspace,
        clashHome,
        network: claim.network,
        hostAccess: "read-only-inputs-and-attempt-directory",
      },
      backend: claim,
      attestation: "dispatcher-asserted-worker-observed",
      observed: { containerMarker: observed.containerMarker },
    };
  }
  return {
    kind: "claude-cloud",
    platform: observed.platform,
    isolation: {
      level: "provider-managed-vm",
      workspace,
      clashHome,
      network: "environment-policy",
      hostAccess: "provider-managed",
    },
    backend: claim,
    attestation: "dispatcher-declared",
    observed: { containerMarker: observed.containerMarker },
  };
}

function buildResolvedEnvironment(input: {
  benchmark: ArtifactBenchmarkCase;
  executionIntent: "execute" | "blocked-no-run";
  agentConfig: BenchmarkAgent;
  agent: BenchmarkLockedParticipant;
  clash?: NonNullable<BenchmarkEnvironmentExecutionLock["clash"]>;
  skills: BenchmarkLockedSkill[];
  runner: BenchmarkResolvedEnvironment["participants"]["runner"];
  task?: LockedSource;
  requirements: BenchmarkEnvironmentExecutionLock["requirements"];
  inputManifest?: WorkspaceBundleManifest;
  runtime?: BenchmarkRuntimeClaim;
  observedRuntime: BenchmarkObservedRuntime;
}): BenchmarkResolvedEnvironment {
  const environment = input.benchmark.execution?.environment;
  if (!environment) {
    throw new Error(
      "An Environment execution lock requires an Environment profile",
    );
  }
  const workspace = declaredWorkspace(input.benchmark);
  if (
    workspace &&
    input.inputManifest &&
    workspace.bundleDigest !== input.inputManifest.integrity.bundleDigest
  ) {
    throw new Error(
      "Resolved Environment input Workspace digest differs from the verified bundle",
    );
  }
  const subject: Omit<
    BenchmarkResolvedEnvironment,
    "resolvedEnvironmentDigest"
  > = {
    schemaVersion: 1,
    profile: "clash-agent-environment-v1",
    track: environment.track,
    executionIntent: input.executionIntent,
    initialState: {
      workspace: workspace
        ? {
            state: "locked",
            format: workspace.format,
            bundleDigest: workspace.bundleDigest,
            materialization: "fresh-directory-import",
          }
        : { state: "undeclared" },
      fixture: input.benchmark.inputFixture
        ? {
            state: "locked",
            manifestSha256: input.benchmark.inputFixture.manifestSha256,
          }
        : { state: "undeclared" },
    },
    runtime: resolvedRuntime(
      input.runtime ?? { kind: "native-local" },
      input.executionIntent,
      input.observedRuntime,
    ),
    phases: {
      agent: resolvedAgentPhase(
        input.agentConfig,
        input.executionIntent,
        input.benchmark.execution?.transport ?? "auto",
      ),
    },
    participants: {
      runner: input.runner,
      agent: input.agent,
      ...(input.clash ? { clash: input.clash } : {}),
      skills: input.skills,
    },
    evidenceInputs: {
      task: input.task
        ? { state: "locked", sha256: input.task.evidence.sha256 }
        : { state: "absent" },
    },
    requirements: input.requirements,
  };
  return {
    ...subject,
    resolvedEnvironmentDigest: hashText(canonicalJson(subject)),
  };
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function captureBenchmarkExecutionLock(input: {
  caseRoot: string;
  suiteRoot: string;
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  qualityReviewer?: BenchmarkQualityReviewer;
  executionIntent: "execute" | "blocked-no-run";
  inputManifest?: WorkspaceBundleManifest;
  /** Where the Attempt runs. Defaults to the in-process native-local backend. */
  runtime?: BenchmarkRuntimeClaim;
  /** The selected build under test, verified against the locked plugin runtime. */
  subject?: BenchmarkLockSubject;
  /** Override for tests; the worker's own observation otherwise. */
  observeRuntime?: () => BenchmarkObservedRuntime;
}): Promise<BenchmarkExecutionLockReceipt> {
  if (
    input.executionIntent === "execute" &&
    input.agent.adapter === "command"
  ) {
    throw new Error(
      "The command adapter cannot bind a verifiable provider for a ready Environment",
    );
  }
  if (
    input.executionIntent === "execute" &&
    hasNativeSelectionOverride(input.agent)
  ) {
    throw new Error(
      "Native Agent arguments must not override the Environment model or provider",
    );
  }
  const codexReviewer =
    input.qualityReviewer?.adapter === "codex"
      ? input.qualityReviewer
      : undefined;
  if (codexReviewer && hasNativeSelectionOverride(codexReviewer)) {
    throw new Error(
      "Native quality-reviewer arguments must not override the Environment model or provider",
    );
  }
  const model = "model" in input.agent ? input.agent.model : undefined;
  if (input.executionIntent === "execute" && !model?.trim()) {
    throw new Error("A ready Environment requires an explicit Agent model");
  }
  if (
    input.executionIntent === "execute" &&
    input.agent.adapter === "pi" &&
    !input.agent.provider?.trim()
  ) {
    throw new Error("A ready Environment requires an explicit Pi provider");
  }
  if (codexReviewer && codexReviewer.provider !== "openai") {
    throw new Error(
      "The Codex quality reviewer provider must be bound to openai",
    );
  }
  if (
    input.qualityReviewer?.adapter === "gemini" &&
    input.qualityReviewer.provider !== "google"
  ) {
    throw new Error(
      "The Gemini quality reviewer provider must be bound to google",
    );
  }
  assertAdapterProviderBinding(input.agent, model);
  const provider = boundProvider(input.agent);
  const participant: BenchmarkLockedParticipant = {
    adapter: input.agent.adapter ?? "command",
    provider,
    model: model
      ? { kind: "explicit", id: safePublicId(model, "Agent model") }
      : { kind: "unselected" },
  };
  const [executable, reviewerExecutable, skills, clash, runnerManifest, task] =
    await Promise.all([
      lockExecutable(input.agent, input.executionIntent === "execute"),
      codexReviewer
        ? lockExecutable(codexReviewer, input.executionIntent === "execute")
        : undefined,
      lockSkills(input),
      lockClashPlugin(
        input.agent,
        input.executionIntent === "execute",
        input.subject,
      ),
      lockRunnerManifest(),
      lockOptionalTask(input.caseRoot),
    ]);
  if (executable) participant.executable = executable.public;
  const requirements = publicRequirements({
    benchmark: input.benchmark,
    inputManifest: input.inputManifest,
    agent: participant,
    ...(clash ? { clash: clash.public } : {}),
  });
  const resolvedEnvironment = buildResolvedEnvironment({
    benchmark: input.benchmark,
    executionIntent: input.executionIntent,
    agentConfig: input.agent,
    agent: participant,
    ...(clash ? { clash: clash.public } : {}),
    skills: skills.public,
    runner: runnerManifest.public,
    ...(task ? { task } : {}),
    requirements,
    ...(input.inputManifest ? { inputManifest: input.inputManifest } : {}),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    observedRuntime: (input.observeRuntime ?? observeLocalRuntime)(),
  });
  const lock: BenchmarkEnvironmentExecutionLock = {
    schemaVersion: 1,
    kind: "clash.benchmark.environment-lock",
    executionIntent: input.executionIntent,
    agent: participant,
    skills: skills.public,
    ...(clash ? { clash: clash.public } : {}),
    requirements,
    resolvedEnvironment,
    ...(input.qualityReviewer
      ? { qualityJudge: lockedQualityJudge(input.qualityReviewer) }
      : {}),
  };
  const lockFile = join(input.caseRoot, "environment-lock.json");
  await writeJsonAtomically(lockFile, lock);
  const lockSha256 = (await hashRegularFile(lockFile)).sha256;
  return {
    lock,
    lockFile,
    lockSha256,
    sources: {
      runnerManifest: runnerManifest.source,
      ...(task ? { task } : {}),
      ...(executable ? { executable: executable.source } : {}),
      ...(reviewerExecutable
        ? { qualityReviewerExecutable: reviewerExecutable.source }
        : {}),
      ...(clash ? { clash: clash.source } : {}),
      skills: skills.sources,
    },
  };
}

function sameEvidence(left: LockedFile, right: LockedFile): boolean {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

function sameTree(left: LockedTree, right: LockedTree): boolean {
  return left.files === right.files && sameEvidence(left, right);
}

export async function verifyBenchmarkExecutionLock(
  receipt: BenchmarkExecutionLockReceipt,
  installed?: { workspace: string; installedSkillNames: string[] },
): Promise<void> {
  const lockBytes = await readFile(receipt.lockFile, "utf8");
  if (
    hashText(lockBytes) !== receipt.lockSha256 ||
    JSON.stringify(JSON.parse(lockBytes) as unknown) !==
      JSON.stringify(receipt.lock)
  ) {
    throw new Error("Environment execution lock changed after capture");
  }
  const runnerManifest = await hashRegularFile(
    receipt.sources.runnerManifest.path,
  );
  if (!sameEvidence(runnerManifest, receipt.sources.runnerManifest.evidence)) {
    throw new Error(
      "Benchmark runner manifest changed after Environment lock capture",
    );
  }
  if (receipt.sources.task) {
    const task = await hashRegularFile(receipt.sources.task.path);
    if (!sameEvidence(task, receipt.sources.task.evidence)) {
      throw new Error("Benchmark task changed after Environment lock capture");
    }
  }
  if (receipt.sources.executable) {
    const current = await hashRegularFile(receipt.sources.executable.path);
    if (!sameEvidence(current, receipt.sources.executable.evidence)) {
      throw new Error(
        "Agent executable changed after Environment lock capture",
      );
    }
  }
  if (receipt.sources.qualityReviewerExecutable) {
    const current = await hashRegularFile(
      receipt.sources.qualityReviewerExecutable.path,
    );
    if (
      !sameEvidence(current, receipt.sources.qualityReviewerExecutable.evidence)
    ) {
      throw new Error(
        "Quality reviewer executable changed after Environment lock capture",
      );
    }
  }
  if (receipt.sources.clash) {
    const [manifest, runtime] = await Promise.all([
      hashRegularFile(receipt.sources.clash.manifest.path),
      hashRegularTree(receipt.sources.clash.runtime.path),
    ]);
    if (!sameEvidence(manifest, receipt.sources.clash.manifest.evidence)) {
      throw new Error(
        "Clash plugin manifest changed after Environment lock capture",
      );
    }
    if (!sameTree(runtime, receipt.sources.clash.runtime.evidence)) {
      throw new Error(
        "Clash plugin runtime changed after Environment lock capture",
      );
    }
  }
  for (const skill of receipt.sources.skills) {
    const current = await hashRegularTree(skill.tree.path);
    if (!sameTree(current, skill.tree.evidence)) {
      throw new Error(
        `Skill '${skill.id}' changed after Environment lock capture`,
      );
    }
  }
  if (installed) {
    const expectedNames = receipt.sources.skills.map(({ id }) => id).sort();
    const installedNames = sortedUnique(
      installed.installedSkillNames,
      "Installed skill id",
    );
    if (JSON.stringify(installedNames) !== JSON.stringify(expectedNames)) {
      throw new Error(
        "Installed skills do not match the Environment execution lock",
      );
    }
    for (const skill of receipt.sources.skills) {
      for (const agentRoot of [".agents", ".claude"]) {
        let current: LockedTree;
        try {
          current = await hashRegularTree(
            join(installed.workspace, agentRoot, "skills", skill.id),
          );
        } catch (error) {
          throw new Error(`Installed skill '${skill.id}' changed`, {
            cause: error,
          });
        }
        if (!sameTree(current, skill.tree.evidence)) {
          throw new Error(`Installed skill '${skill.id}' changed`);
        }
      }
    }
  }
}
