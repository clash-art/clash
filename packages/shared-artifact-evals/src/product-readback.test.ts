import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROJECT_ASSET_RENDER_CANVAS_ID,
  canvasNodeReadToken,
  projectDirectorStageReadToken,
  projectTimelineReadToken,
} from "@clash/shared-types";
import { describe, expect, it } from "vitest";

import {
  captureAssetProductReadback,
  captureRemotionProductReadback,
  captureTimelineProductReadback,
  mixedProductLineageProjectAssetIds,
} from "./product-readback";
import { captureRequiredProductReadback } from "./runner";
import type { ArtifactBenchmarkCase } from "./types";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeSealedMcpTrace(input: {
  caseRoot: string;
  caseId: string;
  tool: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}): Promise<void> {
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const invocationId = "20000000-0000-4000-8000-000000000002";
  const startedAt = "2026-08-14T00:00:00.000Z";
  const argumentsSha256 = sha256(JSON.stringify(input.arguments));
  const resultSha256 = sha256(JSON.stringify(input.result));
  const events = [
    {
      type: "clash.mcp.started",
      sessionId,
      invocationId,
      rpcId: 2,
      startedAt,
      tool: input.tool,
      arguments: input.arguments,
      argumentsSha256,
    },
    {
      type: "clash.mcp.completed",
      sessionId,
      invocationId,
      rpcId: 2,
      startedAt,
      finishedAt: "2026-08-14T00:00:00.010Z",
      durationMs: 10,
      tool: input.tool,
      argumentsSha256,
      result: input.result,
      resultSha256,
      succeeded: true,
    },
  ];
  const traceText = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const logsRoot = join(input.caseRoot, "logs");
  await Promise.all([
    writeFile(join(logsRoot, "clash-mcp-events.jsonl"), traceText, "utf8"),
    writeJson(join(logsRoot, "clash-mcp-trace-receipt.json"), {
      schemaVersion: 1,
      source: "runner-mcp-relay",
      status: "sealed",
      caseId: input.caseId,
      tracePath: "clash-mcp-events.jsonl",
      traceSha256: sha256(traceText),
      eventCount: events.length,
    }),
  ]);
}

const componentSource = `import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
export default function ReadbackCharacter() {
  const frame = useCurrentFrame();
  const wave = interpolate(frame, [0, 12, 23], [0, 1, 0]);
  return <AbsoluteFill data-character-part="torso" data-wave={wave} />;
}
`;

const timeline = {
  id: "remotion-main",
  name: "Remotion Main",
  owner: { kind: "project" as const },
  revisionId: "timeline-revision-remotion-main",
  state: {
    compositionWidth: 320,
    compositionHeight: 180,
    fps: 12,
    durationInFrames: 24,
    tracks: [
      {
        id: "overlays",
        items: [
          {
            id: "overlay-readback-character",
            type: "composition",
            compositionKind: "custom",
            runtime: "remotion",
            compositionId: "ReadbackCharacter",
            sourcePath: "components/readback-character.tsx",
            sourceNodeId: "remotion-component-fixed",
            from: 0,
            durationInFrames: 24,
          },
        ],
      },
    ],
  },
};

const sourceNode = {
  id: "remotion-component-fixed",
  type: "remotion-component",
  data: { componentId: "ReadbackCharacter", content: componentSource },
};

const renderNode = {
  id: "render-node-fixed",
  canvas_id: PROJECT_ASSET_RENDER_CANVAS_ID,
  type: "video",
  data: {
    status: "completed",
    sourceTimelineId: timeline.id,
    sourceTimelineRevisionId: timeline.revisionId,
    assetId: "render-asset-fixed",
  },
};

const mixedDirectorState = {
  schemaVersion: 1 as const,
  scene: {
    backgroundColor: "#090b10",
    grid: { visible: true, snap: false, size: 1 },
  },
  objects: [],
  cameras: [
    {
      id: "camera-product",
      name: "Product camera",
      position: [0, 1, 4] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      fov: 45,
    },
  ],
  shots: [],
  shotSequence: [
    {
      id: "sequence-product",
      name: "Product shot",
      cameraId: "camera-product",
      startTime: 0,
      durationSeconds: 2,
      aspectRatio: "16:9" as const,
      transition: "cut" as const,
    },
  ],
  animation: { durationSeconds: 2, fps: 12, tracks: [] },
};

const mixedDirectorStage = {
  id: "director-stage-mixed",
  name: "Mixed product stage",
  owner: { kind: "project" as const },
  revisionId: "director-revision-mixed",
  state: mixedDirectorState,
};

const mixedTimeline = {
  ...timeline,
  state: {
    ...timeline.state,
    tracks: [
      {
        id: "product-video",
        items: [
          {
            id: "director-product-shot",
            type: "video",
            assetId: "asset-unrelated",
            from: 0,
            durationInFrames: 24,
          },
        ],
      },
      ...timeline.state.tracks,
    ],
  },
};

const benchmark: ArtifactBenchmarkCase = {
  id: "remotion-readback-case",
  title: "Remotion readback",
  category: "mg-character",
  outcome: {
    objective:
      "Persist a Remotion character and render it through a Project Timeline.",
    acceptanceCriteria: [
      "The live component, Timeline, and render are product-backed.",
    ],
    deliverables: [
      {
        artifactId: "mg-character",
        kind: "remotion-component",
        description: "Remotion TSX source",
      },
      {
        artifactId: "timeline",
        kind: "timeline",
        description: "Editable Timeline",
      },
      { artifactId: "mg-video", kind: "video", description: "Timeline render" },
    ],
  },
  passScore: 100,
  timeoutMs: 10_000,
  skills: [],
  execution: {
    profile: "clash-host",
    requiredMcpTools: ["clash"],
    productReadback: {
      required: true,
      mechanism: "remotion-component-timeline-render-receipt",
      artifactIds: ["mg-character", "timeline", "mg-video"],
      description: "Trusted Remotion Canvas and Timeline readback.",
    },
  },
  rubric: [],
};

