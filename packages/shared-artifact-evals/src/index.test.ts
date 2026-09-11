import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DirectorStageStateSchema,
  projectDirectorStageReadToken,
} from "@clash/shared-types";

import {
  ArtifactBenchmarkCaseSchema,
  evaluateSubmission,
  loadBenchmarkSuite,
  runBenchmarkSuite,
  type ArtifactBenchmarkCase,
  type ArtifactSubmission,
} from "./index";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const directorStage = {
  schemaVersion: 1,
  scene: {
    backgroundColor: "#111111",
    grid: { visible: true, snap: false, size: 1 },
  },
  objects: [
    {
      id: "hero",
      name: "Hero",
      kind: "mannequin",
      visible: true,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      mannequin: {
        bodyType: "neutral",
        pose: { preset: "standing", joints: {} },
      },
    },
  ],
  cameras: [
    {
      id: "camera-a",
      name: "Camera A",
      position: [0, 1.6, 5],
      rotation: [0, 0, 0],
      fov: 50,
    },
  ],
  shots: [
    {
      id: "shot-a",
      name: "Shot A",
      cameraId: "camera-a",
      assetId: "director-shot-a",
      aspectRatio: "9:16",
      stageRevisionId: "stage-revision-a",
      createdAt: "2026-08-06T00:00:00.000Z",
    },
  ],
  activeCameraId: "camera-a",
  animation: {
    durationSeconds: 3,
    fps: 30,
    tracks: [
      {
        id: "hero-position",
        targetId: "hero",
        property: "position",
        keyframes: [
          {
            id: "hero-position-0",
            time: 0,
            value: [0, 0, 0],
            interpolation: "linear",
          },
          {
            id: "hero-position-1",
            time: 2,
            value: [1, 0, 0],
            interpolation: "linear",
          },
        ],
      },
    ],
  },
};

const timelineYaml = `
id: mixed-timeline
name: Mixed Timeline
revisionId: timeline-revision-v1:mixed
owner:
  kind: project
state:
  compositionWidth: 1080
  compositionHeight: 1920
  fps: 30
  durationInFrames: 90
  tracks:
    - id: overlay
      category: effect
      items:
        - id: character-overlay
          type: composition
          compositionKind: custom
          runtime: remotion
          compositionId: character-wave
          sourcePath: components/character-wave.tsx
          sourceNodeId: remotion-character-wave
          from: 0
          durationInFrames: 90
    - id: primary
      category: primary
      items:
        - id: director-shot
          type: video
          assetId: capture-output-a
          from: 0
          durationInFrames: 90
`;

const mgCharacter = `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export default function CharacterWave() {
  const frame = useCurrentFrame();
  const wave = interpolate(frame, [0, 45, 89], [0, 1, 0]);
  return <AbsoluteFill data-wave={wave}>
    <div data-character-part="head" />
    <div data-character-part="torso" />
    <div data-character-part="arm-left" />
    <div data-character-part="arm-right" />
    <div data-character-part="leg-left" />
    <div data-character-part="leg-right" />
  </AbsoluteFill>;
}
`;

