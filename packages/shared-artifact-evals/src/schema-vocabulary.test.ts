import { describe, expect, it } from "vitest";

import {
  ArtifactBenchmarkCaseSchema,
  ArtifactSubmissionSchema,
} from "./schemas";
import * as benchmarkTypes from "./types";

const EXPECTED_CATEGORIES = [
  "director",
  "timeline",
  "mg-character",
  "mixed",
  "asset",
  "canvas",
  "generator",
  "document",
  "workflow",
  "plugin",
  "text",
] as const;

const NEW_ARTIFACT_KINDS = [
  "project-asset",
  "canvas-state",
  "generator",
  "action-run",
  "output-commit",
  "document",
] as const;

const EXPECTED_EXECUTION_TRANSPORTS = ["auto", "mcp", "cli"] as const;

function benchmarkCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "asset-import",
    title: "Asset import",
    category: "director",
    outcome: {
      objective: "Import one Project Asset.",
      acceptanceCriteria: ["The Project Asset can be read back."],
      deliverables: [
        {
          artifactId: "receipt",
          kind: "report",
          description: "Product receipt",
        },
      ],
    },
    passScore: 100,
    timeoutMs: 10_000,
    skills: [],
    rubric: [
      {
        id: "receipt-exists",
        type: "artifact-exists",
        artifactId: "receipt",
        kind: "report",
        weight: 1,
        required: true,
      },
    ],
    ...overrides,
  };
}

function executionWithPreflight(
  lane: "agent-product" | "blocked-contract" | undefined,
  status: "ready" | "blocked",
) {
  return {
    profile: "clash-host",
    ...(lane ? { lane } : {}),
    requiredCliCommands: ["assets get"],
    requiredCapabilities: ["project-asset-readback"],
    preflight: {
      status,
      checks: [
        {
          capability: "project-asset-readback",
          status: status === "ready" ? "available" : "missing",
          detail:
            status === "ready"
              ? "Project Asset readback is available."
              : "Project Asset readback is not exposed to the agent.",
        },
      ],
    },
    evidence: { traceRequired: true, submissionRequired: true },
    productReadback: {
      required: true,
      mechanism: "project-asset-receipt",
      artifactIds: ["receipt"],
      description: "Read the Project Asset receipt back from Clash.",
    },
  };
}

describe("benchmark catalog vocabulary", () => {
  it("accepts a benchmark-owned Project Asset identity for trusted readback", () => {
    const execution = executionWithPreflight("agent-product", "ready");
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({
        execution: {
          ...execution,
          productReadback: {
            ...execution.productReadback,
            expectedProjectAssetId: "benchmark-asset-exact-import-v1",
          },
        },
      }),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.execution?.productReadback?.expectedProjectAssetId).toBe(
      "benchmark-asset-exact-import-v1",
    );
  });

  it("exports and accepts every supported benchmark category", () => {
    expect(
      (benchmarkTypes as Record<string, unknown>).BENCHMARK_CATEGORIES,
    ).toEqual(EXPECTED_CATEGORIES);
    for (const category of EXPECTED_CATEGORIES) {
      expect(
        ArtifactBenchmarkCaseSchema.safeParse(benchmarkCase({ category }))
          .success,
        category,
      ).toBe(true);
    }
  });

  it("accepts product-entity receipts as submitted artifacts", () => {
    const parsed = ArtifactSubmissionSchema.safeParse({
      schemaVersion: 1,
      taskId: "product-receipts",
      artifacts: NEW_ARTIFACT_KINDS.map((kind) => ({
        id: `${kind}-receipt`,
        kind,
        path: `receipts/${kind}.json`,
      })),
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts unique kebab-case tags", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({ tags: ["asset-import", "read-before-write"] }),
    );

    expect(parsed.success).toBe(true);
  });

  it.each(["Readiness", "read_ready", "-readiness", "readiness-"])(
    "rejects unsafe benchmark tag %s",
    (tag) => {
      const parsed = ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({ tags: [tag] }),
      );

      expect(parsed.success).toBe(false);
    },
  );

  it("rejects duplicate benchmark tags", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({ tags: ["asset-import", "asset-import"] }),
    );

    expect(parsed.success).toBe(false);
  });
});