const timelineBenchmark: ArtifactBenchmarkCase = {
  ...benchmark,
  id: "timeline-readback-case",
  title: "Timeline readback",
  category: "timeline",
  outcome: {
    objective: "Persist and render a Project Timeline.",
    acceptanceCriteria: ["The live Timeline and render are product-backed."],
    deliverables: [
      {
        artifactId: "timeline",
        kind: "timeline",
        description: "Editable Timeline",
      },
      {
        artifactId: "final-video",
        kind: "video",
        description: "Timeline render",
      },
    ],
  },
  execution: {
    profile: "clash-host",
    requiredMcpTools: ["clash_timeline_render"],
    productReadback: {
      required: true,
      mechanism: "timeline-state-and-render-receipt",
      artifactIds: ["timeline", "final-video"],
      description: "Trusted Timeline and render readback.",
    },
  },
};

const mixedBenchmark: ArtifactBenchmarkCase = {
  ...benchmark,
  id: "mixed-product-readback-case",
  title: "Mixed product readback",
  category: "mixed",
  outcome: {
    objective:
      "Carry one Director capture Project Asset from its Stage revision into a canonical Timeline.",
    acceptanceCriteria: [
      "The capture receipt references the exact Stage revision and the canonical Timeline references its Project Asset output.",
    ],
    deliverables: [
      { artifactId: "stage", kind: "director-stage", description: "Stage" },
      {
        artifactId: "director-capture-frame",
        kind: "image",
        description: "Director capture",
      },
      {
        artifactId: "component-source",
        kind: "remotion-component",
        description: "Component source",
      },
      { artifactId: "timeline", kind: "timeline", description: "Timeline" },
      { artifactId: "final-video", kind: "video", description: "Render" },
    ],
  },
  execution: {
    profile: "clash-host",
    productReadback: {
      required: true,
      mechanism: "mixed-remotion-lineage-and-render-receipt",
      artifactIds: [
        "stage",
        "director-capture-frame",
        "component-source",
        "timeline",
        "final-video",
      ],
      description: "Trusted cross-product lineage readback.",
    },
  },
  rubric: [
    {
      id: "director-source",
      type: "director-stage",
      artifactId: "stage",
      weight: 1,
      required: true,
    },
  ],
};

const assetBenchmark: ArtifactBenchmarkCase = {
  ...benchmark,
  id: "asset-readback-case",
  title: "Asset readback",
  outcome: {
    objective: "Import media as immutable Project Assets.",
    acceptanceCriteria: [
      "Every submitted media file is independently readable from the Project Asset Host.",
    ],
    deliverables: [
      { artifactId: "hero-image", kind: "image", description: "Hero image" },
      { artifactId: "voice-audio", kind: "audio", description: "Voice audio" },
    ],
  },
  execution: {
    profile: "clash-host",
    requiredProductOperations: ["asset.import", "asset.list", "asset.get"],
    productReadback: {
      required: true,
      mechanism: "asset-bytes-and-host-receipt",
      artifactIds: ["hero-image", "voice-audio"],
      description: "Trusted Project Asset byte and Host receipt readback.",
    },
  },
};

