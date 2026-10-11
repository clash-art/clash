#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  createClaudeAgentAdapter,
  createCodexAgentAdapter,
  createPiAgentAdapter,
} from "./runner";
import { runBenchmarkSuite, createNativeLocalBackend } from "./runner";
import {
  qualityJudgeEnvironmentNames,
  resolveQualityJudgeEnvironment,
} from "./quality-judge-environment";
import { loadBenchmarkSuite } from "./suite";
import {
  createClaudeCloudBackend,
  pruneCloudResultBranches,
} from "./backend-claude-cloud";
import { createContainerBackend } from "./backend-container";
import type { ExecutionBackend } from "./execution-backend";
import {
  DEFAULT_SUBJECT_BUILD,
  resolveBenchmarkSubject,
  type BenchmarkSubjectSpec,
  type ResolvedBenchmarkSubject,
} from "./subject";
import type { BenchmarkAgent } from "./types";

const execFileAsync = promisify(execFile);

type CliOptions = {
  suite?: string;
  output?: string;
  runId?: string;
  caseId?: string;
  agent?: "codex" | "claude" | "pi" | "command";
  agentCommand?: string;
  agentArgs: string[];
  agentSkills: string[];
  model?: string;
  provider?: string;
  qualityReviewer?: "codex" | "gemini";
  qualityProvider?: string;
  qualityModel?: string;
  qualityReviewerCommand?: string;
  qualityApiKeyEnv?: string;
  qualityBaseUrl?: string;
  clashPluginRoot?: string;
  clashProfile?: "dev" | "prod";
  resume?: boolean;
  force?: boolean;
  maxInfrastructureAttempts?: number;
  trials?: number;
  passK?: number;
  spreadTrials?: boolean;
  experimentalClaudeCloud?: boolean;
  parallel?: number;
  backends: Array<"native-local" | "container" | "claude-cloud">;
  concurrency?: number;
  subject?: string;
  subjectRepo?: string;
  subjectVersion?: string;
  subjectSha256?: string;
  subjectBuild?: boolean;
  containerImage?: string;
  containerEngine?: "docker" | "podman";
  containerNetwork?: "default" | "none";
  forwardEnv: string[];
  cloudEnvironment?: string;
  cloudRunnerRev?: string;
};

