import { createHash } from "node:crypto";
import {
  readFile,
  rename,
  rm,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type {
  BenchmarkRuntimeClaim,
  BenchmarkSubjectRecord,
} from "./backend-types";
import type { BenchmarkAttemptCompletion } from "./execution-backend";
import { verifyBenchmarkAttempt } from "./attempt-manifest";
import { qualityJudgeEnvironmentNames } from "./quality-judge-environment";
import type { BenchmarkAttemptExecutionInput } from "./runner";
import type {
  ArtifactBenchmarkCase,
  BenchmarkAgent,
  BenchmarkCaseReport,
  BenchmarkQualityReviewer,
} from "./types";

/**
 * The wire format a remote worker receives. It is deliberately incapable of
 * carrying a secret: credentials are named, never valued, and the worker reads
 * the values from its own environment (a container `--env NAME` pass-through or
 * a cloud environment secret).
 */
export type PortableAgent =
  | Omit<Extract<BenchmarkAgent, { adapter: "codex" | "claude" | "pi" }>, "env">
  | Omit<Extract<BenchmarkAgent, { command: string }>, "env">;

export type AttemptUnit = {
  schemaVersion: 1;
  kind: "clash.benchmark.attempt-unit";
  suiteId: string;
  runId: string;
  caseId: string;
  /** Integrity check that the worker loaded the same Task the dispatcher planned. */
  caseSha256: string;
  /** Suite file, relative to `suiteRoot`. */
  suiteFile: string;
  /** Absolute at the worker. For container backends this equals the host path. */
  suiteRoot: string;
  /** Absolute at the worker. The dispatcher guarantees it exists and is empty. */
  caseRoot: string;
  attempt: number;
  trial: number;
  repeated?: boolean;
  forced: boolean;
  startedAt: string;
  agent: PortableAgent;
  /** Names of variables the worker must find in its own environment. */
  envNames: string[];
  qualityReviewer?: BenchmarkQualityReviewer;
  /**
   * Variables the judge reads in the worker's own environment. They are never
   * handed to the Agent as explicit environment.
   */
  judgeEnvNames?: string[];
  runtime: BenchmarkRuntimeClaim;
  subject?: {
    record: BenchmarkSubjectRecord;
    /** Mounted plugin root, when the dispatcher provides the build itself. */
    pluginRoot?: string;
    /** Otherwise the worker obtains the build and must reproduce this record. */
    acquire?: { kind: "commit"; rev: string } | { kind: "npm"; spec: string };
  };
};

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Skill pack paths are machine-specific and re-resolved by each worker. */
export function benchmarkCaseSha256(benchmark: ArtifactBenchmarkCase): string {
  const { skills: _skills, ...rest } = benchmark;
  return sha256Text(JSON.stringify(rest));
}

export function toPortableAgent(
  agent: BenchmarkAgent,
  forwardEnv: readonly string[],
): { agent: PortableAgent; envNames: string[] } {
  const { env, ...rest } = agent as BenchmarkAgent & {
    env?: Record<string, string>;
  };
  const envNames = [
    ...new Set([...Object.keys(env ?? {}), ...forwardEnv]),
  ].sort();
  for (const name of envNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  const portable = { ...rest } as PortableAgent & {
    clashHost?: { pluginRoot: string; profile: "dev" | "prod" };
  };
  // The worker points the host at the plugin it has, never at a dispatcher path.
  if (portable.clashHost) {
    portable.clashHost = {
      pluginRoot: "",
      profile: portable.clashHost.profile,
    };
  }
  return { agent: portable, envNames };
}

export function createAttemptUnit(input: {
  dispatch: BenchmarkAttemptExecutionInput;
  suiteFile: string;
  claim: BenchmarkRuntimeClaim;
  forwardEnv: readonly string[];
  subject?: AttemptUnit["subject"];
}): AttemptUnit {
  const { dispatch } = input;
  const { agent, envNames } = toPortableAgent(dispatch.agent, input.forwardEnv);
  const judgeEnvNames = qualityJudgeEnvironmentNames(dispatch.qualityReviewer);
  return {
    schemaVersion: 1,
    kind: "clash.benchmark.attempt-unit",
    suiteId: dispatch.suiteId,
    runId: dispatch.runId,
    caseId: dispatch.benchmark.id,
    caseSha256: benchmarkCaseSha256(dispatch.benchmark),
    suiteFile: input.suiteFile,
    suiteRoot: dispatch.suiteRoot,
    caseRoot: dispatch.caseRoot,
    attempt: dispatch.attempt,
    trial: dispatch.trial,
    ...(dispatch.repeated ? { repeated: true } : {}),
    forced: dispatch.forced,
    startedAt: dispatch.startedAt,
    agent,
    envNames,
    ...(dispatch.qualityReviewer
      ? { qualityReviewer: dispatch.qualityReviewer }
      : {}),
    ...(judgeEnvNames.length > 0 ? { judgeEnvNames } : {}),
    runtime: input.claim,
    ...(input.subject ? { subject: input.subject } : {}),
  };
}

export async function writeAttemptUnit(
  path: string,
  unit: AttemptUnit,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(unit, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readAttemptUnit(path: string): Promise<AttemptUnit> {
  const unit = JSON.parse(await readFile(path, "utf8")) as AttemptUnit;
  if (
    unit?.schemaVersion !== 1 ||
    unit.kind !== "clash.benchmark.attempt-unit" ||
    typeof unit.caseRoot !== "string" ||
    typeof unit.suiteRoot !== "string"
  ) {
    throw new Error("Not a benchmark attempt unit");
  }
  return unit;
}

function digestOf(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}

/** The sealed lock, not the worker's say-so, decides where an Attempt ran. */
export function assertSealedRuntimeMatches(
  lock: {
    resolvedEnvironment?: { runtime?: { kind?: string; backend?: unknown } };
  },
  claim: BenchmarkRuntimeClaim,
): void {
  const runtime = lock.resolvedEnvironment?.runtime;
  if (
    runtime?.kind !== claim.kind ||
    (claim.kind !== "native-local" &&
      digestOf(runtime.backend) !== digestOf(claim))
  ) {
    throw new Error(
      `Sealed Attempt records runtime '${runtime?.kind ?? "none"}', not the dispatched '${claim.kind}' backend`,
    );
  }
}

/**
 * Accept a worker's output only if it is a complete, verifiable Attempt that
 * ran where the dispatcher said it would. The dispatcher never trusts the
 * worker's own account of success: it re-hashes the sealed Attempt and reads
 * the runtime out of the sealed lock.
 */
export async function collectWorkerAttempt(input: {
  caseRoot: string;
  suiteRoot: string;
  claim: BenchmarkRuntimeClaim;
  requireAttempt: boolean;
}): Promise<BenchmarkAttemptCompletion> {
  let report: BenchmarkCaseReport;
  try {
    report = JSON.parse(
      await readFile(join(input.caseRoot, "case-report.json"), "utf8"),
    ) as BenchmarkCaseReport;
  } catch (error) {
    throw new Error(
      `Worker did not produce a readable case report: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!input.requireAttempt) return { report };
  const verification = await verifyBenchmarkAttempt({
    caseRoot: input.caseRoot,
    suiteRoot: input.suiteRoot,
  });
  let lock: {
    resolvedEnvironment?: { runtime?: { kind?: string; backend?: unknown } };
  };
  try {
    lock = JSON.parse(
      await readFile(join(input.caseRoot, "environment-lock.json"), "utf8"),
    );
  } catch (error) {
    throw new Error(
      `Sealed Attempt has no readable Environment lock: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertSealedRuntimeMatches(lock, input.claim);
  return { report, attemptReceipt: verification.receipt };
}

/**
 * Keep a rejected worker result as evidence, then leave an empty case
 * directory so the dispatcher can seal an infrastructure failure there.
 */
export async function quarantineCaseRoot(input: {
  caseRoot: string;
  runRoot: string;
}): Promise<string | undefined> {
  const entries = await readdir(input.caseRoot).catch(() => []);
  if (entries.length === 0) return undefined;
  const quarantine = join(
    input.runRoot,
    ".rejected-worker-output",
    relative(input.runRoot, input.caseRoot).split(sep).join("__"),
  );
  await mkdir(dirname(quarantine), { recursive: true });
  await rm(quarantine, { recursive: true, force: true });
  await rename(input.caseRoot, quarantine);
  await mkdir(input.caseRoot);
  return quarantine;
}