async function withProductHost<T>(
  timelines: unknown[],
  run: (input: {
    projectId: string;
    apiUrl: string;
    requestedActions: string[];
  }) => Promise<T>,
  options: {
    renderReadbackError?: string;
    director?: {
      stage: typeof mixedDirectorStage;
      frame: {
        artifactId: string;
        sha256: string;
        timeSeconds: number;
        aspectRatio: "16:9";
        width: number;
        height: number;
      };
      projectAssets?: Array<{
        id: string;
        bytes: Buffer;
      }>;
    };
  } = {},
): Promise<T> {
  const projectId = "project-remotion-readback";
  const versions = Object.fromEntries(
    timelines.map((value) => {
      const parsed = value as Parameters<typeof projectTimelineReadToken>[0];
      const readToken = projectTimelineReadToken(parsed);
      return [parsed.id, `${readToken}:receipt:trusted-host`];
    }),
  );
  const requestedActions: string[] = [];
  let apiUrl = "";
  const httpServer = createHttpServer(async (request, response) => {
    if (
      request.method === "POST" &&
      request.url ===
        `/api/v1/projects/${encodeURIComponent(projectId)}/host-command`
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        action?: string;
        nodeId?: string;
        canvasId?: string;
        status?: string;
      };
      requestedActions.push(String(command.action ?? ""));
      let body: unknown = { error: "unsupported" };
      if (command.action === "ping") body = { pong: true };
      if (command.action === "list_timelines") body = { timelines, versions };
      if (command.action === "list_director_stages" && options.director) {
        const version = projectDirectorStageReadToken(options.director.stage);
        body = {
          stages: [options.director.stage],
          versions: {
            [options.director.stage.id]: `${version}:receipt:trusted-host`,
          },
        };
      }
      if (command.action === "list_canvases")
        body = { canvases: [{ id: "main", name: "Main" }] };
      if (command.action === "get" && command.nodeId === sourceNode.id) {
        body = {
          node: sourceNode,
          version: "node-v1:source",
          readToken: "node-v1:source:receipt:trusted-host",
        };
      }
      if (command.action === "list_timeline_renders") {
        if (options.renderReadbackError) {
          body = { error: options.renderReadbackError };
        } else {
          const version = canvasNodeReadToken(renderNode);
          body = {
            canvasId: PROJECT_ASSET_RENDER_CANVAS_ID,
            status: command.status ?? "completed",
            renders: [
              {
                node: renderNode,
                lineage: {
                  sourceTimelineId: timeline.id,
                  sourceTimelineRevisionId: timeline.revisionId,
                  renderTarget: { kind: "project-asset" },
                },
                version,
                readToken: `${version}:receipt:trusted-host`,
              },
            ],
          };
        }
      }
      if (
        command.action === "list" &&
        command.canvasId === PROJECT_ASSET_RENDER_CANVAS_ID
      ) {
        body = {
          error: `Canvas ${PROJECT_ASSET_RENDER_CANVAS_ID} is internal and unregistered`,
        };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/api/v1/local/director-stage/capture" &&
      options.director
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const capture = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        frames?: Array<{
          label?: string;
          timeSeconds?: number;
          aspectRatio?: string;
        }>;
      };
      const frame = options.director.frame;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          renderer: {
            id: "clash-director-viewport-webgl",
            contractVersion: 1,
          },
          stateSha256: sha256(JSON.stringify(options.director.stage.state)),
          frames: (capture.frames ?? []).map((requested) => ({
            label: requested.label,
            timeSeconds: requested.timeSeconds,
            aspectRatio: requested.aspectRatio,
            width: frame.width,
            height: frame.height,
            sha256: frame.sha256,
          })),
        }),
      );
      return;
    }
    const directorProjectAsset = options.director?.projectAssets?.find(
      (asset) =>
        request.url ===
        `/api/v1/projects/${projectId}/assets/${encodeURIComponent(asset.id)}`,
    );
    const capturedAssetIndex = options.director?.projectAssets?.findIndex(
      (asset) =>
        request.url?.startsWith(
          `/api/v1/projects/${projectId}/generator-runs/${encodeURIComponent("capture:" + asset.id)}`,
        ),
    );
    if (
      request.method === "GET" &&
      capturedAssetIndex !== undefined &&
      capturedAssetIndex >= 0
    ) {
      const asset = options.director!.projectAssets![capturedAssetIndex]!;
      const frame = options.director!.frame;
      const stage = options.director!.stage;
      const actionRunId = "capture:" + asset.id;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url!.endsWith("/outputs/frame")
            ? {
                commit: {
                  actionRunId,
                  outputSlot: "frame",
                  asset: { kind: "media", projectAssetId: asset.id },
                },
              }
            : {
                run: {
                  actionRunId,
                  generatorRevision: {
                    generatorId: stage.id,
                    generatorRevisionId: stage.revisionId,
                  },
                  actionId: "capture-frame",
                  executor: {
                    pluginId: "clash.director",
                    version: "0.1.0",
                    exportId: "capture-frame",
                    schemaHash: "sha256:" + sha256("executor"),
                  },
                  invocationFingerprint: "sha256:" + sha256("invocation"),
                  parameters: {
                label:
                  capturedAssetIndex === 0
                    ? frame.artifactId
                    : `${frame.artifactId}-${capturedAssetIndex + 1}`,
                timeSeconds: capturedAssetIndex,
                    aspectRatio: frame.aspectRatio,
                    longEdge: Math.max(frame.width, frame.height),
                  },
                  invocationInputRefs: [],
                  outputContract: [
                    {
                      slot: "frame",
                      assetType: { kind: "media", mediaKind: "image" },
                      cardinality: { minItems: 1, maxItems: 1 },
                    },
                  ],
                  status: "succeeded",
                },
              },
        ),
      );
      return;
    }
    if (request.method === "GET" && directorProjectAsset) {
      response.setHeader("content-type", "application/json");
      response.setHeader(
        "x-clash-read-receipt",
        "receipt:director-capture-project-asset",
      );
      response.end(
        JSON.stringify({
          id: directorProjectAsset.id,
          kind: "image",
          metadata: {
            bytes: directorProjectAsset.bytes.byteLength,
            contentType: "image/png",
          },
          lifecycle: { state: "active" },
          status: "ready",
          url: `${apiUrl}/assets/${encodeURIComponent(directorProjectAsset.id)}`,
        }),
      );
      return;
    }
    const directorMediaAsset = options.director?.projectAssets?.find(
      (asset) => request.url === `/assets/${encodeURIComponent(asset.id)}`,
    );
    if (request.method === "GET" && directorMediaAsset) {
      response.setHeader("content-type", "image/png");
      response.end(directorMediaAsset.bytes);
      return;
    }
    if (
      request.url ===
      `/api/v1/projects/${projectId}/assets/${renderNode.data.assetId}`
    ) {
      response.setHeader("content-type", "application/json");
      response.setHeader("x-clash-read-receipt", "receipt-render-asset");
      response.end(
        JSON.stringify({
          id: renderNode.data.assetId,
          kind: "video",
          metadata: { contentType: "video/mp4" },
          lifecycle: { state: "active" },
          status: "ready",
          url: `${apiUrl}/assets/render.mp4`,
        }),
      );
      return;
    }
    if (request.url === "/assets/render.mp4") {
      response.setHeader("content-type", "video/mp4");
      response.end("video");
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("HTTP test server did not expose a TCP port"));
        return;
      }
      apiUrl = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  try {
    return await run({ projectId, apiUrl, requestedActions });
  } finally {
    await new Promise<void>((resolveClose) =>
      httpServer.close(() => resolveClose()),
    );
  }
}

