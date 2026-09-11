import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createConnection,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { fileURLToPath } from "node:url";
import type { ProjectHostResponse } from "@clash/shared-runtime/project-host-client";
import { createGeneratorClient } from "@clash/shared-runtime/generator-client";
import { createProjectAssetHttpClient } from "@clash/asset-sdk";
import {
  DirectorStageStateSchema,
  projectDirectorStageReadToken,
  ProjectActionRunSchema,
  OutputCommitSchema,
  type ProjectActionRun,
  type OutputCommit,
  type ProjectDirectorStage,
} from "@clash/shared-types";

import { loadSubmission } from "./artifacts";
import { writeAtifTrajectory } from "./atif";
import {
  verifyBenchmarkAttempt,
  writeBenchmarkAttempt,
  type BenchmarkAttemptReceipt,
  type BenchmarkAttemptVerification,
} from "./attempt-manifest";
import { writeBenchmarkTaskManifest } from "./benchmark-task";
import { resolveTaskSkillPack } from "./task-skill-pack";
import { renderCodexTaskSkillContext } from "./codex-task-skills";
import { createBenchmarkEvaluationPipeline } from "./evaluation-pipeline";
import {
  parseEvaluationRecord,
  writeAggregateRecord,
  writeEvaluationRecord,
  writeRewardRecord,
  type BenchmarkEvaluationEvidenceReference,
  type BenchmarkEvaluationRecord,
  type EvaluationRecordReceipt,
} from "./evaluation-records";
import { directorStageArtifactState, evaluateSubmission } from "./evaluator";
import {
  captureBenchmarkWorkspaceScaffold,
  removeVerifiedBenchmarkWorkspaceScaffold,
  writeBenchmarkAttemptCapture,
  type BenchmarkModifiedWorkspaceCapture,
  type BenchmarkWorkspaceScaffoldReceipt,
} from "./environment";
import {
  captureBenchmarkExecutionLock,
  verifyBenchmarkExecutionLock,
  type BenchmarkExecutionLockReceipt,
} from "./environment-lock";
import {
  installBenchmarkInputFixture,
  verifyBenchmarkInputFixture,
  writeBenchmarkInputFixtureReceipt,
  type BenchmarkFixtureIntegrityReport,
} from "./fixture";
import {
  enforceBenchmarkIdentityIntegrity,
  inspectBenchmarkIdentityIntegrity,
} from "./identity-integrity";
import {
  createRunnerMcpTraceRecorder,
  readRunnerSealedMcpInvocations,
} from "./mcp-evidence";
import { createOutcomeResult, renderOutcomeMarkdown } from "./outcome";
import {
  codexQualityJudgeSupportsRequest,
  runCodexQualityJudge,
} from "./quality-review-codex";
import {
  createQualityReviewRequest,
  evaluateQualityReview,
} from "./quality-review";
import {
  effectiveMcpToolName,
  formatCliInvocation,
  matchForbiddenProductOperations,
  matchRequiredProductOperations,
  mcpToolForCliInvocation,
} from "./product-operations";
import { writeSuiteGallery } from "./report";
import {
  writeBenchmarkResultBundle,
  type BenchmarkResultBundleReceipt,
} from "./result-bundle";
import { ArtifactBenchmarkSuiteSchema } from "./schemas";
import {
  publishContentAddressedFile,
  verifyWorkspaceBundleDirectory,
} from "@clash/shared-runtime";
import { captureObservedOutput, writeNormalizedTrajectory } from "./trajectory";
import {
  captureAssetProductReadback,
  captureRemotionProductReadback,
  captureTimelineProductReadback,
  mixedProductLineageProjectAssetIds,
  type AssetProductReadbackReport,
  type RemotionProductReadbackReport,
  type TimelineProductReadbackReport,
} from "./product-readback";
import {
  assertProjectHostReady,
  assertWorkspaceProject,
  productHostContext,
  requestProjectHost,
  type ProductHostReady,
} from "./project-host";
import type {
  AgentRunReport,
  ArtifactBenchmarkCase,
  ArtifactEvaluationReport,
  BenchmarkAttemptLedgerEntry,
  BenchmarkAgent,
  BenchmarkCaseFailure,
  BenchmarkCaseReport,
  BenchmarkInputFixtureProvenance,
  BenchmarkQualityReviewer,
  BenchmarkSuiteReport,
  ClaudeAgent,
  CodexAgent,
  OutcomeResult,
  PiAgent,
  ProductExecutionReport,
  QualityReviewReport,
  QualityReviewResult,
  RunBenchmarkSuiteInput,
  ReevaluateBenchmarkRunInput,
} from "./types";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class BenchmarkInfrastructureError extends Error {
  readonly phase: string;

  constructor(phase: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BenchmarkInfrastructureError";
    this.phase = phase;
  }
}

class BenchmarkPostAgentInfrastructureError extends BenchmarkInfrastructureError {
  readonly agent: AgentRunReport;

  constructor(error: unknown, agent: AgentRunReport) {
    const message = error instanceof Error ? error.message : String(error);
    super(
      error instanceof BenchmarkInfrastructureError ? error.phase : "runner",
      message,
      { cause: error },
    );
    this.name = "BenchmarkPostAgentInfrastructureError";
    this.agent = agent;
  }
}

type ResolvedClashHost = {
  pluginRoot: string;
  runtimePath: string;
  workspace: string;
  profile: "dev" | "prod";
  runtimeRoot: string;
  clashHome: string;
  persistedClashHome: string;
  localDataDir: string;
  localApiPluginSocket: string;
  agentMemberId: string;
  agentName: string;
};

type RunningClashHost = ResolvedClashHost & {
  endpoint: string;
  agentCliPath: string;
  readyAt: string;
  child: ChildProcess;
};

type ProjectHostReady = ProductHostReady & {
  projectId: string;
  workspaceId: string;
  initDisposition: "created" | "reused";
  markerSha256: string;
  apiUrl: string;
  readyAt: string;
};

export type BenchmarkWorkspaceBinding = {
  projectId: string;
  workspaceId: string;
  markerPath: string;
  markerSha256: string;
  initDisposition: "created" | "reused";
};

type DirectorReadbackReport = {
  schemaVersion: 1;
  status: "pass" | "fail";
  projectId: string | null;
  matchedArtifactIds: string[];
  stages: Array<{
    id: string;
    name: string;
    revisionId: string;
    readToken: string;
    hostReceipt: string;
    stateSha256: string;
  }>;
  matches: Array<{
    artifactId: string;
    stageId: string;
    stateSha256: string;
  }>;
  captures: Array<{
    receiptPath: string;
    stageId: string;
    stageRevisionId: string;
    renderer: string;
    stateSha256: string;
    frames: Array<{
      artifactId: string;
      projectAssetId?: string;
      sha256: string;
      timeSeconds: number;
      aspectRatio: string;
      width: number;
      height: number;
      actionRun: ProjectActionRun;
      outputCommit: OutputCommit;
    }>;
  }>;
  imageMatches: Array<{
    artifactId: string;
    stageId: string;
    captureArtifactId: string;
    projectAssetId?: string;
    sha256: string;
  }>;
  detail: string;
};

type CombinedProductReadbackReport = {
  schemaVersion: 1;
  status: "pass" | "fail";
  projectId: string | null;
  matchedArtifactIds: string[];
  reports: Array<
    | AssetProductReadbackReport
    | DirectorReadbackReport
    | RemotionProductReadbackReport
    | TimelineProductReadbackReport
  >;
  mixedLineage?: {
    projectAssetIds: string[];
  };
  detail: string;
};

type ProductReadbackReport =
  | AssetProductReadbackReport
  | DirectorReadbackReport
  | RemotionProductReadbackReport
  | TimelineProductReadbackReport;

type TrustedProductReadback = {
  report: ProductReadbackReport | CombinedProductReadbackReport;
  receiptPath:
    | "asset-readback.json"
    | "director-readback.json"
    | "remotion-readback.json"
    | "timeline-readback.json"
    | "product-readback.json";
};

function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} must be a safe path segment`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeJson(temporaryPath, value);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateChildAndWait(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  terminateChild(child, "SIGTERM");
  if (await waitForProcessClose(child, 3_000)) return;
  terminateChild(child, "SIGKILL");
  await waitForProcessClose(child, 1_000);
}

class BenchmarkProcessScope {
  private readonly children = new Set<ChildProcess>();
  private installed = false;
  private forceKillTimer: NodeJS.Timeout | undefined;
  interruptedSignal: "SIGINT" | "SIGTERM" | undefined;

  private readonly onSigint = (): void => this.interrupt("SIGINT");
  private readonly onSigterm = (): void => this.interrupt("SIGTERM");

  install(): void {
    if (this.installed) return;
    this.installed = true;
    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);
  }

  track<T extends ChildProcess>(child: T): T {
    this.children.add(child);
    child.once("close", () => {
      this.children.delete(child);
      if (this.children.size === 0 && this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = undefined;
      }
    });
    if (this.interruptedSignal) terminateChild(child, "SIGTERM");
    return child;
  }

  private interrupt(signal: "SIGINT" | "SIGTERM"): void {
    if (this.interruptedSignal) {
      for (const child of this.children) terminateChild(child, "SIGKILL");
      return;
    }
    this.interruptedSignal = signal;
    if (process.exitCode === undefined || process.exitCode === 0) {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    }
    for (const child of this.children) terminateChild(child, "SIGTERM");
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      for (const child of this.children) terminateChild(child, "SIGKILL");
    }, 3_000);
    this.forceKillTimer.unref();
  }

  async dispose(): Promise<void> {
    if (this.installed) {
      process.off("SIGINT", this.onSigint);
      process.off("SIGTERM", this.onSigterm);
      this.installed = false;
    }
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = undefined;
    }
    await Promise.all([...this.children].map(terminateChildAndWait));
  }
}

type TrustedCliProxy = {
  agentCliPath: string;
  close(): Promise<void>;
};

type TrustedMcpRelay = {
  runtimePath: string;
  close(): Promise<void>;
};

type AgentClashAccess = {
  sandboxRoots: string[];
  mcp?: {
    runtimePath: string;
    pluginRoot: string;
  };
  cli?: {
    agentCliPath: string;
  };
};

const BENCHMARK_IDENTITY_ENVIRONMENT_KEYS = [
  "CLASH_SESSION_AS_LOCAL_USER",
  "CLASH_AGENT_MEMBER_ID",
  "CLASH_AGENT_NAME",
] as const;

function sanitizedBenchmarkEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of BENCHMARK_IDENTITY_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
  return environment;
}

type TrustedCliProxyResult = {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutBase64: string;
  stderrBase64: string;
  error?: string;
};

type SealedCliInvocation = {
  argv: string[];
  origin?: "mcp-transport";
  succeeded: boolean;
};

function sameStringArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((argument, index) => argument === right[index])
  );
}

function parseSealedCliInvocations(traceText: string):
  | {
      eventCount: number;
      invocations: SealedCliInvocation[];
    }
  | undefined {
  type StartedEvent = {
    invocationId: string;
    startedAt: string;
    pid: number | null;
    parentPid: number;
    cwd: string;
    argv: string[];
    origin?: "mcp-transport";
  };
  type PendingPair = {
    started: StartedEvent;
    completed: boolean;
    succeeded: boolean;
  };

  const pairs = new Map<string, PendingPair>();
  let eventCount = 0;
  for (const line of traceText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    eventCount += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const event = parsed as Record<string, unknown>;
    if (
      (event.type !== "clash.cli.started" &&
        event.type !== "clash.cli.completed") ||
      typeof event.invocationId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        event.invocationId,
      ) ||
      typeof event.startedAt !== "string" ||
      !Number.isFinite(Date.parse(event.startedAt)) ||
      !(
        event.pid === null ||
        (Number.isSafeInteger(event.pid) && (event.pid as number) > 0)
      ) ||
      !Number.isSafeInteger(event.parentPid) ||
      (event.parentPid as number) <= 0 ||
      typeof event.cwd !== "string" ||
      !isAbsolute(event.cwd) ||
      !Array.isArray(event.argv) ||
      !event.argv.every((argument) => typeof argument === "string") ||
      (event.origin !== undefined && event.origin !== "mcp-transport")
    ) {
      return undefined;
    }
    const common: StartedEvent = {
      invocationId: event.invocationId,
      startedAt: event.startedAt,
      pid: event.pid as number | null,
      parentPid: event.parentPid as number,
      cwd: event.cwd,
      argv: event.argv as string[],
      ...(event.origin === "mcp-transport"
        ? { origin: "mcp-transport" as const }
        : {}),
    };
    if (event.type === "clash.cli.started") {
      if (pairs.has(common.invocationId)) return undefined;
      pairs.set(common.invocationId, {
        started: common,
        completed: false,
        succeeded: false,
      });
      continue;
    }

    const pair = pairs.get(common.invocationId);
    if (
      !pair ||
      pair.completed ||
      pair.started.startedAt !== common.startedAt ||
      pair.started.pid !== common.pid ||
      pair.started.parentPid !== common.parentPid ||
      pair.started.cwd !== common.cwd ||
      pair.started.origin !== common.origin ||
      !sameStringArray(pair.started.argv, common.argv) ||
      typeof event.finishedAt !== "string" ||
      !Number.isFinite(Date.parse(event.finishedAt)) ||
      (event.exitCode !== null && !Number.isSafeInteger(event.exitCode)) ||
      (event.signal !== null && typeof event.signal !== "string") ||
      (event.error !== undefined && typeof event.error !== "string")
    ) {
      return undefined;
    }
    pair.completed = true;
    pair.succeeded =
      event.exitCode === 0 &&
      event.signal === null &&
      event.error === undefined;
  }
  if ([...pairs.values()].some((pair) => !pair.completed)) return undefined;
  return {
    eventCount,
    invocations: [...pairs.values()].map((pair) => ({
      argv: pair.started.argv,
      ...(pair.started.origin ? { origin: pair.started.origin } : {}),
      succeeded: pair.succeeded,
    })),
  };
}

const TRUSTED_CLI_PREFIXES_BY_OPERATION: Record<
  string,
  readonly (readonly string[])[]
> = {
  "asset.get": [["assets", "get"]],
  "asset.import": [["assets", "import"]],
  "asset.list": [["assets", "list"]],
  "asset.restore": [["assets", "restore"]],
  "asset.trash": [["assets", "delete"]],
  "canvas.add": [["canvas", "add"]],
  "canvas.get": [["canvas", "get"]],
  "canvas.update": [["canvas", "update"]],
  "director.capture": [["director", "capture"]],
  "director.create": [["director", "create"]],
  "director.get": [["director", "pull"]],
  "director.mutate": [
    ["director", "apply"],
    ["director", "object"],
    ["director", "camera"],
    ["director", "scene"],
    ["director", "keyframe"],
    ["director", "action"],
  ],
  "timeline.create": [["timeline", "create"]],
  "timeline.get": [["timeline", "pull"]],
  "timeline.render": [["timeline", "render"]],
  "timeline.save": [["timeline", "apply"]],
  "timeline.validate": [["timeline", "validate"]],
};

const TRUSTED_CLI_PATH_FLAGS = new Set([
  "--file",
  "--out",
  "--output",
  "--output-dir",
]);

const TRUSTED_CLI_GROUP_ALIASES: Readonly<Record<string, readonly string[]>> = {
  assets: ["assets", "asset"],
};

function trustedCliGroupSpellings(group: string): readonly string[] {
  return TRUSTED_CLI_GROUP_ALIASES[group] ?? [group];
}

const TRUSTED_CLI_NAVIGATION_GROUPS = new Set(
  Object.values(TRUSTED_CLI_PREFIXES_BY_OPERATION).flatMap((prefixes) =>
    prefixes.flatMap((prefix) => trustedCliGroupSpellings(prefix[0]!)),
  ),
);

function isTrustedCliNavigation(argv: string[]): boolean {
  return (
    (argv.length === 1 && argv[0] === "--help") ||
    (argv.length === 2 &&
      argv[1] === "--help" &&
      TRUSTED_CLI_NAVIGATION_GROUPS.has(argv[0]!))
  );
}

const TRUSTED_DIRECTOR_SCHEMA_CONTRACTS = new Set([
  "state",
  "object",
  "camera",
]);

function isTrustedDirectorSchemaDiscovery(argv: string[]): boolean {
  if (argv[0] !== "director" || argv[1] !== "schema") return false;
  if (argv.length === 3) {
    return argv[2] === "--help" || argv[2] === "--json";
  }
  return (
    argv.length === 5 &&
    argv[2] === "--contract" &&
    TRUSTED_DIRECTOR_SCHEMA_CONTRACTS.has(argv[3]!) &&
    argv[4] === "--json"
  );
}

function isTrustedTimelineSchemaDiscovery(argv: string[]): boolean {
  return (
    argv[0] === "timeline" &&
    argv[1] === "schema" &&
    argv.length === 3 &&
    (argv[2] === "--help" || argv[2] === "--json")
  );
}

function benchmarkRequiresDirectorOperation(
  benchmark: ArtifactBenchmarkCase,
): boolean {
  return [
    ...(benchmark.execution?.requiredProductOperations ?? []),
    ...(benchmark.execution?.forbiddenProductOperations ?? []),
  ].some((operation) => operation.startsWith("director."));
}

function benchmarkRequiresTimelineOperation(
  benchmark: ArtifactBenchmarkCase,
): boolean {
  return [
    ...(benchmark.execution?.requiredProductOperations ?? []),
    ...(benchmark.execution?.forbiddenProductOperations ?? []),
  ].some((operation) => operation.startsWith("timeline."));
}

function trustedCliPrefixes(
  benchmark: ArtifactBenchmarkCase,
): readonly (readonly string[])[] {
  const canonicalPrefixes = [
    ...(benchmark.execution?.requiredProductOperations ?? []).flatMap(
      (operation) => TRUSTED_CLI_PREFIXES_BY_OPERATION[operation] ?? [],
    ),
    ...(benchmark.execution?.forbiddenProductOperations ?? []).flatMap(
      (operation) => TRUSTED_CLI_PREFIXES_BY_OPERATION[operation] ?? [],
    ),
    ...(benchmarkRequiresTimelineOperation(benchmark)
      ? (TRUSTED_CLI_PREFIXES_BY_OPERATION["timeline.validate"] ?? [])
      : []),
    ...(benchmark.execution?.requiredCliCommands ?? []).map((command) =>
      command.split(" "),
    ),
  ];
  return canonicalPrefixes.flatMap(([group, ...rest]) =>
    trustedCliGroupSpellings(group!).map((spelling) => [spelling, ...rest]),
  );
}

function assertTrustedCliPrefix(
  argv: string[],
  prefixes: readonly (readonly string[])[],
  allowDirectorSchemaDiscovery: boolean,
  allowTimelineSchemaDiscovery: boolean,
): void {
  if (isTrustedCliNavigation(argv)) return;
  const isDirectorSchema = argv[0] === "director" && argv[1] === "schema";
  const isTimelineSchema = argv[0] === "timeline" && argv[1] === "schema";
  const isSchemaDiscovery = isDirectorSchema || isTimelineSchema;
  const isAllowedSchemaDiscovery =
    (isDirectorSchema &&
      allowDirectorSchemaDiscovery &&
      isTrustedDirectorSchemaDiscovery(argv)) ||
    (isTimelineSchema &&
      allowTimelineSchemaDiscovery &&
      isTrustedTimelineSchemaDiscovery(argv));
  if (
    (isSchemaDiscovery && !isAllowedSchemaDiscovery) ||
    (!isSchemaDiscovery &&
      !prefixes.some((prefix) =>
        prefix.every((argument, index) => argv[index] === argument),
      ))
  ) {
    throw new Error(
      `Trusted Clash CLI proxy rejected a command outside this benchmark case: ${formatCliInvocation(argv)}`,
    );
  }
}

async function assertTrustedCliWorkspacePath(input: {
  workspace: string;
  cwd: string;
  value: string;
}): Promise<void> {
  if (!input.value || input.value.includes("\0"))
    throw new Error("Trusted Clash CLI proxy path is invalid");
  const candidate = resolve(input.cwd, input.value);
  const local = relative(input.workspace, candidate);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
    throw new Error("Trusted Clash CLI proxy path must remain in workspace");
  }
  let current = input.workspace;
  for (const segment of local.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          "Trusted Clash CLI proxy path must not traverse a symbolic link",
        );
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
  }
}

async function assertTrustedCliPaths(
  workspace: string,
  cwd: string,
  argv: string[],
): Promise<void> {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (TRUSTED_CLI_PATH_FLAGS.has(argument)) {
      const value = argv[index + 1];
      if (!value)
        throw new Error(`Trusted Clash CLI proxy ${argument} requires a path`);
      await assertTrustedCliWorkspacePath({ workspace, cwd, value });
      index += 1;
      continue;
    }
    const joinedFlag = [...TRUSTED_CLI_PATH_FLAGS].find((flag) =>
      argument.startsWith(`${flag}=`),
    );
    if (joinedFlag) {
      await assertTrustedCliWorkspacePath({
        workspace,
        cwd,
        value: argument.slice(joinedFlag.length + 1),
      });
      continue;
    }
    if (
      isAbsolute(argument) ||
      argument === ".." ||
      argument.startsWith(`..${sep}`) ||
      argument.startsWith(`.${sep}`)
    ) {
      await assertTrustedCliWorkspacePath({
        workspace,
        cwd,
        value: argument,
      });
    }
  }
}

async function readTrustedCliProxyRequest(
  request: import("node:http").IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 64 * 1024) {
      throw new Error("Trusted Clash CLI proxy request is too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function trustedCliCwd(workspace: string, candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new Error("Trusted Clash CLI proxy cwd must be absolute");
  }
  return realpath(candidate).then((resolved) => {
    if (resolved !== workspace)
      throw new Error("Trusted Clash CLI proxy cwd must be the workspace root");
    return resolved;
  });
}

async function executeTrustedCli(input: {
  cliPath: string;
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  processScope: BenchmarkProcessScope;
  activeChildren: Set<ChildProcess>;
  onSpawn(child: ChildProcess): void;
}): Promise<TrustedCliProxyResult> {
  return await new Promise<TrustedCliProxyResult>((resolveResult) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let child: ChildProcess;
    try {
      child = input.processScope.track(
        spawn(input.cliPath, input.argv, {
          cwd: input.cwd,
          env: input.env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch (error) {
      resolveResult({
        pid: null,
        exitCode: null,
        signal: null,
        stdoutBase64: "",
        stderrBase64: "",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    input.activeChildren.add(child);
    input.onSpawn(child);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    let settled = false;
    const finish = (result: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      input.activeChildren.delete(child);
      resolveResult({
        ...result,
        pid: child.pid ?? null,
        stdoutBase64: Buffer.concat(stdout).toString("base64"),
        stderrBase64: Buffer.concat(stderr).toString("base64"),
      });
    };
    child.once("error", (error) => {
      finish({ exitCode: null, signal: null, error: error.message });
    });
    child.once("close", (exitCode, signal) => {
      finish({ exitCode, signal });
    });
  });
}

async function startTrustedCliProxy(input: {
  host: RunningClashHost;
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  logsRoot: string;
  processScope: BenchmarkProcessScope;
}): Promise<TrustedCliProxy> {
  const tracePath = join(input.logsRoot, "clash-cli-events.jsonl");
  await writeFile(tracePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const allowedPrefixes = trustedCliPrefixes(input.benchmark);
  const allowDirectorSchemaDiscovery = benchmarkRequiresDirectorOperation(
    input.benchmark,
  );
  const allowTimelineSchemaDiscovery = benchmarkRequiresTimelineOperation(
    input.benchmark,
  );
  const activeChildren = new Set<ChildProcess>();
  const activeRequests = new Set<Promise<void>>();
  const events: Array<Record<string, unknown>> = [];
  let accepting = true;
  const server = createServer((request, response) => {
    const task = (async () => {
      if (!accepting) {
        response.statusCode = 503;
        response.end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/invoke") {
        response.statusCode = 404;
        response.end();
        return;
      }
      const body = await readTrustedCliProxyRequest(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Trusted Clash CLI proxy request must be an object");
      }
      const candidate = body as {
        argv?: unknown;
        cwd?: unknown;
        traceOrigin?: unknown;
      };
      if (
        !Array.isArray(candidate.argv) ||
        candidate.argv.length > 256 ||
        !candidate.argv.every(
          (argument) =>
            typeof argument === "string" && argument.length <= 16_384,
        ) ||
        typeof candidate.cwd !== "string"
      ) {
        throw new Error("Trusted Clash CLI proxy argv or cwd is invalid");
      }
      if (
        candidate.traceOrigin !== undefined &&
        candidate.traceOrigin !== "mcp-transport"
      ) {
        throw new Error("Trusted Clash CLI proxy trace origin is invalid");
      }
      const cwd = await trustedCliCwd(input.workspace, candidate.cwd);
      assertTrustedCliPrefix(
        candidate.argv,
        allowedPrefixes,
        allowDirectorSchemaDiscovery,
        allowTimelineSchemaDiscovery,
      );
      await assertTrustedCliPaths(input.workspace, cwd, candidate.argv);
      const startedAt = new Date().toISOString();
      const invocationId = randomUUID();
      const startedMonotonic = process.hrtime.bigint();
      let startedPid: number | null = null;
      const cliEnvironment: NodeJS.ProcessEnv = {
        ...sanitizedBenchmarkEnvironment(process.env),
        ...clashClientEnvironment(input.host, input.workspace),
      };
      delete cliEnvironment.CLASH_CLI_TRACE_PATH;
      delete cliEnvironment.CLASH_CLI_TRACE_ORIGIN;
      const result = await executeTrustedCli({
        cliPath: input.host.agentCliPath,
        argv: candidate.argv,
        cwd,
        env: cliEnvironment,
        processScope: input.processScope,
        activeChildren,
        onSpawn: (child) => {
          startedPid = child.pid ?? null;
          events.push({
            type: "clash.cli.started",
            invocationId,
            startedAt,
            pid: startedPid,
            parentPid: process.pid,
            cwd,
            argv: candidate.argv,
            ...(candidate.traceOrigin ? { origin: candidate.traceOrigin } : {}),
          });
        },
      });
      events.push({
        type: "clash.cli.completed",
        invocationId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Number(
          (process.hrtime.bigint() - startedMonotonic) / 1_000_000n,
        ),
        pid: result.pid ?? startedPid,
        parentPid: process.pid,
        cwd,
        argv: candidate.argv,
        exitCode: result.exitCode,
        signal: result.signal,
        ...(result.error ? { error: result.error } : {}),
        ...(candidate.traceOrigin ? { origin: candidate.traceOrigin } : {}),
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    })().catch((error) => {
      response.statusCode = 400;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    activeRequests.add(task);
    void task.finally(() => activeRequests.delete(task));
  });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClosed) =>
      server.close(() => resolveClosed()),
    );
    throw new Error("Trusted Clash CLI proxy did not bind a TCP port");
  }
  const proxyRoot = join(input.host.runtimeRoot, "trusted-agent-cli");
  const agentCliPath = join(proxyRoot, "clash");
  await mkdir(proxyRoot, { recursive: true });
  await writeFile(
    agentCliPath,
    [
      `#!${process.execPath}`,
      'const fs = require("node:fs")',
      `const endpoint = ${JSON.stringify(`http://127.0.0.1:${address.port}/invoke`)}`,
      ";(async () => {",
      "const response = await fetch(endpoint, {",
      'method: "POST",',
      'headers: {"content-type":"application/json"},',
      'body: JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),...(process.env.CLASH_CLI_TRACE_ORIGIN === "mcp-transport" ? {traceOrigin:"mcp-transport"} : {})}),',
      "})",
      "const result = await response.json()",
      'if (!response.ok) throw new Error(result.error || "Trusted Clash CLI proxy rejected the invocation")',
      'if (result.stdoutBase64) fs.writeSync(1, Buffer.from(result.stdoutBase64, "base64"))',
      'if (result.stderrBase64) fs.writeSync(2, Buffer.from(result.stderrBase64, "base64"))',
      'if (result.error) fs.writeSync(2, Buffer.from(result.error + "\\n"))',
      "if (result.signal) { process.kill(process.pid, result.signal); return }",
      "process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 1",
      '})().catch((error) => { fs.writeSync(2, Buffer.from(String(error && error.stack || error) + "\\n")); process.exitCode = 1 })',
    ].join("\n"),
    { encoding: "utf8", mode: 0o500 },
  );
  let closePromise: Promise<void> | undefined;
  return {
    agentCliPath,
    close: async () => {
      closePromise ??= (async () => {
        accepting = false;
        const serverClosed = new Promise<void>(
          (resolveClosed, rejectClosed) => {
            server.close((error) =>
              error ? rejectClosed(error) : resolveClosed(),
            );
          },
        );
        server.closeAllConnections();
        await Promise.all([...activeChildren].map(terminateChildAndWait));
        await Promise.allSettled([...activeRequests]);
        await serverClosed;
        const traceText = events.length
          ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
          : "";
        await writeFile(tracePath, traceText, {
          encoding: "utf8",
          mode: 0o600,
        });
        await writeJson(join(input.logsRoot, "clash-cli-trace-receipt.json"), {
          schemaVersion: 1,
          source: "runner-cli-proxy",
          status: "sealed",
          caseId: input.benchmark.id,
          tracePath: "clash-cli-events.jsonl",
          traceSha256: sha256Bytes(traceText),
          eventCount: events.length,
        });
      })();
      await closePromise;
    },
  };
}