function usage(): string {
  return `Usage: clash-artifact-bench --suite <suite.json> --out <directory> [options]

Options:
  --agent codex|claude|pi|command  Agent adapter (default: codex)
  --agent-command <path>      Command adapter executable; implies --agent command
  --agent-arg <value>         Append one native agent argument (repeatable)
  --agent-skill <path>        Load one additional Pi skill directory (repeatable)
  --case <case-id>            Run one benchmark case
  --model <model>             Agent model override
  --provider <provider>       Explicit Pi provider (required for ready Environments)
  --quality-reviewer codex|gemini  Run an independent read-only content-effect judge
                              (default: CLASH_BENCH_QUALITY_REVIEWER)
  --quality-provider openai|google  Quality reviewer provider (codex: openai, gemini: google;
                              default: CLASH_BENCH_QUALITY_PROVIDER)
  --quality-model <model>     Quality reviewer model (default: CLASH_BENCH_QUALITY_MODEL)
  --quality-reviewer-command <path>  Codex reviewer executable (default: codex)
  --quality-api-key-env <name>  Variable holding the Gemini API key (default: GEMINI_API_KEY)
  --quality-base-url <url>    Gemini-native API origin, e.g. a relay (default: GEMINI_BASE_URL,
                              then Google)
  --clash-plugin-root <path>  Clash plugin root for clash-host cases (default: plugins/clash)
  --clash-profile dev|prod    Isolated Clash runtime profile (default: dev)
  --trials <n>                Run every case n times; reports pass@1, pass@k, pass^k
  --pass-k <k>                k for the unbiased pass@k / pass^k estimators (1..n, default n)
  --backend <kind>            native-local (default), container, or claude-cloud
                              (experimental). Repeat to use several backends: each
                              task's trials stay on one backend, metrics per backend
  --spread-trials             Opt in to spreading one task's trials across backends
  --experimental-claude-cloud Required for --backend claude-cloud (unverified against
                              a live cloud session)
  --parallel <n>              At most n Attempts at once across all backends
  --concurrency <n>           Attempts at once per backend (default: 1)
  --subject <selector>        Build under test: working-tree (default), commit:<rev>,
                              release:<tarball|directory>, or release:npm:<spec>
  --subject-repo <path>       Repository for working-tree and commit subjects
  --subject-version <v>       Refuse a release whose manifest declares another version
  --subject-sha256 <hex>      Refuse a release tarball or tree with another digest
  --subject-build             Rebuild the working-tree plugin runtime before locking it
  --container-image <ref>     Image for the container backend (Node >= 24.18)
  --container-engine docker|podman
  --container-network default|none
  --forward-env <NAME>        Pass a credential into workers by name (repeatable)
  --cloud-environment <id>    Self-hosted pool (ccpool_...) for claude-cloud
  --cloud-runner-rev <rev>    Pushed revision of this runner for claude-cloud sessions
  --run-id <id>               Stable run id (default: run-<timestamp>)

  clash-artifact-bench prune-cloud-results [--run-id <id>] [--remote <name>] [--repo <path>]
                              Delete bench-results/<run>/... branches claude-cloud pushed
  --resume                    Continue a compatible existing run id
  --force                     Run one explicit retry; later retries require force-pending
  --max-infra-attempts <n>    Retry infrastructure failures only (default: 2 total attempts)
  --out, --output <directory> Run output root
  -h, --help                  Show this help`;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    agentArgs: [],
    agentSkills: [],
    backends: [],
    forwardEnv: [],
  };
  const positive = (value: string, flag: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1 || String(parsed) !== value) {
      throw new Error(`${flag} must be a positive integer`);
    }
    return parsed;
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--") continue;
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (flag === "--suite") options.suite = requiredValue(args, index++, flag);
    else if (flag === "--out" || flag === "--output")
      options.output = requiredValue(args, index++, flag);
    else if (flag === "--run-id")
      options.runId = requiredValue(args, index++, flag);
    else if (flag === "--resume") options.resume = true;
    else if (flag === "--force") options.force = true;
    else if (flag === "--max-infra-attempts") {
      const value = Number.parseInt(requiredValue(args, index++, flag), 10);
      if (!Number.isInteger(value) || value < 1)
        throw new Error("--max-infra-attempts must be a positive integer");
      options.maxInfrastructureAttempts = value;
    } else if (flag === "--trials")
      options.trials = positive(requiredValue(args, index++, flag), flag);
    else if (flag === "--pass-k")
      options.passK = positive(requiredValue(args, index++, flag), flag);
    else if (flag === "--spread-trials") options.spreadTrials = true;
    else if (flag === "--experimental-claude-cloud")
      options.experimentalClaudeCloud = true;
    else if (flag === "--parallel")
      options.parallel = positive(requiredValue(args, index++, flag), flag);
    else if (flag === "--concurrency")
      options.concurrency = positive(requiredValue(args, index++, flag), flag);
    else if (flag === "--backend") {
      const value = requiredValue(args, index++, flag);
      if (
        value !== "native-local" &&
        value !== "container" &&
        value !== "claude-cloud"
      ) {
        throw new Error(
          "--backend must be native-local, container, or claude-cloud",
        );
      }
      options.backends.push(value);
    } else if (flag === "--subject")
      options.subject = requiredValue(args, index++, flag);
    else if (flag === "--subject-repo")
      options.subjectRepo = requiredValue(args, index++, flag);
    else if (flag === "--subject-version")
      options.subjectVersion = requiredValue(args, index++, flag);
    else if (flag === "--subject-sha256")
      options.subjectSha256 = requiredValue(args, index++, flag);
    else if (flag === "--subject-build") options.subjectBuild = true;
    else if (flag === "--container-image")
      options.containerImage = requiredValue(args, index++, flag);
    else if (flag === "--container-engine") {
      const value = requiredValue(args, index++, flag);
      if (value !== "docker" && value !== "podman")
        throw new Error("--container-engine must be docker or podman");
      options.containerEngine = value;
    } else if (flag === "--container-network") {
      const value = requiredValue(args, index++, flag);
      if (value !== "default" && value !== "none")
        throw new Error("--container-network must be default or none");
      options.containerNetwork = value;
    } else if (flag === "--forward-env")
      options.forwardEnv.push(requiredValue(args, index++, flag));
    else if (flag === "--cloud-environment")
      options.cloudEnvironment = requiredValue(args, index++, flag);
    else if (flag === "--cloud-runner-rev")
      options.cloudRunnerRev = requiredValue(args, index++, flag);
    else if (flag === "--case")
      options.caseId = requiredValue(args, index++, flag);
    else if (flag === "--model")
      options.model = requiredValue(args, index++, flag);
    else if (flag === "--provider")
      options.provider = requiredValue(args, index++, flag);
    else if (flag === "--quality-reviewer") {
      const value = requiredValue(args, index++, flag);
      if (value !== "codex" && value !== "gemini") {
        throw new Error("--quality-reviewer must be codex or gemini");
      }
      options.qualityReviewer = value;
    } else if (flag === "--quality-provider")
      options.qualityProvider = requiredValue(args, index++, flag);
    else if (flag === "--quality-model")
      options.qualityModel = requiredValue(args, index++, flag);
    else if (flag === "--quality-reviewer-command")
      options.qualityReviewerCommand = requiredValue(args, index++, flag);
    else if (flag === "--quality-api-key-env")
      options.qualityApiKeyEnv = requiredValue(args, index++, flag);
    else if (flag === "--quality-base-url")
      options.qualityBaseUrl = requiredValue(args, index++, flag);
    else if (flag === "--clash-plugin-root")
      options.clashPluginRoot = requiredValue(args, index++, flag);
    else if (flag === "--clash-profile") {
      const value = requiredValue(args, index++, flag);
      if (value !== "dev" && value !== "prod")
        throw new Error("--clash-profile must be dev or prod");
      options.clashProfile = value;
    } else if (flag === "--agent-arg")
      options.agentArgs.push(requiredValue(args, index++, flag));
    else if (flag === "--agent-skill")
      options.agentSkills.push(requiredValue(args, index++, flag));
    else if (flag === "--agent-command") {
      options.agentCommand = requiredValue(args, index++, flag);
      options.agent = "command";
    } else if (flag === "--agent") {
      const value = requiredValue(args, index++, flag);
      if (
        value !== "codex" &&
        value !== "claude" &&
        value !== "pi" &&
        value !== "command"
      ) {
        throw new Error("--agent must be codex, claude, pi, or command");
      }
      options.agent = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

async function runWorker(args: string[]): Promise<void> {
  const valueOf = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const unit = valueOf("--unit");
  if (!unit) throw new Error("worker requires --unit <attempt-unit.json>");
  const suiteRoot = valueOf("--suite-root");
  const { runAttemptUnit } = await import("./attempt-worker");
  await runAttemptUnit(unit, suiteRoot ? { suiteRoot } : {});
}

async function pruneCloudResults(args: string[]): Promise<void> {
  const valueOf = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? requiredValue(args, index, name) : undefined;
  };
  const invocationRoot = process.env.INIT_CWD ?? process.cwd();
  const repo = valueOf("--repo");
  const runId = valueOf("--run-id");
  const remote = valueOf("--remote");
  const deleted = await pruneCloudResultBranches({
    repoRoot: repo
      ? resolve(invocationRoot, repo)
      : await gitToplevel(invocationRoot),
    ...(runId ? { runId } : {}),
    ...(remote ? { remote } : {}),
  });
  process.stdout.write(`${JSON.stringify({ deleted }, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (process.argv[2] === "worker") {
    await runWorker(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "prune-cloud-results") {
    await pruneCloudResults(process.argv.slice(3));
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (!options.suite) throw new Error("--suite is required");
  if (!options.output) throw new Error("--out is required");
  if (options.resume && !options.runId)
    throw new Error("--resume requires --run-id");
  if (options.force && !options.resume)
    throw new Error("--force requires --resume");
  if (options.passK !== undefined) {
    if (options.trials === undefined)
      throw new Error("--pass-k requires --trials");
    if (options.passK > options.trials)
      throw new Error("--pass-k must not exceed --trials");
  }
  if (options.spreadTrials && new Set(options.backends).size < 2) {
    throw new Error("--spread-trials requires at least two --backend values");
  }
  if (
    options.backends.includes("claude-cloud") &&
    !options.experimentalClaudeCloud
  ) {
    throw new Error(
      "--backend claude-cloud is experimental: it has not been verified against a live claude --cloud session. Pass --experimental-claude-cloud to opt in.",
    );
  }
  const invocationRoot = process.env.INIT_CWD ?? process.cwd();
  const suitePath = resolve(invocationRoot, options.suite);
  const loadedSuite = await loadBenchmarkSuite(suitePath);
  const suite = options.caseId
    ? {
        ...loadedSuite,
        cases: loadedSuite.cases.filter(
          (benchmarkCase) => benchmarkCase.id === options.caseId,
        ),
      }
    : loadedSuite;
  if (suite.cases.length === 0)
    throw new Error(`Benchmark case not found: ${options.caseId}`);

  const adapter = options.agent ?? (options.agentCommand ? "command" : "codex");
  if (options.agentSkills.length > 0 && adapter !== "pi") {
    throw new Error("--agent-skill requires --agent pi");
  }
  if (options.provider && adapter !== "pi") {
    throw new Error("--provider requires --agent pi");
  }
  const requiresExplicitSelection = suite.cases.some(
    (benchmarkCase) =>
      Boolean(benchmarkCase.execution?.environment) &&
      benchmarkCase.execution?.preflight?.status !== "blocked",
  );
  if (requiresExplicitSelection && !options.model) {
    throw new Error("--model is required for every ready Environment");
  }
  if (requiresExplicitSelection && adapter === "pi" && !options.provider) {
    throw new Error("--provider is required for a ready Pi Environment");
  }
  let qualityReviewer = resolveQualityJudgeEnvironment({
    env: process.env,
    overrides: {
      ...(options.qualityReviewer ? { reviewer: options.qualityReviewer } : {}),
      ...(options.qualityProvider ? { provider: options.qualityProvider } : {}),
      ...(options.qualityModel ? { model: options.qualityModel } : {}),
      ...(options.qualityReviewerCommand
        ? { reviewerCommand: options.qualityReviewerCommand }
        : {}),
      ...(options.qualityApiKeyEnv
        ? { apiKeyEnv: options.qualityApiKeyEnv }
        : {}),
      ...(options.qualityBaseUrl ? { baseUrl: options.qualityBaseUrl } : {}),
    },
  });
  if (qualityReviewer) {
    if (
      !suite.cases.some(
        (benchmarkCase) =>
          benchmarkCase.execution?.environment?.track === "content-effect",
      )
    ) {
      if (options.qualityReviewer) {
        throw new Error(
          "--quality-reviewer requires at least one content-effect case",
        );
      }
      // A judge configured only in the harness environment has nothing to review here.
      qualityReviewer = undefined;
    }
  }
  if (qualityReviewer) {
    // A cloud session reads the key from its own environment's secrets.
    const readsHarnessEnvironment =
      options.backends.length === 0 ||
      options.backends.some((kind) => kind !== "claude-cloud");
    const missing = readsHarnessEnvironment
      ? qualityJudgeEnvironmentNames(qualityReviewer).filter(
          (name) => !process.env[name]?.trim(),
        )
      : [];
    if (missing.length > 0) {
      throw new Error(
        `The ${qualityReviewer.adapter} quality reviewer requires ${missing.join(", ")} in the harness environment`,
      );
    }
  }
  const requiresClashHost = suite.cases.some(
    (benchmarkCase) =>
      benchmarkCase.execution?.profile === "clash-host" &&
      benchmarkCase.execution.preflight?.status !== "blocked",
  );
  if (options.subject && !requiresClashHost) {
    throw new Error("--subject needs at least one runnable clash-host case");
  }
  if (options.subject && options.clashPluginRoot) {
    throw new Error(
      "--subject and --clash-plugin-root both select the build under test",
    );
  }
  const repoRoot = options.subjectRepo
    ? resolve(invocationRoot, options.subjectRepo)
    : await gitToplevel(invocationRoot);
  let subject: ResolvedBenchmarkSubject | undefined;
  let clashPluginRoot = resolve(
    invocationRoot,
    options.clashPluginRoot ?? "plugins/clash",
  );
  if (requiresClashHost && !options.clashPluginRoot) {
    subject = await resolveBenchmarkSubject(
      await subjectSpec({ options, repoRoot }),
    );
    clashPluginRoot = subject.pluginRoot;
  } else if (requiresClashHost) {
    process.stderr.write(
      "warning: --clash-plugin-root selects an unattributed build; no subject will be recorded\n",
    );
  }
  try {
    let agent: BenchmarkAgent;
    if (adapter === "command") {
      if (requiresClashHost)
        throw new Error(
          "clash-host cases require the Codex, Claude, or Pi adapter",
        );
      if (!options.agentCommand)
        throw new Error("--agent-command is required for the command adapter");
      agent = { command: options.agentCommand, args: options.agentArgs };
    } else if (adapter === "codex") {
      agent = createCodexAgentAdapter({
        args: options.agentArgs,
        ...(options.model ? { model: options.model } : {}),
        ...(requiresClashHost
          ? {
              clashHost: {
                pluginRoot: clashPluginRoot,
                profile: options.clashProfile ?? "dev",
              },
            }
          : {}),
      });
    } else if (adapter === "claude") {
      agent = createClaudeAgentAdapter({
        args: options.agentArgs,
        ...(options.model ? { model: options.model } : {}),
        ...(requiresClashHost
          ? {
              clashHost: {
                pluginRoot: clashPluginRoot,
                profile: options.clashProfile ?? "dev",
              },
            }
          : {}),
      });
    } else {
      agent = createPiAgentAdapter({
        args: options.agentArgs,
        skills: options.agentSkills.map((skill) =>
          resolve(invocationRoot, skill),
        ),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.model ? { model: options.model } : {}),
        ...(requiresClashHost
          ? {
              clashHost: {
                pluginRoot: clashPluginRoot,
                profile: options.clashProfile ?? "dev",
              },
            }
          : {}),
      });
    }
    const backends = await buildBackends({
      options,
      repoRoot,
      suitePath,
    });
    const report = await runBenchmarkSuite({
      suite,
      suiteRoot: dirname(suitePath),
      ...(options.trials ? { trials: options.trials } : {}),
      ...(options.passK ? { passK: options.passK } : {}),
      ...(backends ? { backends } : {}),
      ...(options.spreadTrials ? { placement: "spread" as const } : {}),
      ...(options.parallel ? { parallelism: options.parallel } : {}),
      ...(subject ? { subject } : {}),
      outputRoot: resolve(invocationRoot, options.output),
      runId: options.runId ?? `run-${Date.now()}`,
      agent,
      ...(qualityReviewer ? { qualityReviewer } : {}),
      ...(options.resume ? { resume: true } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.maxInfrastructureAttempts
        ? { maxInfrastructureAttempts: options.maxInfrastructureAttempts }
        : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const short = report.trialAggregate?.summary.indeterminateTasks ?? 0;
    if (short > 0) {
      process.stderr.write(
        `warning: ${short} task(s) reached fewer than ${report.passK} scored trials after infrastructure retries; pass@k and pass^k leave them out (raise --max-infra-attempts or --trials)\n`,
      );
    }
    for (const entry of report.trialAggregate?.byBackend ?? []) {
      if (entry.experimental) {
        process.stderr.write(
          `warning: results from ${entry.backend} are experimental (backend unverified)\n`,
        );
      }
    }
    if (
      report.status !== "pass" &&
      (process.exitCode === undefined || process.exitCode === 0)
    ) {
      process.exitCode = 1;
    }
  } finally {
    await subject?.dispose();
  }
}

async function gitToplevel(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      cwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    return stdout.trim();
  } catch {
    return cwd;
  }
}

async function subjectSpec(input: {
  options: CliOptions;
  repoRoot: string;
}): Promise<BenchmarkSubjectSpec> {
  const { options, repoRoot } = input;
  const selector = options.subject ?? "working-tree";
  const workRoot = await mkdtemp(resolve(tmpdir(), "clash-bench-subject-"));
  if (selector === "working-tree") {
    return {
      kind: "working-tree",
      repoRoot,
      ...(options.subjectBuild ? { build: DEFAULT_SUBJECT_BUILD } : {}),
    };
  }
  if (options.subjectBuild) {
    throw new Error("--subject-build applies only to the working-tree subject");
  }
  if (selector.startsWith("commit:")) {
    return {
      kind: "commit",
      repoRoot,
      rev: selector.slice("commit:".length),
      workRoot,
      build: DEFAULT_SUBJECT_BUILD,
    };
  }
  if (selector.startsWith("release:")) {
    const target = selector.slice("release:".length);
    const { stat } = await import("node:fs/promises");
    const artifact = target.startsWith("npm:")
      ? { kind: "npm" as const, spec: target.slice("npm:".length) }
      : (await stat(resolve(target))).isDirectory()
        ? { kind: "installed-directory" as const, path: resolve(target) }
        : { kind: "tarball" as const, path: resolve(target) };
    return {
      kind: "release",
      artifact,
      workRoot,
      ...(options.subjectVersion
        ? { expectedVersion: options.subjectVersion }
        : {}),
      ...(options.subjectSha256
        ? { expectedSha256: options.subjectSha256 }
        : {}),
    };
  }
  throw new Error(
    "--subject must be working-tree, commit:<rev>, or release:<tarball|directory|npm:spec>",
  );
}

async function buildBackends(input: {
  options: CliOptions;
  repoRoot: string;
  suitePath: string;
}): Promise<ExecutionBackend[] | undefined> {
  const { options } = input;
  const kinds = [...new Set(options.backends)];
  if (
    kinds.length === 0 &&
    options.concurrency === undefined &&
    options.parallel === undefined
  ) {
    return undefined;
  }
  const effective = kinds.length > 0 ? kinds : (["native-local"] as const);
  const concurrency = options.concurrency ?? options.parallel ?? 1;
  return effective.map((kind): ExecutionBackend => {
    if (kind === "native-local")
      return createNativeLocalBackend({ concurrency });
    if (kind === "container") {
      if (!options.containerImage) {
        throw new Error(
          "--container-image is required for the container backend",
        );
      }
      return createContainerBackend({
        image: options.containerImage,
        ...(options.containerEngine ? { engine: options.containerEngine } : {}),
        ...(options.containerNetwork
          ? { network: options.containerNetwork }
          : {}),
        runnerRoot: input.repoRoot,
        suiteFile: relative(dirname(input.suitePath), input.suitePath),
        forwardEnv: options.forwardEnv,
        concurrency,
      });
    }
    process.stderr.write(
      "warning: claude-cloud is an EXPERIMENTAL backend, verified only against a simulated session\n",
    );
    return createClaudeCloudBackend({
      experimental: true,
      repoRoot: input.repoRoot,
      suiteFile: relative(input.repoRoot, input.suitePath),
      forwardEnv: options.forwardEnv,
      ...(options.cloudEnvironment
        ? { environmentId: options.cloudEnvironment }
        : {}),
      ...(options.cloudRunnerRev ? { runnerRev: options.cloudRunnerRev } : {}),
      concurrency,
    });
  });
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
