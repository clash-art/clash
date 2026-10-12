import {
  GEMINI_API_KEY_ENV,
  geminiBaseUrl,
  geminiJudgeIdentity,
} from "./quality-review-gemini";
import type { BenchmarkQualityReviewer } from "./types";

/**
 * The harness environment variables that configure the content-effect judge.
 * They are the source of truth; CLI flags only override them. The Environment
 * lock records these *names* and the judge's non-secret identity, never a value
 * read from a credential variable.
 */
export const QUALITY_JUDGE_ENVIRONMENT = {
  reviewer: "CLASH_BENCH_QUALITY_REVIEWER",
  provider: "CLASH_BENCH_QUALITY_PROVIDER",
  model: "CLASH_BENCH_QUALITY_MODEL",
  geminiApiKey: GEMINI_API_KEY_ENV,
  geminiBaseUrl: "GEMINI_BASE_URL",
} as const;

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
// A pasted key is not a variable name; refuse it before it can be recorded as one.
const KNOWN_TOKEN_SHAPE =
  /^(?:sk_(?:live|test)_|clsh_|gh[pousr]_|github_pat_|AIza)/u;

export type QualityJudgeOverrides = {
  reviewer?: "codex" | "gemini";
  provider?: string;
  model?: string;
  reviewerCommand?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
};

/** Non-secret judge identity as the Environment lock records it. */
export type BenchmarkLockedQualityJudge =
  | { kind: "codex"; provider: "openai"; model: string }
  | {
      kind: "gemini";
      provider: "google";
      model: string;
      endpointHost: string;
      /** Variable names only. */
      env: { apiKey: string; baseUrl?: string };
    };

export function qualityJudgeEnvironmentName(
  value: string,
  label: string,
): string {
  if (!ENVIRONMENT_VARIABLE_NAME.test(value) || KNOWN_TOKEN_SHAPE.test(value)) {
    throw new Error(`${label} must be an environment variable name`);
  }
  return value;
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the judge from the harness environment, with explicit overrides
 * winning. Returns `undefined` when no judge is configured.
 */
export function resolveQualityJudgeEnvironment(input: {
  env: NodeJS.ProcessEnv;
  overrides?: QualityJudgeOverrides;
}): BenchmarkQualityReviewer | undefined {
  const { env, overrides = {} } = input;
  const names = QUALITY_JUDGE_ENVIRONMENT;
  const kind = overrides.reviewer ?? configured(env[names.reviewer]);
  if (!kind) {
    const stray = (
      [
        ["--quality-provider", overrides.provider],
        ["--quality-model", overrides.model],
        ["--quality-reviewer-command", overrides.reviewerCommand],
        ["--quality-api-key-env", overrides.apiKeyEnv],
        ["--quality-base-url", overrides.baseUrl],
      ] as const
    ).some(([, value]) => value);
    if (stray) {
      throw new Error(
        `--quality-provider, --quality-model, --quality-reviewer-command, --quality-api-key-env, and --quality-base-url require --quality-reviewer (or ${names.reviewer})`,
      );
    }
    return undefined;
  }
  if (kind !== "codex" && kind !== "gemini") {
    throw new Error(`${names.reviewer} must be codex or gemini`);
  }
  const gemini = kind === "gemini";
  const reviewerName = gemini ? "Gemini" : "Codex";
  const expectedProvider = gemini ? "google" : "openai";
  const provider = overrides.provider ?? configured(env[names.provider]);
  if (provider !== expectedProvider) {
    throw new Error(
      `--quality-provider ${expectedProvider} (or ${names.provider}) is required for the ${reviewerName} quality reviewer`,
    );
  }
  const model = overrides.model ?? configured(env[names.model]);
  if (!model) {
    throw new Error(
      `--quality-model (or ${names.model}) is required for the ${reviewerName} quality reviewer`,
    );
  }
  if (!gemini) {
    if (overrides.apiKeyEnv || overrides.baseUrl) {
      throw new Error(
        "--quality-api-key-env and --quality-base-url apply only to gemini",
      );
    }
    return {
      adapter: "codex",
      provider: "openai",
      model,
      ...(overrides.reviewerCommand
        ? { command: overrides.reviewerCommand }
        : {}),
    };
  }
  if (overrides.reviewerCommand) {
    throw new Error("--quality-reviewer-command applies only to codex");
  }
  const apiKeyEnv = qualityJudgeEnvironmentName(
    overrides.apiKeyEnv ?? names.geminiApiKey,
    "--quality-api-key-env",
  );
  const environmentBaseUrl = configured(env[names.geminiBaseUrl]);
  const baseUrl = overrides.baseUrl ?? environmentBaseUrl;
  return {
    adapter: "gemini",
    provider: "google",
    model,
    apiKeyEnv,
    ...(baseUrl ? { baseUrl: geminiBaseUrl(baseUrl) } : {}),
    ...(!overrides.baseUrl && environmentBaseUrl
      ? { baseUrlEnv: names.geminiBaseUrl }
      : {}),
  };
}

/** Variables a worker needs in its own environment to run the judge. */
export function qualityJudgeEnvironmentNames(
  reviewer: BenchmarkQualityReviewer | undefined,
): string[] {
  return reviewer?.adapter === "gemini"
    ? [reviewer.apiKeyEnv ?? QUALITY_JUDGE_ENVIRONMENT.geminiApiKey]
    : [];
}

export function lockedQualityJudge(
  reviewer: BenchmarkQualityReviewer,
): BenchmarkLockedQualityJudge {
  if (reviewer.adapter === "codex") {
    return {
      kind: "codex",
      provider: reviewer.provider,
      model: reviewer.model,
    };
  }
  const { endpointHost, apiKeyEnv } = geminiJudgeIdentity(reviewer);
  return {
    kind: "gemini",
    provider: reviewer.provider,
    model: reviewer.model,
    endpointHost,
    env: {
      apiKey: qualityJudgeEnvironmentName(apiKeyEnv, "Gemini API key variable"),
      ...(reviewer.baseUrlEnv
        ? {
            baseUrl: qualityJudgeEnvironmentName(
              reviewer.baseUrlEnv,
              "Gemini base URL variable",
            ),
          }
        : {}),
    },
  };
}