function observeJsonRpcLines(
  onMessage: (message: unknown) => void,
): (chunk: Buffer | string) => void {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([
      buffered,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    for (;;) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffered
        .subarray(0, newline)
        .toString("utf8")
        .replace(/\r$/u, "");
      buffered = buffered.subarray(newline + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line) as unknown);
      } catch {
        // The real MCP runtime will reject malformed JSON-RPC independently;
        // an unparseable line can never create runner-owned call evidence.
      }
    }
  };
}

async function startTrustedMcpRelay(input: {
  host: RunningClashHost;
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  logsRoot: string;
  processScope: BenchmarkProcessScope;
}): Promise<TrustedMcpRelay> {
  const recorder = createRunnerMcpTraceRecorder();
  const stderr = await open(join(input.logsRoot, "clash-mcp.stderr.log"), "w");
  const sockets = new Set<Socket>();
  const children = new Set<ChildProcess>();
  let accepting = true;
  const server = createNetServer((socket) => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    const sessionId = randomUUID();
    sockets.add(socket);
    const environment = {
      ...sanitizedBenchmarkEnvironment(process.env),
      ...clashClientEnvironment(input.host, input.workspace),
    };
    delete environment.CLASH_CLI_TRACE_PATH;
    delete environment.CLASH_CLI_TRACE_ORIGIN;
    let runtime: ChildProcess;
    try {
      runtime = input.processScope.track(
        spawn(process.execPath, [input.host.runtimePath], {
          cwd: input.host.pluginRoot,
          env: environment,
          shell: false,
          stdio: ["pipe", "pipe", stderr.fd],
        }),
      );
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    children.add(runtime);
    socket.on(
      "data",
      observeJsonRpcLines((message) =>
        recorder.observeClientMessage(sessionId, message),
      ),
    );
    runtime.stdout?.on(
      "data",
      observeJsonRpcLines((message) =>
        recorder.observeServerMessage(sessionId, message),
      ),
    );
    socket.pipe(runtime.stdin!);
    runtime.stdout!.pipe(socket);
    socket.once("error", () => {
      runtime.stdin?.end();
    });
    socket.once("close", () => {
      sockets.delete(socket);
      runtime.stdin?.end();
    });
    runtime.once("error", (error) => socket.destroy(error));
    runtime.once("close", () => {
      children.delete(runtime);
      socket.end();
    });
  });
  try {
    await new Promise<void>((resolveListening, rejectListening) => {
      server.once("error", rejectListening);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", rejectListening);
        resolveListening();
      });
    });
  } catch (error) {
    await stderr.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClosed) =>
      server.close(() => resolveClosed()),
    );
    await stderr.close();
    throw new Error("Trusted Clash MCP relay did not bind a TCP port");
  }
  const relayRoot = join(input.host.runtimeRoot, "trusted-mcp-relay");
  const runtimePath = join(relayRoot, "relay.cjs");
  await mkdir(relayRoot, { recursive: true });
  await writeFile(
    runtimePath,
    [
      'const net = require("node:net")',
      `const socket = net.createConnection({host:"127.0.0.1",port:${address.port}})`,
      "process.stdin.pipe(socket)",
      "socket.pipe(process.stdout)",
      'socket.once("error", (error) => { process.stderr.write(String(error && error.stack || error) + "\\n"); process.exitCode = 1 })',
      'process.stdin.once("error", (error) => socket.destroy(error))',
    ].join("\n"),
    { encoding: "utf8", mode: 0o500 },
  );
  let closePromise: Promise<void> | undefined;
  return {
    runtimePath,
    close: async () => {
      closePromise ??= (async () => {
        accepting = false;
        const serverClosed = new Promise<void>(
          (resolveClosed, rejectClosed) => {
            server.close((error) =>
              error ? rejectClosed(error) : resolveClosed(),
            );
          },
        );
        for (const socket of sockets) socket.destroy();
        await Promise.all([...children].map(terminateChildAndWait));
        await serverClosed;
        await stderr.close();
        await recorder.seal({
          logsRoot: input.logsRoot,
          caseId: input.benchmark.id,
        });
      })();
      await closePromise;
    },
  };
}

function isManagedAssetLinkPath(
  workspaceRoot: string,
  candidatePath: string,
): boolean {
  const managedLinks = join("assets", "links");
  const candidate = relative(workspaceRoot, candidatePath);
  return (
    candidate === managedLinks || candidate.startsWith(`${managedLinks}${sep}`)
  );
}

async function assertSnapshotTree(
  path: string,
  workspaceRootWithManagedLinks?: string,
): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (
      workspaceRootWithManagedLinks &&
      isManagedAssetLinkPath(workspaceRootWithManagedLinks, entryPath)
    ) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Workspace snapshot contains a symbolic link: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      await assertSnapshotTree(entryPath, workspaceRootWithManagedLinks);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `Workspace snapshot contains a non-regular entry: ${entryPath}`,
      );
    }
  }
}

async function publishWorkspaceSnapshot<Result = undefined>(
  source: string,
  destination: string,
  inspect?: (snapshot: string) => Promise<Result>,
): Promise<Result | undefined> {
  await assertSnapshotTree(source, source);
  const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
  try {
    await cp(source, partial, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      filter: (entryPath) => !isManagedAssetLinkPath(source, entryPath),
      force: false,
      verbatimSymlinks: true,
    });
    await assertSnapshotTree(partial);
    const result = inspect ? await inspect(partial) : undefined;
    await assertSnapshotTree(partial);
    await rename(partial, destination);
    return result;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
}

function combineFixtureIntegrityChecks(input: {
  fileCount: number;
  postAgent: BenchmarkFixtureIntegrityReport;
  finalSnapshot: BenchmarkFixtureIntegrityReport;
}): BenchmarkFixtureIntegrityReport {
  const changedFiles = [
    ...new Set([
      ...input.postAgent.changedFiles,
      ...input.finalSnapshot.changedFiles,
    ]),
  ].sort();
  const missingFiles = [
    ...new Set([
      ...input.postAgent.missingFiles,
      ...input.finalSnapshot.missingFiles,
    ]),
  ].sort();
  const status =
    input.postAgent.status === "pass" && input.finalSnapshot.status === "pass"
      ? "pass"
      : "fail";
  return {
    status,
    changedFiles,
    missingFiles,
    detail:
      status === "pass"
        ? `Verified ${input.fileCount} benchmark input fixture file(s) match the installed manifest in the execution workspace after the Agent exited and in the published final workspace snapshot.`
        : `Benchmark input fixture integrity failed. Execution workspace after the Agent exited: ${input.postAgent.detail} Published final workspace snapshot: ${input.finalSnapshot.detail}`,
  };
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may have left its process group; fall back to direct kill.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // A concurrently exiting process is already terminated.
  }
}

async function terminateResidualProcessGroup(
  child: ChildProcess,
): Promise<void> {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await delay(25);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The process group exited after SIGTERM.
  }
}

function resolveAgentCommand(
  agent: BenchmarkAgent,
  workspace: string,
  prompt: string,
  clashAccess?: AgentClashAccess,
  taskSkillContext?: string,
): { command: string; args: string[] } {
  if (agent.adapter === "codex") {
    const clashConfig = clashAccess?.mcp
      ? [
          "-c",
          `mcp_servers.clash.command=${JSON.stringify(process.execPath)}`,
          "-c",
          `mcp_servers.clash.args=${JSON.stringify([clashAccess.mcp.runtimePath])}`,
          "-c",
          `mcp_servers.clash.cwd=${JSON.stringify(clashAccess.mcp.pluginRoot)}`,
          "-c",
          "mcp_servers.clash.enabled=true",
          "-c",
          "mcp_servers.clash.required=true",
          "-c",
          "mcp_servers.clash.startup_timeout_sec=30",
          "-c",
          "mcp_servers.clash.tool_timeout_sec=600",
          "-c",
          'mcp_servers.clash.default_tools_approval_mode="approve"',
        ]
      : [];
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--ignore-user-config",
      "--disable",
      "plugins",
      "--disable",
      "remote_plugin",
      "--disable",
      "recommended_plugins",
      "--strict-config",
      "--ignore-rules",
      "--color",
      "never",
      "--sandbox",
      "workspace-write",
      ...(clashAccess?.sandboxRoots.flatMap((root) => ["--add-dir", root]) ??
        []),
      "-c",
      'approval_policy="never"',
      ...(clashAccess
        ? ["-c", "sandbox_workspace_write.network_access=true"]
        : []),
      "-C",
      workspace,
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.args ?? []),
      "-c",
      "skills.include_instructions=false",
      "-c",
      `developer_instructions=${JSON.stringify(taskSkillContext ?? "")}`,
      ...clashConfig,
      prompt,
    ];
    return { command: agent.command ?? "codex", args };
  }
  if (agent.adapter === "claude") {
    const mcpConfig = clashAccess?.mcp
      ? JSON.stringify({
          mcpServers: {
            clash: {
              command: process.execPath,
              args: [clashAccess.mcp.runtimePath],
              cwd: clashAccess.mcp.pluginRoot,
            },
          },
        })
      : undefined;
    const args = [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      [
        "Read,Write,Edit,Glob,Grep,Skill,Bash,WebFetch,WebSearch",
        ...(clashAccess?.mcp ? ["mcp__clash__*"] : []),
      ].join(","),
      "--setting-sources",
      "project,local",
      ...(clashAccess?.mcp
        ? [
            ...clashAccess.sandboxRoots.flatMap((root) => ["--add-dir", root]),
            "--strict-mcp-config",
            "--mcp-config",
            mcpConfig!,
          ]
        : []),
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.args ?? []),
      "--",
      prompt,
    ];
    return { command: agent.command ?? "claude", args };
  }
  if (agent.adapter === "pi") {
    const currentModulePath = fileURLToPath(import.meta.url);
    const extensionPath = join(
      dirname(currentModulePath),
      currentModulePath.endsWith(".ts")
        ? "pi-clash-extension.ts"
        : "pi-clash-extension.js",
    );
    const args = [
      "--print",
      "--mode",
      "json",
      "--no-session",
      "--no-extensions",
      ...(clashAccess?.mcp ? ["--extension", extensionPath] : []),
      "--no-skills",
      "--skill",
      join(workspace, ".agents", "skills"),
      "--no-prompt-templates",
      "--no-context-files",
      "--approve",
      "--thinking",
      "medium",
      ...(agent.provider ? ["--provider", agent.provider] : []),
      ...(agent.model ? ["--model", agent.model] : []),
      ...(agent.args ?? []),
      prompt,
    ];
    return { command: agent.command ?? "pi", args };
  }
  return { command: agent.command, args: agent.args ?? [] };
}

function isolatedAgentEnvironment(
  source: NodeJS.ProcessEnv,
  workspace: string,
): NodeJS.ProcessEnv {
  const env = sanitizedBenchmarkEnvironment(source);
  for (const key of Object.keys(env)) {
    if (key === "INIT_CWD" || key === "OLDPWD" || /^(npm|pnpm)_/i.test(key)) {
      delete env[key];
    }
  }
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  if (env[pathKey]) {
    env[pathKey] = env[pathKey]
      .split(delimiter)
      .filter((entry) => !entry.includes("node_modules/.bin"))
      .join(delimiter);
  }
  env.PWD = workspace;
  return env;
}

function claudeResultError(eventsText: string): string | undefined {
  let resultError: string | undefined;
  for (const line of eventsText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const result = event as {
        type?: unknown;
        subtype?: unknown;
        is_error?: unknown;
        error?: unknown;
        result?: unknown;
      };
      if (
        result.type !== "result" ||
        (result.is_error !== true && result.subtype === "success")
      ) {
        continue;
      }
      resultError =
        typeof result.error === "string" && result.error.trim()
          ? result.error.trim()
          : typeof result.result === "string" && result.result.trim()
            ? result.result.trim()
            : "Claude Code reported an unsuccessful result";
    } catch {
      // Raw output stays authoritative; malformed lines are covered by the
      // normalized trajectory and do not mask a later valid result event.
    }
  }
  return resultError;
}

function codexLifecycleError(eventsText: string): string | undefined {
  let lifecycleError: string | undefined;
  for (const line of eventsText.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as unknown;
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const item = event as {
        type?: unknown;
        message?: unknown;
        error?: unknown;
      };
      const nestedError =
        item.error &&
        typeof item.error === "object" &&
        !Array.isArray(item.error)
          ? (item.error as { message?: unknown }).message
          : item.error;
      const message =
        typeof nestedError === "string" && nestedError.trim()
          ? nestedError.trim()
          : typeof item.message === "string" && item.message.trim()
            ? item.message.trim()
            : undefined;
      if ((item.type === "error" || item.type === "turn.failed") && message) {
        lifecycleError = message;
      }
    } catch {
      // Raw output stays authoritative; malformed lines do not mask a later
      // valid public Codex lifecycle error.
    }
  }
  return lifecycleError;
}

