import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  benchmarkCaseSha256,
  readAttemptUnit,
  type AttemptUnit,
} from "./attempt-unit";
import type { BenchmarkLockSubject } from "./environment-lock";
import { BenchmarkProcessScope, executeBenchmarkAttempt } from "./runner";
import { loadBenchmarkSuite } from "./suite";
import {
  resolveBenchmarkSubject,
  subjectIdentity,
  DEFAULT_SUBJECT_BUILD,
} from "./subject";
import { resolveTaskSkillPack } from "./task-skill-pack";
import type { BenchmarkAgent } from "./types";

function agentFromUnit(
  unit: AttemptUnit,
  env: NodeJS.ProcessEnv,
  pluginRoot: string | undefined,
): BenchmarkAgent {
  const missing = unit.envNames.filter((name) => env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Worker environment is missing credentials the dispatcher named: ${missing.join(", ")}`,
    );
  }
  const values = Object.fromEntries(
    unit.envNames.map((name) => [name, env[name]!]),
  );
  const agent = {
    ...unit.agent,
    ...(unit.envNames.length > 0 ? { env: values } : {}),
  } as BenchmarkAgent & {
    clashHost?: { pluginRoot: string; profile: "dev" | "prod" };
  };
  if (agent.clashHost) {
    if (!pluginRoot) {
      throw new Error(
        "The Agent needs a Clash plugin but no subject was provided",
      );
    }
    agent.clashHost = { ...agent.clashHost, pluginRoot };
  }
  return agent;
}

async function resolveWorkerSubject(
  unit: AttemptUnit,
  cwd: string,
): Promise<(BenchmarkLockSubject & { dispose(): Promise<void> }) | undefined> {
  const wanted = unit.subject;
  if (!wanted) return undefined;
  if (wanted.pluginRoot) {
    return {
      record: wanted.record,
      pluginRoot: wanted.pluginRoot,
      dispose: async () => {},
    };
  }
  if (!wanted.acquire) {
    throw new Error("Unit names a subject but neither mounts nor acquires it");
  }
  const workRoot = join(unit.caseRoot, "..", `.subject-${process.pid}`);
  const resolved =
    wanted.acquire.kind === "commit"
      ? await resolveBenchmarkSubject({
          kind: "commit",
          repoRoot: cwd,
          rev: wanted.acquire.rev,
          workRoot,
          build: DEFAULT_SUBJECT_BUILD,
        })
      : await resolveBenchmarkSubject({
          kind: "release",
          artifact: { kind: "npm", spec: wanted.acquire.spec },
          workRoot,
          ...(wanted.record.artifact.kind === "release-tarball"
            ? { expectedSha256: wanted.record.artifact.sha256 }
            : {}),
          expectedVersion: wanted.record.version,
        });
  // The worker must reproduce the dispatcher's subject exactly, or the
  // recorded identity would describe a build that was not measured.
  if (subjectIdentity(resolved.record) !== subjectIdentity(wanted.record)) {
    await resolved.dispose();
    throw new Error(
      "The worker obtained a different build than the dispatcher selected",
    );
  }
  return {
    record: resolved.record,
    pluginRoot: resolved.pluginRoot,
    dispose: resolved.dispose,
  };
}

/**
 * Executes one dispatched Attempt in this process and leaves a sealed Attempt
 * directory at `unit.caseRoot`. A benchmark failure is a sealed Attempt with a
 * failing report and exit status 0; only a failure to run at all throws.
 */
export async function runAttemptUnit(
  unitPath: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Where this machine keeps the suite, when it differs from the dispatcher's. */
    suiteRoot?: string;
  } = {},
): Promise<void> {
  const unit = await readAttemptUnit(unitPath);
  const suiteRoot = await realpath(options.suiteRoot ?? unit.suiteRoot);
  const suite = await loadBenchmarkSuite(join(suiteRoot, unit.suiteFile));
  const benchmark = suite.cases.find(({ id }) => id === unit.caseId);
  if (!benchmark) {
    throw new Error(`Worker suite has no case '${unit.caseId}'`);
  }
  if (
    unit.suiteId !== suite.id ||
    benchmarkCaseSha256(benchmark) !== unit.caseSha256
  ) {
    throw new Error(
      "The worker's copy of the benchmark case differs from the dispatched one",
    );
  }
  benchmark.skills = await resolveTaskSkillPack(benchmark, suiteRoot);
  await mkdir(unit.caseRoot, { recursive: true });
  if ((await readdir(unit.caseRoot)).length > 0) {
    throw new Error(`Attempt directory must be empty: ${unit.caseRoot}`);
  }
  const subject = await resolveWorkerSubject(
    unit,
    options.cwd ?? process.cwd(),
  );
  const processScope = new BenchmarkProcessScope();
  processScope.install();
  try {
    const agent = agentFromUnit(
      unit,
      options.env ?? process.env,
      subject?.pluginRoot,
    );
    await executeBenchmarkAttempt({
      suiteId: unit.suiteId,
      runId: unit.runId,
      benchmark,
      agent,
      ...(unit.qualityReviewer
        ? { qualityReviewer: unit.qualityReviewer }
        : {}),
      suiteRoot,
      runRoot: resolve(unit.caseRoot, ".."),
      caseRoot: unit.caseRoot,
      attempt: unit.attempt,
      trial: unit.trial,
      ...(unit.repeated ? { repeated: true } : {}),
      forced: unit.forced,
      startedAt: unit.startedAt,
      processScope,
      runtime: unit.runtime,
      adoptCaseRoot: true,
      ...(subject
        ? {
            subject: { record: subject.record, pluginRoot: subject.pluginRoot },
          }
        : {}),
    });
  } finally {
    await processScope.dispose();
    await subject?.dispose();
  }
}