describe("artifact-first evaluation", () => {
  it("scores mixed lineage without writing capture outputs into the source Director Stage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clash-artifact-eval-"));
    await writeJson(join(workspace, "artifacts", "director.json"), {
      id: "mixed-stage",
      name: "Mixed Stage",
      owner: { kind: "project" },
      revisionId: "director-stage-revision-v1:mixed",
      state: { ...directorStage, shots: [] },
    });
    await writeFile(
      join(workspace, "artifacts", "timeline.yaml"),
      timelineYaml,
      "utf8",
    );
    await writeFile(
      join(workspace, "artifacts", "character.tsx"),
      mgCharacter,
      "utf8",
    );
    await writeFile(
      join(workspace, "artifacts", "review.png"),
      Buffer.alloc(2048, 1),
    );

    const submission: ArtifactSubmission = {
      schemaVersion: 1,
      taskId: "mixed-scene-v1",
      artifacts: [
        {
          id: "stage",
          kind: "director-stage",
          path: "artifacts/director.json",
        },
        { id: "timeline", kind: "timeline", path: "artifacts/timeline.yaml" },
        {
          id: "character",
          kind: "remotion-component",
          path: "artifacts/character.tsx",
        },
        { id: "review", kind: "image", path: "artifacts/review.png" },
      ],
    };
    await writeJson(join(workspace, "submission.json"), submission);

    const benchmark = ArtifactBenchmarkCaseSchema.parse({
      id: "mixed-scene-v1",
      title: "Mixed scene",
      category: "mixed",
      outcome: {
        objective: "Build a mixed Director, Timeline, and MG scene.",
        acceptanceCriteria: [
          "The editable source artifacts are valid and linked.",
          "At least one visual evidence image is present.",
        ],
        deliverables: [
          {
            artifactId: "stage",
            kind: "director-stage",
            description: "Director Stage source",
          },
          {
            artifactId: "timeline",
            kind: "timeline",
            description: "Timeline source",
          },
          {
            artifactId: "character",
            kind: "remotion-component",
            description: "Remotion MG source",
          },
          {
            artifactId: "review",
            kind: "image",
            description: "Visual evidence",
          },
        ],
      },
      passScore: 85,
      timeoutMs: 30_000,
      skills: [],
      rubric: [
        {
          id: "director",
          type: "director-stage",
          artifactId: "stage",
          weight: 25,
          required: true,
          minObjects: 1,
          minCameras: 1,
          minCapturedShots: 3,
          minAnimatedTracks: 1,
          requireMannequin: true,
        },
        {
          id: "timeline",
          type: "timeline",
          artifactId: "timeline",
          weight: 25,
          required: true,
          minTracks: 2,
          minItems: 2,
          requiredItemTypes: ["video", "composition"],
        },
        {
          id: "mg-character",
          type: "mg-character",
          artifactId: "character",
          weight: 25,
          required: true,
          profile: "remotion-tsx",
          minSourceBytes: 300,
          requiredBodyParts: [
            "head",
            "torso",
            "arm-left",
            "arm-right",
            "leg-left",
            "leg-right",
          ],
          requiredRemotionApis: ["useCurrentFrame", "interpolate"],
        },
        {
          id: "lineage",
          type: "mixed-lineage",
          directorArtifactId: "stage",
          timelineArtifactId: "timeline",
          componentArtifactId: "character",
          weight: 15,
          required: true,
        },
        {
          id: "visual-evidence",
          type: "artifact-set",
          kind: "image",
          weight: 10,
          required: true,
          minCount: 1,
          minBytes: 1024,
        },
      ],
    });

    const report = await evaluateSubmission({ benchmark, workspace });

    expect(report.status).toBe("pass");
    expect(report.score).toBe(100);
    expect(report.checks).toHaveLength(5);
    const directorCheck = report.checks.find(({ id }) => id === "director");
    expect(directorCheck).toMatchObject({ status: "pass" });
    expect(directorCheck?.metrics).not.toHaveProperty("capturedShots");
    expect(
      report.artifacts.every((artifact) => artifact.sha256.length === 64),
    ).toBe(true);
  });

  it("accepts semantic left-right body-part aliases instead of requiring one token order", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "clash-artifact-mg-aliases-"),
    );
    const character = mgCharacter
      .replace("arm-left", "left-arm")
      .replace("arm-right", "right-arm")
      .replace("leg-left", "left-leg")
      .replace("leg-right", "right-leg");
    await writeFile(join(workspace, "character.tsx"), character, "utf8");
    await writeJson(join(workspace, "submission.json"), {
      schemaVersion: 1,
      taskId: "mg-aliases",
      artifacts: [
        { id: "character", kind: "remotion-component", path: "character.tsx" },
      ],
    });

    const report = await evaluateSubmission({
      workspace,
      benchmark: {
        id: "mg-aliases",
        title: "MG aliases",
        category: "mg-character",
        outcome: {
          objective: "Create a semantically named geometric character.",
          acceptanceCriteria: ["All six body parts are present."],
          deliverables: [
            {
              artifactId: "character",
              kind: "remotion-component",
              description: "Remotion source",
            },
          ],
        },
        passScore: 100,
        timeoutMs: 30_000,
        skills: [],
        rubric: [
          {
            id: "character",
            type: "mg-character",
            artifactId: "character",
            weight: 100,
            required: true,
            requiredBodyParts: [
              "head",
              "torso",
              "arm-left",
              "arm-right",
              "leg-left",
              "leg-right",
            ],
          },
        ],
      },
    });

    expect(report.status).toBe("pass");
  });

  it("recognizes named Remotion Interactive layers as editable character parts", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "clash-artifact-mg-interactive-"),
    );
    await writeFile(
      join(workspace, "character.tsx"),
      `import React from "react";
import { AbsoluteFill, Interactive } from "remotion";
export default function Character() {
  return <AbsoluteFill>
    <Interactive.Div name="Head" />
    <Interactive.Div name="Torso" />
    <Interactive.Div name="Left arm" />
    <Interactive.Div name="Right arm" />
    <Interactive.Div name="Left leg" />
    <Interactive.Div name="Right leg" />
  </AbsoluteFill>;
}
`,
      "utf8",
    );
    await writeJson(join(workspace, "submission.json"), {
      schemaVersion: 1,
      taskId: "mg-interactive",
      artifacts: [
        { id: "character", kind: "remotion-component", path: "character.tsx" },
      ],
    });

    const report = await evaluateSubmission({
      workspace,
      benchmark: {
        id: "mg-interactive",
        title: "Interactive MG",
        category: "mg-character",
        outcome: {
          objective: "Create an interactively editable character.",
          acceptanceCriteria: ["All six body parts are editable layers."],
          deliverables: [
            {
              artifactId: "character",
              kind: "remotion-component",
              description: "Remotion source",
            },
          ],
        },
        passScore: 100,
        timeoutMs: 30_000,
        skills: [],
        rubric: [
          {
            id: "character",
            type: "mg-character",
            artifactId: "character",
            weight: 100,
            required: true,
            requiredBodyParts: [
              "head",
              "torso",
              "arm-left",
              "arm-right",
              "leg-left",
              "leg-right",
            ],
          },
        ],
      },
    });

    expect(report.status).toBe("pass");
    expect(report.checks[0]?.metrics?.bodyParts).toEqual([
      "arm-left",
      "arm-right",
      "head",
      "leg-left",
      "leg-right",
      "torso",
    ]);
  });

  it("fails a required gate even when optional points clear the score threshold", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "clash-artifact-required-"));
    await writeFile(join(workspace, "notes.txt"), "present", "utf8");
    await writeJson(join(workspace, "submission.json"), {
      schemaVersion: 1,
      taskId: "required-gate",
      artifacts: [{ id: "notes", kind: "report", path: "notes.txt" }],
    });
    const report = await evaluateSubmission({
      workspace,
      benchmark: {
        id: "required-gate",
        title: "Required gate",
        category: "timeline",
        outcome: {
          objective: "Satisfy a required render gate.",
          acceptanceCriteria: ["The required render exists."],
          deliverables: [
            { artifactId: "notes", kind: "report", description: "Notes" },
            {
              artifactId: "render",
              kind: "video",
              description: "Required render",
            },
          ],
        },
        passScore: 50,
        timeoutMs: 30_000,
        skills: [],
        rubric: [
          {
            id: "notes",
            type: "artifact-exists",
            artifactId: "notes",
            weight: 90,
          },
          {
            id: "render",
            type: "artifact-exists",
            artifactId: "render",
            weight: 10,
            required: true,
          },
        ],
      },
    });

    expect(report.score).toBe(90);
    expect(report.status).toBe("fail");
    expect(report.checks.find((check) => check.id === "render")?.status).toBe(
      "fail",
    );
  });

  it("rejects traversal and symlink escapes instead of scoring outside files", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-artifact-escape-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "secret.txt"), "do not read", "utf8");
    await symlink(
      join(root, "secret.txt"),
      join(workspace, "linked-secret.txt"),
    );

    for (const [taskId, artifactPath] of [
      ["traversal", "../secret.txt"],
      ["symlink", "linked-secret.txt"],
    ] as const) {
      await writeJson(join(workspace, "submission.json"), {
        schemaVersion: 1,
        taskId,
        artifacts: [{ id: "secret", kind: "report", path: artifactPath }],
      });
      const report = await evaluateSubmission({
        workspace,
        benchmark: {
          id: taskId,
          title: taskId,
          category: "director",
          outcome: {
            objective: "Keep all deliverables inside the workspace.",
            acceptanceCriteria: ["No artifact escapes the workspace."],
            deliverables: [
              {
                artifactId: "secret",
                kind: "report",
                description: "Local report",
              },
            ],
          },
          passScore: 1,
          timeoutMs: 30_000,
          skills: [],
          rubric: [
            {
              id: "secret",
              type: "artifact-exists",
              artifactId: "secret",
              weight: 1,
              required: true,
            },
          ],
        },
      });
      expect(report.status).toBe("fail");
      expect(report.checks[0]?.detail).toMatch(/inside|symlink/i);
    }
  });
});