async function runAgent(input: {
  agent: BenchmarkAgent;
  /** Canonical executable captured by the pre-execution Environment lock. */
  lockedExecutablePath?: string;
  benchmark: ArtifactBenchmarkCase;
  suiteRoot: string;
  workspace: string;
  logsRoot: string;
  promptPath: string;
  prompt: string;
  clashAccess?: AgentClashAccess;
  processScope: BenchmarkProcessScope;
}): Promise<AgentRunReport> {
  await mkdir(input.logsRoot, { recursive: true });
  const taskSkillContext =
    input.agent.adapter === "codex"
      ? await renderCodexTaskSkillContext(input.workspace)
      : undefined;
  if (taskSkillContext !== undefined) {
    await writeFile(
      join(input.logsRoot, "task-skills.md"),
      taskSkillContext,
      "utf8",
    );
  }
  const stdoutPath = join(
    input.logsRoot,
    input.agent.adapter === "codex" ||
      input.agent.adapter === "claude" ||
      input.agent.adapter === "pi"
      ? "events.jsonl"
      : "stdout.log",
  );
  const observedEventsPath = join(input.logsRoot, "observed-events.jsonl");
  const stderrPath = join(input.logsRoot, "stderr.log");
  const stderr = await open(stderrPath, "w");
  const startedAt = Date.now();
  const startedMonotonic = process.hrtime.bigint();
  const resolvedAgent = resolveAgentCommand(
    input.agent,
    input.workspace,
    input.prompt,
    input.clashAccess,
    taskSkillContext,
  );
  if (input.lockedExecutablePath) {
    resolvedAgent.command = input.lockedExecutablePath;
  }
  const inheritedEnvironment =
    input.agent.inheritEnv === false ? {} : process.env;
  const env = isolatedAgentEnvironment(
    {
      ...inheritedEnvironment,
      ...input.agent.env,
    },
    input.workspace,
  );
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLASH_")) delete env[key];
  }
  if (input.clashAccess?.cli) {
    env.CLASH_CLI_ENTRY_PATH = input.clashAccess.cli.agentCliPath;
    env.PATH = [dirname(input.clashAccess.cli.agentCliPath), env.PATH]
      .filter((entry): entry is string => Boolean(entry))
      .join(delimiter);
  }
  Object.assign(env, {
    CLASH_BENCH_WORKSPACE: input.workspace,
    CLASH_BENCH_CASE_ID: input.benchmark.id,
    CLASH_BENCH_OUTCOME_PATH: join(input.workspace, "outcome.json"),
    CLASH_BENCH_PROMPT_PATH: input.promptPath,
    CLASH_BENCH_PROMPT: input.prompt,
  });
  if (input.agent.adapter === "claude") {
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
  }
  if (input.agent.adapter === "pi") env.PI_TELEMETRY = "0";
  if (input.agent.adapter === "pi" && input.clashAccess?.mcp) {
    env.CLASH_PI_MCP_RUNTIME_PATH = input.clashAccess.mcp.runtimePath;
    env.CLASH_PI_MCP_PLUGIN_ROOT = input.clashAccess.mcp.pluginRoot;
  }

  let child: ChildProcess;
  try {
    child = input.processScope.track(
      spawn(resolvedAgent.command, resolvedAgent.args, {
        cwd: input.workspace,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", stderr.fd],
      }),
    );
  } catch (error) {
    await stderr.close();
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all([
      writeFile(stdoutPath, "", "utf8"),
      writeFile(observedEventsPath, "", "utf8"),
      writeFile(stderrPath, `${message}\n`, { encoding: "utf8", flag: "a" }),
    ]);
    const trajectoryPath = await writeNormalizedTrajectory({
      agent: input.agent,
      logsRoot: input.logsRoot,
      rawPath: stdoutPath,
      observedPath: observedEventsPath,
    });
    return {
      status: "spawn-error",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      stdoutPath,
      stderrPath,
      observedEventsPath,
      trajectoryPath,
      error: message,
    };
  }
  // Install lifecycle listeners before the first await after spawn. ENOENT and
  // similar spawn failures can otherwise emit before stderr.close() settles.
  const lifecyclePromise = new Promise<
    Pick<
      AgentRunReport,
      "status" | "exitCode" | "signal" | "durationMs" | "error"
    >
  >((resolveReport) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateChild(child, "SIGTERM");
      forceKillTimer = setTimeout(
        () => terminateChild(child, "SIGKILL"),
        1_000,
      );
    }, input.benchmark.timeoutMs);

    const finish = (
      report: Pick<AgentRunReport, "status" | "exitCode" | "signal" | "error">,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveReport({
        ...report,
        durationMs: Date.now() - startedAt,
      });
    };

    child.once("error", (error) => {
      void writeFile(stderrPath, `runner spawn error: ${error.message}\n`, {
        encoding: "utf8",
        flag: "a",
      });
      finish({
        status: "spawn-error",
        exitCode: null,
        signal: null,
        error: error.message,
      });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        status: timedOut
          ? "timed-out"
          : exitCode === 0
            ? "completed"
            : "failed",
        exitCode,
        signal,
        ...(timedOut
          ? {
              error: `Agent exceeded timeout of ${input.benchmark.timeoutMs}ms`,
            }
          : {}),
      });
    });
  });
  await stderr.close();
  if (!child.stdout) throw new Error("Agent stdout pipe is unavailable");
  const capture = captureObservedOutput({
    stream: child.stdout,
    rawPath: stdoutPath,
    observedPath: observedEventsPath,
    startedMonotonic,
  });

  let lifecycle = await lifecyclePromise;
  await capture;
  await terminateResidualProcessGroup(child);
  if (
    input.agent.adapter === "codex" &&
    (lifecycle.status === "completed" || lifecycle.status === "failed")
  ) {
    const lifecycleError = codexLifecycleError(
      await readFile(stdoutPath, "utf8"),
    );
    if (lifecycleError) {
      lifecycle = {
        ...lifecycle,
        status: "failed",
        error: lifecycleError,
      };
    }
  }
  if (input.agent.adapter === "claude" && lifecycle.status === "completed") {
    const resultError = claudeResultError(await readFile(stdoutPath, "utf8"));
    if (resultError) {
      lifecycle = {
        ...lifecycle,
        status: "failed",
        error: resultError,
      };
    }
  }
  const trajectoryPath = await writeNormalizedTrajectory({
    agent: input.agent,
    logsRoot: input.logsRoot,
    rawPath: stdoutPath,
    observedPath: observedEventsPath,
  });
  return {
    ...lifecycle,
    stdoutPath,
    stderrPath,
    observedEventsPath,
    trajectoryPath,
  };
}

async function createFreshDirectory(
  path: string,
  label: string,
): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${label} already exists: ${path}`);
    }
    throw error;
  }
}

export async function installCaseSkills(
  skillPaths: string[],
  suiteRoot: string,
  workspace: string,
): Promise<string[]> {
  const destinationRoots = [
    join(workspace, ".agents", "skills"),
    join(workspace, ".claude", "skills"),
  ];
  await Promise.all(
    destinationRoots.map((destinationRoot) =>
      mkdir(destinationRoot, { recursive: true }),
    ),
  );
  if (skillPaths.length === 0) return [];
  const installedNames = new Set<string>();
  for (const configuredPath of skillPaths) {
    const candidate = isAbsolute(configuredPath)
      ? configuredPath
      : resolve(suiteRoot, configuredPath);
    let source: string;
    try {
      source = await realpath(candidate);
    } catch (error) {
      throw new Error(
        `Unable to resolve benchmark skill '${configuredPath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sourceInfo = await stat(source);
    if (!sourceInfo.isDirectory())
      throw new Error(`Benchmark skill must be a directory: ${configuredPath}`);
    const skillDefinition = join(source, "SKILL.md");
    if (!(await stat(skillDefinition)).isFile()) {
      throw new Error(`Benchmark skill is missing SKILL.md: ${configuredPath}`);
    }
    const name = basename(source);
    assertSafePathSegment(name, "Skill name");
    if (installedNames.has(name))
      throw new Error(`Duplicate benchmark skill name: ${name}`);
    await Promise.all(
      destinationRoots.map((destinationRoot) =>
        cp(source, join(destinationRoot, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        }),
      ),
    );
    installedNames.add(name);
  }
  return [...installedNames];
}

async function resolveClashHost(
  agent: BenchmarkAgent,
  caseRoot: string,
  workspace: string,
): Promise<ResolvedClashHost | undefined> {
  if (
    (agent.adapter !== "codex" &&
      agent.adapter !== "claude" &&
      agent.adapter !== "pi") ||
    !agent.clashHost
  ) {
    return undefined;
  }

  const pluginRoot = await realpath(resolve(agent.clashHost.pluginRoot));
  if (!(await stat(pluginRoot)).isDirectory()) {
    throw new Error(`Clash plugin root must be a directory: ${pluginRoot}`);
  }
  const runtimeFiles = ["index.js", "local-api.cjs", "clash-cli.cjs"];
  for (const file of runtimeFiles) {
    const path = join(pluginRoot, "runtime", file);
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      throw new Error(
        `Clash plugin runtime is missing ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!info.isFile())
      throw new Error(`Clash plugin runtime entry must be a file: ${path}`);
  }

  const persistedClashHome = join(caseRoot, "clash-home");
  await mkdir(persistedClashHome, { recursive: true });
  // macOS limits Unix-domain socket paths to roughly 104 bytes. Its default
  // per-user temp directory can make the plugin-host IPC path exceed that
  // limit, so keep the runtime-only home
  // under the short /tmp alias there. Durable case data still lives in the
  // configured benchmark output root.
  const runtimeTempRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
  const runtimeRoot = await mkdtemp(join(runtimeTempRoot, "clash-eval-"));
  try {
    const clashHome = join(runtimeRoot, "home");
    await symlink(persistedClashHome, clashHome, "dir");
    const localDataDir = join(clashHome, "local-api");
    await mkdir(localDataDir, { recursive: true });
    return {
      pluginRoot,
      runtimePath: join(pluginRoot, "runtime", "index.js"),
      workspace,
      profile: agent.clashHost.profile,
      runtimeRoot,
      clashHome,
      persistedClashHome,
      localDataDir,
      localApiPluginSocket: join(clashHome, "sockets", "plugin-host.sock"),
      agentMemberId: `headless-eval-${basename(caseRoot)}`,
      agentName: `Headless Eval ${basename(caseRoot)}`,
    };
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM",
    );
  }
}

function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolveActive) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveActive(active);
    };
    const timer = setTimeout(() => finish(false), 200);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function startClashHost(
  host: ResolvedClashHost,
  logsRoot: string,
  processScope: BenchmarkProcessScope,
): Promise<RunningClashHost> {
  await mkdir(logsRoot, { recursive: true });
  const stdoutPath = join(logsRoot, "clash-host.stdout.log");
  const stderrPath = join(logsRoot, "clash-host.stderr.log");
  const stdout = await open(stdoutPath, "w");
  const stderr = await open(stderrPath, "w");
  const runDir = join(host.clashHome, "run");
  await mkdir(runDir, { recursive: true });
  const ownerClientId = `headless-eval-${process.pid}-${Date.now()}`;
  const env: NodeJS.ProcessEnv = {
    ...sanitizedBenchmarkEnvironment(process.env),
    CLASH_PROFILE: host.profile,
    CLASH_HOME: host.clashHome,
    CLASH_LOCAL_DATA_DIR: host.localDataDir,
    CLASH_HOST_RUN_DIR: runDir,
    CLASH_PLUGIN_OWNER_CLIENT_ID: ownerClientId,
    CLASH_CLI_ENTRY_PATH: join(host.pluginRoot, "runtime", "clash-cli.cjs"),
    CLASH_LOCAL_API_WRAPPER_ENTRY: "1",
    CLASH_NODE_EXEC_PATH: process.execPath,
    CLASH_AGENT_BUNDLE_ROOT: join(host.pluginRoot, "runtime", "agents"),
    CLASH_BUILTIN_PLUGIN_ROOT: host.pluginRoot,
    CLASH_WORKSPACE_ROOT: host.workspace,
    CLASH_AGENT_MEMBER_ID: host.agentMemberId,
    CLASH_AGENT_NAME: host.agentName,
    CLASH_PLUGIN_HOST_SOCKET: "",
    CLASH_API_URL: "",
    PORT: "0",
  };
  let spawnError: Error | undefined;
  let child: ChildProcess;
  try {
    child = processScope.track(
      spawn(
        process.execPath,
        [join(host.pluginRoot, "runtime", "local-api.cjs")],
        {
          cwd: host.pluginRoot,
          env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", stdout.fd, stderr.fd],
        },
      ),
    );
  } catch (error) {
    await Promise.all([stdout.close(), stderr.close()]);
    throw error;
  }
  child.once("error", (error) => {
    spawnError = error;
  });
  await Promise.all([stdout.close(), stderr.close()]);

  const discoveryPath = join(runDir, "host.json");
  const deadline = Date.now() + 15_000;
  try {
    while (Date.now() < deadline) {
      if (spawnError)
        throw new Error(
          `Unable to start bundled Clash host: ${spawnError.message}`,
        );
      if (childHasExited(child)) {
        const detail = await readFile(stderrPath, "utf8").catch(() => "");
        throw new Error(
          `Bundled Clash host exited during startup.${detail ? `\n${detail}` : ""}`,
        );
      }
      try {
        const record = JSON.parse(await readFile(discoveryPath, "utf8")) as {
          endpoint?: unknown;
          pid?: unknown;
          profile?: unknown;
          launchMode?: unknown;
          startedBy?: unknown;
          ownerClientId?: unknown;
          agentCliPath?: unknown;
        };
        if (
          typeof record.endpoint === "string" &&
          typeof record.pid === "number" &&
          record.pid === child.pid &&
          processExists(record.pid) &&
          record.profile === host.profile &&
          record.launchMode === "user-service" &&
          record.startedBy === "plugin" &&
          typeof record.agentCliPath === "string"
        ) {
          const response = await fetch(
            new URL("/api/v1/models/catalog", record.endpoint),
            {
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) {
            const detail = (await response.text()).trim().slice(0, 2_000);
            throw new Error(
              `Bundled Clash host warmup failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
            );
          }
          const pluginDeadline = Date.now() + 5_000;
          while (
            Date.now() < pluginDeadline &&
            !(await socketIsActive(host.localApiPluginSocket))
          ) {
            await delay(25);
          }
          if (!(await socketIsActive(host.localApiPluginSocket))) {
            throw new Error(
              `Bundled Clash plugin runtime did not become ready: ${host.localApiPluginSocket}`,
            );
          }
          return {
            ...host,
            endpoint: record.endpoint,
            agentCliPath: record.agentCliPath,
            readyAt: new Date().toISOString(),
            child,
          };
        }
      } catch (error) {
        if (!(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )) {
          throw error;
        }
      }
      await delay(50);
    }
    throw new Error(
      `Timed out waiting for bundled Clash host discovery: ${discoveryPath}`,
    );
  } catch (error) {
    await terminateChildAndWait(child);
    throw error;
  }
}

async function stopClashHost(host: RunningClashHost): Promise<void> {
  await terminateChildAndWait(host.child);
}

type ProjectHostController = {
  ready: Promise<ProjectHostReady>;
  stop(): Promise<void>;
};

function clashClientEnvironment(
  host: RunningClashHost,
  workspace: string,
): NodeJS.ProcessEnv {
  return {
    CLASH_PROFILE: host.profile,
    CLASH_HOME: host.clashHome,
    CLASH_LOCAL_DATA_DIR: host.localDataDir,
    CLASH_API_URL: host.endpoint,
    CLASH_CLI_ENTRY_PATH: host.agentCliPath,
    CLASH_NODE_EXEC_PATH: process.execPath,
    CLASH_WORKSPACE_ROOT: workspace,
    CLASH_AGENT_MEMBER_ID: host.agentMemberId,
    CLASH_AGENT_NAME: host.agentName,
    CLASH_PLUGIN_HOST_SOCKET: "",
  };
}

function clashProjectEnvironment(
  host: RunningClashHost,
  workspace: string,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedBenchmarkEnvironment(process.env),
    ...clashClientEnvironment(host, workspace),
  };
}

async function waitForProcessClose(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (childHasExited(child)) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolveExit(false);
    }, timeoutMs);
    const onClose = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("close", onClose);
  });
}

async function pathIsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function runWorkspaceCli(input: {
  cliPath: string;
  args: string[];
  workspace: string;
  environment: NodeJS.ProcessEnv;
  stdoutPath: string;
  stderrPath: string;
  processScope: BenchmarkProcessScope;
  label: string;
  timeoutMs?: number;
}): Promise<string> {
  let stdout = "";
  let stderr = "";
  let child: ChildProcess;
  try {
    child = input.processScope.track(
      spawn(input.cliPath, input.args, {
        cwd: input.workspace,
        env: input.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    throw new Error(
      `Unable to start packaged Clash ${input.label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveResult) => {
    let settled = false;
    let timedOut = false;
    const finish = (value: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      void terminateChildAndWait(child).then(() => {
        finish({
          exitCode: null,
          signal: "SIGTERM",
          error: new Error(`Packaged Clash ${input.label} timed out`),
        });
      });
    }, input.timeoutMs ?? 15_000);
    child.once("error", (error) =>
      finish({ exitCode: null, signal: null, error }),
    );
    child.once("close", (exitCode, signal) => {
      if (!timedOut) finish({ exitCode, signal });
    });
  });
  await Promise.all([
    writeFile(input.stdoutPath, stdout, "utf8"),
    writeFile(input.stderrPath, stderr, "utf8"),
  ]);
  if (result.error) throw result.error;
  if (result.exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `Packaged Clash ${input.label} failed with exit code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}${detail ? `: ${detail.slice(0, 2_000)}` : ""}`,
    );
  }
  return stdout;
}

export async function prepareBenchmarkWorkspaceBinding(input: {
  cliPath: string;
  workspace: string;
  caseRoot: string;
  logsRoot: string;
  generatedProjectId: string;
  environment: NodeJS.ProcessEnv;
  processScope?: BenchmarkProcessScope;
}): Promise<BenchmarkWorkspaceBinding> {
  const markerPath = join(input.workspace, ".clash", "project.toml");
  const hadMarker = await pathIsFile(markerPath);
  const originalMarker = hadMarker
    ? await readFile(markerPath, "utf8")
    : undefined;
  const args = hadMarker
    ? ["init", "--json"]
    : ["init", "--project", input.generatedProjectId, "--json"];
  const stdout = await runWorkspaceCli({
    cliPath: input.cliPath,
    args,
    workspace: input.workspace,
    environment: input.environment,
    stdoutPath: join(input.logsRoot, "clash-workspace-init.stdout.log"),
    stderrPath: join(input.logsRoot, "clash-workspace-init.stderr.log"),
    processScope: input.processScope ?? new BenchmarkProcessScope(),
    label: "workspace init",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(
      `Packaged Clash workspace init returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parsed as Record<string, unknown>;
  if (
    typeof result.projectId !== "string" ||
    !result.projectId.trim() ||
    typeof result.workspaceId !== "string" ||
    !result.workspaceId.trim() ||
    typeof result.reused !== "boolean"
  ) {
    throw new Error(
      "Packaged Clash workspace init did not return projectId, workspaceId, and reused",
    );
  }
  if (hadMarker && result.reused !== true) {
    throw new Error(
      "Packaged Clash workspace init replaced an existing project marker instead of reusing it",
    );
  }
  const marker = await readFile(markerPath, "utf8");
  const markerProjectId = /^project_id\s*=\s*"([^"]+)"/mu.exec(marker)?.[1];
  const markerWorkspaceId = /^workspace_id\s*=\s*"([^"]+)"/mu.exec(marker)?.[1];
  if (
    markerProjectId !== result.projectId ||
    markerWorkspaceId !== result.workspaceId
  ) {
    throw new Error(
      "Packaged Clash workspace init result does not match the persisted project marker",
    );
  }
  if (hadMarker && marker !== originalMarker) {
    throw new Error(
      "Packaged Clash workspace init modified an existing project marker",
    );
  }
  if (
    !hadMarker &&
    (result.reused !== false || result.projectId !== input.generatedProjectId)
  ) {
    throw new Error(
      "Packaged Clash workspace init did not create the requested isolated project",
    );
  }
  const binding: BenchmarkWorkspaceBinding = {
    projectId: result.projectId,
    workspaceId: result.workspaceId,
    markerPath,
    markerSha256: sha256Bytes(marker),
    initDisposition: result.reused ? "reused" : "created",
  };
  await writeJson(join(input.caseRoot, "clash-workspace-init.json"), {
    schemaVersion: 1,
    status: "initialized",
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    initDisposition: binding.initDisposition,
    markerPath: ".clash/project.toml",
    markerSha256: binding.markerSha256,
  });
  return binding;
}

function startProjectHostController(input: {
  host: RunningClashHost;
  binding: BenchmarkWorkspaceBinding;
  workspace: string;
  caseRoot: string;
  agentReadyPath: string;
}): ProjectHostController {
  const reportPath = join(input.caseRoot, "clash-project-host.json");

  const task = (async (): Promise<ProjectHostReady> => {
    const markerPath = join(input.workspace, ".clash", "project.toml");
    const marker = await readFile(markerPath, "utf8");
    const projectId = /^project_id\s*=\s*"([^"]+)"/mu.exec(marker)?.[1];
    if (
      projectId !== input.binding.projectId ||
      sha256Bytes(marker) !== input.binding.markerSha256
    ) {
      throw new Error(
        "Workspace project marker changed between initialization and Host activation",
      );
    }
    const readyAt = new Date().toISOString();
    const ready: ProjectHostReady = {
      projectId,
      workspaceId: input.binding.workspaceId,
      initDisposition: input.binding.initDisposition,
      markerSha256: input.binding.markerSha256,
      apiUrl: input.host.endpoint,
      readyAt,
    };
    await assertProjectHostReady(
      productHostContext({ ready, workspace: input.workspace }),
    );
    const publicReport = {
      schemaVersion: 1,
      status: "ready",
      projectId,
      workspaceId: input.binding.workspaceId,
      initDisposition: input.binding.initDisposition,
      markerSha256: input.binding.markerSha256,
      agentMemberId: input.host.agentMemberId,
      localApiReadyAt: input.host.readyAt,
      readyAt,
    };
    await Promise.all([
      writeJson(reportPath, {
        ...publicReport,
        apiUrl: input.host.endpoint,
        transport: "project-host-http",
      }),
      writeJson(input.agentReadyPath, publicReport),
    ]);
    return ready;
  })();
  const settledTask = task.catch(async (error): Promise<never> => {
    const report = {
      schemaVersion: 1,
      status: "failed",
      projectId: input.binding.projectId,
      workspaceId: input.binding.workspaceId,
      initDisposition: input.binding.initDisposition,
      error: error instanceof Error ? error.message : String(error),
    };
    await Promise.all([
      writeJson(reportPath, report),
      writeJson(input.agentReadyPath, report),
    ]);
    throw error;
  });

  return {
    ready: settledTask,
    stop: async () => undefined,
  };
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function findFilesNamed(
  root: string,
  targetName: string,
): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === targetName) {
        matches.push(path);
      }
    }
  };
  await visit(root);
  return matches.sort();
}