async function withAssetHost<T>(
  run: (input: {
    projectId: string;
    apiUrl: string;
    requestedPaths: string[];
  }) => Promise<T>,
  options: { trashedAssetIds?: string[]; duplicateImage?: boolean } = {},
): Promise<T> {
  const projectId = "project-asset-readback";
  const requestedPaths: string[] = [];
  let apiUrl = "";
  const media = new Map([
    [
      "asset-image",
      { kind: "image" as const, bytes: Buffer.from("trusted-image") },
    ],
    [
      "asset-audio",
      { kind: "audio" as const, bytes: Buffer.from("trusted-audio") },
    ],
    [
      "asset-decoy",
      { kind: "video" as const, bytes: Buffer.from("unsubmitted-video") },
    ],
    ...(options.duplicateImage
      ? [
          [
            "asset-image-copy",
            { kind: "image" as const, bytes: Buffer.from("trusted-image") },
          ] as const,
        ]
      : []),
  ]);
  const resolved = (assetId: string) => {
    const value = media.get(assetId);
    if (!value) return undefined;
    return {
      id: assetId,
      kind: value.kind,
      metadata: { bytes: value.bytes.byteLength },
      lifecycle: options.trashedAssetIds?.includes(assetId)
        ? {
            state: "trashed" as const,
            deleteOperationId: "delete:test",
            deletedAt: "2026-08-14T00:00:00.000Z",
            purgeAfter: "2026-09-13T00:00:00.000Z",
          }
        : { state: "active" as const },
      status: "ready" as const,
      url: `${apiUrl}/media/${assetId}`,
    };
  };
  const httpServer = createHttpServer(async (request, response) => {
    const path = request.url ?? "";
    requestedPaths.push(path);
    if (
      request.method === "POST" &&
      path === `/api/v1/projects/${projectId}/host-command`
    ) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ pong: true }));
      return;
    }
    const assetsPath = `/api/v1/projects/${projectId}/assets`;
    if (request.method === "GET" && path === assetsPath) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          assets: [...media.keys()].map((assetId) => resolved(assetId)),
        }),
      );
      return;
    }
    if (request.method === "GET" && path.startsWith(`${assetsPath}/`)) {
      const assetId = decodeURIComponent(path.slice(assetsPath.length + 1));
      const asset = resolved(assetId);
      if (asset) {
        response.setHeader("content-type", "application/json");
        response.setHeader("x-clash-read-receipt", `receipt:${assetId}`);
        response.end(JSON.stringify(asset));
        return;
      }
    }
    if (request.method === "GET" && path.startsWith("/media/")) {
      const assetId = decodeURIComponent(path.slice("/media/".length));
      const value = media.get(assetId);
      if (value) {
        response.end(value.bytes);
        return;
      }
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once("error", rejectListen);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("HTTP test server did not expose a TCP port"));
        return;
      }
      apiUrl = `http://127.0.0.1:${address.port}`;
      resolveListen();
    });
  });
  try {
    return await run({ projectId, apiUrl, requestedPaths });
  } finally {
    await new Promise<void>((resolveClose) =>
      httpServer.close(() => resolveClose()),
    );
  }
}

function mixedTimelineForAsset(projectAssetId: string) {
  return {
    ...mixedTimeline,
    state: {
      ...mixedTimeline.state,
      tracks: mixedTimeline.state.tracks.map((track, index) =>
        index === 0
          ? {
              ...track,
              items: track.items.map((item) => ({
                ...item,
                assetId: projectAssetId,
              })),
            }
          : track,
      ),
    },
  };
}

async function captureMixedFixtureReadback(input: {
  captureProjectAssetId?: string;
  additionalCaptureProjectAssetIds?: string[];
  timelineProjectAssetId: string;
}) {
  const captureBytes = "trusted-director-capture";
  const frame = {
    artifactId: "director-capture-frame",
    sha256: sha256(captureBytes),
    timeSeconds: 0,
    aspectRatio: "16:9" as const,
    width: 320,
    height: 180,
  };
  const captureProjectAssetIds = [
    ...(input.captureProjectAssetId ? [input.captureProjectAssetId] : []),
    ...(input.additionalCaptureProjectAssetIds ?? []),
  ];
  const directorStage = mixedDirectorStage;
  const canonicalTimeline = mixedTimelineForAsset(input.timelineProjectAssetId);
  return withProductHost(
    [canonicalTimeline],
    async ({ projectId, apiUrl }) => {
      const caseRoot = await mkdtemp(join("/tmp", "mixed-readback-lineage-"));
      const workspace = join(caseRoot, "workspace");
      const captureRoot = join(workspace, "director-capture");
      await mkdir(join(workspace, ".clash"), { recursive: true });
      await mkdir(captureRoot, { recursive: true });
      await writeFile(
        join(workspace, ".clash", "project.toml"),
        `schema_version = 1\nproject_id = "${projectId}"\n`,
        "utf8",
      );
      await Promise.all([
        writeFile(join(workspace, "component.tsx"), componentSource, "utf8"),
        writeFile(
          join(workspace, "timeline.yaml"),
          `${JSON.stringify(canonicalTimeline.state, null, 2)}\n`,
          "utf8",
        ),
        writeFile(
          join(workspace, "stage.json"),
          `${JSON.stringify(directorStage.state, null, 2)}\n`,
          "utf8",
        ),
        writeFile(
          join(workspace, "director-capture.png"),
          captureBytes,
          "utf8",
        ),
        writeFile(join(workspace, "render.mp4"), "video", "utf8"),
        writeJson(join(captureRoot, "capture.json"), {
          captured: true,
          stageId: directorStage.id,
          sourceStageRevisionId: directorStage.revisionId,
          verifiedStageRevisionId: directorStage.revisionId,
          actionRunIds: captureProjectAssetIds.map((id) => "capture:" + id),
          renderer: {
            id: "clash-director-viewport-webgl",
            contractVersion: 1,
          },
          stateSha256: sha256(JSON.stringify(directorStage.state)),
          frames:
            captureProjectAssetIds.length > 0
              ? captureProjectAssetIds.map((projectAssetId, index) => ({
                  ...frame,
                  artifactId:
                    index === 0
                      ? frame.artifactId
                      : `${frame.artifactId}-${index + 1}`,
                  projectAssetId,
                  timeSeconds: index,
                  metadataAttached: false,
                  mimeType: "image/png",
                  path: join(workspace, "director-capture.png"),
                }))
              : [
                  {
                    ...frame,
                    metadataAttached: false,
                    mimeType: "image/png",
                    path: join(workspace, "director-capture.png"),
                  },
                ],
        }),
      ]);
      await writeJson(join(workspace, "submission.json"), {
        schemaVersion: 1,
        taskId: mixedBenchmark.id,
        artifacts: [
          { id: "stage", kind: "director-stage", path: "stage.json" },
          {
            id: "director-capture-frame",
            kind: "image",
            path: "director-capture.png",
          },
          {
            id: "component-source",
            kind: "remotion-component",
            path: "component.tsx",
          },
          { id: "timeline", kind: "timeline", path: "timeline.yaml" },
          { id: "final-video", kind: "video", path: "render.mp4" },
        ],
      });
      try {
        return await captureRequiredProductReadback({
          benchmark: mixedBenchmark,
          workspace,
          caseRoot,
          ready: {
            projectId,
            apiUrl,
            workspaceId: "managed:test",
            initDisposition: "created",
            markerSha256: "test-marker-sha256",
            readyAt: "2026-08-14T00:00:00.000Z",
          },
        });
      } finally {
        await rm(caseRoot, { recursive: true, force: true });
      }
    },
    {
      director: {
        stage: directorStage,
        frame,
        ...(captureProjectAssetIds.length > 0
          ? {
              projectAssets: captureProjectAssetIds.map((id) => ({
                id,
                bytes: Buffer.from(captureBytes),
              })),
            }
          : {}),
      },
    },
  );
}

