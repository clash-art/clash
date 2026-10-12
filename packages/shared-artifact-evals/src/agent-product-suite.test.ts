import { describe, expect, it } from "vitest";

import { createBenchmarkFixtureManifest } from "./fixture";
import { renderOutcomeMarkdown } from "./outcome";
import { loadBenchmarkSuite } from "./suite";
import { verifyWorkspaceBundleDirectory } from "@clash/shared-runtime";

const suiteUrl = new URL(
  "../../../benchmarks/agent-product/v1/suite.json",
  import.meta.url,
);

const readyCaseIds = [
  "asset-image-exact-import-v1",
  "asset-trash-restore-v1",
  "asset-image-exact-import-mcp-v1",
  "asset-image-exact-import-cli-v1",
  "director-three-beat-v1",
  "timeline-multitrack-render-v1",
  "remotion-character-render-v1",
  "mixed-director-remotion-timeline-v1",
] as const;

const blockedCaseIds = [
  "generator-multi-action-v1",
  "generator-cow-replay-v1",
  "document-version-attachment-v1",
  "asr-generator-transcript-document-v1",
  "stage-generator-multi-action-v1",
  "timeline-generator-render-v1",
] as const;

describe("agent product benchmark catalog", () => {
  it("declares the required ready and contract-blocked scenarios without pretending missing product surfaces are runnable", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const cases = new Map(
      suite.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]),
    );

    for (const id of readyCaseIds) {
      const benchmarkCase = cases.get(id);
      expect(benchmarkCase, id).toBeDefined();
      expect(benchmarkCase?.execution?.lane, id).toBe("agent-product");
      expect(benchmarkCase?.execution?.preflight?.status, id).toBe("ready");
      expect(
        benchmarkCase?.execution?.preflight?.checks,
        id,
      ).not.toContainEqual(expect.objectContaining({ status: "missing" }));
      expect(
        benchmarkCase?.execution?.requiredProductOperations?.length,
        id,
      ).toBeGreaterThan(0);
      expect(
        benchmarkCase?.execution?.requiredCapabilities?.length,
        id,
      ).toBeGreaterThan(0);
      expect(benchmarkCase?.execution?.productReadback?.required, id).toBe(
        true,
      );
      expect(
        benchmarkCase?.execution?.productReadback?.artifactIds.length,
        id,
      ).toBeGreaterThan(0);
      expect(benchmarkCase?.execution?.evidence, id).toEqual({
        traceRequired: true,
        submissionRequired: true,
      });
      expect(benchmarkCase?.execution?.environment, id).toMatchObject({
        profile: "clash-agent-environment-v1",
        track: "functional",
        outputs: {
          modifiedWorkspace: true,
          rawTrajectory: true,
          normalizedTrajectory: "clash-normalized-v1",
          atifTrajectory: "ATIF-v1.7-when-supported",
          otlpTrace: "otlp-json",
          attempt: "clash-attempt-v1",
        },
      });
      const inputWorkspace =
        benchmarkCase?.execution?.environment?.initialState?.workspace;
      expect(inputWorkspace, id).toBeDefined();
      const verified = await verifyWorkspaceBundleDirectory(
        new URL(`${inputWorkspace!.path}/`, suiteUrl).pathname,
      );
      expect(verified.manifest.integrity.bundleDigest, id).toBe(
        inputWorkspace!.bundleDigest,
      );
    }

    for (const id of blockedCaseIds) {
      const benchmarkCase = cases.get(id);
      expect(benchmarkCase, id).toBeDefined();
      expect(benchmarkCase?.execution?.lane, id).toBe("blocked-contract");
      expect(benchmarkCase?.execution?.preflight?.status, id).toBe("blocked");
      const missing =
        benchmarkCase?.execution?.preflight?.checks.filter(
          (check) => check.status === "missing",
        ) ?? [];
      expect(missing.length, id).toBeGreaterThan(0);
      expect(
        missing
          .map((check) => `${check.capability}: ${check.detail}`)
          .join("\n"),
        id,
      ).toMatch(/(?:CLI|MCP|readback)/i);
      expect(benchmarkCase?.execution?.environment, id).toMatchObject({
        profile: "clash-agent-environment-v1",
        track: "functional",
      });
      expect(
        benchmarkCase?.execution?.environment?.initialState,
        id,
      ).toBeUndefined();
    }
  });

  it("provides equivalent auto, MCP, and CLI lanes for exact Asset import", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const cases = new Map(
      suite.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]),
    );
    const specs = [
      { id: "asset-image-exact-import-v1", transport: "auto" },
      { id: "asset-image-exact-import-mcp-v1", transport: "mcp" },
      { id: "asset-image-exact-import-cli-v1", transport: "cli" },
    ] as const;
    const benchmarkCases = specs.map(({ id, transport }) => {
      const benchmarkCase = cases.get(id);
      expect(benchmarkCase, id).toBeDefined();
      expect(benchmarkCase?.execution?.transport, id).toBe(transport);
      return benchmarkCase!;
    });
    const [autoCase] = benchmarkCases;
    const rubricShapes = benchmarkCases.map((benchmarkCase) =>
      benchmarkCase.rubric.map((rubric) => {
        const shape: Record<string, unknown> = { ...rubric };
        delete shape.artifactId;
        return shape;
      }),
    );

    for (const [index, benchmarkCase] of benchmarkCases.entries()) {
      if (index === 0) continue;
      expect(benchmarkCase.inputFixture, benchmarkCase.id).toEqual(
        autoCase.inputFixture,
      );
      expect(
        benchmarkCase.execution?.environment?.initialState?.workspace,
        benchmarkCase.id,
      ).toEqual(autoCase.execution?.environment?.initialState?.workspace);
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).toEqual(autoCase.execution?.requiredProductOperations);
      expect(rubricShapes[index], benchmarkCase.id).toEqual(rubricShapes[0]);
    }

    for (const benchmarkCase of benchmarkCases) {
      const readback = benchmarkCase.execution?.productReadback;
      expect(readback?.projectAssetIdentity, benchmarkCase.id).toBe(
        "first-import",
      );
      expect(
        readback?.expectedProjectAssetId,
        benchmarkCase.id,
      ).toBeUndefined();
    }

    const reviewArtifactIds = benchmarkCases.map(
      (benchmarkCase) =>
        benchmarkCase.outcome.deliverables.find(
          (deliverable) => deliverable.kind === "report",
        )?.artifactId,
    );
    expect(
      reviewArtifactIds.every(
        (artifactId) => typeof artifactId === "string" && artifactId.length > 0,
      ),
    ).toBe(true);
    expect(new Set(reviewArtifactIds).size).toBe(reviewArtifactIds.length);
  });

  it("pins every copied input fixture to its canonical manifest", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const fixtureCases = suite.cases.filter(
      (benchmarkCase) => benchmarkCase.inputFixture !== undefined,
    );

    expect(fixtureCases.map((benchmarkCase) => benchmarkCase.id)).toEqual(
      expect.arrayContaining([...readyCaseIds.slice(0, 2)]),
    );

    for (const benchmarkCase of fixtureCases) {
      const fixture = benchmarkCase.inputFixture!;
      const manifest = await createBenchmarkFixtureManifest(
        new URL(`${fixture.path}/`, suiteUrl).pathname,
      );
      expect(manifest.manifestSha256, benchmarkCase.id).toBe(
        fixture.manifestSha256,
      );
    }
  });

  it("uses trusted Asset byte readback for both runnable Asset lifecycle cases", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const cases = new Map(
      suite.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]),
    );

    for (const id of readyCaseIds.slice(0, 2)) {
      expect(cases.get(id)?.execution?.productReadback?.mechanism, id).toBe(
        "asset-bytes-and-host-receipt",
      );
    }
    const assetCases = readyCaseIds.slice(0, 2).map((id) => cases.get(id)!);
    for (const benchmarkCase of assetCases) {
      const readback = benchmarkCase.execution?.productReadback;
      expect(readback?.projectAssetIdentity, benchmarkCase.id).toBe(
        "first-import",
      );
      expect(
        readback?.expectedProjectAssetId,
        benchmarkCase.id,
      ).toBeUndefined();
      // The task leaves the identity to the import; it must not name one.
      expect(
        renderOutcomeMarkdown(benchmarkCase),
        benchmarkCase.id,
      ).not.toMatch(/preassign|benchmark-asset-/iu);
    }
  });

  it("keeps the mixed functional regression medium-complexity and independent of content review", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const benchmarkCase = suite.cases.find(
      (candidate) => candidate.id === "mixed-director-remotion-timeline-v1",
    );

    expect(benchmarkCase).toBeDefined();
    expect(benchmarkCase).toMatchObject({
      passScore: 100,
      tags: expect.arrayContaining([
        "agent-product",
        "functional-regression",
        "medium-complexity",
        "director",
        "remotion",
        "timeline",
      ]),
      execution: {
        profile: "clash-host",
        lane: "agent-product",
        environment: {
          profile: "clash-agent-environment-v1",
          track: "functional",
        },
        productReadback: {
          required: true,
          mechanism: "mixed-remotion-lineage-and-render-receipt",
        },
      },
    });
    expect(benchmarkCase?.qualityCriteria).toBeUndefined();
    expect(benchmarkCase?.execution?.requiredProductOperations).toEqual([
      "director.create",
      "director.mutate",
      "director.get",
      "director.capture",
      "canvas.add",
      "canvas.get",
      "timeline.create",
      "timeline.get",
      "timeline.save",
      "timeline.render",
      "asset.get",
    ]);
    expect(benchmarkCase?.execution?.requiredProductOperations).not.toContain(
      "timeline.validate",
    );
    expect(
      benchmarkCase?.execution?.forbiddenProductOperations ?? [],
    ).not.toContain("timeline.validate");
    const directorRubric = benchmarkCase?.rubric.find(
      (rubric) => rubric.type === "director-stage",
    );
    expect(directorRubric).toMatchObject({
      minObjects: 4,
      minCameras: 2,
      minSequenceShots: 3,
      minAnimatedTracks: 1,
    });
    expect(directorRubric).not.toHaveProperty("minCapturedShots");
    expect(
      benchmarkCase?.rubric.find((rubric) => rubric.type === "mg-character"),
    ).toMatchObject({
      profile: "remotion-tsx",
      minSourceBytes: 1800,
      requiredRemotionApis: [
        "useCurrentFrame",
        "interpolate",
        "spring",
        "Sequence",
      ],
    });
    expect(
      benchmarkCase?.rubric.find((rubric) => rubric.type === "timeline"),
    ).toMatchObject({
      minTracks: 3,
      minItems: 5,
      minDurationInFrames: 270,
      requiredItemTypes: ["image", "composition", "text"],
    });
    expect(
      benchmarkCase?.rubric.find((rubric) => rubric.type === "media"),
    ).toMatchObject({
      width: 1080,
      height: 1080,
      minDurationSeconds: 8.8,
      maxDurationSeconds: 9.2,
      requireVideo: true,
    });

    const publicContract =
      benchmarkCase?.outcome.acceptanceCriteria.join("\n") ?? "";
    expect(publicContract).toMatch(
      /at least four objects.*two cameras.*three ordered sequence shots.*one animated track/isu,
    );
    expect(publicContract).not.toMatch(/captured shots/iu);
    expect(publicContract).toMatch(
      /at least three tracks.*five items.*270 frames.*image.*composition.*text/isu,
    );
    expect(publicContract).toMatch(
      /capture receipt.*projectAssetId.*final Stage revision.*canonical Timeline media item.*same projectAssetId.*Stage.*not mutated.*own Action output/isu,
    );
    expect(publicContract).toMatch(
      /completed render Project Asset.*public Asset read surface.*final-video/isu,
    );
  });

  it("treats successful Timeline submissions as already validated", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const timelineCases = suite.cases.filter((benchmarkCase) =>
      benchmarkCase.execution?.requiredProductOperations?.some((operation) =>
        operation.startsWith("timeline."),
      ),
    );

    expect(timelineCases.length).toBeGreaterThan(0);
    for (const benchmarkCase of timelineCases) {
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).not.toContain("timeline.validate");
    }
  });
});