function parseProjectDirectorStage(value: unknown): ProjectDirectorStage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Director readback stage must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim())
    throw new Error("Director readback stage id is required");
  if (typeof raw.name !== "string" || !raw.name.trim())
    throw new Error(`Director Stage ${raw.id} name is required`);
  if (typeof raw.revisionId !== "string" || !raw.revisionId.trim()) {
    throw new Error(`Director Stage ${raw.id} revisionId is required`);
  }
  if (!raw.owner || typeof raw.owner !== "object" || Array.isArray(raw.owner)) {
    throw new Error(`Director Stage ${raw.id} owner is invalid`);
  }
  const owner = raw.owner as Record<string, unknown>;
  const parsedOwner: ProjectDirectorStage["owner"] =
    owner.kind === "project"
      ? { kind: "project" }
      : owner.kind === "canvas-action" &&
          typeof owner.canvasId === "string" &&
          typeof owner.actionNodeId === "string"
        ? {
            kind: "canvas-action",
            canvasId: owner.canvasId,
            actionNodeId: owner.actionNodeId,
          }
        : (() => {
            throw new Error(`Director Stage ${raw.id} owner is invalid`);
          })();
  const state = DirectorStageStateSchema.safeParse(raw.state);
  if (!state.success)
    throw new Error(`Director Stage ${raw.id} state is invalid`);
  return {
    id: raw.id,
    name: raw.name,
    revisionId: raw.revisionId,
    owner: parsedOwner,
    state: state.data,
  };
}

export function directorCaptureTargetsStageRevision(
  capture: { stageId: string; sourceStageRevisionId: string },
  stage: Pick<ProjectDirectorStage, "id" | "revisionId">,
): boolean {
  return (
    capture.stageId === stage.id &&
    capture.sourceStageRevisionId === stage.revisionId
  );
}

export function directorCaptureFrameId(frame: {
  artifactId?: unknown;
  label?: unknown;
}): string | undefined {
  const value =
    typeof frame.artifactId === "string"
      ? frame.artifactId
      : typeof frame.label === "string"
        ? frame.label
        : undefined;
  return value?.trim() ? value : undefined;
}