describe("trusted mixed product readback", () => {
  it("does not link a capture receipt from a different Stage revision", () => {
    expect(
      mixedProductLineageProjectAssetIds({
        director: {
          stages: [{ id: "stage-final", revisionId: "revision-final" }],
          matches: [{ stageId: "stage-final" }],
          captures: [
            {
              stageId: "stage-final",
              stageRevisionId: "revision-stale",
              frames: [{ projectAssetId: "asset-shared" }],
            },
          ],
        },
        remotion: {
          matches: [{ timelineProjectAssetIds: ["asset-shared"] }],
        },
      }),
    ).toEqual([]);
  });

  it("rejects a Timeline asset unrelated to the verified capture output", async () => {
    const captured = await captureMixedFixtureReadback({
      captureProjectAssetId: "asset-captured-exact",
      timelineProjectAssetId: "asset-unrelated",
    });

    expect(captured).toMatchObject({
      receiptPath: "product-readback.json",
      report: { status: "fail" },
    });
    expect(captured?.report.detail).toMatch(
      /capture Project Asset.*canonical Timeline/iu,
    );
  });

  it("passes when the Timeline references a verified capture output without rewriting the Stage", async () => {
    const captured = await captureMixedFixtureReadback({
      captureProjectAssetId: "asset-captured-exact",
      timelineProjectAssetId: "asset-captured-exact",
    });

    expect(captured).toMatchObject({
      receiptPath: "product-readback.json",
      report: {
        status: "pass",
        mixedLineage: { projectAssetIds: ["asset-captured-exact"] },
      },
    });
  });

  it("passes when the Timeline references another Project Asset from the same verified Stage capture", async () => {
    const captured = await captureMixedFixtureReadback({
      captureProjectAssetId: "asset-capture-submitted",
      additionalCaptureProjectAssetIds: [
        "asset-capture-timeline",
        "asset-capture-unused",
      ],
      timelineProjectAssetId: "asset-capture-timeline",
    });

    expect(captured).toMatchObject({
      receiptPath: "product-readback.json",
      report: {
        status: "pass",
        mixedLineage: { projectAssetIds: ["asset-capture-timeline"] },
      },
    });
  });

  it("fails closed when the trusted capture receipt predates Project Asset identity", async () => {
    const captured = await captureMixedFixtureReadback({
      timelineProjectAssetId: "asset-captured-exact",
    });

    expect(captured?.report).toMatchObject({
      status: "fail",
      mixedLineage: { projectAssetIds: [] },
    });
  });
});

