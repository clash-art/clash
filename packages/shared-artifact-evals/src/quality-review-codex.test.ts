import { delimiter } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCodexQualityJudgeInvocation,
  codexQualityJudgeSupportsRequest,
  parseCodexQualityJudgeResponse,
  renderQualityJudgePrompt,
  sanitizeQualityReviewerEnvironment,
} from "./quality-review-codex";
import { createQualityReviewRequest } from "./quality-review";
import type {
  ArtifactBenchmarkCase,
  ArtifactEvaluationReport,
  CodexQualityReviewer,
} from "./types";

const IMAGE_SHA =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const CODEX_EXEC_VALUE_OPTIONS = new Set([
  "--cd",
  "--model",
  "--output-last-message",
  "--output-schema",
  "--sandbox",
]);

function parseCodexExecPromptAndImages(args: string[]): {
  prompt: string | undefined;
  imagePaths: string[];
} {
  let prompt: string | undefined;
  const imagePaths: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--image") {
      while (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-")
      ) {
        imagePaths.push(args[index + 1]!);
        index += 1;
      }
      continue;
    }
    if (CODEX_EXEC_VALUE_OPTIONS.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-") && prompt === undefined) prompt = argument;
  }
  return { prompt, imagePaths };
}

function request() {
  const benchmark: ArtifactBenchmarkCase = {
    id: "image-judge",
    title: "Image judge",
    category: "mixed",
    tags: ["content-effect"],
    outcome: {
      objective: "Create a legible title card.",
      acceptanceCriteria: ["The title is immediately legible."],
      deliverables: [
        {
          artifactId: "frame",
          kind: "image",
          description: "Title card",
        },
      ],
    },
    qualityCriteria: [
      {
        id: "title-legibility",
        description: "The title is immediately legible.",
        weight: 1,
        evidenceArtifactIds: ["frame"],
      },
    ],
    passScore: 80,
    timeoutMs: 10_000,
    skills: [],
    execution: {
      profile: "clash-host",
      requiredProductOperations: ["timeline.render"],
      environment: {
        profile: "clash-workspace-v1",
        track: "content-effect",
        inputWorkspace: {
          path: "environments/base-v1",
          bundleDigest:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
        outputs: {
          modifiedWorkspace: true,
          rawTrajectory: true,
          normalizedTrajectory: "clash-normalized-v1",
          atifTrajectory: "ATIF-v1.7-when-supported",
          otlpTrace: "otlp-json",
          attempt: "clash-attempt-v1",
        },
      },
    },
    rubric: [
      {
        id: "frame",
        type: "artifact-exists",
        artifactId: "frame",
        weight: 1,
      },
    ],
  };
  const evaluation: ArtifactEvaluationReport = {
    schemaVersion: 1,
    benchmarkId: benchmark.id,
    taskId: benchmark.id,
    status: "pass",
    score: 100,
    checks: [],
    artifacts: [
      {
        id: "frame",
        kind: "image",
        path: "renders/frame.png",
        bytes: 300,
        sha256: IMAGE_SHA,
      },
    ],
    outcomeGate: {
      status: "pass",
      detail: "Present.",
      missingArtifactIds: [],
      invalidArtifactIds: [],
    },
  };
  return createQualityReviewRequest({ benchmark, evaluation });
}

const reviewer: CodexQualityReviewer = {
  adapter: "codex",
  provider: "openai",
  model: "gpt-5.6-sol",
};

describe("Codex content-effect judge", () => {
  it("keeps a mixed image and audio rubric pending for an image-only reviewer", () => {
    const imageRequest = request();
    const mixedRequest = {
      ...imageRequest,
      criteria: [
        ...imageRequest.criteria,
        {
          id: "audio-synchrony",
          description: "The visual impacts synchronize to the rhythm bed.",
          weight: 1,
          evidenceArtifactIds: ["rhythm-audio"],
        },
      ],
      artifacts: [
        ...imageRequest.artifacts,
        {
          id: "rhythm-audio",
          kind: "audio" as const,
          bytes: 4_000,
          sha256:
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        },
      ],
    };

    expect(codexQualityJudgeSupportsRequest(mixedRequest)).toBe(false);
  });

  it("removes Clash authority and topology from the reviewer process", () => {
    expect(
      sanitizeQualityReviewerEnvironment({
        PATH: ["/workspace/node_modules/.bin", "/usr/bin"].join(delimiter),
        CODEX_HOME: "/private/codex-auth",
        CLASH_SESSION_AS_LOCAL_USER: "1",
        CLASH_AGENT_MEMBER_ID: "agent-secret",
        CLASH_AGENT_NAME: "benchmark-agent",
        CLASH_API_URL: "http://127.0.0.1:9999",
        CLASH_LOCAL_API_PLUGIN_SOCKET: "/private/clash.sock",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      CODEX_HOME: "/private/codex-auth",
    });
  });

  it("builds an explicit read-only invocation with attached image evidence", () => {
    const invocation = buildCodexQualityJudgeInvocation({
      reviewer,
      workingDirectory: "/private/review",
      outputSchemaPath: "/private/review/schema.json",
      outputResponsePath: "/private/review/response.json",
      imagePaths: ["/private/case/workspace/renders/frame.png"],
      prompt: "Judge this evidence.",
    });

    expect(invocation.command).toBe("codex");
    expect(invocation.args).toContain("read-only");
    expect(invocation.args).toContain("gpt-5.6-sol");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("--ignore-rules");
    expect(invocation.args).toContain("skills.include_instructions=false");
    expect(invocation.args).toContain("features.plugins=false");
    expect(invocation.args).toContain("--image");
    expect(invocation.args).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("keeps the judge prompt outside Codex's variadic image arguments", () => {
    const invocation = buildCodexQualityJudgeInvocation({
      reviewer,
      workingDirectory: "/private/review",
      outputSchemaPath: "/private/review/schema.json",
      outputResponsePath: "/private/review/response.json",
      imagePaths: [
        "/private/case/workspace/renders/first.png",
        "/private/case/workspace/renders/second.png",
      ],
      prompt: "Judge this evidence.",
    });

    expect(parseCodexExecPromptAndImages(invocation.args)).toEqual({
      prompt: "Judge this evidence.",
      imagePaths: [
        "/private/case/workspace/renders/first.png",
        "/private/case/workspace/renders/second.png",
      ],
    });
  });

  it("renders only public artifact identities and exact quality criteria", () => {
    const prompt = renderQualityJudgePrompt(request());

    expect(prompt).toContain("title-legibility");
    expect(prompt).toContain("The title is immediately legible.");
    expect(prompt).toContain(IMAGE_SHA);
    expect(prompt).not.toContain("renders/frame.png");
    expect(prompt).not.toMatch(/\/private\//u);
  });

  it.each([false, true])(
    "accepts a completed tool-free response with diagnostic=%s",
    (withDiagnostic) => {
      const boundRequest = request();
      const rawResponse = JSON.stringify({
        schemaVersion: 1,
        criteria: [
          {
            id: "title-legibility",
            score: 95,
            rationale: "The title has strong contrast and clear hierarchy.",
          },
        ],
        overallRationale: "The supplied image clearly meets the criterion.",
      });
      const result = parseCodexQualityJudgeResponse({
        request: boundRequest,
        reviewer,
        adapterVersion: "codex-cli 0.147.0",
        prompt: renderQualityJudgePrompt(boundRequest),
        rawResponse,
        rawEvents: [
          JSON.stringify({ type: "thread.started", thread_id: "private" }),
          ...(withDiagnostic
            ? [
                JSON.stringify({
                  // Captured from codex-cli 0.154.0, product-ad-pack E2E on 2026-09-10.
                  type: "item.completed",
                  item: {
                    id: "item_0",
                    type: "error",
                    message:
                      "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
                  },
                }),
              ]
            : []),
          JSON.stringify({
            type: "item.completed",
            item: { type: "reasoning", text: "private reasoning" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: rawResponse },
          }),
          JSON.stringify({ type: "turn.completed", usage: {} }),
        ].join("\n"),
      });

      expect(result.aggregate.status).toBe("pass");
      expect(result.reviewer).toEqual({
        kind: "codex",
        provider: "openai",
        model: "gpt-5.6-sol",
        adapterVersion: "codex-cli 0.147.0",
      });
    },
  );

  it.each(["turn.failed", "error"])(
    "rejects a failed reviewer lifecycle (%s)",
    (type) => {
      const boundRequest = request();
      expect(() =>
        parseCodexQualityJudgeResponse({
          request: boundRequest,
          reviewer,
          adapterVersion: "codex-cli 0.154.0",
          prompt: renderQualityJudgePrompt(boundRequest),
          rawResponse: JSON.stringify({
            schemaVersion: 1,
            criteria: [
              {
                id: "title-legibility",
                score: 95,
                rationale: "Stale response.",
              },
            ],
            overallRationale: "Stale response.",
          }),
          rawEvents: JSON.stringify({
            type,
            error: { message: "Reviewer turn failed" },
          }),
        }),
      ).toThrow(/reviewer.*failed/i);
    },
  );

  it("rejects a judge that executes any command or Clash tool", () => {
    const boundRequest = request();
    expect(() =>
      parseCodexQualityJudgeResponse({
        request: boundRequest,
        reviewer,
        adapterVersion: "codex-cli 0.147.0",
        prompt: renderQualityJudgePrompt(boundRequest),
        rawResponse: JSON.stringify({
          schemaVersion: 1,
          criteria: [
            {
              id: "title-legibility",
              score: 100,
              rationale: "Claimed pass.",
            },
          ],
          overallRationale: "Claimed pass.",
        }),
        rawEvents: JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "clash timeline get --timeline hidden",
          },
        }),
      }),
    ).toThrow(/read-only evidence judge.*tool/i);
  });
});
