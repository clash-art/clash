#!/usr/bin/env node
import { dirname, resolve } from "node:path";

import {
  createClaudeAgentAdapter,
  createCodexAgentAdapter,
  createPiAgentAdapter,
} from "./runner";
import { runBenchmarkSuite } from "./runner";
import { geminiBaseUrl } from "./quality-review-gemini";
import { loadBenchmarkSuite } from "./suite";
import type { BenchmarkAgent } from "./types";

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
  --quality-provider openai|google  Explicit quality reviewer provider (codex: openai, gemini: google)
  --quality-model <model>     Explicit quality reviewer model
  --quality-reviewer-command <path>  Codex reviewer executable (default: codex)
  --quality-api-key-env <name>  Gemini API key environment variable (default: GEMINI_API_KEY)
  --quality-base-url <url>    Gemini-native API origin, e.g. a relay (default: Google)
  --clash-plugin-root <path>  Clash plugin root for clash-host cases (default: plugins/clash)
  --clash-profile dev|prod    Isolated Clash runtime profile (default: dev)
  --run-id <id>               Stable run id (default: run-<timestamp>)
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
  const options: CliOptions = { agentArgs: [], agentSkills: [] };
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
    } else if (flag === "--case")
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.suite) throw new Error("--suite is required");
  if (!options.output) throw new Error("--out is required");
  if (options.resume && !options.runId)
    throw new Error("--resume requires --run-id");
  if (options.force && !options.resume)
    throw new Error("--force requires --resume");
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
  const hasQualityOption = Boolean(
    options.qualityProvider ||
    options.qualityModel ||
    options.qualityReviewerCommand ||
    options.qualityApiKeyEnv ||
    options.qualityBaseUrl,
  );
  if (hasQualityOption && !options.qualityReviewer) {
    throw new Error(
      "--quality-provider, --quality-model, --quality-reviewer-command, --quality-api-key-env, and --quality-base-url require --quality-reviewer",
    );
  }
  if (options.qualityReviewer) {
    const gemini = options.qualityReviewer === "gemini";
    const reviewerName = gemini ? "Gemini" : "Codex";
    const expectedProvider = gemini ? "google" : "openai";
    if (options.qualityProvider !== expectedProvider) {
      throw new Error(
        `--quality-provider ${expectedProvider} is required for the ${reviewerName} quality reviewer`,
      );
    }
    if (!options.qualityModel) {
      throw new Error(
        `--quality-model is required for the ${reviewerName} quality reviewer`,
      );
    }
    if (gemini && options.qualityReviewerCommand) {
      throw new Error("--quality-reviewer-command applies only to codex");
    }
    if (!gemini && (options.qualityApiKeyEnv || options.qualityBaseUrl)) {
      throw new Error(
        "--quality-api-key-env and --quality-base-url apply only to gemini",
      );
    }
    if (options.qualityBaseUrl) geminiBaseUrl(options.qualityBaseUrl);
    if (
      !suite.cases.some(
        (benchmarkCase) =>
          benchmarkCase.execution?.environment?.track === "content-effect",
      )
    ) {
      throw new Error(
        "--quality-reviewer requires at least one content-effect case",
      );
    }
  }
  const requiresClashHost = suite.cases.some(
    (benchmarkCase) =>
      benchmarkCase.execution?.profile === "clash-host" &&
      benchmarkCase.execution.preflight?.status !== "blocked",
  );
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
              pluginRoot: resolve(
                invocationRoot,
                options.clashPluginRoot ?? "plugins/clash",
              ),
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
              pluginRoot: resolve(
                invocationRoot,
                options.clashPluginRoot ?? "plugins/clash",
              ),
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
              pluginRoot: resolve(
                invocationRoot,
                options.clashPluginRoot ?? "plugins/clash",
              ),
              profile: options.clashProfile ?? "dev",
            },
          }
        : {}),
    });
  }
  const report = await runBenchmarkSuite({
    suite,
    suiteRoot: dirname(suitePath),
    outputRoot: resolve(invocationRoot, options.output),
    runId: options.runId ?? `run-${Date.now()}`,
    agent,
    ...(options.qualityReviewer === "gemini"
      ? {
          qualityReviewer: {
            adapter: "gemini" as const,
            provider: "google" as const,
            model: options.qualityModel!,
            ...(options.qualityApiKeyEnv
              ? { apiKeyEnv: options.qualityApiKeyEnv }
              : {}),
            ...(options.qualityBaseUrl
              ? { baseUrl: options.qualityBaseUrl }
              : {}),
          },
        }
      : options.qualityReviewer
        ? {
            qualityReviewer: {
              adapter: "codex" as const,
              provider: "openai" as const,
              model: options.qualityModel!,
              ...(options.qualityReviewerCommand
                ? { command: options.qualityReviewerCommand }
                : {}),
            },
          }
        : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.force ? { force: true } : {}),
    ...(options.maxInfrastructureAttempts
      ? { maxInfrastructureAttempts: options.maxInfrastructureAttempts }
      : {}),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    report.status !== "pass" &&
    (process.exitCode === undefined || process.exitCode === 0)
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