describe("trusted Remotion product readback", () => {
  it("matches a product-exported Timeline envelope to its live state and render", async () => {
    await withProductHost(
      [timeline],
      async ({ projectId, apiUrl, requestedActions }) => {
        const caseRoot = await mkdtemp(join("/tmp", "remotion-readback-case-"));
        const workspace = join(caseRoot, "workspace");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await mkdir(join(workspace, "components"), { recursive: true });
        await writeFile(
          join(workspace, "components", "character.tsx"),
          componentSource,
          "utf8",
        );
        await writeFile(
          join(workspace, "timeline.yaml"),
          `${JSON.stringify(timeline, null, 2)}\n`,
          "utf8",
        );
        await writeFile(join(workspace, "render.mp4"), "video", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: benchmark.id,
          artifacts: [
            {
              id: "mg-character",
              kind: "remotion-component",
              path: "components/character.tsx",
            },
            { id: "timeline", kind: "timeline", path: "timeline.yaml" },
            { id: "mg-video", kind: "video", path: "render.mp4" },
          ],
        });

        const report = await captureRemotionProductReadback({
          benchmark,
          workspace,
          caseRoot,
          ready: {
            projectId,
            apiUrl,
          },
        });

        expect(report).toMatchObject({
          status: "pass",
          projectId,
          matchedArtifactIds: ["mg-character", "timeline", "mg-video"],
          sourceNodes: [{ id: sourceNode.id, type: "remotion-component" }],
          matches: [
            {
              timelineId: timeline.id,
              sourceNodeId: sourceNode.id,
              componentArtifactId: "mg-character",
              timelineArtifactId: "timeline",
              videoArtifactId: "mg-video",
              renderNodeId: renderNode.id,
              renderAssetId: "render-asset-fixed",
            },
          ],
        });
        expect(report.timelines[0]?.hostReceipt).toMatch(
          /:receipt:trusted-host$/u,
        );
        expect(
          requestedActions.filter(
            (action) => action === "list_timeline_renders",
          ),
        ).toEqual(["list_timeline_renders"]);
        expect(requestedActions).not.toContain("list");
        expect(
          JSON.parse(
            await readFile(join(caseRoot, "remotion-readback.json"), "utf8"),
          ),
        ).toEqual(report);
        await rm(caseRoot, { recursive: true, force: true });
      },
    );
  });

  it("matches a plain Timeline revision to its completed product render", async () => {
    await withProductHost(
      [timeline],
      async ({ projectId, apiUrl, requestedActions }) => {
        const caseRoot = await mkdtemp(join("/tmp", "timeline-readback-case-"));
        const workspace = join(caseRoot, "workspace");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await writeFile(
          join(workspace, "timeline.yaml"),
          `${JSON.stringify(timeline.state, null, 2)}\n`,
          "utf8",
        );
        await writeFile(join(workspace, "render.mp4"), "video", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: timelineBenchmark.id,
          artifacts: [
            { id: "timeline", kind: "timeline", path: "timeline.yaml" },
            { id: "final-video", kind: "video", path: "render.mp4" },
          ],
        });

        const report = await captureTimelineProductReadback({
          benchmark: timelineBenchmark,
          workspace,
          caseRoot,
          ready: {
            projectId,
            apiUrl,
          },
        });

        expect(report).toMatchObject({
          status: "pass",
          projectId,
          matchedArtifactIds: ["timeline", "final-video"],
          matches: [
            {
              timelineId: timeline.id,
              timelineArtifactId: "timeline",
              videoArtifactId: "final-video",
              renderNodeId: renderNode.id,
              renderAssetId: "render-asset-fixed",
            },
          ],
        });
        expect(
          requestedActions.filter(
            (action) => action === "list_timeline_renders",
          ),
        ).toEqual(["list_timeline_renders"]);
        expect(requestedActions).not.toContain("list");
        expect(
          JSON.parse(
            await readFile(join(caseRoot, "timeline-readback.json"), "utf8"),
          ),
        ).toEqual(report);
        await rm(caseRoot, { recursive: true, force: true });
      },
    );
  });

  it("rejects files that were never persisted through the live product graph", async () => {
    await withProductHost([], async ({ projectId, apiUrl }) => {
      const caseRoot = await mkdtemp(
        join("/tmp", "remotion-readback-missing-"),
      );
      const workspace = join(caseRoot, "workspace");
      await mkdir(join(workspace, ".clash"), { recursive: true });
      await writeFile(
        join(workspace, ".clash", "project.toml"),
        `schema_version = 1\nproject_id = "${projectId}"\n`,
        "utf8",
      );
      await writeFile(
        join(workspace, "component.tsx"),
        componentSource,
        "utf8",
      );
      await writeFile(
        join(workspace, "timeline.yaml"),
        `${JSON.stringify(timeline.state)}\n`,
        "utf8",
      );
      await writeFile(join(workspace, "render.mp4"), "video", "utf8");
      await writeJson(join(workspace, "submission.json"), {
        schemaVersion: 1,
        taskId: benchmark.id,
        artifacts: [
          {
            id: "mg-character",
            kind: "remotion-component",
            path: "component.tsx",
          },
          { id: "timeline", kind: "timeline", path: "timeline.yaml" },
          { id: "mg-video", kind: "video", path: "render.mp4" },
        ],
      });

      const report = await captureRemotionProductReadback({
        benchmark,
        workspace,
        caseRoot,
        ready: {
          projectId,
          apiUrl,
        },
      });

      expect(report.status).toBe("fail");
      expect(report.matchedArtifactIds).toEqual([]);
      expect(report.detail).toMatch(/do not match live product state/i);
      await rm(caseRoot, { recursive: true, force: true });
    });
  });

  it("reports the exact Host error from Timeline render readback", async () => {
    await withProductHost(
      [timeline],
      async ({ projectId, apiUrl }) => {
        const caseRoot = await mkdtemp(
          join("/tmp", "timeline-readback-error-"),
        );
        const workspace = join(caseRoot, "workspace");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await writeFile(
          join(workspace, "timeline.yaml"),
          `${JSON.stringify(timeline.state, null, 2)}\n`,
          "utf8",
        );
        await writeFile(join(workspace, "render.mp4"), "video", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: timelineBenchmark.id,
          artifacts: [
            { id: "timeline", kind: "timeline", path: "timeline.yaml" },
            { id: "final-video", kind: "video", path: "render.mp4" },
          ],
        });

        const report = await captureTimelineProductReadback({
          benchmark: timelineBenchmark,
          workspace,
          caseRoot,
          ready: {
            projectId,
            apiUrl,
          },
        });

        expect(report.status).toBe("fail");
        expect(report.detail).toBe("render index unavailable at revision 42");
        await rm(caseRoot, { recursive: true, force: true });
      },
      { renderReadbackError: "render index unavailable at revision 42" },
    );
  });
});

