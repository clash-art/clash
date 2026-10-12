import { describe, expect, it } from "vitest";

import { createAttemptUnit } from "./attempt-unit";
import {
  QUALITY_JUDGE_ENVIRONMENT,
  lockedQualityJudge,
  qualityJudgeEnvironmentNames,
  resolveQualityJudgeEnvironment,
} from "./quality-judge-environment";
import { geminiJudgeIdentity } from "./quality-review-gemini";

const names = QUALITY_JUDGE_ENVIRONMENT;
const SECRET = "judge-key-value-that-must-stay-private";

function geminiEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [names.reviewer]: "gemini",
    [names.provider]: "google",
    [names.model]: "gemini-judge",
    [names.geminiApiKey]: SECRET,
    ...extra,
  };
}

describe("quality judge harness environment", () => {
  it("configures no judge when the harness environment names none", () => {
    expect(resolveQualityJudgeEnvironment({ env: {} })).toBeUndefined();
    expect(qualityJudgeEnvironmentNames(undefined)).toEqual([]);
  });

  it("takes the Gemini judge, its key variable, and its base URL from the harness environment", () => {
    const reviewer = resolveQualityJudgeEnvironment({
      env: geminiEnvironment({
        [names.geminiBaseUrl]: "https://relay.example/",
      }),
    });

    expect(reviewer).toMatchObject({
      adapter: "gemini",
      provider: "google",
      model: "gemini-judge",
      apiKeyEnv: names.geminiApiKey,
      baseUrlEnv: names.geminiBaseUrl,
    });
    expect(new URL((reviewer as { baseUrl: string }).baseUrl).host).toBe(
      "relay.example",
    );
    expect(qualityJudgeEnvironmentNames(reviewer)).toEqual([
      names.geminiApiKey,
    ]);
    expect(JSON.stringify(reviewer)).not.toContain(SECRET);
  });

  it("lets explicit overrides win over the harness environment", () => {
    const reviewer = resolveQualityJudgeEnvironment({
      env: geminiEnvironment({
        [names.geminiBaseUrl]: "https://relay.example",
      }),
      overrides: {
        model: "gemini-judge-next",
        apiKeyEnv: "CLASH_TEST_JUDGE_KEY",
        baseUrl: "https://other-relay.example",
      },
    });

    expect(reviewer).toMatchObject({
      model: "gemini-judge-next",
      apiKeyEnv: "CLASH_TEST_JUDGE_KEY",
    });
    // An overridden origin did not come from the variable, so no name is recorded for it.
    expect(reviewer).not.toHaveProperty("baseUrlEnv");
    expect(lockedQualityJudge(reviewer!)).toMatchObject({
      endpointHost: "other-relay.example",
      env: { apiKey: "CLASH_TEST_JUDGE_KEY" },
    });
  });

  it("records in the lock exactly the identity the Evaluation's evaluator carries", () => {
    const reviewer = resolveQualityJudgeEnvironment({
      env: geminiEnvironment({
        [names.geminiBaseUrl]: "https://relay.example",
      }),
    })!;
    const locked = lockedQualityJudge(reviewer);
    const evaluator = geminiJudgeIdentity(
      reviewer as { apiKeyEnv?: string; baseUrl?: string },
    );

    expect(locked).toMatchObject({
      kind: "gemini",
      provider: reviewer.provider,
      model: reviewer.model,
      endpointHost: evaluator.endpointHost,
      env: { apiKey: evaluator.apiKeyEnv, baseUrl: names.geminiBaseUrl },
    });
    expect(JSON.stringify(locked)).not.toContain(SECRET);
  });

  it("rejects a judge whose provider, model, or adapter-specific settings do not fit", () => {
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: geminiEnvironment({ [names.provider]: "openai" }),
      }),
    ).toThrow(/google/u);
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: geminiEnvironment({ [names.model]: "" }),
      }),
    ).toThrow(/--quality-model/u);
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: geminiEnvironment(),
        overrides: { reviewerCommand: "codex" },
      }),
    ).toThrow(/only to codex/u);
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: {},
        overrides: {
          reviewer: "codex",
          provider: "openai",
          model: "review-model",
          baseUrl: "https://relay.example",
        },
      }),
    ).toThrow(/only to gemini/u);
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: {},
        overrides: { model: "gemini-judge" },
      }),
    ).toThrow(/require --quality-reviewer/u);
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: geminiEnvironment({ [names.reviewer]: "other" }),
      }),
    ).toThrow(/codex or gemini/u);
  });

  it("refuses a key-bearing base URL that is not a credential-free https origin", () => {
    for (const bad of [
      "http://relay.example",
      "https://user:pw@relay.example",
      "https://relay.example/?key=1",
    ]) {
      expect(() =>
        resolveQualityJudgeEnvironment({
          env: geminiEnvironment({ [names.geminiBaseUrl]: bad }),
        }),
      ).toThrow(/https origin/u);
    }
  });

  it("refuses a pasted key where a variable name belongs", () => {
    expect(() =>
      resolveQualityJudgeEnvironment({
        env: geminiEnvironment(),
        overrides: { apiKeyEnv: "AIzaSyPastedKeyInsteadOfAName" },
      }),
    ).toThrow(/environment variable name/u);
  });

  it("names the judge's variables to a worker without handing them to the Agent", () => {
    const reviewer = resolveQualityJudgeEnvironment({
      env: geminiEnvironment(),
      overrides: { apiKeyEnv: "CLASH_TEST_JUDGE_KEY" },
    })!;
    const unit = createAttemptUnit({
      dispatch: {
        suiteId: "suite",
        runId: "run",
        benchmark: { id: "task" },
        agent: { command: "agent", args: [] },
        qualityReviewer: reviewer,
        suiteRoot: "/suite",
        caseRoot: "/runs/run/task",
        attempt: 1,
        trial: 1,
        forced: false,
        startedAt: "2026-10-11T00:00:00.000Z",
      } as unknown as Parameters<typeof createAttemptUnit>[0]["dispatch"],
      suiteFile: "suite.json",
      claim: { kind: "native-local" },
      forwardEnv: [],
    });

    expect(unit.judgeEnvNames).toEqual(["CLASH_TEST_JUDGE_KEY"]);
    expect(unit.envNames).toEqual([]);
    expect(JSON.stringify(unit)).not.toContain(SECRET);
  });
});
