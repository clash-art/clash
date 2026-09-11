import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDefaultDirectorStageState,
  projectDirectorStageReadToken,
  type ProjectDirectorStage,
} from "@clash/shared-types";
import { expect, it } from "vitest";

import { captureRequiredProductReadback } from "./runner";
import type { ArtifactBenchmarkCase } from "./types";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const benchmark: ArtifactBenchmarkCase = {
  id: "director-capture-project-asset-readback",
  title: "Director capture Project Asset readback",
  category: "mixed",
  outcome: {
    objective: "Verify a Director capture through its immutable Project Asset.",
    acceptanceCriteria: [
      "The submitted frame is the exact image published by Director capture.",
    ],
    deliverables: [
      { artifactId: "stage", kind: "director-stage", description: "Stage" },
      { artifactId: "capture", kind: "image", description: "Capture" },
    ],
  },
  passScore: 100,
  timeoutMs: 10_000,
  skills: [],
  execution: {
    profile: "clash-host",
    productReadback: {
      required: true,
      mechanism: "director-stage-and-render-receipt",
      artifactIds: ["stage", "capture"],
      description: "Trusted Director Stage and capture readback.",
    },
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
};

const projectId = "project-director-capture-readback";
const projectAssetId = "director-capture:immutable-frame";
const stage: ProjectDirectorStage = {
  id: "director-stage",
  name: "Director Stage",
  owner: { kind: "project" },
  revisionId: "director-stage-revision-v1:live",
  state: createDefaultDirectorStageState(),
};

async function captureDirectorFixture(input: {
  submittedBytes: Buffer;
  hostBytes: Buffer;
  rerenderedSha256: string;
  publicDirectorGetArtifact?: boolean;
  omitProjectAssetId?: boolean;
  origin?:
    | "valid"
    | "missing"
    | "wrong-revision"
    | "wrong-asset"
    | "wrong-executor"
    | "wrong-time"
    | "failed-run";
  assetState?: "ready" | "missing" | "trashed" | "missing-bytes";
  receiptStateSha256?: string;
}) {
  const root = await mkdtemp(join("/tmp", "director-capture-readback-"));
  const workspace = join(root, "workspace");
  const captureRoot = join(workspace, "captures");
  await Promise.all([
    mkdir(join(workspace, ".clash"), { recursive: true }),
    mkdir(captureRoot, { recursive: true }),
  ]);
  const stateText = JSON.stringify(stage.state);
  const submittedStageArtifact = input.publicDirectorGetArtifact
    ? { stage }
    : stage.state;
  const frameSha256 = sha256(input.submittedBytes);
  await Promise.all([
    writeFile(
      join(workspace, ".clash", "project.toml"),
      `schema_version = 1\nproject_id = "${projectId}"\n`,
      "utf8",
    ),
    writeFile(
      join(workspace, "stage.json"),
      JSON.stringify(submittedStageArtifact),
      "utf8",
    ),
    writeFile(join(workspace, "capture.png"), input.submittedBytes),
    writeFile(
      join(workspace, "submission.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: benchmark.id,
        artifacts: [
          { id: "stage", kind: "director-stage", path: "stage.json" },
          { id: "capture", kind: "image", path: "capture.png" },
        ],
      })}\n`,
      "utf8",
    ),
    writeFile(
      join(captureRoot, "capture.json"),
      `${JSON.stringify({
        captured: true,
        stageId: stage.id,
        sourceStageRevisionId: stage.revisionId,
        verifiedStageRevisionId: stage.revisionId,
        actionRunIds: ["director-capture-run:immutable-frame"],
        renderer: {
          id: "clash-director-viewport-webgl",
          contractVersion: 1,
        },
        stateSha256: input.receiptStateSha256 ?? sha256(stateText),
        frames: [
          {
            artifactId: "capture",
            ...(input.omitProjectAssetId ? {} : { projectAssetId }),
            metadataAttached: false,
            sha256: frameSha256,
            timeSeconds: 0,
            aspectRatio: "16:9",
            width: 320,
            height: 180,
            mimeType: "image/png",
            path: join(workspace, "capture.png"),
          },
        ],
      })}\n`,
      "utf8",
    ),
  ]);

  let apiUrl = "";
  const server = createServer(async (request, response) => {
    const path = request.url ?? "";
    if (
      request.method === "POST" &&
      path === `/api/v1/projects/${projectId}/host-command`
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        action?: string;
      };
      const readToken = projectDirectorStageReadToken(stage);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          command.action === "ping"
            ? { pong: true }
            : command.action === "list_director_stages"
              ? {
                  stages: [stage],
                  versions: {
                    [stage.id]: `${readToken}:receipt:trusted-host`,
                  },
                }
              : { error: "unsupported" },
        ),
      );
      return;
    }
    if (
      request.method === "POST" &&
      path === "/api/v1/local/director-stage/capture"
    ) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          renderer: {
            id: "clash-director-viewport-webgl",
            contractVersion: 1,
          },
          stateSha256: sha256(stateText),
          frames: [
            {
              label: "capture",
              timeSeconds: 0,
              aspectRatio: "16:9",
              width: 320,
              height: 180,
              sha256: input.rerenderedSha256,
            },
          ],
        }),
      );
      return;
    }
    if (
      request.method === "GET" &&
      path.startsWith(`/api/v1/projects/${projectId}/generator-runs/`)
    ) {
      // Public native Generator response, matching app.ts routes and the shipped
      // plugins/director/generators/director-stage.json contract.
      const actionRunId = "director-capture-run:immutable-frame";
      const run = {
        actionRunId,
        generatorRevision: {
          generatorId: stage.id,
          generatorRevisionId:
            input.origin === "wrong-revision" ? "stale" : stage.revisionId,
        },
        actionId: "capture-frame",
        executor: {
          pluginId:
            input.origin === "wrong-executor"
              ? "clash.other"
              : "clash.director",
          version: "0.1.0",
          exportId: "capture-frame",
          schemaHash: `sha256:${sha256("executor")}`,
        },
        invocationFingerprint: `sha256:${sha256("invocation")}`,
        parameters: {
          label: "capture",
          timeSeconds: input.origin === "wrong-time" ? 5 : 0,
          aspectRatio: "16:9",
          longEdge: 320,
        },
        invocationInputRefs: [],
        outputContract: [
          {
            slot: "frame",
            assetType: { kind: "media", mediaKind: "image" },
            cardinality: { minItems: 1, maxItems: 1 },
          },
        ],
        status: input.origin === "failed-run" ? "failed" : "succeeded",
      };
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/outputs/frame")) {
        response.statusCode = input.origin === "missing" ? 404 : 200;
        response.end(
          JSON.stringify(
            input.origin === "missing"
              ? { error: "Generator output is not committed" }
              : {
                  commit: {
                    actionRunId,
                    outputSlot: "frame",
                    asset: {
                      kind: "media",
                      projectAssetId:
                        input.origin === "wrong-asset"
                          ? "another-asset"
                          : projectAssetId,
                    },
                  },
                },
          ),
        );
      } else response.end(JSON.stringify({ run }));
      return;
    }
    if (
      request.method === "GET" &&
      path ===
        `/api/v1/projects/${projectId}/assets/${encodeURIComponent(projectAssetId)}`
    ) {
      if (input.assetState === "missing") {
        response.statusCode = 404;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "Project Asset not found" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.setHeader(
        "x-clash-read-receipt",
        "receipt:director-capture-project-asset",
      );
      response.end(
        JSON.stringify({
          id: projectAssetId,
          kind: "image",
          metadata: {
            ...(input.assetState === "missing-bytes"
              ? {}
              : { bytes: input.hostBytes.byteLength }),
            contentType: "image/png",
          },
          lifecycle:
            input.assetState === "trashed"
              ? {
                  state: "trashed",
                  deleteOperationId: "delete:test",
                  deletedAt: "2026-08-15T00:00:00.000Z",
                  purgeAfter: "2026-09-14T00:00:00.000Z",
                }
              : { state: "active" },
          status: "ready",
          url: `${apiUrl}/media/capture.png`,
        }),
      );
      return;
    }
    if (request.method === "GET" && path === "/media/capture.png") {
      response.setHeader("content-type", "image/png");
      response.end(input.hostBytes);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Director test Host did not expose a port"));
        return;
      }
      apiUrl = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  try {
    return await captureRequiredProductReadback({
      benchmark,
      workspace,
      caseRoot: root,
      ready: {
        projectId,
        apiUrl,
        workspaceId: "managed:test",
        initDisposition: "created",
        markerSha256: "test-marker-sha256",
        readyAt: "2026-08-15T00:00:00.000Z",
      },
    });
  } finally {
    await Promise.all([
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      rm(root, { recursive: true, force: true }),
    ]);
  }
}

it("accepts immutable Host Asset bytes when rendering the same Stage again is nondeterministic", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256("different-webgl-render"),
  });

  expect(result).toMatchObject({
    receiptPath: "director-readback.json",
    report: {
      status: "pass",
      matchedArtifactIds: ["stage", "capture"],
      captures: [
        {
          frames: [
            {
              artifactId: "capture",
              projectAssetId,
              outputCommit: {
                actionRunId: "director-capture-run:immutable-frame",
                asset: { kind: "media", projectAssetId },
              },
            },
          ],
        },
      ],
    },
  });
});

it("matches a Stage artifact saved from the public director.get response", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256("different-webgl-render"),
    publicDirectorGetArtifact: true,
  });

  expect(result).toMatchObject({
    receiptPath: "director-readback.json",
    report: {
      status: "pass",
      matchedArtifactIds: ["stage", "capture"],
    },
  });
});

it("rejects a capture when the named Project Asset has different immutable bytes", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");
  const differentHostBytes = Buffer.from("captured-byte-B");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: differentHostBytes,
    rerenderedSha256: sha256(capturedBytes),
  });

  expect(result).toMatchObject({
    receiptPath: "director-readback.json",
    report: { status: "fail", matchedArtifactIds: ["stage"], captures: [] },
  });
  expect(result?.report.detail).toMatch(
    /Project Asset director-capture:immutable-frame fetched SHA-256 .* does not match capture artifact SHA-256/iu,
  );
});

it("fails closed when a capture receipt omits its Project Asset identity", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256(capturedBytes),
    omitProjectAssetId: true,
  });

  expect(result?.report).toMatchObject({
    status: "fail",
    matchedArtifactIds: ["stage"],
    captures: [],
  });
  expect(result?.report.detail).toMatch(/missing its Project Asset identity/iu);
});

it("rejects a capture Asset without its revision-scoped output reference", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256(capturedBytes),
    origin: "missing",
  });

  expect(result?.report).toMatchObject({
    status: "fail",
    matchedArtifactIds: ["stage"],
    captures: [],
  });
  expect(result?.report.detail).toMatch(/output.*not committed/iu);
});

it("rejects a capture Asset whose output reference targets another Stage revision", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256(capturedBytes),
    origin: "wrong-revision",
  });

  expect(result?.report).toMatchObject({
    status: "fail",
    matchedArtifactIds: ["stage"],
    captures: [],
  });
  expect(result?.report.detail).toMatch(/capture.*Run.*Stage revision/iu);
});

it("rejects an Output Commit pointing to a different capture Asset", async () => {
  const capturedBytes = Buffer.from("captured-byte-A");

  const result = await captureDirectorFixture({
    submittedBytes: capturedBytes,
    hostBytes: capturedBytes,
    rerenderedSha256: sha256(capturedBytes),
    origin: "wrong-asset",
  });

  expect(result?.report).toMatchObject({
    status: "fail",
    matchedArtifactIds: ["stage"],
    captures: [],
  });
  expect(result?.report.detail).toMatch(/Output Commit.*capture Asset/iu);
});

it.each(["wrong-executor", "wrong-time", "failed-run"] as const)(
  "rejects a capture with %s even when the Asset bytes match",
  async (origin) => {
    const bytes = Buffer.from("captured-byte-A");
    const result = await captureDirectorFixture({
      submittedBytes: bytes,
      hostBytes: bytes,
      rerenderedSha256: sha256(bytes),
      origin,
    });
    expect(result?.report.status).toBe("fail");
    expect(result?.report.detail).toMatch(/capture.*Run.*Stage revision/iu);
  },
);