describe("trusted Project Asset product readback", () => {
  it("maps an absolute import path only from runner-sealed MCP evidence", async () => {
    await withAssetHost(async ({ projectId, apiUrl }) => {
      const caseRoot = await mkdtemp(join("/tmp", "asset-readback-path-map-"));
      const executionWorkspace = join(caseRoot, "execution-workspace");
      const finalWorkspace = join(caseRoot, "final-workspace");
      const logsRoot = join(caseRoot, "logs");
      await mkdir(join(finalWorkspace, ".clash"), { recursive: true });
      await mkdir(executionWorkspace, { recursive: true });
      await mkdir(logsRoot, { recursive: true });
      await writeFile(
        join(finalWorkspace, ".clash", "project.toml"),
        `schema_version = 1\nproject_id = "${projectId}"\n`,
        "utf8",
      );
      await writeFile(
        join(executionWorkspace, "hero.png"),
        "trusted-image",
        "utf8",
      );
      await writeFile(
        join(finalWorkspace, "hero.png"),
        "trusted-image",
        "utf8",
      );
      await writeJson(join(finalWorkspace, "submission.json"), {
        schemaVersion: 1,
        taskId: assetBenchmark.id,
        artifacts: [{ id: "hero-image", kind: "image", path: "hero.png" }],
      });
      await writeJson(join(caseRoot, "clash-host.json"), {
        executionWorkspace,
        finalWorkspace,
      });
      const writeImportEvent = (filePath: string) =>
        writeFile(
          join(logsRoot, "events.jsonl"),
          `${JSON.stringify({
            type: "item.completed",
            item: {
              id: "asset-import-no-result",
              type: "mcp_tool_call",
              server: "clash",
              tool: "clash_assets_import_file",
              arguments: {
                filePath,
                kind: "image",
                projectAssetId: "asset-image",
              },
              status: "completed",
              error: null,
            },
          })}\n`,
          "utf8",
        );
      await writeImportEvent(join(executionWorkspace, "hero.png"));
      const identityBenchmark: ArtifactBenchmarkCase = {
        ...assetBenchmark,
        outcome: {
          ...assetBenchmark.outcome,
          deliverables: [assetBenchmark.outcome.deliverables[0]!],
        },
        execution: {
          ...assetBenchmark.execution!,
          requiredProductOperations: ["asset.import"],
          productReadback: {
            ...assetBenchmark.execution!.productReadback!,
            artifactIds: ["hero-image"],
            expectedProjectAssetId: "asset-image",
          },
        },
      };

      const forgedStdoutReport = await captureAssetProductReadback({
        benchmark: identityBenchmark,
        workspace: finalWorkspace,
        caseRoot,
        ready: { projectId, apiUrl },
      });
      expect(forgedStdoutReport.status).toBe("fail");
      expect(forgedStdoutReport.detail).toMatch(/evidence is missing/iu);

      const writeImportReceipt = (filePath: string) =>
        writeSealedMcpTrace({
          caseRoot,
          caseId: identityBenchmark.id,
          tool: "clash_assets_import_file",
          arguments: {
            filePath,
            kind: "image",
            projectAssetId: "asset-image",
          },
          result: {
            structuredContent: {
              id: "asset-image",
              kind: "image",
              status: "ready",
            },
          },
        });
      await writeImportReceipt(join(executionWorkspace, "hero.png"));
      const report = await captureAssetProductReadback({
        benchmark: identityBenchmark,
        workspace: finalWorkspace,
        caseRoot,
        ready: { projectId, apiUrl },
      });

      expect(report.status).toBe("pass");
      expect(report.operationEvidence).toContainEqual(
        expect.objectContaining({
          operation: "asset.import",
          projectAssetId: "asset-image",
          sourcePath: join(executionWorkspace, "hero.png"),
        }),
      );

      await writeFile(
        join(executionWorkspace, "import-copy.png"),
        "trusted-image",
        "utf8",
      );
      await writeFile(
        join(finalWorkspace, "import-copy.png"),
        "trusted-image",
        "utf8",
      );
      await writeImportReceipt(join(executionWorkspace, "import-copy.png"));
      await expect(
        captureAssetProductReadback({
          benchmark: identityBenchmark,
          workspace: finalWorkspace,
          caseRoot,
          ready: { projectId, apiUrl },
        }),
      ).resolves.toMatchObject({ status: "pass" });

      await writeImportReceipt(join(caseRoot, "outside", "hero.png"));
      const outsideReport = await captureAssetProductReadback({
        benchmark: identityBenchmark,
        workspace: finalWorkspace,
        caseRoot,
        ready: { projectId, apiUrl },
      });
      expect(outsideReport.status).toBe("fail");
      expect(outsideReport.detail).toMatch(/submitted media file/iu);
      await rm(caseRoot, { recursive: true, force: true });
    });
  });

  it("rejects active submitted bytes when lifecycle evidence operated a different duplicate Asset", async () => {
    await withAssetHost(
      async ({ projectId, apiUrl }) => {
        const caseRoot = await mkdtemp(
          join("/tmp", "asset-readback-identity-"),
        );
        const workspace = join(caseRoot, "workspace");
        const logsRoot = join(caseRoot, "logs");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await mkdir(logsRoot, { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await writeFile(join(workspace, "hero.png"), "trusted-image", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: assetBenchmark.id,
          artifacts: [{ id: "hero-image", kind: "image", path: "hero.png" }],
        });
        await writeSealedMcpTrace({
          caseRoot,
          caseId: assetBenchmark.id,
          tool: "clash_assets_import_file",
          arguments: {
            filePath: "hero.png",
            kind: "image",
            projectAssetId: "asset-image",
          },
          result: {
            structuredContent: {
              id: "asset-image",
              kind: "image",
              status: "ready",
            },
          },
        });
        const completedCliEvent = (argv: string[]) => ({
          type: "clash.cli.completed",
          startedAt: "2026-08-14T00:00:00.000Z",
          finishedAt: "2026-08-14T00:00:00.010Z",
          durationMs: 10,
          pid: 101,
          cwd: workspace,
          argv,
          exitCode: 0,
          signal: null,
        });
        await writeFile(
          join(logsRoot, "clash-cli-events.jsonl"),
          [
            ["assets", "get", "--asset", "asset-image-copy", "--json"],
            [
              "assets",
              "delete",
              "--asset",
              "asset-image-copy",
              "--yes",
              "--json",
            ],
          ]
            .map((argv) => JSON.stringify(completedCliEvent(argv)))
            .join("\n") + "\n",
          "utf8",
        );
        const identityBenchmark: ArtifactBenchmarkCase = {
          ...assetBenchmark,
          outcome: {
            ...assetBenchmark.outcome,
            deliverables: [assetBenchmark.outcome.deliverables[0]!],
          },
          execution: {
            ...assetBenchmark.execution!,
            requiredProductOperations: [
              "asset.import",
              "asset.get",
              "asset.trash",
            ],
            productReadback: {
              ...assetBenchmark.execution!.productReadback!,
              artifactIds: ["hero-image"],
              expectedProjectAssetId: "asset-image",
            },
          },
        };

        const report = await captureAssetProductReadback({
          benchmark: identityBenchmark,
          workspace,
          caseRoot,
          ready: { projectId, apiUrl },
        });

        expect(report.status).toBe("fail");
        expect(report.detail).toMatch(/same Project Asset identity/iu);
        await rm(caseRoot, { recursive: true, force: true });
      },
      {
        duplicateImage: true,
        trashedAssetIds: ["asset-image-copy"],
      },
    );
  });

  it("fails closed when multiple active Assets have the submitted bytes", async () => {
    await withAssetHost(
      async ({ projectId, apiUrl }) => {
        const caseRoot = await mkdtemp(
          join("/tmp", "asset-readback-ambiguous-"),
        );
        const workspace = join(caseRoot, "workspace");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await writeFile(join(workspace, "hero.png"), "trusted-image", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: assetBenchmark.id,
          artifacts: [{ id: "hero-image", kind: "image", path: "hero.png" }],
        });
        const oneAssetBenchmark: ArtifactBenchmarkCase = {
          ...assetBenchmark,
          outcome: {
            ...assetBenchmark.outcome,
            deliverables: [assetBenchmark.outcome.deliverables[0]!],
          },
          execution: {
            ...assetBenchmark.execution!,
            productReadback: {
              ...assetBenchmark.execution!.productReadback!,
              artifactIds: ["hero-image"],
            },
          },
        };

        const report = await captureAssetProductReadback({
          benchmark: oneAssetBenchmark,
          workspace,
          caseRoot,
          ready: { projectId, apiUrl },
        });

        expect(report.status).toBe("fail");
        expect(report.matchedArtifactIds).toEqual([]);
        await rm(caseRoot, { recursive: true, force: true });
      },
      { duplicateImage: true },
    );
  });

  it("does not accept matching bytes from a trashed Project Asset", async () => {
    await withAssetHost(
      async ({ projectId, apiUrl }) => {
        const caseRoot = await mkdtemp(join("/tmp", "asset-readback-trash-"));
        const workspace = join(caseRoot, "workspace");
        await mkdir(join(workspace, ".clash"), { recursive: true });
        await writeFile(
          join(workspace, ".clash", "project.toml"),
          `schema_version = 1\nproject_id = "${projectId}"\n`,
          "utf8",
        );
        await writeFile(join(workspace, "hero.png"), "trusted-image", "utf8");
        await writeJson(join(workspace, "submission.json"), {
          schemaVersion: 1,
          taskId: assetBenchmark.id,
          artifacts: [{ id: "hero-image", kind: "image", path: "hero.png" }],
        });
        const oneAssetBenchmark: ArtifactBenchmarkCase = {
          ...assetBenchmark,
          outcome: {
            ...assetBenchmark.outcome,
            deliverables: [assetBenchmark.outcome.deliverables[0]!],
          },
          execution: {
            ...assetBenchmark.execution!,
            productReadback: {
              ...assetBenchmark.execution!.productReadback!,
              artifactIds: ["hero-image"],
            },
          },
        };

        const report = await captureAssetProductReadback({
          benchmark: oneAssetBenchmark,
          workspace,
          caseRoot,
          ready: { projectId, apiUrl },
        });

        expect(report.status).toBe("fail");
        expect(report.matchedArtifactIds).toEqual([]);
        await rm(caseRoot, { recursive: true, force: true });
      },
      { trashedAssetIds: ["asset-image"] },
    );
  });

  it("matches submitted media bytes to independently listed and Host-receipted Assets", async () => {
    await withAssetHost(async ({ projectId, apiUrl, requestedPaths }) => {
      const caseRoot = await mkdtemp(join("/tmp", "asset-readback-case-"));
      const workspace = join(caseRoot, "workspace");
      await mkdir(join(workspace, ".clash"), { recursive: true });
      await writeFile(
        join(workspace, ".clash", "project.toml"),
        `schema_version = 1\nproject_id = "${projectId}"\n`,
        "utf8",
      );
      await writeFile(join(workspace, "hero.png"), "trusted-image", "utf8");
      await writeFile(join(workspace, "voice.wav"), "trusted-audio", "utf8");
      await writeJson(join(workspace, "submission.json"), {
        schemaVersion: 1,
        taskId: assetBenchmark.id,
        artifacts: [
          { id: "hero-image", kind: "image", path: "hero.png" },
          { id: "voice-audio", kind: "audio", path: "voice.wav" },
        ],
      });

      const report = await captureAssetProductReadback({
        benchmark: assetBenchmark,
        workspace,
        caseRoot,
        ready: { projectId, apiUrl },
      });

      expect(report).toMatchObject({
        status: "pass",
        projectId,
        matchedArtifactIds: ["hero-image", "voice-audio"],
        matches: [
          {
            artifactId: "hero-image",
            assetId: "asset-image",
            kind: "image",
            hostReceipt: "receipt:asset-image",
            sha256: sha256("trusted-image"),
          },
          {
            artifactId: "voice-audio",
            assetId: "asset-audio",
            kind: "audio",
            hostReceipt: "receipt:asset-audio",
            sha256: sha256("trusted-audio"),
          },
        ],
      });
      expect(new Set(report.matches.map((match) => match.sha256)).size).toBe(2);
      expect(requestedPaths).toContain(`/api/v1/projects/${projectId}/assets`);
      expect(requestedPaths).toContain(
        `/api/v1/projects/${projectId}/assets/asset-image`,
      );
      expect(requestedPaths).toContain(
        `/api/v1/projects/${projectId}/assets/asset-audio`,
      );
      expect(requestedPaths).toContain("/media/asset-image");
      expect(requestedPaths).toContain("/media/asset-audio");
      expect(
        JSON.parse(
          await readFile(join(caseRoot, "asset-readback.json"), "utf8"),
        ),
      ).toEqual(report);
      await rm(caseRoot, { recursive: true, force: true });
    });
  });

  it("dispatches the Asset mechanism through the runner with its own receipt", async () => {
    await withAssetHost(async ({ projectId, apiUrl }) => {
      const caseRoot = await mkdtemp(join("/tmp", "asset-runner-readback-"));
      const workspace = join(caseRoot, "workspace");
      await mkdir(join(workspace, ".clash"), { recursive: true });
      await writeFile(
        join(workspace, ".clash", "project.toml"),
        `schema_version = 1\nproject_id = "${projectId}"\n`,
        "utf8",
      );
      await writeFile(join(workspace, "hero.png"), "trusted-image", "utf8");
      await writeFile(join(workspace, "voice.wav"), "trusted-audio", "utf8");
      await writeJson(join(workspace, "submission.json"), {
        schemaVersion: 1,
        taskId: assetBenchmark.id,
        artifacts: [
          { id: "hero-image", kind: "image", path: "hero.png" },
          { id: "voice-audio", kind: "audio", path: "voice.wav" },
        ],
      });

      const captured = await captureRequiredProductReadback({
        benchmark: assetBenchmark,
        workspace,
        caseRoot,
        ready: {
          projectId,
          apiUrl,
          workspaceId: "managed:test",
          initDisposition: "created",
          markerSha256: "test-marker-sha256",
          readyAt: "2026-08-14T00:00:00.000Z",
        },
      });

      expect(captured).toMatchObject({
        receiptPath: "asset-readback.json",
        report: {
          status: "pass",
          matchedArtifactIds: ["hero-image", "voice-audio"],
        },
      });
      await rm(caseRoot, { recursive: true, force: true });
    });
  });
});