describe("benchmark execution lanes", () => {
  it("publishes and accepts only the standard execution transports", () => {
    expect(
      (benchmarkTypes as Record<string, unknown>)
        .BENCHMARK_EXECUTION_TRANSPORTS,
    ).toEqual(EXPECTED_EXECUTION_TRANSPORTS);

    for (const transport of EXPECTED_EXECUTION_TRANSPORTS) {
      const parsed = ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            transport,
            requiredProductOperations: ["asset.get"],
          },
        }),
      );

      expect(parsed.success, transport).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.execution?.transport, transport).toBe(transport);
      expect(parsed.data.execution?.requiredProductOperations).toEqual([
        "asset.get",
      ]);
    }

    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            transport: "socket",
            requiredProductOperations: ["asset.get"],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("canonicalizes an omitted execution transport to auto", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({
        execution: {
          profile: "clash-host",
          requiredProductOperations: ["asset.get"],
        },
      }),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.execution?.transport).toBe("auto");
  });

  it("accepts only unique forbidden product operations disjoint from required operations", () => {
    const accepted = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({
        execution: {
          profile: "clash-host",
          requiredProductOperations: ["asset.get"],
          forbiddenProductOperations: ["timeline.validate"],
        },
      }),
    );

    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(accepted.data.execution?.forbiddenProductOperations).toEqual([
      "timeline.validate",
    ]);

    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            forbiddenProductOperations: [
              "timeline.validate",
              "timeline.validate",
            ],
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            requiredProductOperations: ["timeline.validate"],
            forbiddenProductOperations: ["timeline.validate"],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("publishes a score-free Attempt output for functional and content-effect Environments", () => {
    for (const track of ["functional", "content-effect"] as const) {
      const execution = executionWithPreflight("agent-product", "ready");
      const parsed = ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          ...(track === "content-effect"
            ? {
                tags: ["content-effect"],
                qualityCriteria: [
                  {
                    id: "receipt-clarity",
                    description: "The result communicates a clear outcome.",
                    weight: 1,
                    evidenceArtifactIds: ["receipt"],
                  },
                ],
              }
            : {}),
          execution: {
            ...execution,
            environment: {
              profile: "clash-workspace-v1",
              track,
              inputWorkspace: {
                path: "environments/empty-workspace-v1",
                bundleDigest:
                  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
        }),
      );

      expect(parsed.success, track).toBe(true);
      if (!parsed.success) continue;
      expect(parsed.data.execution?.environment?.outputs).toMatchObject({
        attempt: "clash-attempt-v1",
      });
      expect(parsed.data.execution?.environment?.outputs).not.toHaveProperty(
        "attemptManifest",
      );
    }
  });

  it("normalizes the legacy Result Bundle output declaration without publishing it", () => {
    const execution = executionWithPreflight("agent-product", "ready");
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({
        execution: {
          ...execution,
          environment: {
            profile: "clash-workspace-v1",
            track: "functional",
            inputWorkspace: {
              path: "environments/empty-workspace-v1",
              bundleDigest:
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
            outputs: {
              modifiedWorkspace: true,
              rawTrajectory: true,
              normalizedTrajectory: "clash-normalized-v1",
              atifTrajectory: "ATIF-v1.7-when-supported",
              otlpTrace: "otlp-json",
              attemptManifest: "clash-attempt-result-bundle-v1",
            },
          },
        },
      }),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.execution?.environment?.outputs).toMatchObject({
      attempt: "clash-attempt-v1",
    });
    expect(JSON.stringify(parsed.data)).not.toContain("attemptManifest");
    expect(JSON.stringify(parsed.data)).not.toContain(
      "clash-attempt-result-bundle-v1",
    );
  });

  it("requires an exact input Workspace bundle only when the Environment gate is ready", () => {
    const ready = executionWithPreflight("agent-product", "ready");
    const blocked = executionWithPreflight("blocked-contract", "blocked");
    const environment = {
      profile: "clash-workspace-v1",
      track: "functional",
      outputs: {
        modifiedWorkspace: true,
        rawTrajectory: true,
        normalizedTrajectory: "clash-normalized-v1",
        atifTrajectory: "ATIF-v1.7-when-supported",
        otlpTrace: "otlp-json",
        attempt: "clash-attempt-v1",
      },
    };

    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({ execution: { ...ready, environment } }),
      ).success,
    ).toBe(false);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({ execution: { ...blocked, environment } }),
      ).success,
    ).toBe(true);
  });

  it("keeps the declared Environment track aligned with the benchmark content-effect tag", () => {
    const execution = executionWithPreflight("agent-product", "ready");
    const environment = {
      profile: "clash-workspace-v1",
      inputWorkspace: {
        path: "environments/empty-workspace-v1",
        bundleDigest:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      outputs: {
        modifiedWorkspace: true,
        rawTrajectory: true,
        normalizedTrajectory: "clash-normalized-v1",
        atifTrajectory: "ATIF-v1.7-when-supported",
        otlpTrace: "otlp-json",
        attempt: "clash-attempt-v1",
      },
    };

    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            environment: { ...environment, track: "content-effect" },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          tags: ["content-effect"],
          execution: {
            ...execution,
            environment: { ...environment, track: "functional" },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("binds agent-product Asset readback to exactly one identity rule", () => {
    const execution = executionWithPreflight("agent-product", "ready");
    const assetReadback = {
      ...execution.productReadback,
      mechanism: "asset-bytes-and-host-receipt",
      expectedProjectAssetId: "benchmark-asset-exact-import-v1",
    };

    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            productReadback: assetReadback,
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            productReadback: {
              ...assetReadback,
              expectedProjectAssetId: undefined,
            },
          },
        }),
      ).success,
    ).toBe(false);
    const firstImportReadback = {
      ...assetReadback,
      expectedProjectAssetId: undefined,
      projectAssetIdentity: "first-import",
    };
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            requiredProductOperations: ["asset.import", "asset.get"],
            productReadback: firstImportReadback,
          },
        }),
      ).success,
    ).toBe(true);
    // The identity comes from an import, so a case must require one...
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            requiredProductOperations: ["asset.get"],
            productReadback: firstImportReadback,
          },
        }),
      ).success,
    ).toBe(false);
    // ...and cannot also pin a benchmark-owned one.
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            requiredProductOperations: ["asset.import", "asset.get"],
            productReadback: {
              ...firstImportReadback,
              expectedProjectAssetId: "benchmark-asset-exact-import-v1",
            },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            ...execution,
            productReadback: {
              ...assetReadback,
              artifactIds: ["hero-image", "voice-audio"],
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("requires blocked-contract cases to declare a blocked preflight", () => {
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: executionWithPreflight("blocked-contract", "blocked"),
        }),
      ).success,
    ).toBe(true);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: executionWithPreflight("blocked-contract", "ready"),
        }),
      ).success,
    ).toBe(false);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            lane: "blocked-contract",
            requiredCliCommands: ["assets get"],
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("allows agent-product cases only when an optional preflight is ready", () => {
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: {
            profile: "clash-host",
            lane: "agent-product",
            requiredCliCommands: ["assets get"],
          },
        }),
      ).success,
    ).toBe(true);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: executionWithPreflight("agent-product", "ready"),
        }),
      ).success,
    ).toBe(true);
    expect(
      ArtifactBenchmarkCaseSchema.safeParse(
        benchmarkCase({
          execution: executionWithPreflight("agent-product", "blocked"),
        }),
      ).success,
    ).toBe(false);
  });

  it("preserves legacy execution behavior when lane is omitted", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse(
      benchmarkCase({
        execution: executionWithPreflight(undefined, "blocked"),
      }),
    );

    expect(parsed.success).toBe(true);
  });
});