describe("headless benchmark runner", () => {
  it("accepts explicit capability, trajectory, submission, and product-readback contracts", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse({
      id: "director-product-frames",
      title: "Director product frames",
      category: "director",
      outcome: {
        objective:
          "Create an editable Director Stage and three product-rendered evidence frames.",
        acceptanceCriteria: [
          "The Stage and three frames can be read back from Clash.",
        ],
        deliverables: [
          {
            artifactId: "stage",
            kind: "director-stage",
            description: "Editable Stage",
          },
          {
            artifactId: "frame-a",
            kind: "image",
            description: "Opening frame",
          },
          { artifactId: "frame-b", kind: "image", description: "Action frame" },
          {
            artifactId: "frame-c",
            kind: "image",
            description: "Closing frame",
          },
        ],
      },
      passScore: 80,
      timeoutMs: 10_000,
      skills: [],
      execution: {
        profile: "clash-host",
        requiredProductOperations: ["director.create", "director.capture"],
        requiredCapabilities: [
          "director-stage-readback",
          "director-headless-png-capture",
        ],
        preflight: {
          status: "blocked",
          checks: [
            {
              capability: "director-stage-readback",
              status: "available",
              detail:
                "Director Stage receipts are available through the project host.",
            },
            {
              capability: "director-headless-png-capture",
              status: "missing",
              detail:
                "No offscreen Director renderer is wired into the headless host yet.",
            },
          ],
        },
        evidence: { traceRequired: true, submissionRequired: true },
        productReadback: {
          required: true,
          mechanism: "director-stage-and-render-receipt",
          artifactIds: ["stage", "frame-a", "frame-b", "frame-c"],
          description:
            "Read the Stage and product-rendered PNG receipts back from Clash.",
        },
      },
      rubric: [
        {
          id: "stage",
          type: "director-stage",
          artifactId: "stage",
          weight: 70,
          required: true,
        },
        {
          id: "frames",
          type: "artifact-set",
          kind: "image",
          minCount: 3,
          weight: 30,
          required: true,
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects artifact-set rubrics that cannot be satisfied by declared outcome deliverables", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse({
      id: "missing-evidence",
      title: "Missing evidence",
      category: "mg-character",
      outcome: {
        objective:
          "Create a rendered motion-graphics character with review evidence.",
        acceptanceCriteria: ["Three evidence frames are present."],
        deliverables: [
          {
            artifactId: "mg-video",
            kind: "video",
            description: "Rendered character",
          },
        ],
      },
      passScore: 80,
      timeoutMs: 10_000,
      skills: [],
      rubric: [
        {
          id: "evidence",
          type: "artifact-set",
          kind: "image",
          minCount: 3,
          required: true,
          weight: 1,
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.map((issue) => issue.message).join("\n"),
      ).toMatch(/declares 0 image deliverables.*requires 3/i);
    }
  });

  it("rejects unknown product operation ids", () => {
    const parsed = ArtifactBenchmarkCaseSchema.safeParse({
      id: "unknown-operation",
      title: "Unknown operation",
      category: "timeline",
      outcome: {
        objective: "Exercise a product operation.",
        acceptanceCriteria: ["The product state is persisted."],
        deliverables: [
          {
            artifactId: "timeline",
            kind: "timeline",
            description: "Timeline",
          },
        ],
      },
      passScore: 100,
      timeoutMs: 10_000,
      skills: [],
      execution: {
        profile: "clash-host",
        requiredProductOperations: ["timeline.teleport"],
      },
      rubric: [
        {
          id: "timeline",
          type: "timeline",
          artifactId: "timeline",
          weight: 1,
          required: true,
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("loads v2 cases with readback for their declared editable sources and media", async () => {
    const suitePath = fileURLToPath(
      new URL(
        "../../../benchmarks/creative-artifacts/v2/suite.json",
        import.meta.url,
      ),
    );

    const suite = await loadBenchmarkSuite(suitePath);
    expect(suite.id).toBe("clash-creative-artifacts-v2");

    for (const benchmarkCase of suite.cases) {
      const deliverables = benchmarkCase.outcome.deliverables;
      const declaredArtifactIds = new Set(
        deliverables.map((deliverable) => deliverable.artifactId),
      );
      const imageCount = deliverables.filter(
        (deliverable) => deliverable.kind === "image",
      ).length;
      const hasMedia = deliverables.some((deliverable) =>
        ["video", "audio"].includes(deliverable.kind),
      );
      const editableKinds = new Set(
        deliverables.map((deliverable) => deliverable.kind),
      );
      const execution = benchmarkCase.execution;

      expect(execution, benchmarkCase.id).toBeDefined();
      expect(
        execution?.requiredProductOperations?.length,
        benchmarkCase.id,
      ).toBeGreaterThan(0);
      expect(execution?.requiredMcpTools, benchmarkCase.id).toBeUndefined();
      expect(execution?.requiredCliCommands, benchmarkCase.id).toBeUndefined();
      expect(
        execution?.requiredCapabilities?.length,
        benchmarkCase.id,
      ).toBeGreaterThan(0);
      expect(execution?.preflight?.checks, benchmarkCase.id).toHaveLength(
        execution?.requiredCapabilities?.length ?? 0,
      );
      expect(execution?.evidence, benchmarkCase.id).toEqual({
        traceRequired: true,
        submissionRequired: true,
      });
      expect(execution?.productReadback?.required, benchmarkCase.id).toBe(true);
      expect(
        execution?.productReadback?.artifactIds.every((id) =>
          declaredArtifactIds.has(id),
        ),
        benchmarkCase.id,
      ).toBe(true);
      expect(hasMedia || imageCount >= 3, benchmarkCase.id).toBe(true);

      if (benchmarkCase.category === "director")
        expect(editableKinds.has("director-stage"), benchmarkCase.id).toBe(
          true,
        );
      if (benchmarkCase.category === "timeline")
        expect(editableKinds.has("timeline"), benchmarkCase.id).toBe(true);
      if (benchmarkCase.category === "mg-character")
        expect(editableKinds.has("remotion-component"), benchmarkCase.id).toBe(
          true,
        );
      if (benchmarkCase.category === "mixed") {
        expect(editableKinds.has("director-stage"), benchmarkCase.id).toBe(
          true,
        );
        expect(editableKinds.has("timeline"), benchmarkCase.id).toBe(true);
        const lineageArtifactIds = deliverables
          .filter(({ kind }) =>
            [
              "director-stage",
              "timeline",
              "remotion-component",
              "video",
            ].includes(kind),
          )
          .map(({ artifactId }) => artifactId);
        expect(
          execution?.productReadback?.artifactIds,
          benchmarkCase.id,
        ).toEqual(expect.arrayContaining(lineageArtifactIds));
      }
    }

    for (const benchmarkCase of suite.cases.filter(
      ({ category }) => category === "director",
    )) {
      expect(
        benchmarkCase.outcome.deliverables.filter(
          ({ kind }) => kind === "image",
        ),
        benchmarkCase.id,
      ).toHaveLength(3);
      expect(
        benchmarkCase.execution?.requiredCapabilities,
        benchmarkCase.id,
      ).toContain("director-headless-png-capture");
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).toEqual([
        "director.create",
        "director.mutate",
        "director.get",
        "director.capture",
      ]);
      expect(
        benchmarkCase.execution?.preflight,
        benchmarkCase.id,
      ).toMatchObject({
        status: "ready",
        checks: expect.arrayContaining([
          expect.objectContaining({
            capability: "director-headless-png-capture",
            status: "available",
          }),
        ]),
      });
    }

    for (const benchmarkCase of suite.cases.filter(
      ({ category }) => category === "timeline",
    )) {
      expect(
        benchmarkCase.execution?.requiredCapabilities,
        benchmarkCase.id,
      ).toContain("timeline-headless-render");
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).toContain("timeline.render");
      expect(
        benchmarkCase.execution?.preflight,
        benchmarkCase.id,
      ).toMatchObject({
        status: "ready",
        checks: expect.arrayContaining([
          expect.objectContaining({
            capability: "timeline-headless-render",
            status: "available",
          }),
        ]),
      });
    }

    for (const benchmarkCase of suite.cases.filter(
      ({ category }) => category === "mg-character",
    )) {
      expect(
        benchmarkCase.execution?.requiredCapabilities,
        benchmarkCase.id,
      ).toEqual(
        expect.arrayContaining([
          "canvas-remotion-component",
          "remotion-component-readback",
          "timeline-headless-render",
          "timeline-render-readback",
        ]),
      );
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).toEqual(
        expect.arrayContaining(["canvas.add", "canvas.get", "timeline.render"]),
      );
      expect(
        benchmarkCase.execution?.preflight,
        benchmarkCase.id,
      ).toMatchObject({
        status: "ready",
        checks: expect.arrayContaining([
          expect.objectContaining({
            capability: "remotion-component-readback",
            status: "available",
          }),
        ]),
      });
    }

    for (const benchmarkCase of suite.cases.filter(
      ({ category, outcome }) =>
        category === "mixed" &&
        outcome.deliverables.some(({ kind }) => kind === "remotion-component"),
    )) {
      expect(
        benchmarkCase.execution?.requiredProductOperations,
        benchmarkCase.id,
      ).toEqual(
        expect.arrayContaining([
          "director.capture",
          "canvas.add",
          "timeline.render",
        ]),
      );
      expect(
        benchmarkCase.execution?.productReadback?.mechanism,
        benchmarkCase.id,
      ).toBe("mixed-remotion-lineage-and-render-receipt");
    }

    expect(JSON.stringify(suite)).not.toMatch(
      /mg-spec|MgCompositionSpec|render-mg|export-mg-video|verify-mg-preview|mg-headless-render|"runtime":"html"/u,
    );
    expect(JSON.stringify(suite)).not.toContain('"requiredMcpTools"');
  });

  it("runs an isolated command agent, captures logs, and evaluates its submission", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-headless-runner-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    await mkdir(suiteRoot);
    await mkdir(join(suiteRoot, "skills", "test-skill"), { recursive: true });
    await writeFile(
      join(suiteRoot, "skills", "test-skill", "SKILL.md"),
      "---\nname: test-skill\ndescription: Test-only copied skill.\n---\n\n# Test Skill\n",
      "utf8",
    );
    const suite = {
      schemaVersion: 1 as const,
      id: "smoke-suite",
      title: "Smoke suite",
      cases: [
        {
          id: "command-agent",
          title: "Command agent",
          category: "timeline" as const,
          outcome: {
            objective: "Create result.txt and submission.json.",
            acceptanceCriteria: ["result.txt contains a non-empty artifact."],
            deliverables: [
              {
                artifactId: "result",
                kind: "report" as const,
                description: "Result artifact",
              },
            ],
          },
          passScore: 100,
          timeoutMs: 10_000,
          skills: ["skills/test-skill"],
          rubric: [
            {
              id: "hidden-rubric-sentinel",
              type: "artifact-exists" as const,
              artifactId: "result",
              weight: 1,
              required: true,
            },
          ],
        },
      ],
    };
    const childScript = [
      'const fs = require("node:fs")',
      'const path = require("node:path")',
      "const workspace = process.env.CLASH_BENCH_WORKSPACE",
      "if (process.env.CLASH_BENCH_SUITE_ROOT) process.exit(2)",
      'if (!fs.existsSync(path.join(workspace, ".agents", "skills", "test-skill", "SKILL.md"))) process.exit(3)',
      "if (process.env.INIT_CWD) process.exit(4)",
      "if (process.env.PWD !== workspace) process.exit(5)",
      'if ((process.env.PATH || "").split(path.delimiter).some((entry) => entry.includes("node_modules/.bin"))) process.exit(6)',
      'fs.writeFileSync(path.join(workspace, "result.txt"), "artifact")',
      'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"command-agent",artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
      'process.stdout.write("agent completed\\n")',
    ].join(";");

    const report = await runBenchmarkSuite({
      suite,
      suiteRoot,
      outputRoot,
      runId: "run-001",
      agent: { command: process.execPath, args: ["-e", childScript] },
    });

    expect(report.status).toBe("pass");
    expect(report.cases[0]?.agent).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(report.cases[0]?.evaluation.status).toBe("pass");
    const gallery = await readFile(
      join(outputRoot, "run-001", "report.html"),
      "utf8",
    );
    expect(gallery).toContain("command-agent/workspace/result.txt");
    expect(gallery).toContain("command-agent/logs/stdout.log");
    const stdout = await readFile(
      join(outputRoot, "run-001", "command-agent", "logs", "stdout.log"),
      "utf8",
    );
    expect(stdout).toContain("agent completed");
    const outcome = await readFile(
      join(outputRoot, "run-001", "command-agent", "workspace", "OUTCOME.md"),
      "utf8",
    );
    expect(outcome).toContain("Create result.txt and submission.json");
    expect(outcome).not.toContain("$test-skill");
    expect(outcome).not.toContain("## Skills");
    expect(outcome).not.toContain("hidden-rubric-sentinel");
    expect(outcome).toContain('"id": "result"');
    expect(outcome).not.toContain("<deliverable artifactId>");
    expect(outcome).toMatch(/evaluation label, not a product entity id/i);
    await expect(
      readFile(
        join(
          outputRoot,
          "run-001",
          "command-agent",
          "workspace",
          "benchmark-case.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const outcomeResult = JSON.parse(
      await readFile(
        join(outputRoot, "run-001", "command-agent", "outcome-result.json"),
        "utf8",
      ),
    );
    expect(outcomeResult.status).toBe("achieved");
  });

  it("tees Codex JSONL unchanged while recording observation time and a repair-aware trajectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-headless-trajectory-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const fakeCodex = join(root, "fake-codex");
    await mkdir(suiteRoot);
    const events = [
      { type: "thread.started", thread_id: "trajectory-thread" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "clash",
          tool: "clash_canvas_get",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-1",
          type: "mcp_tool_call",
          server: "clash",
          tool: "clash_canvas_get",
          status: "failed",
          error: "node was not found",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "mcp-2",
          type: "mcp_tool_call",
          server: "clash",
          tool: "clash_canvas",
          arguments: {
            operation: "clash_canvas_get",
            arguments: { nodeId: "node-1" },
          },
          status: "completed",
          error: null,
          result: { structured_content: { id: "node-1" } },
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    ];
    const rawEvents = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await writeFile(
      fakeCodex,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        `const events = ${JSON.stringify(events)}`,
        "const workspace = process.env.CLASH_BENCH_WORKSPACE",
        ";(async () => {",
        'for (const event of events) { process.stdout.write(JSON.stringify(event) + "\\n"); await new Promise((resolve) => setTimeout(resolve, 5)) }',
        'fs.writeFileSync(path.join(workspace, "result.txt"), "artifact")',
        'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"trajectory-case",artifacts:[{id:"result",kind:"report",path:"result.txt"}]}))',
        "})().catch((error) => { console.error(error); process.exit(1) })",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    const report = await runBenchmarkSuite({
      suite: {
        schemaVersion: 1,
        id: "trajectory-suite",
        title: "Trajectory suite",
        cases: [
          {
            id: "trajectory-case",
            title: "Trajectory case",
            category: "timeline",
            outcome: {
              objective:
                "Create one report while exposing a repair trajectory.",
              acceptanceCriteria: ["The report exists."],
              deliverables: [
                { artifactId: "result", kind: "report", description: "Result" },
              ],
            },
            passScore: 100,
            timeoutMs: 10_000,
            skills: [],
            rubric: [
              {
                id: "result",
                type: "artifact-exists",
                artifactId: "result",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      },
      suiteRoot,
      outputRoot,
      runId: "trajectory-run",
      agent: { adapter: "codex", command: fakeCodex },
    });

    expect(report.status).toBe("pass");
    const logsRoot = join(
      outputRoot,
      "trajectory-run",
      "trajectory-case",
      "logs",
    );
    const eventsPath = join(logsRoot, "events.jsonl");
    expect(await readFile(eventsPath, "utf8")).toBe(rawEvents);
    const observed = (
      await readFile(join(logsRoot, "observed-events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            line: number;
            observedAt: string;
            monotonicMs: number;
            rawLineSha256: string;
          },
      );
    expect(observed.map((event) => event.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      observed.every((event) => Number.isFinite(Date.parse(event.observedAt))),
    ).toBe(true);
    expect(observed.map((event) => event.monotonicMs)).toEqual(
      [...observed.map((event) => event.monotonicMs)].sort(
        (left, right) => left - right,
      ),
    );
    expect(observed[3]?.rawLineSha256).toBe(
      createHash("sha256").update(JSON.stringify(events[3])).digest("hex"),
    );

    const trajectory = JSON.parse(
      await readFile(join(logsRoot, "trajectory.json"), "utf8"),
    ) as {
      sourceTraces: Array<{ kind: string; path: string; sha256: string }>;
      actions: Array<{
        sequence: number;
        kind: string;
        operation: string;
        status: string;
        error?: string;
      }>;
      repairs: Array<{
        operation: string;
        failedSequence: number;
        recoverySequence: number;
      }>;
      turns: Array<{ status: string; usage: Record<string, number> }>;
      usage: Record<string, number>;
    };
    expect(trajectory.sourceTraces).toContainEqual(
      expect.objectContaining({
        kind: "codex-events",
        path: "events.jsonl",
        sha256: createHash("sha256").update(rawEvents).digest("hex"),
      }),
    );
    expect(
      trajectory.actions.filter((action) => action.kind === "mcp"),
    ).toMatchObject([
      { sequence: 1, operation: "clash/clash_canvas_get", status: "started" },
      {
        sequence: 2,
        operation: "clash/clash_canvas_get",
        status: "failed",
        error: "node was not found",
      },
      { sequence: 3, operation: "clash/clash_canvas_get", status: "succeeded" },
    ]);
    expect(trajectory.repairs).toEqual([
      {
        operation: "clash/clash_canvas_get",
        failedSequence: 2,
        recoverySequence: 3,
      },
    ]);
    expect(trajectory.turns).toEqual([
      {
        status: "completed",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
        },
      },
    ]);
    expect(trajectory.usage).toEqual({
      turnCount: 1,
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 30,
      reasoningOutputTokens: 5,
    });
  });

  it("does not treat agent-authored MCP stdout as product-operation evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "clash-host-runner-"));
    const suiteRoot = join(root, "suite");
    const outputRoot = join(root, "runs");
    const pluginRoot = join(root, "clash-plugin");
    const fakeCodex = join(root, "fake-codex");
    const productStage = {
      id: "runner-stage",
      name: "Runner Stage",
      owner: { kind: "project" as const },
      revisionId: "runner-stage-revision-v1",
      state: DirectorStageStateSchema.parse(directorStage),
    };
    const productStageReceipt = `${projectDirectorStageReadToken(productStage)}:receipt:fake-hmac`;
    await mkdir(join(pluginRoot, "runtime"), { recursive: true });
    await mkdir(suiteRoot);
    await writeFile(
      join(pluginRoot, "runtime", "index.js"),
      "// test runtime\n",
      "utf8",
    );
    await writeFile(
      join(pluginRoot, "runtime", "local-api.cjs"),
      [
        'const fs = require("node:fs")',
        'const http = require("node:http")',
        'const net = require("node:net")',
        'const path = require("node:path")',
        'if (process.env.CLASH_LOCAL_API_WRAPPER_ENTRY !== "1") process.exit(23)',
        "const runDir = process.env.CLASH_HOST_RUN_DIR",
        'const discovery = path.join(runDir, "host.json")',
        "fs.mkdirSync(runDir, {recursive:true})",
        'const pluginSocket = process.env.CLASH_PLUGIN_HOST_SOCKET || path.join(process.env.CLASH_HOME, "sockets", "plugin-host.sock")',
        "fs.mkdirSync(path.dirname(pluginSocket), {recursive:true})",
        "fs.rmSync(pluginSocket, {force:true})",
        "const ipc = net.createServer((socket) => socket.end())",
        "ipc.listen(pluginSocket)",
        `const stage = ${JSON.stringify(productStage)}`,
        `const receipt = ${JSON.stringify(productStageReceipt)}`,
        'const server = http.createServer((request, response) => { const chunks = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => { let body = {}; if (request.method === "POST" && /\\/api\\/v1\\/projects\\/[^/]+\\/host-command$/.test(request.url || "")) { const command = JSON.parse(Buffer.concat(chunks).toString("utf8")); body = command.action === "ping" ? {pong:true} : command.action === "list_director_stages" ? {stages:[stage],versions:{[stage.id]:receipt}} : {error:"unsupported"} } response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)) }) })',
        'server.listen(0, "127.0.0.1", () => { const port = server.address().port; fs.writeFileSync(discovery, JSON.stringify({endpoint:"http://127.0.0.1:" + port,pid:process.pid,profile:process.env.CLASH_PROFILE,launchMode:"user-service",startedBy:"plugin",agentCliPath:process.env.CLASH_CLI_ENTRY_PATH})) })',
        'process.on("SIGTERM", () => { server.close(); ipc.close(); fs.rmSync(discovery, {force:true}); fs.rmSync(pluginSocket, {force:true}); process.exit(0) })',
      ].join("\n"),
      "utf8",
    );
    const fakeClashCli = join(pluginRoot, "runtime", "clash-cli.cjs");
    await writeFile(
      fakeClashCli,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        "const argv = process.argv.slice(2)",
        'const command = argv.join(" ")',
        'const marker = path.join(process.cwd(), ".clash", "project.toml")',
        'if (argv[0] === "init") { const requested = argv.includes("--project") ? argv[argv.indexOf("--project") + 1] : undefined; let reused = false; let projectId = requested; if (fs.existsSync(marker)) { const source = fs.readFileSync(marker, "utf8"); projectId = /project_id\\s*=\\s*"([^"]+)"/.exec(source)?.[1]; if (requested && requested !== projectId) process.exit(41); reused = true } else { if (!projectId) process.exit(42); fs.mkdirSync(path.dirname(marker), {recursive:true}); fs.writeFileSync(marker, "schema_version = 1\\nproject_id = " + JSON.stringify(projectId) + "\\nworkspace_id = \\"managed:test\\"\\nstore = \\"managed\\"\\n") } process.stdout.write(JSON.stringify({projectId,markerPath:marker,workspaceId:"managed:test",reused}) + "\\n"); process.exit(0) }',
        "if (!fs.existsSync(marker)) process.exit(43)",
        'const projectId = /project_id\\s*=\\s*"([^"]+)"/.exec(fs.readFileSync(marker, "utf8"))?.[1]',
        "const tracePath = process.env.CLASH_CLI_TRACE_PATH",
        "const startedAt = new Date().toISOString()",
        'if (tracePath) fs.appendFileSync(tracePath, JSON.stringify({type:"clash.cli.started",startedAt,pid:process.pid,cwd:process.cwd(),argv}) + "\\n")',
        'if (command === "timeline render --timeline smoke --json") { if (tracePath) fs.appendFileSync(tracePath, JSON.stringify({type:"clash.cli.completed",startedAt,finishedAt:new Date().toISOString(),durationMs:1,pid:process.pid,cwd:process.cwd(),argv,exitCode:0,signal:null}) + "\\n"); process.exit(0) }',
        "process.exit(2)",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeClashCli, 0o755);
    await writeFile(
      fakeCodex,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs")',
        'const path = require("node:path")',
        "const workspace = process.env.CLASH_BENCH_WORKSPACE",
        ";(async () => {",
        'const privateHostKeys = ["CLASH_PROFILE","CLASH_HOME","CLASH_LOCAL_DATA_DIR","CLASH_API_URL","CLASH_NODE_EXEC_PATH","CLASH_WORKSPACE_ROOT","CLASH_AGENT_MEMBER_ID","CLASH_AGENT_NAME","CLASH_PLUGIN_HOST_SOCKET"]',
        "if (privateHostKeys.some((key) => process.env[key] !== undefined)) process.exit(12)",
        'if (!(process.env.PATH || "").split(path.delimiter).includes(path.dirname(process.env.CLASH_CLI_ENTRY_PATH || ""))) process.exit(15)',
        'if (path.basename(process.env.CLASH_CLI_ENTRY_PATH) !== "clash") process.exit(16)',
        "if (process.env.CLASH_CLI_TRACE_PATH) process.exit(17)",
        'if (fs.existsSync(path.join(workspace, "AGENTS.md"))) process.exit(10)',
        "if (process.env.CLASH_BENCH_PROJECT_HOST_PATH) process.exit(11)",
        'const marker = path.join(workspace, ".clash", "project.toml")',
        "if (!fs.existsSync(marker)) process.exit(7)",
        'const ready = JSON.parse(fs.readFileSync(path.join(workspace, ".clash", "headless-host-ready.json"), "utf8"))',
        'const projectId = /project_id\\s*=\\s*"([^"]+)"/.exec(fs.readFileSync(marker, "utf8"))?.[1]',
        'if (ready.status !== "ready" || ready.projectId !== projectId || ready.initDisposition !== "created") process.exit(8)',
        'require("node:child_process").execFileSync(process.env.CLASH_CLI_ENTRY_PATH, ["timeline", "render", "--timeline", "smoke", "--json"], {stdio:"ignore"})',
        'fs.writeFileSync(path.join(workspace, "argv.json"), JSON.stringify(process.argv.slice(2)))',
        "const rawHostEnvironment = {}",
        "for (const key of privateHostKeys) if (process.env[key] !== undefined) rawHostEnvironment[key] = process.env[key]",
        'const trustedCliInPath = (process.env.PATH || "").split(path.delimiter).includes(path.dirname(process.env.CLASH_CLI_ENTRY_PATH))',
        "const sandboxTopology = {rawHostEnvironment,trustedCliInPath}",
        'fs.writeFileSync(path.join(workspace, "sandbox-topology.json"), JSON.stringify(sandboxTopology))',
        `fs.writeFileSync(path.join(workspace, "stage.json"), ${JSON.stringify(JSON.stringify(directorStage))})`,
        'fs.writeFileSync(path.join(workspace, "submission.json"), JSON.stringify({schemaVersion:1,taskId:"clash-host",artifacts:[{id:"stage",kind:"director-stage",path:"stage.json"}]}))',
        'process.stdout.write(JSON.stringify({type:"thread.started",thread_id:"test"}) + "\\n")',
        'process.stdout.write(JSON.stringify({type:"item.completed",item:{id:"item_0",type:"mcp_tool_call",server:"clash",tool:"clash_director",arguments:{operation:"clash_director_create",arguments:{stageId:"stage"}},result:{structured_content:{stageId:"stage"}},error:null,status:"completed"}}) + "\\n")',
        "})().catch((error) => { console.error(error); process.exit(9) })",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeCodex, 0o755);

    const report = await runBenchmarkSuite({
      suite: {
        schemaVersion: 1,
        id: "clash-host-suite",
        title: "Clash host suite",
        cases: [
          {
            id: "clash-host",
            title: "Clash host",
            category: "director",
            outcome: {
              objective:
                "Create a product-backed artifact in a newly initialized Clash workspace.",
              acceptanceCriteria: [
                "The execution agent starts after the Clash project host is ready.",
              ],
              deliverables: [
                {
                  artifactId: "stage",
                  kind: "director-stage",
                  description: "Host-backed Stage",
                },
              ],
            },
            passScore: 100,
            timeoutMs: 10_000,
            skills: [],
            execution: {
              profile: "clash-host",
              requiredProductOperations: ["director.create", "timeline.render"],
            },
            rubric: [
              {
                id: "stage",
                type: "director-stage",
                artifactId: "stage",
                weight: 1,
                required: true,
              },
            ],
          },
        ],
      },
      suiteRoot,
      outputRoot,
      runId: "host-run-001",
      agent: {
        adapter: "codex",
        command: fakeCodex,
        clashHost: { pluginRoot, profile: "dev" },
      },
    });

    expect(report.status).toBe("fail");
    expect(report.cases[0]?.execution).toMatchObject({
      profile: "clash-host",
      status: "fail",
      requiredProductOperations: ["director.create", "timeline.render"],
      observedProductOperations: [
        {
          operation: "timeline.render",
          transport: "cli",
          invocation: "timeline render --timeline smoke --json",
        },
      ],
      missingProductOperations: ["director.create"],
      observedMcpTools: [],
      missingMcpTools: [],
      observedCliCommands: ["timeline render --timeline smoke --json"],
      missingCliCommands: [],
    });
    const trajectory = JSON.parse(
      await readFile(
        join(
          outputRoot,
          "host-run-001",
          "clash-host",
          "logs",
          "trajectory.json",
        ),
        "utf8",
      ),
    ) as {
      sourceTraces: Array<{ kind: string; path: string; sha256: string }>;
      actions: Array<{
        source: string;
        kind: string;
        operation: string;
        status: string;
        sequence: number;
      }>;
    };
    expect(trajectory.sourceTraces).toContainEqual(
      expect.objectContaining({
        kind: "clash-cli-events",
        path: "clash-cli-events.jsonl",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(
      trajectory.actions.filter((action) => action.kind === "cli"),
    ).toMatchObject([
      { source: "clash-cli", operation: "timeline render", status: "started" },
      {
        source: "clash-cli",
        operation: "timeline render",
        status: "succeeded",
      },
    ]);
    expect(
      trajectory.actions.filter((action) => action.kind === "mcp"),
    ).toMatchObject([
      {
        source: "codex",
        operation: "clash/clash_director_create",
        status: "succeeded",
      },
    ]);
    expect(trajectory.actions.map((action) => action.sequence)).toEqual(
      trajectory.actions.map((_action, index) => index + 1),
    );
    const resolvedOutputRoot = await realpath(outputRoot);
    const caseRoot = join(resolvedOutputRoot, "host-run-001", "clash-host");
    const workspace = join(caseRoot, "workspace");
    const hostManifest = JSON.parse(
      await readFile(join(caseRoot, "clash-host.json"), "utf8"),
    ) as {
      runtimeClashHome: string;
      persistedClashHome: string;
      executionWorkspace: string;
      finalWorkspace: string;
      initDisposition: string;
      localApiReadyAt: string;
      projectHostReadyAt: string;
    };
    const args = JSON.parse(
      await readFile(join(workspace, "argv.json"), "utf8"),
    ) as string[];
    const sandboxTopology = JSON.parse(
      await readFile(join(workspace, "sandbox-topology.json"), "utf8"),
    ) as {
      rawHostEnvironment: Record<string, string>;
      trustedCliInPath: boolean;
    };
    const config = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] !== "-c") continue;
      const entry = args[index + 1] ?? "";
      const separator = entry.indexOf("=");
      config.set(entry.slice(0, separator), entry.slice(separator + 1));
    }
    expect(args).toContain("--ignore-user-config");
    expect(config.get("skills.include_instructions")).toBe("false");
    expect(JSON.parse(config.get("developer_instructions")!)).toContain(
      "Task skills",
    );
    expect(
      args.flatMap((argument, index) =>
        argument === "--disable" ? [args[index + 1]] : [],
      ),
    ).toEqual(["plugins", "remote_plugin", "recommended_plugins"]);
    const addDirs = args.flatMap((argument, index) =>
      argument === "--add-dir" ? [args[index + 1]] : [],
    );
    expect(addDirs).toEqual([
      join(dirname(hostManifest.runtimeClashHome), "trusted-mcp-relay"),
      join(dirname(hostManifest.runtimeClashHome), "trusted-agent-cli"),
    ]);
    expect(sandboxTopology).toEqual({
      rawHostEnvironment: {},
      trustedCliInPath: true,
    });
    expect(config.get("mcp_servers.clash.required")).toBe("true");
    expect(config.get("mcp_servers.clash.command")).toBe(
      JSON.stringify(process.execPath),
    );
    const mcpArgs = JSON.parse(
      config.get("mcp_servers.clash.args") ?? "null",
    ) as unknown;
    expect(mcpArgs).toEqual([
      expect.stringMatching(/trusted-mcp-relay[/\\]relay\.cjs$/u),
    ]);
    expect(config.has("mcp_servers.clash.env.CLASH_PROFILE")).toBe(false);
    expect(config.has("mcp_servers.clash.env.CLASH_WORKSPACE_ROOT")).toBe(
      false,
    );
    expect(config.has("mcp_servers.clash.env.CLASH_HOME")).toBe(false);
    expect(config.has("mcp_servers.clash.env.CLASH_CLI_TRACE_PATH")).toBe(
      false,
    );
    expect(config.get("sandbox_workspace_write.network_access")).toBe("true");
    expect(hostManifest.persistedClashHome).toBe(join(caseRoot, "clash-home"));
    expect(hostManifest.initDisposition).toBe("created");
    expect(Date.parse(hostManifest.localApiReadyAt)).toBeLessThanOrEqual(
      Date.parse(hostManifest.projectHostReadyAt),
    );
    expect(hostManifest.executionWorkspace).not.toBe(workspace);
    expect(hostManifest.finalWorkspace).toBe(workspace);
    const outcome = await readFile(join(workspace, "OUTCOME.md"), "utf8");
    expect(outcome).not.toContain("starts unbound");
    expect(outcome).not.toContain("clash_workspace_init");
    expect(outcome).not.toMatch(/\bclash init\b/i);
    expect(outcome).not.toContain("CLASH_BENCH_PROJECT_HOST_PATH");
    expect(outcome).toMatch(/already bound.*project host is ready/i);
    await expect(
      readFile(join(workspace, "AGENTS.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await readFile(join(workspace, ".clash", "project.toml"), "utf8"),
    ).toMatch(/project_id = "headless_eval_[a-f0-9]{24}"/);
    expect(
      JSON.parse(
        await readFile(join(caseRoot, "clash-project-host.json"), "utf8"),
      ),
    ).toMatchObject({
      status: "ready",
      projectId: expect.stringMatching(/^headless_eval_[a-f0-9]{24}$/),
      initDisposition: "created",
    });
    expect(
      JSON.parse(
        await readFile(join(caseRoot, "director-readback.json"), "utf8"),
      ),
    ).toMatchObject({
      status: "pass",
      projectId: expect.stringMatching(/^headless_eval_[a-f0-9]{24}$/),
      matchedArtifactIds: ["stage"],
    });
  }, 15_000);
});