async function verifyDirectorCaptureWithProjectAssets(input: {
  ready: ProjectHostReady;
  stage: ProjectDirectorStage;
  receiptStateSha256: string;
  actionRunIds: unknown;
  frames: Array<
    Omit<
      DirectorReadbackReport["captures"][number]["frames"][number],
      "actionRun" | "outputCommit"
    >
  >;
}): Promise<DirectorReadbackReport["captures"][number]["frames"]> {
  const liveStateSha256 = sha256Bytes(JSON.stringify(input.stage.state));
  if (input.receiptStateSha256 !== liveStateSha256) {
    throw new Error(
      `capture receipt state SHA-256 does not match live Director Stage ${input.stage.id}`,
    );
  }
  const client = createProjectAssetHttpClient({
    endpoint: input.ready.apiUrl,
    fetch: (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  const actionRunIds = input.actionRunIds;
  if (
    !Array.isArray(actionRunIds) ||
    actionRunIds.length !== input.frames.length ||
    !actionRunIds.every(
      (id): id is string => typeof id === "string" && Boolean(id.trim()),
    )
  ) {
    throw new Error(
      "Director capture receipt must identify one native Action Run per frame",
    );
  }
  const generators = createGeneratorClient((path, init) =>
    fetch(new URL(path, input.ready.apiUrl), {
      ...init,
      signal: AbortSignal.timeout(15_000),
    }),
  );
  return Promise.all(
    input.frames.map(async (frame, index) => {
      if (!frame.projectAssetId) {
        throw new Error(
          `Director capture frame '${frame.artifactId}' is missing its Project Asset identity`,
        );
      }
      const assetId = frame.projectAssetId;
      let observed;
      try {
        observed = await client.get({
          projectId: input.ready.projectId,
          assetId,
        });
      } catch (error) {
        throw new Error(
          `Director capture frame '${frame.artifactId}' Project Asset ${assetId} Host read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const asset = observed.value;
      if (asset.id !== assetId) {
        throw new Error(
          `Director capture frame '${frame.artifactId}' Host returned a different Project Asset identity for ${assetId}`,
        );
      }
      if (asset.kind !== "image") {
        throw new Error(
          `Director capture Project Asset ${assetId} has media kind '${asset.kind}', expected 'image'`,
        );
      }
      if (asset.lifecycle.state !== "active") {
        throw new Error(
          `Director capture Project Asset ${assetId} is not active (${asset.lifecycle.state})`,
        );
      }
      if (asset.status !== "ready" || !asset.url) {
        throw new Error(
          `Director capture Project Asset ${assetId} is not ready with immutable media bytes`,
        );
      }
      const declaredByteLength = asset.metadata.bytes;
      const declaredContentType = asset.metadata.contentType
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (declaredByteLength === undefined) {
        throw new Error(
          `Director capture Project Asset ${assetId} is missing its authoritative byte length`,
        );
      }
      if (!declaredContentType?.startsWith("image/")) {
        throw new Error(
          `Director capture Project Asset ${assetId} is missing an image media content type`,
        );
      }
      const mediaResponse = await fetch(asset.url, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!mediaResponse.ok) {
        throw new Error(
          `Director capture Project Asset ${assetId} media readback failed with HTTP ${mediaResponse.status}`,
        );
      }
      const fetchedContentType = mediaResponse.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      if (
        !fetchedContentType?.startsWith("image/") ||
        fetchedContentType !== declaredContentType
      ) {
        throw new Error(
          `Director capture Project Asset ${assetId} fetched media kind does not match '${declaredContentType}'`,
        );
      }
      const bytes = new Uint8Array(await mediaResponse.arrayBuffer());
      if (bytes.byteLength !== declaredByteLength) {
        throw new Error(
          `Director capture Project Asset ${assetId} byte length ${bytes.byteLength} does not match Host metadata ${declaredByteLength}`,
        );
      }
      const fetchedSha256 = sha256Bytes(bytes);
      if (fetchedSha256 !== frame.sha256) {
        throw new Error(
          `Director capture Project Asset ${assetId} fetched SHA-256 ${fetchedSha256} does not match capture artifact SHA-256 ${frame.sha256}`,
        );
      }

      const actionRunId = actionRunIds[index]!;
      const runResponse = (await generators.getActionRun(
        input.ready.projectId,
        actionRunId,
      )) as { run?: unknown };
      const actionRun = ProjectActionRunSchema.parse(runResponse.run);
      if (
        actionRun.actionRunId !== actionRunId ||
        actionRun.status !== "succeeded" ||
        actionRun.generatorRevision.generatorId !== input.stage.id ||
        actionRun.generatorRevision.generatorRevisionId !==
          input.stage.revisionId ||
        actionRun.actionId !== "capture-frame" ||
        actionRun.executor.pluginId !== "clash.director" ||
        actionRun.executor.exportId !== "capture-frame" ||
        actionRun.parameters.label !== frame.artifactId ||
        actionRun.parameters.timeSeconds !== frame.timeSeconds ||
        actionRun.parameters.aspectRatio !== frame.aspectRatio ||
        actionRun.parameters.longEdge !== Math.max(frame.width, frame.height) ||
        !actionRun.outputContract.some(
          (output) =>
            output.slot === "frame" &&
            output.assetType.kind === "media" &&
            output.assetType.mediaKind === "image",
        )
      ) {
        throw new Error(
          `Director capture Action Run ${actionRunId} does not match the Stage revision and frame parameters`,
        );
      }
      const commitResponse = (await generators.getOutputCommit(
        input.ready.projectId,
        actionRunId,
        "frame",
      )) as { commit?: unknown };
      const outputCommit = OutputCommitSchema.parse(commitResponse.commit);
      if (
        outputCommit.actionRunId !== actionRunId ||
        outputCommit.outputSlot !== "frame" ||
        outputCommit.itemKey !== undefined ||
        outputCommit.asset.kind !== "media" ||
        outputCommit.asset.projectAssetId !== assetId
      ) {
        throw new Error(
          `Director Output Commit does not identify the capture Asset ${assetId}`,
        );
      }
      return {
        ...frame,
        actionRun,
        outputCommit,
      };
    }),
  );
}

async function captureDirectorReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  caseRoot: string;
  ready?: ProjectHostReady;
}): Promise<DirectorReadbackReport> {
  const reportPath = join(input.caseRoot, "director-readback.json");
  const matchedArtifactIds: string[] = [];
  const stages: DirectorReadbackReport["stages"] = [];
  const matches: DirectorReadbackReport["matches"] = [];
  const captures: DirectorReadbackReport["captures"] = [];
  const imageMatches: DirectorReadbackReport["imageMatches"] = [];
  const captureVerificationErrors: string[] = [];
  try {
    if (!input.ready)
      throw new Error("Clash Project Host did not become ready");
    const host = productHostContext({
      ready: input.ready,
      workspace: input.workspace,
    });
    await assertProjectHostReady(host);
    await assertWorkspaceProject(input.workspace, input.ready.projectId);
    const response = await requestProjectHost<
      ProjectHostResponse & {
        stages?: unknown;
        versions?: unknown;
      }
    >({
      ...host,
      command: { action: "list_director_stages" },
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Director host readback response must be an object");
    }
    const raw = response as {
      error?: unknown;
      stages?: unknown;
      versions?: unknown;
    };
    if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
    if (
      !Array.isArray(raw.stages) ||
      !raw.versions ||
      typeof raw.versions !== "object" ||
      Array.isArray(raw.versions)
    ) {
      throw new Error(
        "Director host readback response is missing stages or receipts",
      );
    }
    const versions = raw.versions as Record<string, unknown>;
    const parsedStages = raw.stages.map(parseProjectDirectorStage);
    for (const stage of parsedStages) {
      const readToken = projectDirectorStageReadToken(stage);
      const hostReceipt = versions[stage.id];
      const prefix = `${readToken}:receipt:`;
      if (
        typeof hostReceipt !== "string" ||
        !hostReceipt.startsWith(prefix) ||
        !/^[A-Za-z0-9._~-]{1,256}$/u.test(hostReceipt.slice(prefix.length))
      ) {
        throw new Error(
          `Director Stage ${stage.id} is missing a live Host read receipt`,
        );
      }
      stages.push({
        id: stage.id,
        name: stage.name,
        revisionId: stage.revisionId,
        readToken,
        hostReceipt,
        stateSha256: sha256Json(stage.state),
      });
    }

    const expectedArtifactIds =
      input.benchmark.execution?.productReadback?.artifactIds ??
      input.benchmark.rubric
        .filter((rubric) => rubric.type === "director-stage")
        .map((rubric) => rubric.artifactId);
    const submission = await loadSubmission(input.workspace);
    if (submission.error) throw new Error(submission.error);
    const artifactById = new Map(
      submission.artifacts.map((artifact) => [
        artifact.descriptor.id,
        artifact,
      ]),
    );
    const directorArtifactIds = expectedArtifactIds.filter(
      (artifactId) =>
        artifactById.get(artifactId)?.descriptor.kind === "director-stage",
    );
    const imageArtifactIds = expectedArtifactIds.filter(
      (artifactId) => artifactById.get(artifactId)?.descriptor.kind === "image",
    );
    for (const artifactId of directorArtifactIds) {
      const artifact = artifactById.get(artifactId);
      if (!artifact?.content || artifact.error) {
        throw new Error(
          `Director artifact '${artifactId}' is unavailable for product readback matching`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(artifact.content.toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(
          `Director artifact '${artifactId}' is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const state = DirectorStageStateSchema.safeParse(
        directorStageArtifactState(value),
      );
      if (!state.success)
        throw new Error(
          `Director artifact '${artifactId}' is not a valid Stage state`,
        );
      const stateSha256 = sha256Json(state.data);
      const matchedStage = stages.find(
        (stage) => stage.stateSha256 === stateSha256,
      );
      if (!matchedStage) {
        throw new Error(
          `Director artifact '${artifactId}' does not match any live product Stage`,
        );
      }
      matchedArtifactIds.push(artifactId);
      matches.push({
        artifactId,
        stageId: matchedStage.id,
        stateSha256,
      });
    }

    const matchedStageIds = new Set(matches.map((match) => match.stageId));
    for (const receiptPath of await findFilesNamed(
      input.workspace,
      "capture.json",
    )) {
      let receipt: unknown;
      try {
        receipt = JSON.parse(await readFile(receiptPath, "utf8")) as unknown;
      } catch {
        continue;
      }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
        continue;
      const value = receipt as {
        captured?: unknown;
        stageId?: unknown;
        sourceStageRevisionId?: unknown;
        verifiedStageRevisionId?: unknown;
        renderer?: unknown;
        stateSha256?: unknown;
        frames?: unknown;
        actionRunIds?: unknown;
      };
      if (
        value.captured !== true ||
        typeof value.stageId !== "string" ||
        !matchedStageIds.has(value.stageId) ||
        typeof value.sourceStageRevisionId !== "string" ||
        (value.verifiedStageRevisionId !== undefined &&
          value.sourceStageRevisionId !== value.verifiedStageRevisionId) ||
        !value.renderer ||
        typeof value.renderer !== "object" ||
        Array.isArray(value.renderer) ||
        (value.renderer as { id?: unknown }).id !==
          "clash-director-viewport-webgl" ||
        (value.renderer as { contractVersion?: unknown }).contractVersion !==
          1 ||
        typeof value.stateSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.stateSha256) ||
        !Array.isArray(value.frames)
      )
        continue;
      const liveStage = parsedStages.find((stage) =>
        directorCaptureTargetsStageRevision(
          {
            stageId: value.stageId as string,
            sourceStageRevisionId: value.sourceStageRevisionId as string,
          },
          stage,
        ),
      );
      if (!liveStage) continue;
      const frames = value.frames.flatMap((frame) => {
        if (!frame || typeof frame !== "object" || Array.isArray(frame))
          return [];
        const candidate = frame as {
          artifactId?: unknown;
          label?: unknown;
          projectAssetId?: unknown;
          sha256?: unknown;
          timeSeconds?: unknown;
          aspectRatio?: unknown;
          width?: unknown;
          height?: unknown;
        };
        const artifactId = directorCaptureFrameId(candidate);
        const projectAssetId =
          typeof candidate.projectAssetId === "string" &&
          candidate.projectAssetId.trim()
            ? candidate.projectAssetId.trim()
            : undefined;
        return artifactId &&
          (candidate.projectAssetId === undefined || projectAssetId) &&
          typeof candidate.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(candidate.sha256) &&
          typeof candidate.timeSeconds === "number" &&
          typeof candidate.aspectRatio === "string" &&
          typeof candidate.width === "number" &&
          Number.isInteger(candidate.width) &&
          candidate.width > 0 &&
          typeof candidate.height === "number" &&
          Number.isInteger(candidate.height) &&
          candidate.height > 0
          ? [
              {
                artifactId,
                ...(projectAssetId ? { projectAssetId } : {}),
                sha256: candidate.sha256,
                timeSeconds: candidate.timeSeconds,
                aspectRatio: candidate.aspectRatio,
                width: candidate.width,
                height: candidate.height,
              },
            ]
          : [];
      });
      if (frames.length !== value.frames.length) continue;
      let verifiedFrames: DirectorReadbackReport["captures"][number]["frames"];
      try {
        verifiedFrames = await verifyDirectorCaptureWithProjectAssets({
          ready: input.ready,
          stage: liveStage,
          receiptStateSha256: value.stateSha256,
          actionRunIds: value.actionRunIds,
          frames,
        });
      } catch (error) {
        captureVerificationErrors.push(
          `${relative(input.workspace, receiptPath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      captures.push({
        receiptPath: relative(input.workspace, receiptPath),
        stageId: value.stageId,
        stageRevisionId: value.sourceStageRevisionId,
        renderer: "clash-director-viewport-webgl@1",
        stateSha256: value.stateSha256,
        frames: verifiedFrames,
      });
    }

    for (const artifactId of imageArtifactIds) {
      const artifact = artifactById.get(artifactId);
      if (!artifact?.evidence || artifact.error) {
        throw new Error(
          `Director capture artifact '${artifactId}' is unavailable for product readback matching`,
        );
      }
      const match = captures
        .flatMap((capture) =>
          capture.frames.map((frame) => ({ capture, frame })),
        )
        .find(({ frame }) => frame.sha256 === artifact.evidence!.sha256);
      if (!match) {
        throw new Error(
          [
            `Director capture artifact '${artifactId}' does not match a trusted product capture receipt`,
            ...captureVerificationErrors,
          ].join(". "),
        );
      }
      matchedArtifactIds.push(artifactId);
      imageMatches.push({
        artifactId,
        stageId: match.capture.stageId,
        captureArtifactId: match.frame.artifactId,
        ...(match.frame.projectAssetId
          ? { projectAssetId: match.frame.projectAssetId }
          : {}),
        sha256: match.frame.sha256,
      });
    }
    const report: DirectorReadbackReport = {
      schemaVersion: 1,
      status: "pass",
      projectId: input.ready.projectId,
      matchedArtifactIds,
      stages,
      matches,
      captures,
      imageMatches,
      detail: `Matched ${matches.length} Director Stage artifact(s) and ${imageMatches.length} product-rendered capture frame(s) with Host receipts.`,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    const report: DirectorReadbackReport = {
      schemaVersion: 1,
      status: "fail",
      projectId: input.ready?.projectId ?? null,
      matchedArtifactIds,
      stages,
      matches,
      captures,
      imageMatches,
      detail: error instanceof Error ? error.message : String(error),
    };
    await writeJson(reportPath, report);
    return report;
  }
}

function combineProductReadbackReports(
  reports: Array<
    | AssetProductReadbackReport
    | DirectorReadbackReport
    | RemotionProductReadbackReport
    | TimelineProductReadbackReport
  >,
  options: { requireMixedLineage?: boolean } = {},
): CombinedProductReadbackReport {
  const matchedArtifactIds = [
    ...new Set(reports.flatMap((report) => report.matchedArtifactIds)),
  ];
  const projectIds = [
    ...new Set(
      reports
        .map((report) => report.projectId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const directorReport = reports.find(
    (report): report is DirectorReadbackReport => "captures" in report,
  );
  const remotionReport = reports.find(
    (report): report is RemotionProductReadbackReport =>
      "sourceNodes" in report,
  );
  const mixedLineageProjectAssetIds = mixedProductLineageProjectAssetIds({
    ...(directorReport ? { director: directorReport } : {}),
    ...(remotionReport ? { remotion: remotionReport } : {}),
  });
  const mixedLineageValid =
    !options.requireMixedLineage || mixedLineageProjectAssetIds.length > 0;
  const readbacksValid =
    reports.length > 0 &&
    reports.every((candidate) => candidate.status === "pass");
  return {
    schemaVersion: 1,
    status:
      readbacksValid && projectIds.length === 1 && mixedLineageValid
        ? "pass"
        : "fail",
    projectId: projectIds.length === 1 ? projectIds[0]! : null,
    matchedArtifactIds,
    reports,
    ...(options.requireMixedLineage
      ? {
          mixedLineage: {
            projectAssetIds: mixedLineageProjectAssetIds,
          },
        }
      : {}),
    detail:
      reports.length === 0
        ? "No supported trusted product readback was executed."
        : [
            ...reports.map((candidate) => candidate.detail),
            ...(options.requireMixedLineage && !mixedLineageValid
              ? [
                  "No exact Director capture Project Asset from the verified Stage revision is referenced by a matched canonical Timeline.",
                ]
              : []),
          ].join(" "),
  };
}

export async function captureRequiredProductReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  caseRoot: string;
  ready?: ProjectHostReady;
}): Promise<TrustedProductReadback | undefined> {
  const readbackMechanism =
    input.benchmark.execution?.productReadback?.mechanism;
  const requiresDirectorReadback = input.benchmark.rubric.some(
    (rubric) => rubric.type === "director-stage",
  );
  const requiresRemotionReadback =
    readbackMechanism === "remotion-component-and-render-receipt" ||
    readbackMechanism === "mixed-remotion-lineage-and-render-receipt";
  const requiresTimelineReadback =
    readbackMechanism === "timeline-state-and-render-receipt";
  const requiresAssetReadback =
    readbackMechanism === "asset-bytes-and-host-receipt";
  if (
    !requiresAssetReadback &&
    !requiresDirectorReadback &&
    !requiresRemotionReadback &&
    !requiresTimelineReadback
  ) {
    return undefined;
  }

  const readbacks: Array<
    | AssetProductReadbackReport
    | DirectorReadbackReport
    | RemotionProductReadbackReport
    | TimelineProductReadbackReport
  > = [];
  if (requiresAssetReadback) {
    readbacks.push(
      await captureAssetProductReadback({
        benchmark: input.benchmark,
        workspace: input.workspace,
        caseRoot: input.caseRoot,
        ready: input.ready,
      }),
    );
  }
  if (requiresDirectorReadback) {
    readbacks.push(
      await captureDirectorReadback({
        benchmark: input.benchmark,
        workspace: input.workspace,
        caseRoot: input.caseRoot,
        ready: input.ready,
      }),
    );
  }
  if (requiresRemotionReadback) {
    readbacks.push(
      await captureRemotionProductReadback({
        benchmark: input.benchmark,
        workspace: input.workspace,
        caseRoot: input.caseRoot,
        ready: input.ready,
      }),
    );
  } else if (requiresTimelineReadback) {
    readbacks.push(
      await captureTimelineProductReadback({
        benchmark: input.benchmark,
        workspace: input.workspace,
        caseRoot: input.caseRoot,
        ready: input.ready,
      }),
    );
  }
  if (readbacks.length === 1) {
    return {
      report: readbacks[0]!,
      receiptPath: requiresAssetReadback
        ? "asset-readback.json"
        : requiresDirectorReadback
          ? "director-readback.json"
          : requiresRemotionReadback
            ? "remotion-readback.json"
            : "timeline-readback.json",
    };
  }
  const report = combineProductReadbackReports(readbacks, {
    requireMixedLineage:
      readbackMechanism === "mixed-remotion-lineage-and-render-receipt",
  });
  await writeJson(join(input.caseRoot, "product-readback.json"), report);
  return {
    receiptPath: "product-readback.json",
    report,
  };
}

async function evaluateProductExecution(
  benchmark: ArtifactBenchmarkCase,
  agent: AgentRunReport,
  productReadback?: TrustedProductReadback,
  fixtureIntegrity?: BenchmarkFixtureIntegrityReport,
): Promise<ProductExecutionReport> {
  const requiredProductOperations =
    benchmark.execution?.requiredProductOperations ?? [];
  const forbiddenProductOperations =
    benchmark.execution?.forbiddenProductOperations ?? [];
  const requiredMcpTools = benchmark.execution?.requiredMcpTools ?? [];
  const requiredCliCommands = benchmark.execution?.requiredCliCommands ?? [];
  if (!benchmark.execution) {
    return {
      profile: "portable",
      status: fixtureIntegrity?.status === "fail" ? "fail" : "pass",
      requiredProductOperations,
      observedProductOperations: [],
      missingProductOperations: [],
      forbiddenProductOperations,
      observedForbiddenProductOperations: [],
      requiredMcpTools,
      observedMcpTools: [],
      missingMcpTools: [],
      requiredCliCommands,
      observedCliCommands: [],
      missingCliCommands: [],
      detail: [
        "No live Clash host calls are required for this portable case.",
        ...(fixtureIntegrity ? [fixtureIntegrity.detail] : []),
      ].join(" "),
    };
  }

  const observedMcpTools: string[] = [];
  const observedCliCommands: string[] = [];
  const successfulCliArgv: string[][] = [];
  const logsRoot = dirname(agent.stdoutPath);
  let agentEventsText = "";
  try {
    agentEventsText = await readFile(agent.stdoutPath, "utf8");
  } catch (error) {
    return {
      profile: "clash-host",
      status: "fail",
      requiredProductOperations,
      observedProductOperations: [],
      missingProductOperations: [...requiredProductOperations],
      forbiddenProductOperations,
      observedForbiddenProductOperations: [],
      requiredMcpTools,
      observedMcpTools,
      missingMcpTools: [...requiredMcpTools],
      requiredCliCommands,
      observedCliCommands,
      missingCliCommands: [...requiredCliCommands],
      detail: `Unable to inspect Agent events for identity violations: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const seenMcpTools = new Set<string>();
  const invokedMcpTools: string[] = [];
  const seenInvokedMcpTools = new Set<string>();
  for (const call of await readRunnerSealedMcpInvocations({
    logsRoot,
    caseId: benchmark.id,
  })) {
    const tool = effectiveMcpToolName(call) ?? call.tool;
    if (!seenInvokedMcpTools.has(tool)) {
      seenInvokedMcpTools.add(tool);
      invokedMcpTools.push(tool);
    }
    if (call.succeeded && !seenMcpTools.has(tool)) {
      seenMcpTools.add(tool);
      observedMcpTools.push(tool);
    }
  }
  let cliTraceText = "";
  let trustedCliTrace = false;
  const invokedCliArgv: string[][] = [];
  try {
    cliTraceText = await readFile(
      join(logsRoot, "clash-cli-events.jsonl"),
      "utf8",
    );
    const receipt = JSON.parse(
      await readFile(join(logsRoot, "clash-cli-trace-receipt.json"), "utf8"),
    ) as Record<string, unknown>;
    const parsedTrace = parseSealedCliInvocations(cliTraceText);
    trustedCliTrace =
      receipt.schemaVersion === 1 &&
      receipt.source === "runner-cli-proxy" &&
      receipt.status === "sealed" &&
      receipt.caseId === benchmark.id &&
      receipt.tracePath === "clash-cli-events.jsonl" &&
      receipt.traceSha256 === sha256Bytes(cliTraceText) &&
      parsedTrace !== undefined &&
      receipt.eventCount === parsedTrace.eventCount;
    if (trustedCliTrace && parsedTrace) {
      const seenCliCommands = new Set<string>();
      for (const invocation of parsedTrace.invocations) {
        if (invocation.origin === "mcp-transport") {
          const tool = mcpToolForCliInvocation(invocation.argv);
          if (tool) {
            if (!seenInvokedMcpTools.has(tool)) {
              seenInvokedMcpTools.add(tool);
              invokedMcpTools.push(tool);
            }
            if (invocation.succeeded && !seenMcpTools.has(tool)) {
              seenMcpTools.add(tool);
              observedMcpTools.push(tool);
            }
          }
          continue;
        }
        if (isCliDiscoveryInvocation(invocation.argv)) continue;
        invokedCliArgv.push(invocation.argv);
        if (!invocation.succeeded) continue;
        const command = formatCliInvocation(invocation.argv);
        successfulCliArgv.push(invocation.argv);
        if (!seenCliCommands.has(command)) {
          seenCliCommands.add(command);
          observedCliCommands.push(command);
        }
      }
    }
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  const missingMcpTools = requiredMcpTools.filter(
    (tool) => !observedMcpTools.includes(tool),
  );
  const missingCliCommands = requiredCliCommands.filter(
    (required) =>
      !successfulCliArgv.some((argv) =>
        matchesRequiredCliCommand(required, argv),
      ),
  );
  const { observedProductOperations, missingProductOperations } =
    matchRequiredProductOperations({
      requiredProductOperations,
      successfulMcpTools: observedMcpTools,
      successfulCliArgv,
    });
  const observedForbiddenProductOperations = matchForbiddenProductOperations({
    forbiddenProductOperations,
    invokedMcpTools,
    invokedCliArgv,
  });
  const tracePassed =
    missingProductOperations.length === 0 &&
    observedForbiddenProductOperations.length === 0 &&
    missingMcpTools.length === 0 &&
    missingCliCommands.length === 0;
  const expectedReadbackArtifactIds =
    benchmark.execution.productReadback?.artifactIds ?? [];
  const missingReadbackArtifactIds = expectedReadbackArtifactIds.filter(
    (artifactId) =>
      !productReadback?.report.matchedArtifactIds.includes(artifactId),
  );
  const readbackPassed =
    expectedReadbackArtifactIds.length === 0
      ? !productReadback || productReadback.report.status === "pass"
      : productReadback?.report.status === "pass" &&
        missingReadbackArtifactIds.length === 0;
  const executionReport: ProductExecutionReport = {
    profile: "clash-host",
    status:
      tracePassed && readbackPassed && fixtureIntegrity?.status !== "fail"
        ? "pass"
        : "fail",
    requiredProductOperations,
    observedProductOperations,
    missingProductOperations,
    forbiddenProductOperations,
    observedForbiddenProductOperations,
    requiredMcpTools,
    observedMcpTools,
    missingMcpTools,
    requiredCliCommands,
    observedCliCommands,
    missingCliCommands,
    detail: [
      ...(requiredProductOperations.length > 0
        ? [
            missingProductOperations.length === 0
              ? `Observed all ${requiredProductOperations.length} required product operations through successful Clash CLI or MCP calls.`
              : `Missing successful Clash product operations: ${missingProductOperations.join(", ")}.`,
          ]
        : []),
      ...(forbiddenProductOperations.length > 0
        ? [
            observedForbiddenProductOperations.length === 0
              ? `Observed no forbidden Clash product operations across runner-sealed CLI or MCP invocations.`
              : `Observed forbidden Clash product operations: ${observedForbiddenProductOperations
                  .map(
                    ({ operation, transport, invocation }) =>
                      `${operation} (${transport}: ${invocation})`,
                  )
                  .join(", ")}.`,
          ]
        : []),
      ...(requiredMcpTools.length > 0
        ? [
            missingMcpTools.length === 0
              ? `Observed all ${requiredMcpTools.length} required successful Clash MCP calls in the runner-sealed proxy trace.`
              : `Missing runner-sealed successful Clash MCP calls: ${missingMcpTools.join(", ")}.`,
          ]
        : []),
      ...(requiredCliCommands.length > 0
        ? [
            missingCliCommands.length === 0
              ? `Observed all ${requiredCliCommands.length} required successful Clash CLI calls in the runner trace.`
              : `Missing successful Clash CLI calls: ${missingCliCommands.join(", ")}.`,
          ]
        : []),
      ...(productReadback ? [productReadback.report.detail] : []),
      ...(missingReadbackArtifactIds.length > 0
        ? [
            `Missing trusted product readback for artifacts: ${missingReadbackArtifactIds.join(", ")}.`,
          ]
        : []),
      ...(fixtureIntegrity ? [fixtureIntegrity.detail] : []),
    ].join(" "),
    ...(productReadback
      ? {
          productReadback: {
            status: productReadback.report.status,
            receiptPath: productReadback.receiptPath,
            matchedArtifactIds: productReadback.report.matchedArtifactIds,
            detail: productReadback.report.detail,
          },
        }
      : {}),
  };
  const identityIntegrity = inspectBenchmarkIdentityIntegrity({
    agentEventsText,
    cliTraceText,
  });
  return enforceBenchmarkIdentityIntegrity(executionReport, identityIntegrity);
}

export function matchesRequiredCliCommand(
  required: string,
  argv: string[],
): boolean {
  if (isCliDiscoveryInvocation(argv)) return false;
  const requiredArgv = required.trim().split(/\s+/u).filter(Boolean);
  return (
    requiredArgv.length > 0 &&
    requiredArgv.every((argument, index) => argv[index] === argument)
  );
}

function isCliDiscoveryInvocation(argv: string[]): boolean {
  return argv.some(
    (argument) =>
      argument === "--help" ||
      argument === "-h" ||
      argument === "--version" ||
      argument === "-V",
  );
}

function nonRequiredQualityReview(): QualityReviewReport {
  return {
    required: false,
    status: "pass",
    detail:
      "Independent semantic review is not required for the functional track.",
  };
}

function nonRunQualityReview(
  benchmark: ArtifactBenchmarkCase,
  status: "blocked" | "failed",
): QualityReviewReport {
  if (benchmark.execution?.environment?.track !== "content-effect") {
    return nonRequiredQualityReview();
  }
  return {
    required: true,
    status: status === "blocked" ? "pending" : "fail",
    detail:
      status === "blocked"
        ? "Content-effect review is pending because preflight blocked artifact production."
        : "Content-effect review failed closed because exact reviewable artifact evidence was not produced.",
  };
}

async function evaluateCaseQualityReview(input: {
  benchmark: ArtifactBenchmarkCase;
  evaluation: ArtifactEvaluationReport;
  execution: ProductExecutionReport;
  agent: AgentRunReport;
  reviewer?: BenchmarkQualityReviewer;
  executionLockReceipt?: BenchmarkExecutionLockReceipt;
  workspace: string;
  caseRoot: string;
}): Promise<QualityReviewReport> {
  if (input.benchmark.execution?.environment?.track !== "content-effect") {
    const review = nonRequiredQualityReview();
    await writeJson(join(input.caseRoot, "quality-review.json"), review);
    return review;
  }
  if (input.agent.status !== "completed") {
    const review = nonRunQualityReview(input.benchmark, "failed");
    await writeJson(join(input.caseRoot, "quality-review.json"), review);
    return review;
  }

  let request;
  try {
    request = createQualityReviewRequest({
      benchmark: input.benchmark,
      evaluation: input.evaluation,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const review: QualityReviewReport = {
      required: true,
      status: "fail",
      detail: `Independent content review lacked exact artifact evidence (error sha256 ${sha256Bytes(detail)}).`,
    };
    await writeJson(join(input.caseRoot, "quality-review.json"), review);
    return review;
  }
  await writeJson(join(input.caseRoot, "quality-review-request.json"), request);
  let review = evaluateQualityReview({ request });
  if (!input.reviewer) {
    await writeJson(join(input.caseRoot, "quality-review.json"), review);
    return review;
  }
  if (!codexQualityJudgeSupportsRequest(request)) {
    review = {
      ...review,
      detail:
        "The configured Codex reviewer supports exact image evidence only; at least one quality criterion requires unsupported evidence, so the whole review remains pending.",
    };
    await writeJson(join(input.caseRoot, "quality-review.json"), review);
    return review;
  }

  try {
    if (input.executionLockReceipt) {
      await verifyBenchmarkExecutionLock(input.executionLockReceipt);
    }
    let result;
    try {
      const lockedReviewerExecutable =
        input.executionLockReceipt?.sources.qualityReviewerExecutable?.path;
      result = await runCodexQualityJudge({
        reviewer: lockedReviewerExecutable
          ? { ...input.reviewer, command: lockedReviewerExecutable }
          : input.reviewer,
        request,
        evidence: input.evaluation.artifacts,
        workspace: input.workspace,
        caseRoot: input.caseRoot,
      });
    } finally {
      if (input.executionLockReceipt) {
        await verifyBenchmarkExecutionLock(input.executionLockReceipt);
      }
    }
    if (!result) {
      review = {
        ...review,
        detail:
          "The configured reviewer could not inspect every criterion's exact evidence, so the whole review remains pending.",
      };
    } else {
      await writeJson(
        join(input.caseRoot, "quality-review-result.json"),
        result,
      );
      review = evaluateQualityReview({ request, result });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    review = {
      required: true,
      status: "fail",
      detail: `Independent quality reviewer failed closed (error sha256 ${sha256Bytes(detail)}).`,
      request,
    };
  }
  await writeJson(join(input.caseRoot, "quality-review.json"), review);
  return review;
}

async function runCase(input: {
  suiteId: string;
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  qualityReviewer?: BenchmarkQualityReviewer;
  suiteRoot: string;
  caseRoot: string;
  processScope: BenchmarkProcessScope;
}): Promise<BenchmarkCaseReport> {
  assertSafePathSegment(input.benchmark.id, "Benchmark case id");
  const caseRoot = input.caseRoot;
  await createFreshDirectory(caseRoot, "Case directory");
  if (input.benchmark.execution?.environment) {
    await writeBenchmarkTaskManifest({
      caseRoot,
      suiteId: input.suiteId,
      track: input.benchmark.execution.environment.track,
      benchmark: input.benchmark,
    });
  }
  const finalWorkspace = join(caseRoot, "workspace");
  const executionWorkspaceRoot = await mkdtemp(
    join(tmpdir(), "clash-benchmark-workspace-"),
  );
  const workspaceCandidate = join(executionWorkspaceRoot, "workspace");
  const environment = input.benchmark.execution?.environment;
  if (!environment) await mkdir(workspaceCandidate);
  let workspace = environment
    ? workspaceCandidate
    : await realpath(workspaceCandidate);
  const logsRoot = join(caseRoot, "logs");
  let snapshotPublished = false;
  let clashHostConfig: ResolvedClashHost | undefined;
  let inputFixture: BenchmarkInputFixtureProvenance | undefined;
  let environmentCapture: BenchmarkModifiedWorkspaceCapture | undefined;
  let executionLockReceipt: BenchmarkExecutionLockReceipt | undefined;
  let completedAgent: AgentRunReport | undefined;
  try {
    clashHostConfig = await resolveClashHost(input.agent, caseRoot, workspace);
    if (environment) {
      const inputWorkspace = environment.initialState?.workspace;
      if (!inputWorkspace || !clashHostConfig) {
        throw new BenchmarkInfrastructureError(
          "environment-import",
          "A ready benchmark Environment requires an exact input Workspace bundle and a packaged Clash Host",
        );
      }
      const inputBundleCandidate = resolve(
        input.suiteRoot,
        inputWorkspace.path,
      );
      const inputBundle = await realpath(inputBundleCandidate);
      const suiteRelative = relative(input.suiteRoot, inputBundle);
      if (
        !suiteRelative ||
        suiteRelative === ".." ||
        suiteRelative.startsWith(`..${sep}`) ||
        isAbsolute(suiteRelative)
      ) {
        throw new BenchmarkInfrastructureError(
          "environment-import",
          "Benchmark input Workspace must remain beneath suiteRoot",
        );
      }
      const verifiedInput = await verifyWorkspaceBundleDirectory(inputBundle);
      if (
        verifiedInput.manifest.integrity.bundleDigest !==
        inputWorkspace.bundleDigest
      ) {
        throw new BenchmarkInfrastructureError(
          "environment-import",
          "Benchmark input Workspace digest does not match the suite contract",
        );
      }
      executionLockReceipt = await captureBenchmarkExecutionLock({
        caseRoot,
        suiteRoot: input.suiteRoot,
        benchmark: input.benchmark,
        agent: input.agent,
        ...(input.qualityReviewer
          ? { qualityReviewer: input.qualityReviewer }
          : {}),
        executionIntent: "execute",
        inputManifest: verifiedInput.manifest,
      });
      const importHost = await startClashHost(
        clashHostConfig,
        logsRoot,
        input.processScope,
      );
      try {
        await runWorkspaceCli({
          cliPath: importHost.agentCliPath,
          args: [
            "workspace",
            "import",
            inputBundle,
            "--into",
            workspaceCandidate,
            "--json",
          ],
          workspace: executionWorkspaceRoot,
          environment: clashProjectEnvironment(
            importHost,
            executionWorkspaceRoot,
          ),
          stdoutPath: join(logsRoot, "workspace-import.stdout.log"),
          stderrPath: join(logsRoot, "workspace-import.stderr.log"),
          processScope: input.processScope,
          label: "workspace import",
          timeoutMs: 5 * 60_000,
        });
      } finally {
        await stopClashHost(importHost);
      }
      workspace = await realpath(workspaceCandidate);
      clashHostConfig = { ...clashHostConfig, workspace };
    }
    if (input.benchmark.inputFixture) {
      inputFixture = await installBenchmarkInputFixture({
        suiteRoot: input.suiteRoot,
        workspace,
        fixture: input.benchmark.inputFixture,
        ...(environment ? { allowExistingWorkspace: true as const } : {}),
      });
    }
    // Persist the public outcome before any optional setup so even a setup crash
    // leaves a useful, recoverable attempt workspace.
    await writeJson(join(workspace, "outcome.json"), input.benchmark.outcome);
    const installedSkillNames = await installCaseSkills(
      [
        ...input.benchmark.skills,
        ...(input.agent.adapter === "pi" ? (input.agent.skills ?? []) : []),
      ],
      input.suiteRoot,
      workspace,
    );
    const agentReadyPath = join(
      workspace,
      ".clash",
      "headless-host-ready.json",
    );
    const prompt = renderOutcomeMarkdown(input.benchmark, installedSkillNames, {
      clashHost: Boolean(clashHostConfig),
      workspaceRoot: workspace,
    });
    const promptPath = join(workspace, "OUTCOME.md");
    const setupWrites: Promise<void>[] = [
      writeFile(promptPath, prompt, "utf8"),
    ];
    if (clashHostConfig) {
      setupWrites.push(
        writeJson(join(caseRoot, "clash-host.json"), {
          profile: clashHostConfig.profile,
          pluginRoot: clashHostConfig.pluginRoot,
          runtimePath: clashHostConfig.runtimePath,
          runtimeClashHome: clashHostConfig.clashHome,
          persistedClashHome: clashHostConfig.persistedClashHome,
          localDataDir: clashHostConfig.localDataDir,
          localApiPluginSocket: clashHostConfig.localApiPluginSocket,
          executionWorkspace: workspace,
          finalWorkspace,
          workspaceBinding: "runner-managed",
          projectHostGate: "required-before-agent",
        }),
      );
    }
    await Promise.all(setupWrites);
    let clashHost: RunningClashHost | undefined;
    let projectHost: ProjectHostController | undefined;
    let projectReady: ProjectHostReady | undefined;
    let agent: AgentRunReport;
    let productReadback: TrustedProductReadback | undefined;
    let fixtureIntegrity: BenchmarkFixtureIntegrityReport | undefined;
    let trustedCliProxy: TrustedCliProxy | undefined;
    let trustedMcpRelay: TrustedMcpRelay | undefined;
    let workspaceScaffold: BenchmarkWorkspaceScaffoldReceipt | undefined;
    try {
      clashHost = clashHostConfig
        ? await startClashHost(clashHostConfig, logsRoot, input.processScope)
        : undefined;
      if (clashHost) {
        const generatedProjectId = `headless_eval_${createHash("sha256")
          .update(caseRoot)
          .digest("hex")
          .slice(0, 24)}`;
        let binding: BenchmarkWorkspaceBinding;
        try {
          binding = await prepareBenchmarkWorkspaceBinding({
            cliPath: clashHost.agentCliPath,
            workspace,
            caseRoot,
            logsRoot,
            generatedProjectId,
            environment: clashProjectEnvironment(clashHost, workspace),
            processScope: input.processScope,
          });
        } catch (error) {
          throw new BenchmarkInfrastructureError(
            "workspace-init",
            `Clash workspace initialization failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        projectHost = startProjectHostController({
          host: clashHost,
          binding,
          workspace,
          caseRoot,
          agentReadyPath,
        });
        try {
          projectReady = await projectHost.ready;
        } catch (error) {
          throw new BenchmarkInfrastructureError(
            "project-host-setup",
            `Clash Project Host setup failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        await writeJson(join(caseRoot, "clash-host.json"), {
          profile: clashHost.profile,
          pluginRoot: clashHost.pluginRoot,
          runtimePath: clashHost.runtimePath,
          runtimeClashHome: clashHost.clashHome,
          persistedClashHome: clashHost.persistedClashHome,
          localDataDir: clashHost.localDataDir,
          localApiPluginSocket: clashHost.localApiPluginSocket,
          endpoint: clashHost.endpoint,
          agentCliPath: clashHost.agentCliPath,
          agentMemberId: clashHost.agentMemberId,
          agentName: clashHost.agentName,
          hostPid: clashHost.child.pid,
          localApiReadyAt: clashHost.readyAt,
          executionWorkspace: workspace,
          finalWorkspace,
          projectId: projectReady.projectId,
          workspaceId: projectReady.workspaceId,
          initDisposition: projectReady.initDisposition,
          markerSha256: projectReady.markerSha256,
          projectHostReadyAt: projectReady.readyAt,
          workspaceBinding: "ready",
          projectHostGate: "satisfied-before-agent",
          lifecycleOwner: "benchmark-runner",
        });
        if (environment) {
          workspaceScaffold = await captureBenchmarkWorkspaceScaffold({
            workspace,
            skillNames: installedSkillNames,
          });
        }
      }
      const clashTransport =
        input.benchmark.execution?.transport ?? ("auto" as const);
      trustedCliProxy = clashHost
        ? await startTrustedCliProxy({
            host: clashHost,
            benchmark: input.benchmark,
            workspace,
            logsRoot,
            processScope: input.processScope,
          })
        : undefined;
      trustedMcpRelay =
        clashHost && clashTransport !== "cli"
          ? await startTrustedMcpRelay({
              host: {
                ...clashHost,
                ...(trustedCliProxy
                  ? { agentCliPath: trustedCliProxy.agentCliPath }
                  : {}),
              },
              benchmark: input.benchmark,
              workspace,
              logsRoot,
              processScope: input.processScope,
            })
          : undefined;
      const agentClashAccess: AgentClashAccess | undefined = clashHost
        ? {
            sandboxRoots: [
              ...(trustedMcpRelay
                ? [dirname(trustedMcpRelay.runtimePath)]
                : []),
              ...(clashTransport !== "mcp" && trustedCliProxy
                ? [dirname(trustedCliProxy.agentCliPath)]
                : []),
            ],
            ...(trustedMcpRelay
              ? {
                  mcp: {
                    runtimePath: trustedMcpRelay.runtimePath,
                    pluginRoot: clashHost.pluginRoot,
                  },
                }
              : {}),
            ...(clashTransport !== "mcp" && trustedCliProxy
              ? { cli: { agentCliPath: trustedCliProxy.agentCliPath } }
              : {}),
          }
        : undefined;
      if (executionLockReceipt) {
        await verifyBenchmarkExecutionLock(executionLockReceipt, {
          workspace,
          installedSkillNames,
        });
      }
      agent = await runAgent({
        agent: input.agent,
        ...(executionLockReceipt?.sources.executable
          ? {
              lockedExecutablePath:
                executionLockReceipt.sources.executable.path,
            }
          : {}),
        benchmark: input.benchmark,
        suiteRoot: input.suiteRoot,
        workspace,
        logsRoot,
        promptPath,
        prompt,
        clashAccess: agentClashAccess,
        processScope: input.processScope,
      });
      completedAgent = agent;
      if (executionLockReceipt) {
        await verifyBenchmarkExecutionLock(executionLockReceipt, {
          workspace,
          installedSkillNames,
        });
      }
      if (trustedMcpRelay) {
        await trustedMcpRelay.close();
        trustedMcpRelay = undefined;
      }
      if (trustedCliProxy) {
        await trustedCliProxy.close();
        trustedCliProxy = undefined;
        agent.trajectoryPath = await writeNormalizedTrajectory({
          agent: input.agent,
          logsRoot,
          rawPath: agent.stdoutPath,
          observedPath:
            agent.observedEventsPath ?? join(logsRoot, "observed-events.jsonl"),
        });
      }
      if (
        environment &&
        (input.agent.adapter === "codex" || input.agent.adapter === "pi")
      ) {
        const lockedAgent = executionLockReceipt?.lock.agent;
        if (
          !lockedAgent ||
          lockedAgent.adapter !== input.agent.adapter ||
          lockedAgent.model.kind !== "explicit" ||
          !lockedAgent.executable
        ) {
          throw new BenchmarkInfrastructureError(
            "atif-projection",
            `${input.agent.adapter} ATIF projection requires the exact locked Agent executable and model`,
          );
        }
        let atifReceipt;
        try {
          atifReceipt = await writeAtifTrajectory({
            adapter: input.agent.adapter,
            publicPrompt: prompt,
            source: { kind: "file", path: agent.stdoutPath },
            lockedAgent: {
              name: input.agent.adapter,
              version:
                lockedAgent.executable.reportedVersion ??
                `sha256:${lockedAgent.executable.sha256}`,
              model: lockedAgent.model.id,
            },
            workspaceRoot: workspace,
            outputDirectory: logsRoot,
          });
        } catch (error) {
          throw new BenchmarkInfrastructureError(
            "atif-projection",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
        await writeJson(
          join(logsRoot, "trajectory.atif-receipt.json"),
          atifReceipt,
        );
      }
      let postAgentIntegrity: BenchmarkFixtureIntegrityReport | undefined;
      if (inputFixture) {
        postAgentIntegrity = await verifyBenchmarkInputFixture(
          workspace,
          inputFixture,
        );
        await writeJson(
          join(caseRoot, "fixture-integrity.json"),
          postAgentIntegrity,
        );
      }
      if (environment) {
        try {
          if (!workspaceScaffold || !clashHost) {
            throw new Error(
              "Workspace Environment capture requires runner scaffold provenance and a live Clash Host",
            );
          }
          await removeVerifiedBenchmarkWorkspaceScaffold({
            workspace,
            receipt: workspaceScaffold,
          });
          const modifiedWorkspace = join(caseRoot, "modified-workspace");
          await runWorkspaceCli({
            cliPath: clashHost.agentCliPath,
            args: ["workspace", "export", "--out", modifiedWorkspace, "--json"],
            workspace,
            environment: clashProjectEnvironment(clashHost, workspace),
            stdoutPath: join(logsRoot, "workspace-export.stdout.log"),
            stderrPath: join(logsRoot, "workspace-export.stderr.log"),
            processScope: input.processScope,
            label: "workspace export",
            timeoutMs: 5 * 60_000,
          });
          await verifyWorkspaceBundleDirectory(modifiedWorkspace);
          environmentCapture = {
            status: "complete",
            path: modifiedWorkspace,
          };
        } catch (error) {
          environmentCapture = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await writeJson(join(caseRoot, "environment-capture.json"), {
          schemaVersion: 1,
          status: environmentCapture.status,
          ...(environmentCapture.status === "complete"
            ? { path: "modified-workspace" }
            : environmentCapture.status === "failed"
              ? { error: environmentCapture.error }
              : {}),
        });
      }
      if (inputFixture) {
        const finalSnapshotIntegrity = await publishWorkspaceSnapshot(
          workspace,
          finalWorkspace,
          async (snapshot) => {
            const integrity = await verifyBenchmarkInputFixture(
              snapshot,
              inputFixture!,
            );
            await writeBenchmarkInputFixtureReceipt(snapshot, inputFixture!);
            return integrity;
          },
        );
        if (!finalSnapshotIntegrity) {
          throw new Error(
            "Published benchmark fixture snapshot was not inspected",
          );
        }
        fixtureIntegrity = combineFixtureIntegrityChecks({
          fileCount: inputFixture.files.length,
          postAgent: postAgentIntegrity!,
          finalSnapshot: finalSnapshotIntegrity,
        });
        await writeJson(
          join(caseRoot, "fixture-integrity.json"),
          fixtureIntegrity,
        );
      } else {
        await publishWorkspaceSnapshot(workspace, finalWorkspace);
      }
      snapshotPublished = true;
      productReadback = await captureRequiredProductReadback({
        benchmark: input.benchmark,
        workspace: finalWorkspace,
        caseRoot,
        ready: projectReady,
      });
    } finally {
      try {
        if (trustedMcpRelay) await trustedMcpRelay.close();
      } finally {
        try {
          if (trustedCliProxy) await trustedCliProxy.close();
        } finally {
          try {
            if (projectHost) await projectHost.stop();
          } finally {
            if (clashHost) await stopClashHost(clashHost);
          }
        }
      }
    }

    const execution = await evaluateProductExecution(
      input.benchmark,
      agent,
      productReadback,
      fixtureIntegrity,
    );
    if (environmentCapture?.status === "failed") {
      execution.status = "fail";
      execution.detail =
        `${execution.detail} Modified Workspace capture failed: ${environmentCapture.error}`.trim();
    }
    const evaluation = await evaluateSubmission({
      benchmark: input.benchmark,
      workspace: finalWorkspace,
    });
    const qualityReview = await evaluateCaseQualityReview({
      benchmark: input.benchmark,
      evaluation,
      execution,
      agent,
      ...(input.qualityReviewer ? { reviewer: input.qualityReviewer } : {}),
      ...(executionLockReceipt ? { executionLockReceipt } : {}),
      workspace: finalWorkspace,
      caseRoot,
    });
    const outcome = createOutcomeResult({
      benchmark: input.benchmark,
      agentStatus: agent.status,
      evaluationStatus: evaluation.status,
      executionStatus: execution.status,
      qualityReviewStatus: qualityReview.status,
      score: evaluation.score,
    });
    const status =
      outcome.status === "achieved"
        ? "pass"
        : outcome.status === "pending-review"
          ? "pending-review"
          : "fail";
    const report: BenchmarkCaseReport = {
      id: input.benchmark.id,
      workspace: finalWorkspace,
      ...(inputFixture ? { inputFixture } : {}),
      status,
      agent,
      execution,
      evaluation,
      qualityReview,
      outcome,
      ...(environmentCapture?.status === "failed"
        ? {
            failure: {
              classification: "infrastructure" as const,
              retryable: true,
              phase: "environment-capture",
              detail: environmentCapture.error,
            },
          }
        : {}),
    };
    await Promise.all([
      writeJson(join(caseRoot, "evaluation.json"), evaluation),
      writeJson(join(caseRoot, "execution.json"), execution),
      writeJson(join(caseRoot, "outcome-result.json"), outcome),
      writeJson(join(caseRoot, "case-report.json"), report),
    ]);
    return report;
  } catch (error) {
    if (completedAgent) {
      throw new BenchmarkPostAgentInfrastructureError(error, completedAgent);
    }
    throw error;
  } finally {
    if (!snapshotPublished) {
      try {
        await publishWorkspaceSnapshot(workspace, finalWorkspace);
        snapshotPublished = true;
      } catch (error) {
        await writeFile(
          join(caseRoot, "workspace-snapshot-error.log"),
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
          "utf8",
        ).catch(() => undefined);
      }
    }
    if (clashHostConfig) {
      await rm(clashHostConfig.runtimeRoot, { recursive: true, force: true });
    }
    await rm(executionWorkspaceRoot, { recursive: true, force: true });
  }
}

type RunManifest = {
  schemaVersion: 1;
  suiteId: string;
  runId: string;
  suiteSha256: string;
  startedAt: string;
};

type RunProgressCase = {
  id: string;
  status: BenchmarkCaseReport["status"];
  attempt?: number;
  failure?: BenchmarkCaseFailure;
};

type LegacyRunProgress = {
  schemaVersion: 1;
  suiteId: string;
  runId: string;
  status: "in-progress";
  startedAt: string;
  updatedAt: string;
  resumed: boolean;
  completedCases: RunProgressCase[];
};

type RunProgress = {
  schemaVersion: 2;
  suiteId: string;
  runId: string;
  status: "in-progress" | BenchmarkSuiteReport["status"];
  startedAt: string;
  updatedAt: string;
  resumed: boolean;
  completedCases: RunProgressCase[];
  attempts: BenchmarkAttemptLedgerEntry[];
};

type StoredRunProgress = LegacyRunProgress | RunProgress;

async function assertEnvironmentResumeLockMatches(input: {
  suiteId: string;
  suiteRoot: string;
  runRoot: string;
  priorCaseRoot: string;
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  qualityReviewer?: BenchmarkQualityReviewer;
}): Promise<void> {
  const environment = input.benchmark.execution?.environment;
  if (!environment) return;
  const priorRoot = resolve(input.runRoot, input.priorCaseRoot);
  relativeRunPath(input.runRoot, priorRoot);
  const priorLock = JSON.parse(
    await readFile(join(priorRoot, "environment-lock.json"), "utf8"),
  ) as unknown;
  const comparisonRoot = await mkdtemp(
    join(input.runRoot, ".resume-environment-lock-"),
  );
  try {
    await writeBenchmarkTaskManifest({
      caseRoot: comparisonRoot,
      suiteId: input.suiteId,
      track: environment.track,
      benchmark: input.benchmark,
    });
    const declaredWorkspace =
      environment.profile === "clash-agent-environment-v1"
        ? environment.initialState?.workspace
        : environment.inputWorkspace;
    const inputManifest = declaredWorkspace
      ? (
          await verifyWorkspaceBundleDirectory(
            resolve(input.suiteRoot, declaredWorkspace.path),
          )
        ).manifest
      : undefined;
    const current = await captureBenchmarkExecutionLock({
      caseRoot: comparisonRoot,
      suiteRoot: input.suiteRoot,
      benchmark: input.benchmark,
      agent: input.agent,
      ...(input.qualityReviewer
        ? { qualityReviewer: input.qualityReviewer }
        : {}),
      executionIntent:
        input.benchmark.execution?.preflight?.status === "blocked"
          ? "blocked-no-run"
          : "execute",
      ...(inputManifest ? { inputManifest } : {}),
    });
    if (sha256Json(priorLock) !== sha256Json(current.lock)) {
      throw new Error(
        `Cannot resume case '${input.benchmark.id}': the resolved Environment does not match the completed attempt`,
      );
    }
  } finally {
    await rm(comparisonRoot, { recursive: true, force: true });
  }
}

async function assertEnvironmentResumeAttemptMatches(input: {
  suiteRoot: string;
  runRoot: string;
  benchmark: ArtifactBenchmarkCase;
  completed: BenchmarkAttemptLedgerEntry;
}): Promise<BenchmarkAttemptVerification | undefined> {
  if (!input.benchmark.execution?.environment) return undefined;
  const fail = (detail: string): never => {
    throw new Error(
      `Cannot resume case '${input.benchmark.id}': the immutable Attempt does not match its sealed ledger entry: ${detail}`,
    );
  };
  if (
    typeof input.completed.attemptPath !== "string" ||
    typeof input.completed.attemptSha256 !== "string" ||
    typeof input.completed.attemptDigest !== "string"
  ) {
    fail("Attempt identity is missing");
  }
  const priorRoot = resolve(input.runRoot, input.completed.caseRoot);
  relativeRunPath(input.runRoot, priorRoot);
  const verification = await verifyBenchmarkAttempt({
    caseRoot: priorRoot,
    suiteRoot: input.suiteRoot,
  }).catch((error: unknown) =>
    fail(error instanceof Error ? error.message : String(error)),
  );
  const receipt: BenchmarkAttemptReceipt = verification.receipt;
  const manifestPath = relativeRunPath(
    input.runRoot,
    join(priorRoot, receipt.path),
  );
  if (
    manifestPath !== input.completed.attemptPath ||
    receipt.sha256 !== input.completed.attemptSha256 ||
    receipt.attemptDigest !== input.completed.attemptDigest
  ) {
    fail("Attempt path, bytes, or digest changed");
  }
  return verification;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return false;
    throw error;
  }
}

async function ensureFile(path: string, contents = ""): Promise<void> {
  if (!(await pathExists(path))) await writeFile(path, contents, "utf8");
}

function nonRunEvaluation(
  benchmark: ArtifactBenchmarkCase,
  status: "fail" | "not-run",
  detail: string,
): ArtifactEvaluationReport {
  return {
    schemaVersion: 1,
    benchmarkId: benchmark.id,
    taskId: null,
    status,
    score: 0,
    checks: [],
    artifacts: [],
    outcomeGate: {
      status: "fail",
      detail,
      missingArtifactIds: benchmark.outcome.deliverables.map(
        ({ artifactId }) => artifactId,
      ),
      invalidArtifactIds: [],
    },
    error: detail,
  };
}

function nonRunExecution(
  benchmark: ArtifactBenchmarkCase,
  status: "fail" | "blocked",
  detail: string,
): ProductExecutionReport {
  return {
    profile: benchmark.execution ? "clash-host" : "portable",
    status,
    requiredProductOperations:
      benchmark.execution?.requiredProductOperations ?? [],
    observedProductOperations: [],
    missingProductOperations:
      benchmark.execution?.requiredProductOperations ?? [],
    forbiddenProductOperations:
      benchmark.execution?.forbiddenProductOperations ?? [],
    observedForbiddenProductOperations: [],
    requiredMcpTools: benchmark.execution?.requiredMcpTools ?? [],
    observedMcpTools: [],
    missingMcpTools: benchmark.execution?.requiredMcpTools ?? [],
    requiredCliCommands: benchmark.execution?.requiredCliCommands ?? [],
    observedCliCommands: [],
    missingCliCommands: benchmark.execution?.requiredCliCommands ?? [],
    detail,
  };
}

async function createNonRunAgentReport(input: {
  agent: BenchmarkAgent;
  logsRoot: string;
  error?: string;
}): Promise<AgentRunReport> {
  await mkdir(input.logsRoot, { recursive: true });
  const stdoutPath = join(
    input.logsRoot,
    input.agent.adapter === "codex" ||
      input.agent.adapter === "claude" ||
      input.agent.adapter === "pi"
      ? "events.jsonl"
      : "stdout.log",
  );
  const stderrPath = join(input.logsRoot, "stderr.log");
  const observedEventsPath = join(input.logsRoot, "observed-events.jsonl");
  await Promise.all([
    ensureFile(stdoutPath),
    ensureFile(stderrPath),
    ensureFile(observedEventsPath),
  ]);
  const trajectoryPath = await writeNormalizedTrajectory({
    agent: input.agent,
    logsRoot: input.logsRoot,
    rawPath: stdoutPath,
    observedPath: observedEventsPath,
  }).catch(() => undefined);
  return {
    status: "not-run",
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdoutPath,
    stderrPath,
    observedEventsPath,
    ...(trajectoryPath ? { trajectoryPath } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

async function writeCaseReportFiles(
  caseRoot: string,
  report: BenchmarkCaseReport,
): Promise<void> {
  await Promise.all([
    writeJson(join(caseRoot, "evaluation.json"), report.evaluation),
    writeJson(join(caseRoot, "execution.json"), report.execution),
    writeJson(join(caseRoot, "outcome-result.json"), report.outcome),
    ...(report.qualityReview
      ? [writeJson(join(caseRoot, "quality-review.json"), report.qualityReview)]
      : []),
    writeJson(join(caseRoot, "case-report.json"), report),
  ]);
}

async function publishEvaluationEvidence(input: {
  caseRoot: string;
  value: unknown;
}): Promise<BenchmarkEvaluationEvidenceReference> {
  const bytes = Buffer.from(`${stableJson(input.value)}\n`);
  const digest = sha256Bytes(bytes);
  const relativePath = `evaluation-evidence/sha256/${digest}.json`;
  const absolutePath = join(input.caseRoot, relativePath);
  await publishContentAddressedFile(absolutePath, bytes, {
    isValidForIdentity: (candidate) => sha256Bytes(candidate) === digest,
  });
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error("Evaluation evidence must be one immutable regular file");
  }
  const actual = await readFile(absolutePath);
  if (!actual.equals(bytes)) {
    throw new Error("Evaluation evidence changed after publication");
  }
  return {
    path: relativePath,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

async function verifyEvaluationEvidenceReference(input: {
  caseRoot: string;
  evidence: BenchmarkEvaluationEvidenceReference;
}): Promise<void> {
  const segments = input.evidence.path.split("/");
  let cursor = input.caseRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `Evaluation evidence path must not traverse a link: ${input.evidence.path}`,
      );
    }
  }
  const absolutePath = join(input.caseRoot, ...segments);
  const before = await lstat(absolutePath);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(
      `Evaluation evidence must be one regular unlinked file: ${input.evidence.path}`,
    );
  }
  const bytes = await readFile(absolutePath);
  const after = await lstat(absolutePath);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.nlink !== 1 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    bytes.byteLength !== input.evidence.bytes ||
    sha256Bytes(bytes) !== input.evidence.sha256
  ) {
    throw new Error(
      `Evaluation evidence bytes or sha256 changed: ${input.evidence.path}`,
    );
  }
}

async function readAttemptEvaluationReceipts(input: {
  caseRoot: string;
  attemptDigest: string;
}): Promise<EvaluationRecordReceipt<BenchmarkEvaluationRecord>[]> {
  const directory = join(input.caseRoot, "evaluations", "sha256");
  if (!(await pathExists(directory))) return [];
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Evaluation store must be a real directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
          throw new Error(
            `Evaluation store contains an unsupported entry: ${entry.name}`,
          );
        }
        const relativePath = `evaluations/sha256/${entry.name}`;
        const absolutePath = join(input.caseRoot, relativePath);
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
          throw new Error(
            `Evaluation record must be one immutable regular file: ${relativePath}`,
          );
        }
        const bytes = await readFile(absolutePath);
        const record = parseEvaluationRecord(bytes);
        if (
          record.attemptDigest !== input.attemptDigest ||
          `${record.digest}.json` !== entry.name
        ) {
          throw new Error(
            `Evaluation record is bound to a different Attempt: ${relativePath}`,
          );
        }
        await Promise.all(
          record.evidence.map((evidence) =>
            verifyEvaluationEvidenceReference({
              caseRoot: input.caseRoot,
              evidence,
            }),
          ),
        );
        return {
          record,
          path: relativePath,
          bytes: bytes.byteLength,
          sha256: sha256Bytes(bytes),
          publication: "existing" as const,
        };
      }),
  );
}

async function publishBenchmarkEvaluationResults(input: {
  caseRoot: string;
  suiteRoot: string;
  benchmark: ArtifactBenchmarkCase;
  report: BenchmarkCaseReport;
}): Promise<BenchmarkResultBundleReceipt> {
  const attempt = await verifyBenchmarkAttempt({
    caseRoot: input.caseRoot,
    suiteRoot: input.suiteRoot,
  });
  const technicalEvidence = await publishEvaluationEvidence({
    caseRoot: input.caseRoot,
    value: {
      schemaVersion: 1,
      kind: "clash.benchmark.technical-evaluation-evidence",
      benchmarkId: input.benchmark.id,
      agent: input.report.agent,
      evaluation: input.report.evaluation,
      execution: input.report.execution,
    },
  });
  const qualityEvidence = input.report.qualityReview?.result
    ? await publishEvaluationEvidence({
        caseRoot: input.caseRoot,
        value: {
          schemaVersion: 1,
          kind: "clash.benchmark.quality-evaluation-evidence",
          benchmarkId: input.benchmark.id,
          qualityReview: input.report.qualityReview,
        },
      })
    : undefined;
  const pipeline = createBenchmarkEvaluationPipeline({
    attemptDigest: attempt.receipt.attemptDigest,
    benchmark: input.benchmark,
    report: input.report,
    evidence: {
      technical: [technicalEvidence],
      ...(qualityEvidence ? { quality: [qualityEvidence] } : {}),
    },
  });
  await Promise.all(
    pipeline.evaluations.map((record) =>
      writeEvaluationRecord({ storeRoot: input.caseRoot, record }),
    ),
  );
  const aggregate = await writeAggregateRecord({
    storeRoot: input.caseRoot,
    record: pipeline.aggregate,
    evaluations: pipeline.evaluations,
  });
  const reward = pipeline.reward
    ? await writeRewardRecord({
        storeRoot: input.caseRoot,
        record: pipeline.reward,
        aggregate: pipeline.aggregate,
      })
    : undefined;
  const evaluations = await readAttemptEvaluationReceipts({
    caseRoot: input.caseRoot,
    attemptDigest: attempt.receipt.attemptDigest,
  });
  return await writeBenchmarkResultBundle({
    root: input.caseRoot,
    attempt,
    evaluations,
    aggregate,
    ...(reward ? { reward } : {}),
  });
}

async function createInfrastructureFailureReport(input: {
  suiteId: string;
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  caseRoot: string;
  attempt: number;
  error: unknown;
}): Promise<BenchmarkCaseReport> {
  const detail =
    input.error instanceof Error ? input.error.message : String(input.error);
  const phase =
    input.error instanceof BenchmarkInfrastructureError
      ? input.error.phase
      : "runner";
  const stack =
    input.error instanceof Error ? (input.error.stack ?? detail) : detail;
  const workspace = join(input.caseRoot, "workspace");
  const logsRoot = join(input.caseRoot, "logs");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(logsRoot, { recursive: true }),
  ]);
  if (input.benchmark.execution?.environment) {
    await writeBenchmarkTaskManifest({
      caseRoot: input.caseRoot,
      suiteId: input.suiteId,
      track: input.benchmark.execution.environment.track,
      benchmark: input.benchmark,
    });
  }
  await Promise.all([
    ensureFile(
      join(workspace, "outcome.json"),
      `${JSON.stringify(input.benchmark.outcome, null, 2)}\n`,
    ),
    writeJson(join(input.caseRoot, "runner-error.json"), {
      schemaVersion: 1,
      classification: "infrastructure",
      retryable: true,
      phase,
      detail,
      stack,
    }),
  ]);
  const failure: BenchmarkCaseFailure = {
    classification: "infrastructure",
    retryable: true,
    phase,
    detail,
  };
  const agent =
    input.error instanceof BenchmarkPostAgentInfrastructureError
      ? input.error.agent
      : await createNonRunAgentReport({
          agent: input.agent,
          logsRoot,
          error: detail,
        });
  const evaluation = nonRunEvaluation(
    input.benchmark,
    "fail",
    `Benchmark evaluation did not run because the runner infrastructure failed: ${detail}`,
  );
  const execution = nonRunExecution(
    input.benchmark,
    "fail",
    `Product execution could not be verified because the runner infrastructure failed: ${detail}`,
  );
  const qualityReview = nonRunQualityReview(input.benchmark, "failed");
  const outcome: OutcomeResult = {
    schemaVersion: 1,
    caseId: input.benchmark.id,
    objective: input.benchmark.outcome.objective,
    status: "failed",
    score: 0,
    passScore: input.benchmark.passScore,
    agentStatus: agent.status,
    evaluationStatus: evaluation.status,
    executionStatus: execution.status,
    qualityReviewStatus: qualityReview.status,
    completedAt: new Date().toISOString(),
  };
  const report: BenchmarkCaseReport = {
    id: input.benchmark.id,
    workspace,
    status: "fail",
    attempt: input.attempt,
    failure,
    agent,
    execution,
    evaluation,
    qualityReview,
    outcome,
  };
  await writeCaseReportFiles(input.caseRoot, report);
  return report;
}

async function createBlockedCaseReport(input: {
  suiteId: string;
  benchmark: ArtifactBenchmarkCase;
  agent: BenchmarkAgent;
  qualityReviewer?: BenchmarkQualityReviewer;
  suiteRoot: string;
  caseRoot: string;
  attempt: number;
}): Promise<BenchmarkCaseReport> {
  await createFreshDirectory(input.caseRoot, "Case directory");
  if (input.benchmark.execution?.environment) {
    await writeBenchmarkTaskManifest({
      caseRoot: input.caseRoot,
      suiteId: input.suiteId,
      track: input.benchmark.execution.environment.track,
      benchmark: input.benchmark,
    });
    await captureBenchmarkExecutionLock({
      caseRoot: input.caseRoot,
      suiteRoot: input.suiteRoot,
      benchmark: input.benchmark,
      agent: input.agent,
      ...(input.qualityReviewer
        ? { qualityReviewer: input.qualityReviewer }
        : {}),
      executionIntent: "blocked-no-run",
    });
  }
  const workspace = join(input.caseRoot, "workspace");
  const logsRoot = join(input.caseRoot, "logs");
  await Promise.all([mkdir(workspace), mkdir(logsRoot)]);
  const preflight = input.benchmark.execution?.preflight;
  const missing =
    preflight?.checks.filter(({ status }) => status === "missing") ?? [];
  const detail =
    missing.length > 0
      ? `Preflight blocked: ${missing.map(({ capability, detail: reason }) => `${capability}: ${reason}`).join("; ")}`
      : "Preflight blocked by the benchmark capability contract.";
  await Promise.all([
    writeJson(join(workspace, "outcome.json"), input.benchmark.outcome),
    writeFile(
      join(workspace, "OUTCOME.md"),
      renderOutcomeMarkdown(input.benchmark),
      "utf8",
    ),
    writeJson(join(input.caseRoot, "preflight.json"), {
      schemaVersion: 1,
      status: "blocked",
      checks: preflight?.checks ?? [],
      detail,
    }),
  ]);
  const failure: BenchmarkCaseFailure = {
    classification: "preflight",
    retryable: false,
    phase: "preflight",
    detail,
  };
  const agent = await createNonRunAgentReport({ agent: input.agent, logsRoot });
  const evaluation = nonRunEvaluation(input.benchmark, "not-run", detail);
  const execution = nonRunExecution(input.benchmark, "blocked", detail);
  const qualityReview = nonRunQualityReview(input.benchmark, "blocked");
  const outcome: OutcomeResult = {
    schemaVersion: 1,
    caseId: input.benchmark.id,
    objective: input.benchmark.outcome.objective,
    status: "blocked",
    score: 0,
    passScore: input.benchmark.passScore,
    agentStatus: agent.status,
    evaluationStatus: evaluation.status,
    executionStatus: execution.status,
    qualityReviewStatus: qualityReview.status,
    completedAt: new Date().toISOString(),
  };
  const report: BenchmarkCaseReport = {
    id: input.benchmark.id,
    workspace,
    status: "blocked",
    attempt: input.attempt,
    failure,
    agent,
    execution,
    evaluation,
    qualityReview,
    outcome,
  };
  await writeCaseReportFiles(input.caseRoot, report);
  return report;
}

function classifyCaseFailure(
  report: BenchmarkCaseReport,
): BenchmarkCaseFailure | undefined {
  if (report.status === "pass" || report.status === "pending-review") {
    return undefined;
  }
  if (report.failure) return report.failure;
  if (report.status === "blocked" || report.execution.status === "blocked") {
    return (
      report.failure ?? {
        classification: "preflight",
        retryable: false,
        phase: "preflight",
        detail: report.execution.detail,
      }
    );
  }
  if (report.agent.status === "spawn-error") {
    return {
      classification: "infrastructure",
      retryable: true,
      phase: "agent-spawn",
      detail:
        report.agent.error ??
        "The benchmark agent process could not be spawned.",
    };
  }
  if (
    report.agent.status === "failed" &&
    report.agent.error &&
    /(?:\busage\s+limit\b|\busage\s+quota\b|\bquota\s+(?:is\s+)?(?:exhausted|exceeded)\b|\bcredits?\s+(?:are\s+)?(?:exhausted|depleted)\b|\b(?:quota|usage|credits?)\b[^.\n]*\b(?:resets?|try\s+again\s+at)\b)/iu.test(
      report.agent.error,
    )
  ) {
    return {
      classification: "infrastructure",
      retryable: false,
      phase: "agent",
      detail: report.agent.error,
    };
  }
  if (report.agent.status !== "completed") {
    return {
      classification: "agent",
      retryable: false,
      phase: "agent",
      detail:
        report.agent.error ??
        `Agent finished with status ${report.agent.status}.`,
    };
  }
  if (report.execution.status !== "pass") {
    return {
      classification: "product",
      retryable: false,
      phase: "product-execution",
      detail: report.execution.detail,
    };
  }
  return {
    classification: "evaluation",
    retryable: false,
    phase: "artifact-evaluation",
    detail:
      report.evaluation.error ??
      (report.evaluation.checks
        .filter(({ status }) => status === "fail")
        .map(({ detail }) => detail)
        .join("; ") ||
        "Artifact evaluation did not satisfy the benchmark rubric."),
  };
}

function relativeRunPath(runRoot: string, path: string): string {
  const local = relative(runRoot, path);
  if (!local || local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(
      `Attempt path must remain inside the run directory: ${path}`,
    );
  }
  return local;
}

async function recordAttemptEntry(
  progressPath: string,
  progress: RunProgress,
  entry: BenchmarkAttemptLedgerEntry,
): Promise<void> {
  const attempts = [...progress.attempts, entry];
  const updatedAt = new Date().toISOString();
  await writeJsonAtomically(progressPath, { ...progress, updatedAt, attempts });
  progress.updatedAt = updatedAt;
  progress.attempts.push(entry);
}

async function loadAttemptLedger(
  path: string,
): Promise<BenchmarkAttemptLedgerEntry[]> {
  if (!(await pathExists(path))) return [];
  const contents = await readFile(path, "utf8");
  const lines = contents.split("\n");
  const entries: BenchmarkAttemptLedgerEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as BenchmarkAttemptLedgerEntry);
    } catch (error) {
      // A killed process can leave only the final append incomplete. Preserve the
      // source ledger and recover from every complete entry before it.
      if (
        index === lines.length - 1 ||
        lines.slice(index + 1).every((item) => !item.trim())
      )
        break;
      throw new Error(
        `Attempt ledger is corrupt at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return entries;
}

async function loadRunProgress(input: {
  progressPath: string;
  manifest: RunManifest;
  resumed: boolean;
}): Promise<RunProgress> {
  let stored: StoredRunProgress | undefined;
  if (await pathExists(input.progressPath)) {
    try {
      stored = JSON.parse(
        await readFile(input.progressPath, "utf8"),
      ) as StoredRunProgress;
    } catch (error) {
      throw new Error(
        `Cannot resume without readable run progress: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      (stored.schemaVersion !== 1 && stored.schemaVersion !== 2) ||
      stored.suiteId !== input.manifest.suiteId ||
      stored.runId !== input.manifest.runId ||
      stored.startedAt !== input.manifest.startedAt
    ) {
      throw new Error(
        "Cannot resume: run progress does not match the existing run manifest",
      );
    }
    if (stored.schemaVersion === 2) return stored;
  }
  const legacyLedgerPath = join(dirname(input.progressPath), "attempts.jsonl");
  const progress: RunProgress = {
    schemaVersion: 2,
    suiteId: input.manifest.suiteId,
    runId: input.manifest.runId,
    status: "in-progress",
    startedAt: input.manifest.startedAt,
    updatedAt: new Date().toISOString(),
    resumed: input.resumed,
    completedCases: stored?.completedCases ?? [],
    attempts: await loadAttemptLedger(legacyLedgerPath),
  };
  await writeJsonAtomically(input.progressPath, progress);
  await rm(legacyLedgerPath, { force: true });
  return progress;
}

function attemptRoot(runRoot: string, caseId: string, attempt: number): string {
  return attempt === 1
    ? join(runRoot, caseId)
    : join(runRoot, caseId, "attempts", String(attempt).padStart(3, "0"));
}

function suiteStatus(
  cases: BenchmarkCaseReport[],
): BenchmarkSuiteReport["status"] {
  if (cases.some(({ status }) => status === "fail")) return "fail";
  if (cases.some(({ status }) => status === "blocked")) return "blocked";
  if (cases.some(({ status }) => status === "pending-review")) {
    return "pending-review";
  }
  return "pass";
}

function suiteQualityReview(
  cases: BenchmarkCaseReport[],
): NonNullable<BenchmarkSuiteReport["qualityReview"]> {
  const statuses = cases.map(
    (report) => report.qualityReview?.status ?? "pass",
  );
  const failed = statuses.filter((status) => status === "fail").length;
  const pending = statuses.filter((status) => status === "pending").length;
  const passed = statuses.filter((status) => status === "pass").length;
  return {
    status: failed > 0 ? "fail" : pending > 0 ? "pending" : "pass",
    pending,
    passed,
    failed,
  };
}

async function writeSuiteProgress(input: {
  progressPath: string;
  progress: RunProgress;
  resumed: boolean;
  cases: BenchmarkCaseReport[];
  status?: RunProgress["status"];
}): Promise<void> {
  const completedCases = input.cases.map(
    ({ id, status, attempt, failure }): RunProgressCase => ({
      id,
      status,
      attempt,
      ...(failure ? { failure } : {}),
    }),
  );
  const updatedAt = new Date().toISOString();
  await writeJsonAtomically(input.progressPath, {
    ...input.progress,
    status: input.status ?? input.progress.status,
    updatedAt,
    resumed: input.resumed,
    completedCases,
  });
  input.progress.status = input.status ?? input.progress.status;
  input.progress.updatedAt = updatedAt;
  input.progress.resumed = input.resumed;
  input.progress.completedCases = completedCases;
}

export type CodexAgentAdapterOptions = Omit<CodexAgent, "adapter">;

export function createCodexAgentAdapter(
  options: CodexAgentAdapterOptions = {},
): CodexAgent {
  return { adapter: "codex", ...options };
}

export type ClaudeAgentAdapterOptions = Omit<ClaudeAgent, "adapter">;

export function createClaudeAgentAdapter(
  options: ClaudeAgentAdapterOptions = {},
): ClaudeAgent {
  return { adapter: "claude", ...options };
}

export type PiAgentAdapterOptions = Omit<PiAgent, "adapter">;

export function createPiAgentAdapter(
  options: PiAgentAdapterOptions = {},
): PiAgent {
  return { adapter: "pi", ...options };
}

async function runBenchmarkSuiteInProcessScope(
  input: RunBenchmarkSuiteInput,
  processScope: BenchmarkProcessScope,
): Promise<BenchmarkSuiteReport> {
  if (input.force && !input.resume) {
    throw new Error("--force requires --resume");
  }
  const parsedSuite = ArtifactBenchmarkSuiteSchema.safeParse(input.suite);
  if (!parsedSuite.success) {
    const detail = parsedSuite.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid benchmark suite: ${detail}`);
  }
  assertSafePathSegment(input.runId, "Run id");
  for (const benchmark of parsedSuite.data.cases)
    assertSafePathSegment(benchmark.id, "Benchmark case id");

  const suiteRoot = await realpath(input.suiteRoot);
  if (!(await stat(suiteRoot)).isDirectory())
    throw new Error("suiteRoot must be a directory");
  for (const benchmark of parsedSuite.data.cases) {
    benchmark.skills = await resolveTaskSkillPack(benchmark, suiteRoot);
  }
  await mkdir(resolve(input.outputRoot), { recursive: true });
  const outputRoot = await realpath(resolve(input.outputRoot));
  if (!(await stat(outputRoot)).isDirectory())
    throw new Error("outputRoot must be a directory");
  const configuredRunRoot = join(outputRoot, input.runId);
  const suiteSha256 = sha256Json(parsedSuite.data);
  let runRoot: string;
  let manifest: RunManifest;
  if (input.resume) {
    if (!(await pathExists(configuredRunRoot))) {
      throw new Error(
        `Cannot resume because the run directory does not exist: ${configuredRunRoot}`,
      );
    }
    runRoot = await realpath(configuredRunRoot);
    const localRunRoot = relative(outputRoot, runRoot);
    if (
      !localRunRoot ||
      localRunRoot === ".." ||
      localRunRoot.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `Run directory must remain inside outputRoot: ${runRoot}`,
      );
    }
    const manifestPath = join(runRoot, "run-manifest.json");
    let parsedManifest: RunManifest;
    try {
      parsedManifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as RunManifest;
    } catch (error) {
      throw new Error(
        `Cannot resume without a readable run manifest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      parsedManifest.schemaVersion !== 1 ||
      parsedManifest.suiteId !== parsedSuite.data.id ||
      parsedManifest.runId !== input.runId ||
      parsedManifest.suiteSha256 !== suiteSha256
    ) {
      throw new Error(
        "Cannot resume: the benchmark suite does not match the existing run manifest",
      );
    }
    manifest = parsedManifest;
  } else {
    await createFreshDirectory(configuredRunRoot, "Run directory");
    runRoot = await realpath(configuredRunRoot);
    manifest = {
      schemaVersion: 1,
      suiteId: parsedSuite.data.id,
      runId: input.runId,
      suiteSha256,
      startedAt: new Date().toISOString(),
    };
    await writeJsonAtomically(join(runRoot, "run-manifest.json"), manifest);
  }

  const maxInfrastructureAttempts = input.maxInfrastructureAttempts ?? 2;
  if (
    !Number.isInteger(maxInfrastructureAttempts) ||
    maxInfrastructureAttempts < 1
  ) {
    throw new Error("maxInfrastructureAttempts must be a positive integer");
  }
  const progressPath = join(runRoot, "suite-progress.json");
  const progress = await loadRunProgress({
    progressPath,
    manifest,
    resumed: Boolean(input.resume),
  });
  const ledger = progress.attempts;
  const startedAt = manifest.startedAt;
  const cases: BenchmarkCaseReport[] = [];
  for (const benchmark of parsedSuite.data.cases) {
    if (processScope.interruptedSignal) break;
    const existingEntries = ledger.filter(
      ({ caseId }) => caseId === benchmark.id,
    );
    const terminalAttempts = new Set(
      existingEntries
        .filter(({ event }) => event === "completed" || event === "abandoned")
        .map(({ attempt }) => attempt),
    );
    for (const entry of existingEntries.filter(
      ({ event, attempt }) =>
        event === "started" && !terminalAttempts.has(attempt),
    )) {
      const failure: BenchmarkCaseFailure = {
        classification: "infrastructure",
        retryable: true,
        phase: "runner-interrupted",
        detail:
          "The previous runner stopped before recording a completed attempt.",
      };
      const abandoned: BenchmarkAttemptLedgerEntry = {
        schemaVersion: 1,
        suiteId: parsedSuite.data.id,
        runId: input.runId,
        caseId: benchmark.id,
        attempt: entry.attempt,
        event: "abandoned",
        at: new Date().toISOString(),
        caseRoot: entry.caseRoot,
        failure,
      };
      await recordAttemptEntry(progressPath, progress, abandoned);
      existingEntries.push(abandoned);
    }

    const completedEntries = existingEntries.filter(
      (entry): entry is BenchmarkAttemptLedgerEntry & { reportPath: string } =>
        entry.event === "completed" && typeof entry.reportPath === "string",
    );
    const latestCompleted = completedEntries.at(-1);
    let latestReport: BenchmarkCaseReport | undefined;
    if (latestCompleted) {
      await assertEnvironmentResumeLockMatches({
        suiteId: parsedSuite.data.id,
        suiteRoot,
        runRoot,
        priorCaseRoot: latestCompleted.caseRoot,
        benchmark,
        agent: input.agent,
        ...(input.qualityReviewer
          ? { qualityReviewer: input.qualityReviewer }
          : {}),
      });
      await assertEnvironmentResumeAttemptMatches({
        suiteRoot,
        runRoot,
        benchmark,
        completed: latestCompleted,
      });
      const reportPath = resolve(runRoot, latestCompleted.reportPath);
      relativeRunPath(runRoot, reportPath);
      try {
        latestReport = JSON.parse(
          await readFile(reportPath, "utf8"),
        ) as BenchmarkCaseReport;
      } catch (error) {
        throw new Error(
          `Cannot resume case '${benchmark.id}' because its completed report is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      latestReport.attempt ??= latestCompleted.attempt;
      latestReport.failure ??= classifyCaseFailure(latestReport);
    }

    const completedInfrastructureFailures = completedEntries.filter(
      ({ failure }) =>
        failure?.classification === "infrastructure" && failure.retryable,
    ).length;
    const completedForcedEntries = completedEntries.filter(
      ({ forced }) => forced === true,
    );
    const latestForcedCompleted = completedForcedEntries.at(-1);
    const latestAttemptWasForced = latestCompleted?.forced === true;
    let forcedRetryRequested = false;
    if (
      input.force &&
      latestReport?.status === "fail" &&
      (latestAttemptWasForced ||
        latestReport.failure?.classification !== "infrastructure")
    ) {
      if (latestAttemptWasForced && latestForcedCompleted) {
        const hasForcePending = existingEntries.some(
          ({ event, attempt, forced }) =>
            event === "force-pending" &&
            attempt === latestForcedCompleted.attempt &&
            forced === true,
        );
        const pendingWasConsumed = existingEntries.some(
          ({ event, attempt, forced }) =>
            event === "started" &&
            forced === true &&
            attempt > latestForcedCompleted.attempt,
        );
        if (!hasForcePending || pendingWasConsumed) {
          throw new Error(
            `A force-pending record is required before another forced retry of case '${benchmark.id}'`,
          );
        }
      }
      forcedRetryRequested = true;
    }
    if (
      latestReport &&
      !forcedRetryRequested &&
      (latestAttemptWasForced ||
        latestReport.status === "pass" ||
        latestReport.status === "blocked" ||
        latestReport.failure?.classification !== "infrastructure" ||
        !latestReport.failure.retryable ||
        completedInfrastructureFailures >= maxInfrastructureAttempts)
    ) {
      cases.push(latestReport);
      await writeSuiteProgress({
        progressPath,
        progress,
        resumed: Boolean(input.resume),
        cases,
      });
      continue;
    }

    let infrastructureFailures = completedInfrastructureFailures;
    let nextAttempt =
      Math.max(0, ...existingEntries.map(({ attempt }) => attempt)) + 1;
    while (true) {
      const caseRoot = attemptRoot(runRoot, benchmark.id, nextAttempt);
      await mkdir(dirname(caseRoot), { recursive: true });
      const startedEntry: BenchmarkAttemptLedgerEntry = {
        schemaVersion: 1,
        suiteId: parsedSuite.data.id,
        runId: input.runId,
        caseId: benchmark.id,
        attempt: nextAttempt,
        event: "started",
        at: new Date().toISOString(),
        caseRoot: relativeRunPath(runRoot, caseRoot),
        ...(forcedRetryRequested ? { forced: true } : {}),
      };
      await recordAttemptEntry(progressPath, progress, startedEntry);

      let report: BenchmarkCaseReport;
      try {
        report =
          benchmark.execution?.preflight?.status === "blocked"
            ? await createBlockedCaseReport({
                suiteId: parsedSuite.data.id,
                benchmark,
                agent: input.agent,
                ...(input.qualityReviewer
                  ? { qualityReviewer: input.qualityReviewer }
                  : {}),
                suiteRoot,
                caseRoot,
                attempt: nextAttempt,
              })
            : await runCase({
                suiteId: parsedSuite.data.id,
                benchmark,
                agent: input.agent,
                ...(input.qualityReviewer
                  ? { qualityReviewer: input.qualityReviewer }
                  : {}),
                suiteRoot,
                caseRoot,
                processScope,
              });
      } catch (error) {
        report = await createInfrastructureFailureReport({
          suiteId: parsedSuite.data.id,
          benchmark,
          agent: input.agent,
          caseRoot,
          attempt: nextAttempt,
          error,
        });
      }
      report.attempt = nextAttempt;
      report.failure = classifyCaseFailure(report);
      if (forcedRetryRequested && report.status !== "pass") {
        report.forcePending = true;
      }
      await writeJson(join(caseRoot, "case-report.json"), report);

      let attemptReceipt: BenchmarkAttemptReceipt | undefined;

      if (benchmark.execution?.environment) {
        let environmentCapture: BenchmarkModifiedWorkspaceCapture;
        if (benchmark.execution.preflight?.status === "blocked") {
          environmentCapture = { status: "blocked" };
        } else {
          try {
            const recorded = JSON.parse(
              await readFile(
                join(caseRoot, "environment-capture.json"),
                "utf8",
              ),
            ) as Record<string, unknown>;
            environmentCapture =
              recorded.status === "complete" &&
              typeof recorded.path === "string"
                ? {
                    status: "complete",
                    path: resolve(caseRoot, recorded.path),
                  }
                : recorded.status === "failed" &&
                    typeof recorded.error === "string"
                  ? { status: "failed", error: recorded.error }
                  : {
                      status: "failed",
                      error: "Modified Workspace capture receipt is invalid",
                    };
          } catch (error) {
            environmentCapture = {
              status: "failed",
              error:
                report.failure?.detail ??
                `Modified Workspace capture receipt is unavailable: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }
        if (
          environmentCapture.status !== "complete" &&
          report.status === "pass"
        ) {
          const detail =
            environmentCapture.status === "failed"
              ? environmentCapture.error
              : "Modified Workspace capture was blocked";
          report.status = "fail";
          report.execution.status = "fail";
          report.execution.detail =
            `${report.execution.detail} Modified Workspace capture failed: ${detail}`.trim();
          report.outcome.status = "failed";
          report.outcome.executionStatus = "fail";
          report.failure = {
            classification: "infrastructure",
            retryable: true,
            phase: "environment-capture",
            detail,
          };
          await writeCaseReportFiles(caseRoot, report);
        }
        const inputWorkspace =
          benchmark.execution.environment.initialState?.workspace;
        await writeBenchmarkAttemptCapture({
          caseRoot,
          suiteId: parsedSuite.data.id,
          runId: input.runId,
          benchmark,
          agent: input.agent,
          report,
          attempt: nextAttempt,
          startedAt: startedEntry.at,
          finishedAt: new Date().toISOString(),
          ...(inputWorkspace
            ? {
                inputWorkspaceBundle: resolve(suiteRoot, inputWorkspace.path),
              }
            : {}),
          modifiedWorkspaceCapture: environmentCapture,
          serviceVersion: "0.1.0",
        });
        attemptReceipt = await writeBenchmarkAttempt({
          caseRoot,
          suiteRoot,
        });
        await publishBenchmarkEvaluationResults({
          caseRoot,
          suiteRoot,
          benchmark,
          report,
        });
      }

      const completedEntry: BenchmarkAttemptLedgerEntry = {
        schemaVersion: 1,
        suiteId: parsedSuite.data.id,
        runId: input.runId,
        caseId: benchmark.id,
        attempt: nextAttempt,
        event: "completed",
        at: new Date().toISOString(),
        caseRoot: relativeRunPath(runRoot, caseRoot),
        status: report.status,
        ...(forcedRetryRequested ? { forced: true } : {}),
        ...(report.failure ? { failure: report.failure } : {}),
        reportPath: relativeRunPath(
          runRoot,
          join(caseRoot, "case-report.json"),
        ),
        ...(attemptReceipt
          ? {
              attemptPath: relativeRunPath(
                runRoot,
                join(caseRoot, attemptReceipt.path),
              ),
              attemptSha256: attemptReceipt.sha256,
              attemptDigest: attemptReceipt.attemptDigest,
            }
          : {}),
      };
      await recordAttemptEntry(progressPath, progress, completedEntry);

      if (forcedRetryRequested && report.status !== "pass") {
        const forcePendingEntry: BenchmarkAttemptLedgerEntry = {
          schemaVersion: 1,
          suiteId: parsedSuite.data.id,
          runId: input.runId,
          caseId: benchmark.id,
          attempt: nextAttempt,
          event: "force-pending",
          at: new Date().toISOString(),
          caseRoot: relativeRunPath(runRoot, caseRoot),
          forced: true,
          status: report.status,
          ...(report.failure ? { failure: report.failure } : {}),
          reportPath: relativeRunPath(
            runRoot,
            join(caseRoot, "case-report.json"),
          ),
        };
        await recordAttemptEntry(progressPath, progress, forcePendingEntry);
      }

      if (processScope.interruptedSignal) {
        cases.push(report);
        await writeSuiteProgress({
          progressPath,
          progress,
          resumed: Boolean(input.resume),
          cases,
        });
        break;
      }

      if (
        !forcedRetryRequested &&
        report.failure?.classification === "infrastructure" &&
        report.failure.retryable
      ) {
        infrastructureFailures += 1;
        if (infrastructureFailures < maxInfrastructureAttempts) {
          nextAttempt += 1;
          continue;
        }
      }
      cases.push(report);
      await writeSuiteProgress({
        progressPath,
        progress,
        resumed: Boolean(input.resume),
        cases,
      });
      break;
    }
    if (processScope.interruptedSignal) break;
  }
  const report: BenchmarkSuiteReport = {
    schemaVersion: 1,
    suiteId: parsedSuite.data.id,
    runId: input.runId,
    status: processScope.interruptedSignal ? "fail" : suiteStatus(cases),
    startedAt,
    finishedAt: new Date().toISOString(),
    resumed: Boolean(input.resume),
    qualityReview: suiteQualityReview(cases),
    cases,
  };
  await Promise.all([
    writeJson(join(runRoot, "suite-report.json"), report),
    writeSuiteGallery({ report, runRoot }),
  ]);
  await writeSuiteProgress({
    progressPath,
    progress,
    resumed: Boolean(input.resume),
    cases,
    status: report.status,
  });
  return report;
}

export async function runBenchmarkSuite(
  input: RunBenchmarkSuiteInput,
): Promise<BenchmarkSuiteReport> {
  const processScope = new BenchmarkProcessScope();
  processScope.install();
  try {
    return await runBenchmarkSuiteInProcessScope(input, processScope);
  } finally {
    await processScope.dispose();
  }
}

function sameArtifactEvidence(
  left: ArtifactEvaluationReport["artifacts"],
  right: ArtifactEvaluationReport["artifacts"],
): boolean {
  const byId = (artifacts: ArtifactEvaluationReport["artifacts"]) =>
    [...artifacts].sort((a, b) => a.id.localeCompare(b.id));
  return stableJson(byId(left)) === stableJson(byId(right));
}

async function assertPersistedAgentEvidence(
  caseRoot: string,
  agent: AgentRunReport,
): Promise<void> {
  if (agent.status !== "completed" || agent.exitCode !== 0) {
    throw new Error(
      "Cannot reevaluate a case whose original agent did not complete successfully",
    );
  }
  const paths = [
    agent.stdoutPath,
    agent.stderrPath,
    agent.observedEventsPath,
    agent.trajectoryPath,
  ].filter((path): path is string => typeof path === "string");
  for (const path of paths) {
    const canonical = await realpath(path).catch((error) => {
      throw new Error(
        `Cannot reevaluate without persisted agent evidence '${path}': ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    relativeRunPath(caseRoot, canonical);
    if (!(await stat(canonical)).isFile()) {
      throw new Error(`Persisted agent evidence is not a file: ${path}`);
    }
  }
}

function persistedProductReadbackReport(
  value: unknown,
  path: Exclude<TrustedProductReadback["receiptPath"], "product-readback.json">,
): ProductReadbackReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Persisted product readback '${path}' must be an object`);
  }
  const report = value as Record<string, unknown>;
  if (
    report.schemaVersion !== 1 ||
    (report.status !== "pass" && report.status !== "fail") ||
    (report.projectId !== null && typeof report.projectId !== "string") ||
    !Array.isArray(report.matchedArtifactIds) ||
    !report.matchedArtifactIds.every((id) => typeof id === "string") ||
    typeof report.detail !== "string"
  ) {
    throw new Error(`Persisted product readback '${path}' is invalid`);
  }
  const requiredArrays =
    path === "asset-readback.json"
      ? ["operationEvidence", "matches"]
      : path === "director-readback.json"
        ? ["stages", "matches", "captures", "imageMatches"]
        : path === "remotion-readback.json"
          ? ["timelines", "sourceNodes", "matches"]
          : ["timelines", "matches"];
  if (requiredArrays.some((key) => !Array.isArray(report[key]))) {
    throw new Error(`Persisted product readback '${path}' is invalid`);
  }
  if (path === "director-readback.json") {
    const captures = report.captures as Array<Record<string, unknown>>;
    if (
      captures.some(
        (capture) =>
          !capture ||
          typeof capture !== "object" ||
          !Array.isArray(capture.frames),
      )
    ) {
      throw new Error(`Persisted product readback '${path}' is invalid`);
    }
  }
  if (path === "remotion-readback.json") {
    const matches = report.matches as Array<Record<string, unknown>>;
    if (
      matches.some(
        (match) =>
          !match ||
          typeof match !== "object" ||
          !Array.isArray(match.timelineProjectAssetIds),
      )
    ) {
      throw new Error(`Persisted product readback '${path}' is invalid`);
    }
  }
  return report as ProductReadbackReport;
}

async function loadPersistedProductReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  caseRoot: string;
  attempt?: BenchmarkAttemptVerification;
}): Promise<TrustedProductReadback | undefined> {
  const mechanism = input.benchmark.execution?.productReadback?.mechanism;
  const paths: Array<
    Exclude<TrustedProductReadback["receiptPath"], "product-readback.json">
  > = [];
  if (mechanism === "asset-bytes-and-host-receipt") {
    paths.push("asset-readback.json");
  }
  if (
    input.benchmark.rubric.some((rubric) => rubric.type === "director-stage")
  ) {
    paths.push("director-readback.json");
  }
  if (
    mechanism === "remotion-component-and-render-receipt" ||
    mechanism === "mixed-remotion-lineage-and-render-receipt"
  ) {
    paths.push("remotion-readback.json");
  } else if (mechanism === "timeline-state-and-render-receipt") {
    paths.push("timeline-readback.json");
  }
  if (paths.length === 0) return undefined;

  const declared = input.attempt
    ? new Set(
        input.attempt.record.evidence.readback.map((evidence) => evidence.path),
      )
    : undefined;
  const reports = await Promise.all(
    paths.map(async (path) => {
      if (declared && !declared.has(path)) {
        throw new Error(
          `Cannot reevaluate because the sealed Attempt does not declare '${path}'`,
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(await readFile(join(input.caseRoot, path), "utf8"));
      } catch (error) {
        throw new Error(
          `Cannot reevaluate without persisted product readback '${path}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return persistedProductReadbackReport(value, path);
    }),
  );
  if (reports.length === 1) {
    return { report: reports[0]!, receiptPath: paths[0]! };
  }
  return {
    receiptPath: "product-readback.json",
    report: combineProductReadbackReports(reports, {
      requireMixedLineage:
        mechanism === "mixed-remotion-lineage-and-render-receipt",
    }),
  };
}

export async function reevaluateBenchmarkRun(
  input: ReevaluateBenchmarkRunInput,
): Promise<BenchmarkCaseReport> {
  const parsedSuite = ArtifactBenchmarkSuiteSchema.safeParse(input.suite);
  if (!parsedSuite.success) {
    const detail = parsedSuite.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid benchmark suite: ${detail}`);
  }
  assertSafePathSegment(input.runId, "Run id");
  assertSafePathSegment(input.caseId, "Benchmark case id");
  const matchingCases = parsedSuite.data.cases.filter(
    ({ id }) => id === input.caseId,
  );
  if (matchingCases.length !== 1) {
    throw new Error(`Benchmark case not found: ${input.caseId}`);
  }
  const benchmark = matchingCases[0]!;
  const suiteRoot = await realpath(input.suiteRoot);
  if (!(await stat(suiteRoot)).isDirectory()) {
    throw new Error("suiteRoot must be a directory");
  }
  const outputRoot = await realpath(resolve(input.outputRoot));
  if (!(await stat(outputRoot)).isDirectory()) {
    throw new Error("outputRoot must be a directory");
  }
  const configuredRunRoot = join(outputRoot, input.runId);
  if (!(await pathExists(configuredRunRoot))) {
    throw new Error(
      `Cannot reevaluate because the run directory does not exist: ${configuredRunRoot}`,
    );
  }
  const runRoot = await realpath(configuredRunRoot);
  relativeRunPath(outputRoot, runRoot);
  const manifestPath = join(runRoot, "run-manifest.json");
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunManifest;
  } catch (error) {
    throw new Error(
      `Cannot reevaluate without a readable run manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const singleCaseSuite = { ...parsedSuite.data, cases: [benchmark] };
  const acceptedSuiteHashes = new Set([
    sha256Json(parsedSuite.data),
    sha256Json(singleCaseSuite),
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.suiteId !== parsedSuite.data.id ||
    manifest.runId !== input.runId ||
    !acceptedSuiteHashes.has(manifest.suiteSha256)
  ) {
    throw new Error(
      "Cannot reevaluate: the benchmark suite does not match the existing run manifest",
    );
  }
  const progress = await loadRunProgress({
    progressPath: join(runRoot, "suite-progress.json"),
    manifest,
    resumed: true,
  });
  const ledger = progress.attempts;
  const completed = ledger.filter(
    (entry): entry is BenchmarkAttemptLedgerEntry & { reportPath: string } =>
      entry.caseId === benchmark.id &&
      entry.event === "completed" &&
      typeof entry.reportPath === "string",
  );
  const latest = completed.at(-1);
  if (!latest) {
    throw new Error(
      `Cannot reevaluate case '${benchmark.id}' without a completed attempt`,
    );
  }
  const caseRoot = resolve(runRoot, latest.caseRoot);
  relativeRunPath(runRoot, caseRoot);
  if ((await realpath(caseRoot)) !== caseRoot) {
    throw new Error("Cannot reevaluate a case root reached through a symlink");
  }
  const attemptVerification = await assertEnvironmentResumeAttemptMatches({
    suiteRoot,
    runRoot,
    benchmark,
    completed: latest,
  });
  const reportPath = resolve(runRoot, latest.reportPath);
  relativeRunPath(runRoot, reportPath);
  if (dirname(reportPath) !== caseRoot) {
    throw new Error(
      "Completed attempt report does not belong to its case root",
    );
  }
  let previous: BenchmarkCaseReport;
  try {
    previous = JSON.parse(
      await readFile(reportPath, "utf8"),
    ) as BenchmarkCaseReport;
  } catch (error) {
    throw new Error(
      `Cannot reevaluate case '${benchmark.id}' because its completed report is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (previous.id !== benchmark.id) {
    throw new Error(
      "Completed attempt report does not match the benchmark case",
    );
  }
  const workspace = await realpath(join(caseRoot, "workspace"));
  if (previous.workspace !== workspace) {
    throw new Error(
      "Completed attempt report does not match its persisted workspace",
    );
  }
  await assertPersistedAgentEvidence(caseRoot, previous.agent);
  const submission = await loadSubmission(workspace);
  if (
    submission.error ||
    !submission.submission ||
    submission.submission.taskId !== benchmark.id ||
    submission.artifacts.some(({ error }) => Boolean(error))
  ) {
    throw new Error(
      `Cannot reevaluate without a valid persisted submission for '${benchmark.id}': ${submission.error ?? "artifact evidence is missing or invalid"}`,
    );
  }
  const currentEvidence = submission.artifacts.flatMap(({ evidence }) =>
    evidence ? [evidence] : [],
  );
  if (!sameArtifactEvidence(previous.evaluation.artifacts, currentEvidence)) {
    throw new Error(
      "Cannot reevaluate because the persisted workspace artifacts changed after the original evaluation",
    );
  }
  const productReadback = benchmark.execution
    ? await loadPersistedProductReadback({
        benchmark,
        caseRoot,
        ...(attemptVerification ? { attempt: attemptVerification } : {}),
      })
    : undefined;
  const fixtureIntegrity = previous.inputFixture
    ? await verifyBenchmarkInputFixture(workspace, previous.inputFixture)
    : undefined;
  const execution = await evaluateProductExecution(
    benchmark,
    previous.agent,
    productReadback,
    fixtureIntegrity,
  );
  const evaluation = await evaluateSubmission({ benchmark, workspace });
  let qualityReview: QualityReviewReport;
  if (benchmark.execution?.environment?.track !== "content-effect") {
    qualityReview = nonRequiredQualityReview();
  } else if (previous.agent.status !== "completed") {
    qualityReview = nonRunQualityReview(benchmark, "failed");
  } else {
    try {
      const request = createQualityReviewRequest({ benchmark, evaluation });
      let result: QualityReviewResult | undefined;
      try {
        result = JSON.parse(
          await readFile(join(caseRoot, "quality-review-result.json"), "utf8"),
        ) as QualityReviewResult;
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      qualityReview = evaluateQualityReview({
        request,
        ...(result ? { result } : {}),
      });
      await writeJsonAtomically(
        join(caseRoot, "quality-review-request.json"),
        request,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      qualityReview = {
        required: true,
        status: "fail",
        detail: `Independent content review lacked exact artifact evidence (error sha256 ${sha256Bytes(detail)}).`,
      };
    }
  }
  await writeJsonAtomically(
    join(caseRoot, "quality-review.json"),
    qualityReview,
  );
  const outcome = createOutcomeResult({
    benchmark,
    agentStatus: previous.agent.status,
    evaluationStatus: evaluation.status,
    executionStatus: execution.status,
    qualityReviewStatus: qualityReview.status,
    score: evaluation.score,
  });
  const report: BenchmarkCaseReport = {
    id: benchmark.id,
    workspace,
    ...(previous.inputFixture ? { inputFixture: previous.inputFixture } : {}),
    status:
      outcome.status === "achieved"
        ? "pass"
        : outcome.status === "pending-review"
          ? "pending-review"
          : "fail",
    attempt: previous.attempt ?? latest.attempt,
    agent: previous.agent,
    execution,
    evaluation,
    qualityReview,
    outcome,
  };
  report.failure = classifyCaseFailure(report);

  const suiteReportPath = join(runRoot, "suite-report.json");
  let suiteReport: BenchmarkSuiteReport;
  try {
    suiteReport = JSON.parse(
      await readFile(suiteReportPath, "utf8"),
    ) as BenchmarkSuiteReport;
  } catch (error) {
    throw new Error(
      `Cannot reevaluate without a readable suite report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    suiteReport.schemaVersion !== 1 ||
    suiteReport.suiteId !== manifest.suiteId ||
    suiteReport.runId !== manifest.runId ||
    !suiteReport.cases.some(({ id }) => id === benchmark.id)
  ) {
    throw new Error(
      "Cannot reevaluate: suite report does not match the run manifest",
    );
  }
  const cases = suiteReport.cases.map((candidate) =>
    candidate.id === benchmark.id ? report : candidate,
  );
  const updatedSuiteReport: BenchmarkSuiteReport = {
    ...suiteReport,
    status: suiteStatus(cases),
    qualityReview: suiteQualityReview(cases),
    finishedAt: new Date().toISOString(),
    cases,
  };
  await writeJsonAtomically(join(caseRoot, "evaluation.json"), evaluation);
  await writeJsonAtomically(join(caseRoot, "execution.json"), execution);
  await writeJsonAtomically(join(caseRoot, "outcome-result.json"), outcome);
  await writeJsonAtomically(reportPath, report);
  if (benchmark.execution?.environment) {
    await publishBenchmarkEvaluationResults({
      caseRoot,
      suiteRoot,
      benchmark,
      report,
    });
  }
  await writeJsonAtomically(suiteReportPath, updatedSuiteReport);
  await writeSuiteGallery({ report: updatedSuiteReport, runRoot });
  return report;
}
