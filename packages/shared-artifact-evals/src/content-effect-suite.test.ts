import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createBenchmarkFixtureManifest } from "./fixture";
import { loadBenchmarkSuite } from "./suite";
import { verifyWorkspaceBundleDirectory } from "@clash/shared-runtime";

const suiteUrl = new URL(
  "../../../benchmarks/creative-artifacts/v2/suite.json",
  import.meta.url,
);

const requiredContentCategories = [
  "content-ad-product-showcase",
  "content-talking-head-interview",
  "content-tutorial-explainer",
  "content-narrative-cinematic",
  "content-music-rhythm-mv",
  "content-motion-graphics-brand",
] as const;

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("content-effect benchmark catalog", () => {
  it("covers the required content categories with product-read visual or audiovisual evidence", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);

    for (const contentCategory of requiredContentCategories) {
      const cases = suite.cases.filter((benchmarkCase) =>
        benchmarkCase.tags?.includes(contentCategory),
      );
      expect(
        cases.some(
          (benchmarkCase) =>
            benchmarkCase.execution?.preflight?.status === "ready",
        ),
        contentCategory,
      ).toBe(true);
      for (const benchmarkCase of cases) {
        expect(benchmarkCase.tags, benchmarkCase.id).toContain(
          "content-effect",
        );
        if (benchmarkCase.execution?.preflight?.status !== "ready") {
          // A not-yet-runnable case stays in the explicit contract-gap lane,
          // which the runner records as not-run instead of launching an Agent.
          expect(benchmarkCase.execution?.lane, benchmarkCase.id).toBe(
            "blocked-contract",
          );
        }
        expect(
          benchmarkCase.execution?.productReadback?.required,
          benchmarkCase.id,
        ).toBe(true);
        expect(
          benchmarkCase.execution?.environment,
          benchmarkCase.id,
        ).toMatchObject({
          profile: "clash-agent-environment-v1",
          track: "content-effect",
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
          benchmarkCase.execution?.environment?.initialState?.workspace;
        expect(inputWorkspace, benchmarkCase.id).toBeDefined();
        const verified = await verifyWorkspaceBundleDirectory(
          new URL(`${inputWorkspace!.path}/`, suiteUrl).pathname,
        );
        expect(verified.manifest.integrity.bundleDigest, benchmarkCase.id).toBe(
          inputWorkspace!.bundleDigest,
        );
        expect(
          benchmarkCase.outcome.deliverables.some(({ kind }) =>
            ["image", "video", "audio"].includes(kind),
          ),
          benchmarkCase.id,
        ).toBe(true);
        expect(
          benchmarkCase.rubric.some(
            (rubric) =>
              rubric.type === "media" ||
              rubric.type === "visual-frames" ||
              (rubric.type === "artifact-set" && rubric.kind === "image"),
          ),
          benchmarkCase.id,
        ).toBe(true);
      }
    }
  });

  it("keeps every effect case in one public content category", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);

    for (const benchmarkCase of suite.cases) {
      const contentTags =
        benchmarkCase.tags?.filter((tag) =>
          requiredContentCategories.includes(
            tag as (typeof requiredContentCategories)[number],
          ),
        ) ?? [];
      expect(benchmarkCase.tags, benchmarkCase.id).toContain("content-effect");
      expect(contentTags, benchmarkCase.id).toHaveLength(1);
    }
  });

  it("publishes every functional minimum and exact final-revision lineage requirement for the medium mixed review", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const benchmarkCase = suite.cases.find(
      (candidate) => candidate.id === "mixed-premium-gadget-mini-review-v2",
    );

    expect(benchmarkCase).toBeDefined();
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
      benchmarkCase?.rubric.find((rubric) => rubric.type === "timeline"),
    ).toMatchObject({
      minTracks: 3,
      minItems: 5,
      minDurationInFrames: 270,
      requiredItemTypes: ["image", "composition", "text"],
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
  });

  it("uses authored sequence shots instead of Stage-embedded capture outputs in every mixed case", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const expectedSequenceShots = new Map([
      ["mixed-productivity-mythbust-short-v2", 2],
      ["mixed-challenge-cold-open-v2", 3],
      ["mixed-premium-gadget-mini-review-v2", 3],
      ["mixed-map-investigation-story-v2", 3],
      ["mixed-future-tech-optimist-short-v2", 4],
    ]);

    for (const [caseId, minSequenceShots] of expectedSequenceShots) {
      const benchmarkCase = suite.cases.find(({ id }) => id === caseId);
      const directorRubric = benchmarkCase?.rubric.find(
        (rubric) => rubric.type === "director-stage",
      );
      expect(directorRubric, caseId).toMatchObject({ minSequenceShots });
      expect(directorRubric, caseId).not.toHaveProperty("minCapturedShots");
    }
  });

  it("makes the music-video case comparable against a fixed public beat source", async () => {
    const suite = await loadBenchmarkSuite(suiteUrl.pathname);
    const benchmarkCase = suite.cases.find((candidate) =>
      candidate.tags?.includes("content-music-rhythm-mv"),
    );

    expect(benchmarkCase).toBeDefined();
    expect(benchmarkCase?.inputFixture).toBeDefined();
    expect(
      benchmarkCase?.rubric.some(
        (rubric) => rubric.type === "media" && rubric.requireAudio === true,
      ),
    ).toBe(true);
    expect(
      benchmarkCase?.rubric.some((rubric) => rubric.type === "visual-frames"),
    ).toBe(true);
    expect(benchmarkCase?.execution?.productReadback?.mechanism).toBe(
      "remotion-component-and-render-receipt",
    );

    const fixture = benchmarkCase!.inputFixture!;
    const fixtureRoot = new URL(`${fixture.path}/`, suiteUrl).pathname;
    const manifest = await createBenchmarkFixtureManifest(fixtureRoot);
    expect(manifest.manifestSha256).toBe(fixture.manifestSha256);

    const provenance = JSON.parse(
      await readFile(
        new URL("provenance.json", `file://${fixtureRoot}/`),
        "utf8",
      ),
    ) as { sourceType?: unknown; license?: unknown };
    expect(provenance).toMatchObject({
      sourceType: "deterministic-synthetic",
      license: "CC0-1.0",
    });
  });

  it("generates byte-identical non-silent WAV inputs from the public beat map", async () => {
    const fixtureRoot = new URL(
      "../../../benchmarks/creative-artifacts/v2/fixtures/rhythm-bed-v1/",
      import.meta.url,
    ).pathname;
    const root = await mkdtemp(join(tmpdir(), "clash-rhythm-fixture-"));
    roots.push(root);
    const first = join(root, "first.wav");
    const second = join(root, "second.wav");
    const generator = join(fixtureRoot, "inputs", "generate-beat.ts");

    await execFileAsync(process.execPath, [generator, first]);
    await execFileAsync(process.execPath, [generator, second]);
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(first),
      readFile(second),
    ]);

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(firstBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(firstBytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(firstBytes.subarray(44).some((byte) => byte !== 0)).toBe(true);
  });
});
