import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createProjectAssetHttpClient } from "@clash/asset-sdk";
import type { ProjectHostResponse } from "@clash/shared-runtime/project-host-client";
import {
  PROJECT_ASSET_RENDER_CANVAS_ID,
  TimelineDslSchema,
  canvasNodeReadToken,
  projectTimelineReadToken,
  type ProjectTimeline,
} from "@clash/shared-types";
import { parse as parseYaml } from "yaml";
import { timelineDslDocumentFromArtifact } from "./timeline-artifact";

import { loadSubmission } from "./artifacts";
import { readRunnerSealedMcpCalls } from "./mcp-evidence";
import {
  extractTrustedAssetOperationEvidence,
  type SuccessfulAssetCliCall,
  type SuccessfulAssetMcpCall,
  type TrustedAssetOperationEvidence,
} from "./product-operations";
import {
  assertProjectHostReady,
  assertWorkspaceProject,
  productHostContext,
  requestProjectHost,
  type ProductHostContext,
  type ProductHostReady,
} from "./project-host";
import type { ArtifactBenchmarkCase } from "./types";

export type { ProductHostReady } from "./project-host";

export type RemotionProductReadbackReport = {
  schemaVersion: 1;
  status: "pass" | "fail";
  projectId: string | null;
  matchedArtifactIds: string[];
  timelines: Array<{
    id: string;
    name: string;
    revisionId: string;
    readToken: string;
    hostReceipt: string;
    stateSha256: string;
  }>;
  sourceNodes: Array<{
    id: string;
    type: "remotion-component";
    version: string;
    readToken: string;
    sourceSha256: string;
  }>;
  matches: Array<{
    timelineId: string;
    timelineRevisionId: string;
    compositionId: string;
    sourceNodeId: string;
    componentArtifactId: string;
    componentSha256: string;
    timelineArtifactId: string;
    timelineSha256: string;
    timelineProjectAssetIds: string[];
    videoArtifactId: string;
    videoSha256: string;
    renderNodeId: string;
    renderNodeVersion: string;
    renderNodeReadToken: string;
    renderAssetId: string;
    renderAssetSha256: string;
  }>;
  detail: string;
};

export type TimelineProductReadbackReport = {
  schemaVersion: 1;
  status: "pass" | "fail";
  projectId: string | null;
  matchedArtifactIds: string[];
  timelines: RemotionProductReadbackReport["timelines"];
  matches: Array<{
    timelineId: string;
    timelineRevisionId: string;
    timelineArtifactId: string;
    timelineSha256: string;
    videoArtifactId: string;
    videoSha256: string;
    renderNodeId: string;
    renderNodeVersion: string;
    renderNodeReadToken: string;
    renderAssetId: string;
    renderAssetSha256: string;
  }>;
  detail: string;
};

export type AssetProductReadbackReport = {
  schemaVersion: 1;
  status: "pass" | "fail";
  projectId: string | null;
  expectedProjectAssetId?: string;
  /** Identity taken from the first trusted import of the submitted media. */
  importedProjectAssetId?: string;
  matchedArtifactIds: string[];
  operationEvidence: TrustedAssetOperationEvidence[];
  matches: Array<{
    artifactId: string;
    assetId: string;
    kind: "image" | "audio" | "video";
    hostReceipt: string;
    sha256: string;
  }>;
  detail: string;
};

export function mixedProductLineageProjectAssetIds(input: {
  director?: {
    stages: ReadonlyArray<{ id: string; revisionId: string }>;
    matches: ReadonlyArray<{ stageId: string }>;
    captures: ReadonlyArray<{
      stageId: string;
      stageRevisionId: string;
      frames: ReadonlyArray<{ projectAssetId?: string }>;
    }>;
  };
  remotion?: {
    matches: ReadonlyArray<{ timelineProjectAssetIds: readonly string[] }>;
  };
}): string[] {
  const matchedStageIds = new Set(
    input.director?.matches.map((match) => match.stageId) ?? [],
  );
  const matchedStageRevisions = new Map(
    (input.director?.stages ?? [])
      .filter((stage) => matchedStageIds.has(stage.id))
      .map((stage) => [stage.id, stage.revisionId] as const),
  );
  const timelineProjectAssetIds = new Set(
    input.remotion?.matches.flatMap((match) => match.timelineProjectAssetIds) ??
      [],
  );
  return [
    ...new Set(
      (input.director?.captures ?? []).flatMap((capture) =>
        matchedStageRevisions.get(capture.stageId) === capture.stageRevisionId
          ? capture.frames.flatMap((frame) => {
              const projectAssetId = frame.projectAssetId?.trim();
              return projectAssetId &&
                timelineProjectAssetIds.has(projectAssetId)
                ? [projectAssetId]
                : [];
            })
          : [],
      ),
    ),
  ].sort();
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return "null";
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function timelineStateFromArtifact(
  timeline: Record<string, unknown>,
): Record<string, unknown> {
  const state = { ...timeline };
  delete state.id;
  delete state.name;
  return state;
}

function parseProjectTimeline(value: unknown): ProjectTimeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Remotion readback Timeline must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim())
    throw new Error("Remotion readback Timeline id is required");
  if (typeof raw.name !== "string" || !raw.name.trim())
    throw new Error(`Timeline ${raw.id} name is required`);
  if (typeof raw.revisionId !== "string" || !raw.revisionId.trim()) {
    throw new Error(`Timeline ${raw.id} revisionId is required`);
  }
  if (!raw.owner || typeof raw.owner !== "object" || Array.isArray(raw.owner)) {
    throw new Error(`Timeline ${raw.id} owner is invalid`);
  }
  const owner = raw.owner as Record<string, unknown>;
  const parsedOwner: ProjectTimeline["owner"] =
    owner.kind === "project"
      ? { kind: "project" }
      : owner.kind === "canvas-action" &&
          typeof owner.canvasId === "string" &&
          typeof owner.actionNodeId === "string"
        ? {
            kind: "canvas-action",
            canvasId: owner.canvasId,
            actionNodeId: owner.actionNodeId,
          }
        : (() => {
            throw new Error(`Timeline ${raw.id} owner is invalid`);
          })();
  if (!raw.state || typeof raw.state !== "object" || Array.isArray(raw.state)) {
    throw new Error(`Timeline ${raw.id} state is invalid`);
  }
  return {
    id: raw.id,
    name: raw.name,
    revisionId: raw.revisionId,
    owner: parsedOwner,
    state: raw.state,
  };
}

function normalizeSource(source: string): string {
  return source.replaceAll("\r\n", "\n").trimEnd();
}

function sha256Source(source: string): string {
  return createHash("sha256").update(normalizeSource(source)).digest("hex");
}

async function readRenderedAssetSha256(input: {
  apiUrl: string;
  projectId: string;
  assetId: string;
  expectedSha256: string;
}): Promise<string> {
  const client = createProjectAssetHttpClient({
    endpoint: input.apiUrl,
    fetch: (request, init) =>
      fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
  const asset = (
    await client.get({
      projectId: input.projectId,
      assetId: input.assetId,
    })
  ).value;
  if (asset.id !== input.assetId || asset.status !== "ready" || !asset.url) {
    throw new Error(
      `Rendered Asset ${input.assetId} is not a ready ResolvedAsset with playable media`,
    );
  }
  const mediaResponse = await fetch(asset.url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!mediaResponse.ok) {
    throw new Error(
      `Rendered Asset ${input.assetId} media readback failed with HTTP ${mediaResponse.status}`,
    );
  }
  const sha256 = createHash("sha256")
    .update(new Uint8Array(await mediaResponse.arrayBuffer()))
    .digest("hex");
  if (sha256 !== input.expectedSha256) {
    throw new Error(
      `Submitted video does not match rendered Asset ${input.assetId}`,
    );
  }
  return sha256;
}

function timelineItems(
  timeline: ProjectTimeline,
): Array<Record<string, unknown>> {
  const tracks = (timeline.state as { tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.flatMap((track) => {
    if (!track || typeof track !== "object" || Array.isArray(track)) return [];
    const items = (track as { items?: unknown }).items;
    return Array.isArray(items)
      ? items.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  });
}

function compositionItems(
  timeline: ProjectTimeline,
): Array<Record<string, unknown>> {
  return timelineItems(timeline).filter(
    (item) =>
      item.type === "composition" &&
      item.runtime === "remotion" &&
      typeof item.sourceNodeId === "string" &&
      item.sourceNodeId.length > 0,
  );
}

function timelineProjectAssetIds(timeline: ProjectTimeline): string[] {
  const mediaTypes = new Set(["audio", "image", "sticker", "video"]);
  return [
    ...new Set(
      timelineItems(timeline).flatMap((item) =>
        mediaTypes.has(String(item.type)) &&
        typeof item.assetId === "string" &&
        item.assetId.trim()
          ? [item.assetId.trim()]
          : [],
      ),
    ),
  ].sort();
}

type HostNode = {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  canvas_id?: string;
  [key: string]: unknown;
};

type TrustedTimelineRender = {
  node: HostNode;
  lineage: {
    sourceTimelineId: string;
    sourceTimelineRevisionId: string;
  };
  version: string;
  readToken: string;
};

async function listTimelineRenders(
  input: ProductHostContext,
): Promise<TrustedTimelineRender[]> {
  const response = await requestProjectHost<
    ProjectHostResponse & {
      canvasId?: unknown;
      status?: unknown;
      renders?: unknown;
    }
  >({
    ...input,
    command: { action: "list_timeline_renders", status: "completed" },
  });
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Timeline render host readback response must be an object");
  }
  const raw = response as {
    canvasId?: unknown;
    status?: unknown;
    renders?: unknown;
    error?: unknown;
  };
  if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
  if (
    raw.canvasId !== PROJECT_ASSET_RENDER_CANVAS_ID ||
    raw.status !== "completed" ||
    !Array.isArray(raw.renders)
  ) {
    throw new Error(
      "Timeline render host readback response is missing the internal render scope or completed renders",
    );
  }
  return raw.renders.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Timeline render readback entry ${index} must be an object`,
      );
    }
    const render = value as {
      node?: unknown;
      lineage?: unknown;
      version?: unknown;
      readToken?: unknown;
    };
    if (
      !render.node ||
      typeof render.node !== "object" ||
      Array.isArray(render.node)
    ) {
      throw new Error(
        `Timeline render readback entry ${index} is missing its node`,
      );
    }
    const node = render.node as HostNode;
    if (
      typeof node.id !== "string" ||
      node.type !== "video" ||
      node.canvas_id !== PROJECT_ASSET_RENDER_CANVAS_ID ||
      !node.data ||
      typeof node.data !== "object"
    ) {
      throw new Error(
        `Timeline render readback entry ${index} has an invalid node`,
      );
    }
    if (
      !render.lineage ||
      typeof render.lineage !== "object" ||
      Array.isArray(render.lineage)
    ) {
      throw new Error(
        `Timeline render readback entry ${index} is missing lineage`,
      );
    }
    const lineage = render.lineage as Record<string, unknown>;
    if (
      typeof lineage.sourceTimelineId !== "string" ||
      lineage.sourceTimelineId !== node.data.sourceTimelineId ||
      typeof lineage.sourceTimelineRevisionId !== "string" ||
      lineage.sourceTimelineRevisionId !== node.data.sourceTimelineRevisionId
    ) {
      throw new Error(
        `Timeline render readback entry ${index} has invalid lineage`,
      );
    }
    const version = canvasNodeReadToken(node);
    const receiptPrefix = `${version}:receipt:`;
    if (
      render.version !== version ||
      typeof render.readToken !== "string" ||
      !render.readToken.startsWith(receiptPrefix) ||
      !/^[A-Za-z0-9._~-]{1,256}$/u.test(
        render.readToken.slice(receiptPrefix.length),
      )
    ) {
      throw new Error(
        `Timeline render ${node.id} is missing a live Host read receipt`,
      );
    }
    return {
      node,
      lineage: {
        sourceTimelineId: lineage.sourceTimelineId,
        sourceTimelineRevisionId: lineage.sourceTimelineRevisionId,
      },
      version,
      readToken: render.readToken,
    };
  });
}

async function readCanvasNode(
  input: ProductHostContext,
  canvasIds: string[],
  nodeId: string,
): Promise<{ node: HostNode; version: string; readToken: string } | null> {
  for (const canvasId of canvasIds) {
    const requested = await input.client.request<
      ProjectHostResponse & {
        node?: unknown;
        version?: unknown;
        readToken?: unknown;
      }
    >({
      cwd: input.workspace,
      projectId: input.ready.projectId,
      command: { action: "get", canvasId, nodeId },
    });
    if (requested.projectId !== input.ready.projectId) {
      throw new Error("Project Host readback resolved a different Project");
    }
    const response = requested.value;
    if (response.error) continue;
    if (!response || typeof response !== "object" || Array.isArray(response))
      continue;
    const raw = response as {
      node?: unknown;
      version?: unknown;
      readToken?: unknown;
      error?: unknown;
    };
    if (
      raw.node &&
      typeof raw.node === "object" &&
      !Array.isArray(raw.node) &&
      typeof (raw.node as { id?: unknown }).id === "string" &&
      typeof (raw.node as { type?: unknown }).type === "string" &&
      typeof raw.version === "string" &&
      typeof raw.readToken === "string" &&
      raw.readToken.startsWith(`${raw.version}:receipt:`)
    ) {
      return {
        node: raw.node as HostNode,
        version: raw.version,
        readToken: raw.readToken,
      };
    }
  }
  return null;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readJsonLinesIfPresent(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
  return text.split(/\r?\n/u).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

async function readTrustedAssetOperationEvidence(
  caseRoot: string,
  caseId: string,
): Promise<TrustedAssetOperationEvidence[]> {
  const successfulMcpCalls: SuccessfulAssetMcpCall[] =
    await readRunnerSealedMcpCalls({
      logsRoot: join(caseRoot, "logs"),
      caseId,
    });

  const successfulCliCalls = (
    await readJsonLinesIfPresent(
      join(caseRoot, "logs", "clash-cli-events.jsonl"),
    )
  ).flatMap((value): SuccessfulAssetCliCall[] => {
    const event = recordOf(value);
    return event?.type === "clash.cli.completed" &&
      event.exitCode === 0 &&
      event.origin !== "mcp-transport" &&
      Array.isArray(event.argv) &&
      event.argv.every((argument) => typeof argument === "string")
      ? [
          {
            argv: event.argv as string[],
            ...(typeof event.importedProjectAssetId === "string"
              ? { importedProjectAssetId: event.importedProjectAssetId }
              : {}),
            ...(typeof event.startedAt === "string"
              ? { startedAt: event.startedAt }
              : {}),
          },
        ]
      : [];
  });
  return extractTrustedAssetOperationEvidence({
    successfulMcpCalls,
    successfulCliCalls,
  });
}

function relativePathInside(
  root: string,
  candidate: string,
): string | undefined {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath;
}

async function mapImportSourceToSnapshot(input: {
  caseRoot: string;
  declaredFinalWorkspace: string;
  snapshotWorkspace: string;
  sourcePath: string;
}): Promise<string | undefined> {
  const declaredFinalWorkspace = resolve(input.declaredFinalWorkspace);
  const snapshotWorkspace = resolve(input.snapshotWorkspace);
  if (!isAbsolute(input.sourcePath)) {
    const candidate = resolve(snapshotWorkspace, input.sourcePath);
    return relativePathInside(snapshotWorkspace, candidate) === undefined
      ? undefined
      : candidate;
  }

  const finalRelativePath =
    relativePathInside(snapshotWorkspace, input.sourcePath) ??
    relativePathInside(declaredFinalWorkspace, input.sourcePath);
  if (finalRelativePath !== undefined) {
    return resolve(snapshotWorkspace, finalRelativePath);
  }

  let hostManifest: Record<string, unknown> | undefined;
  try {
    hostManifest = recordOf(
      JSON.parse(
        await readFile(join(input.caseRoot, "clash-host.json"), "utf8"),
      ),
    );
  } catch {
    return undefined;
  }
  if (
    typeof hostManifest?.executionWorkspace !== "string" ||
    typeof hostManifest.finalWorkspace !== "string" ||
    (resolve(hostManifest.finalWorkspace) !== declaredFinalWorkspace &&
      resolve(hostManifest.finalWorkspace) !== snapshotWorkspace)
  ) {
    return undefined;
  }
  const executionRelativePath = relativePathInside(
    hostManifest.executionWorkspace,
    input.sourcePath,
  );
  return executionRelativePath === undefined
    ? undefined
    : resolve(snapshotWorkspace, executionRelativePath);
}

async function fileSha256(path: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  return hash.digest("hex");
}

async function fetchMediaSha256(url: string, assetId: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `Project Asset ${assetId} media readback failed with HTTP ${response.status}`,
    );
  }
  return createHash("sha256")
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest("hex");
}

export async function captureAssetProductReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  caseRoot: string;
  ready?: ProductHostReady;
}): Promise<AssetProductReadbackReport> {
  const reportPath = join(input.caseRoot, "asset-readback.json");
  const expectedProjectAssetId =
    input.benchmark.execution?.productReadback?.expectedProjectAssetId;
  const identityFromFirstImport =
    !expectedProjectAssetId &&
    input.benchmark.execution?.productReadback?.projectAssetIdentity ===
      "first-import";
  let requiredProjectAssetId = expectedProjectAssetId;
  const matchedArtifactIds: string[] = [];
  let operationEvidence: TrustedAssetOperationEvidence[] = [];
  const matches: AssetProductReadbackReport["matches"] = [];
  try {
    if (!input.ready)
      throw new Error("Clash Project Host did not become ready");
    const host = productHostContext({
      ready: input.ready,
      workspace: input.workspace,
    });
    await assertProjectHostReady(host);
    await assertWorkspaceProject(input.workspace, input.ready.projectId);

    const expectedIds =
      input.benchmark.execution?.productReadback?.artifactIds ?? [];
    if (expectedIds.length === 0) {
      throw new Error("Project Asset readback requires media artifact ids");
    }
    const submission = await loadSubmission(input.workspace);
    if (submission.error) throw new Error(submission.error);
    const artifacts = expectedIds.map((artifactId) => {
      const artifact = submission.artifacts.find(
        (candidate) => candidate.descriptor.id === artifactId,
      );
      if (
        !artifact ||
        artifact.error ||
        !artifact.evidence ||
        !artifact.absolutePath ||
        (artifact.descriptor.kind !== "image" &&
          artifact.descriptor.kind !== "audio" &&
          artifact.descriptor.kind !== "video")
      ) {
        throw new Error(
          `Project Asset artifact '${artifactId}' must be an available image, audio, or video file`,
        );
      }
      return artifact;
    });
    operationEvidence = await readTrustedAssetOperationEvidence(
      input.caseRoot,
      input.benchmark.id,
    );
    if (expectedProjectAssetId || identityFromFirstImport) {
      if (artifacts.length !== 1) {
        throw new Error(
          "A Project Asset identity rule requires exactly one submitted media artifact",
        );
      }
      const submittedSha256 = artifacts[0]!.evidence!.sha256;
      const importEvidence = operationEvidence.filter(
        (evidence) => evidence.operation === "asset.import",
      );
      const importedSha256 = await Promise.all(
        importEvidence.map(async (evidence) => {
          const sourcePath = evidence.sourcePath
            ? await mapImportSourceToSnapshot({
                caseRoot: input.caseRoot,
                declaredFinalWorkspace: input.workspace,
                snapshotWorkspace: submission.workspace,
                sourcePath: evidence.sourcePath,
              })
            : undefined;
          return sourcePath ? await fileSha256(sourcePath) : undefined;
        }),
      );
      if (identityFromFirstImport) {
        const firstImportIndex = importedSha256.indexOf(submittedSha256);
        const firstImport = importEvidence[firstImportIndex];
        if (!firstImport) {
          throw new Error(
            "Trusted asset.import evidence is missing for the submitted media file, so no Project Asset identity was established",
          );
        }
        requiredProjectAssetId = firstImport.projectAssetId;
        const otherImport = importEvidence.find(
          (evidence) => evidence.projectAssetId !== requiredProjectAssetId,
        );
        if (otherImport) {
          throw new Error(
            `Project Asset identity changed: the first successful import of the submitted media file created ${requiredProjectAssetId}, but another import created ${otherImport.projectAssetId}. Extra imports and trash-and-reimport are not accepted; keep operating the first imported Asset`,
          );
        }
      }
      const requiredEntityOperations = [
        ...new Set(
          (input.benchmark.execution?.requiredProductOperations ?? []).filter(
            (
              operation,
            ): operation is TrustedAssetOperationEvidence["operation"] =>
              operation === "asset.import" ||
              operation === "asset.get" ||
              operation === "asset.trash" ||
              operation === "asset.restore",
          ),
        ),
      ];
      for (const operation of requiredEntityOperations) {
        const observed = operationEvidence.filter(
          (evidence) => evidence.operation === operation,
        );
        if (observed.length === 0) {
          throw new Error(
            `Trusted ${operation} evidence is missing for ${identityFromFirstImport ? "first-imported" : "expected"} Project Asset ${requiredProjectAssetId}`,
          );
        }
        const stray = observed.find(
          (evidence) => evidence.projectAssetId !== requiredProjectAssetId,
        );
        if (stray) {
          throw new Error(
            `Every required Asset operation must target the same Project Asset identity ${requiredProjectAssetId}; ${operation} targeted ${stray.projectAssetId}`,
          );
        }
      }
      if (
        requiredEntityOperations.includes("asset.import") &&
        importedSha256.some(
          (sha256, index) =>
            importEvidence[index]!.projectAssetId === requiredProjectAssetId &&
            sha256 !== submittedSha256,
        )
      ) {
        throw new Error(
          `Trusted import evidence for ${requiredProjectAssetId} must use bytes matching the submitted media file`,
        );
      }
    }

    const client = createProjectAssetHttpClient({
      endpoint: input.ready.apiUrl,
      fetch: (request, init) =>
        fetch(request, { ...init, signal: AbortSignal.timeout(15_000) }),
    });
    const listedAssets = await client.list({
      projectId: input.ready.projectId,
    });
    const expectedKinds = new Set(
      artifacts.map((artifact) => artifact.descriptor.kind),
    );
    const candidates: Array<{
      assetId: string;
      kind: "image" | "audio" | "video";
      hostReceipt: string;
      sha256: string;
    }> = [];
    for (const listed of listedAssets) {
      if (
        (listed.kind !== "image" &&
          listed.kind !== "audio" &&
          listed.kind !== "video") ||
        listed.lifecycle.state !== "active" ||
        !expectedKinds.has(listed.kind)
      ) {
        continue;
      }
      const observed = await client.get({
        projectId: input.ready.projectId,
        assetId: listed.id,
      });
      const asset = observed.value;
      if (
        asset.id !== listed.id ||
        asset.kind !== listed.kind ||
        asset.lifecycle.state !== "active" ||
        asset.status !== "ready" ||
        !asset.url
      ) {
        continue;
      }
      candidates.push({
        assetId: asset.id,
        kind: asset.kind,
        hostReceipt: observed.receipt,
        sha256: await fetchMediaSha256(asset.url, asset.id),
      });
    }

    const usedAssetIds = new Set<string>();
    for (const artifact of artifacts) {
      const matchingCandidates = candidates.filter(
        (candidate) =>
          !usedAssetIds.has(candidate.assetId) &&
          (!requiredProjectAssetId ||
            candidate.assetId === requiredProjectAssetId) &&
          candidate.kind === artifact.descriptor.kind &&
          candidate.sha256 === artifact.evidence!.sha256,
      );
      if (matchingCandidates.length !== 1) {
        throw new Error(
          matchingCandidates.length === 0
            ? `Submitted media artifact '${artifact.descriptor.id}' does not match a ready Project Asset with a Host receipt`
            : `Submitted media artifact '${artifact.descriptor.id}' ambiguously matches multiple ready Project Assets`,
        );
      }
      const match = matchingCandidates[0]!;
      usedAssetIds.add(match.assetId);
      matchedArtifactIds.push(artifact.descriptor.id);
      matches.push({
        artifactId: artifact.descriptor.id,
        ...match,
      });
    }

    const report: AssetProductReadbackReport = {
      schemaVersion: 1,
      status: "pass",
      projectId: input.ready.projectId,
      ...(expectedProjectAssetId ? { expectedProjectAssetId } : {}),
      ...(identityFromFirstImport && requiredProjectAssetId
        ? { importedProjectAssetId: requiredProjectAssetId }
        : {}),
      matchedArtifactIds,
      operationEvidence,
      matches,
      detail: `Matched ${matches.length} submitted media artifact(s) to ready Project Assets by bytes with Host receipts.`,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    const report: AssetProductReadbackReport = {
      schemaVersion: 1,
      status: "fail",
      projectId: input.ready?.projectId ?? null,
      ...(expectedProjectAssetId ? { expectedProjectAssetId } : {}),
      ...(identityFromFirstImport && requiredProjectAssetId
        ? { importedProjectAssetId: requiredProjectAssetId }
        : {}),
      matchedArtifactIds,
      operationEvidence,
      matches,
      detail: error instanceof Error ? error.message : String(error),
    };
    await writeJson(reportPath, report);
    return report;
  }
}

export async function captureRemotionProductReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  caseRoot: string;
  ready?: ProductHostReady;
}): Promise<RemotionProductReadbackReport> {
  const reportPath = join(input.caseRoot, "remotion-readback.json");
  const matchedArtifactIds: string[] = [];
  const timelines: RemotionProductReadbackReport["timelines"] = [];
  const sourceNodes: RemotionProductReadbackReport["sourceNodes"] = [];
  const matches: RemotionProductReadbackReport["matches"] = [];
  try {
    if (!input.ready)
      throw new Error("Clash Project Host did not become ready");
    const host = productHostContext({
      ready: input.ready,
      workspace: input.workspace,
    });
    await assertProjectHostReady(host);
    await assertWorkspaceProject(input.workspace, input.ready.projectId);

    const response = await requestProjectHost<
      ProjectHostResponse & {
        timelines?: unknown;
        versions?: unknown;
      }
    >({
      ...host,
      command: { action: "list_timelines" },
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Remotion host readback response must be an object");
    }
    const raw = response as {
      error?: unknown;
      timelines?: unknown;
      versions?: unknown;
    };
    if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
    if (
      !Array.isArray(raw.timelines) ||
      !raw.versions ||
      typeof raw.versions !== "object" ||
      Array.isArray(raw.versions)
    ) {
      throw new Error(
        "Remotion host readback response is missing Timelines or receipts",
      );
    }
    const versions = raw.versions as Record<string, unknown>;
    const parsedTimelines = raw.timelines.map(parseProjectTimeline);
    for (const timeline of parsedTimelines) {
      const readToken = projectTimelineReadToken(timeline);
      const hostReceipt = versions[timeline.id];
      const prefix = `${readToken}:receipt:`;
      if (
        typeof hostReceipt !== "string" ||
        !hostReceipt.startsWith(prefix) ||
        !/^[A-Za-z0-9._~-]{1,256}$/u.test(hostReceipt.slice(prefix.length))
      ) {
        throw new Error(
          `Timeline ${timeline.id} is missing a live Host read receipt`,
        );
      }
      timelines.push({
        id: timeline.id,
        name: timeline.name,
        revisionId: timeline.revisionId,
        readToken,
        hostReceipt,
        stateSha256: sha256Json(timeline.state),
      });
    }

    const canvasesResponse = await requestProjectHost<
      ProjectHostResponse & {
        canvases?: unknown;
      }
    >({
      ...host,
      command: { action: "list_canvases" },
    });
    const canvasIds = [
      "main",
      ...(canvasesResponse &&
      typeof canvasesResponse === "object" &&
      !Array.isArray(canvasesResponse) &&
      Array.isArray((canvasesResponse as { canvases?: unknown }).canvases)
        ? (canvasesResponse as { canvases: Array<{ id?: unknown }> }).canvases
            .map((canvas) => canvas.id)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            )
        : []),
    ];
    const expectedIds =
      input.benchmark.execution?.productReadback?.artifactIds ?? [];
    const submission = await loadSubmission(input.workspace);
    if (submission.error) throw new Error(submission.error);
    const artifacts = expectedIds.map((artifactId) => {
      const artifact = submission.artifacts.find(
        (candidate) => candidate.descriptor.id === artifactId,
      );
      if (
        !artifact ||
        artifact.error ||
        !artifact.evidence ||
        !artifact.absolutePath
      ) {
        throw new Error(
          `Remotion artifact '${artifactId}' is unavailable for product readback matching`,
        );
      }
      return artifact;
    });
    const componentArtifact = artifacts.find(
      (artifact) => artifact.descriptor.kind === "remotion-component",
    );
    const timelineArtifact = artifacts.find(
      (artifact) => artifact.descriptor.kind === "timeline",
    );
    const videoArtifact = artifacts.find(
      (artifact) => artifact.descriptor.kind === "video",
    );
    if (!componentArtifact?.content) {
      throw new Error(
        "Remotion product readback requires one readable remotion-component artifact",
      );
    }
    if (!timelineArtifact?.content)
      throw new Error(
        "Remotion product readback requires one readable Timeline artifact",
      );
    if (!videoArtifact?.evidence)
      throw new Error(
        "Remotion product readback requires one rendered video artifact",
      );
    let timelineValue: unknown;
    try {
      timelineValue = timelineDslDocumentFromArtifact(
        parseYaml(timelineArtifact.content.toString("utf8")) as unknown,
      );
    } catch (error) {
      throw new Error(
        `Timeline artifact is not YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsedTimeline = TimelineDslSchema.safeParse(timelineValue);
    if (!parsedTimeline.success)
      throw new Error("Timeline artifact does not satisfy TimelineDslSchema");
    const timelineSha256 = sha256Json(
      timelineStateFromArtifact(parsedTimeline.data),
    );
    const componentSha256 = sha256Source(
      componentArtifact.content.toString("utf8"),
    );
    const renderNodes = await listTimelineRenders(host);

    for (const timeline of parsedTimelines) {
      if (sha256Json(timeline.state) !== timelineSha256) continue;
      const renderNode = renderNodes.find((render) => {
        const data = render.node.data ?? {};
        return (
          data.status === "completed" &&
          render.lineage.sourceTimelineId === timeline.id &&
          render.lineage.sourceTimelineRevisionId === timeline.revisionId &&
          typeof data.assetId === "string" &&
          data.assetId.length > 0
        );
      });
      if (!renderNode) continue;
      const renderAssetId = String(renderNode.node.data!.assetId);
      const renderAssetSha256 = await readRenderedAssetSha256({
        apiUrl: input.ready.apiUrl,
        projectId: input.ready.projectId,
        assetId: renderAssetId,
        expectedSha256: videoArtifact.evidence.sha256,
      });
      for (const item of compositionItems(timeline)) {
        const sourceNodeId = String(item.sourceNodeId);
        const source = await readCanvasNode(host, canvasIds, sourceNodeId);
        const sourceData = source?.node.data ?? {};
        if (!source || source.node.type !== "remotion-component") continue;
        if (
          typeof sourceData.content !== "string" ||
          sha256Source(sourceData.content) !== componentSha256
        )
          continue;
        if (!sourceNodes.some((node) => node.id === sourceNodeId)) {
          sourceNodes.push({
            id: sourceNodeId,
            type: "remotion-component",
            version: source.version,
            readToken: source.readToken,
            sourceSha256: componentSha256,
          });
        }
        matches.push({
          timelineId: timeline.id,
          timelineRevisionId: timeline.revisionId,
          compositionId: String(item.compositionId ?? sourceNodeId),
          sourceNodeId,
          componentArtifactId: componentArtifact.descriptor.id,
          componentSha256,
          timelineArtifactId: timelineArtifact.descriptor.id,
          timelineSha256,
          timelineProjectAssetIds: timelineProjectAssetIds(timeline),
          videoArtifactId: videoArtifact.descriptor.id,
          videoSha256: videoArtifact.evidence.sha256,
          renderNodeId: renderNode.node.id,
          renderNodeVersion: renderNode.version,
          renderNodeReadToken: renderNode.readToken,
          renderAssetId,
          renderAssetSha256,
        });
      }
    }
    if (matches.length === 0) {
      throw new Error(
        "The submitted Remotion source, Timeline, and render do not match live product state",
      );
    }
    matchedArtifactIds.push(
      componentArtifact.descriptor.id,
      timelineArtifact.descriptor.id,
      videoArtifact.descriptor.id,
    );
    const report: RemotionProductReadbackReport = {
      schemaVersion: 1,
      status: "pass",
      projectId: input.ready.projectId,
      matchedArtifactIds,
      timelines,
      sourceNodes,
      matches,
      detail: `Matched Remotion source, Timeline revision, and completed product render for ${matches.length} live composition(s) with Host receipts.`,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    const report: RemotionProductReadbackReport = {
      schemaVersion: 1,
      status: "fail",
      projectId: input.ready?.projectId ?? null,
      matchedArtifactIds,
      timelines,
      sourceNodes,
      matches,
      detail: error instanceof Error ? error.message : String(error),
    };
    await writeJson(reportPath, report);
    return report;
  }
}

export async function captureTimelineProductReadback(input: {
  benchmark: ArtifactBenchmarkCase;
  workspace: string;
  caseRoot: string;
  ready?: ProductHostReady;
}): Promise<TimelineProductReadbackReport> {
  const reportPath = join(input.caseRoot, "timeline-readback.json");
  const matchedArtifactIds: string[] = [];
  const timelines: TimelineProductReadbackReport["timelines"] = [];
  const matches: TimelineProductReadbackReport["matches"] = [];
  try {
    if (!input.ready)
      throw new Error("Clash Project Host did not become ready");
    const host = productHostContext({
      ready: input.ready,
      workspace: input.workspace,
    });
    await assertProjectHostReady(host);
    await assertWorkspaceProject(input.workspace, input.ready.projectId);

    const response = await requestProjectHost<
      ProjectHostResponse & {
        timelines?: unknown;
        versions?: unknown;
      }
    >({
      ...host,
      command: { action: "list_timelines" },
    });
    if (!response || typeof response !== "object" || Array.isArray(response)) {
      throw new Error("Timeline host readback response must be an object");
    }
    const raw = response as {
      error?: unknown;
      timelines?: unknown;
      versions?: unknown;
    };
    if (typeof raw.error === "string" && raw.error) throw new Error(raw.error);
    if (
      !Array.isArray(raw.timelines) ||
      !raw.versions ||
      typeof raw.versions !== "object" ||
      Array.isArray(raw.versions)
    ) {
      throw new Error(
        "Timeline host readback response is missing Timelines or receipts",
      );
    }
    const versions = raw.versions as Record<string, unknown>;
    const parsedTimelines = raw.timelines.map(parseProjectTimeline);
    for (const timeline of parsedTimelines) {
      const readToken = projectTimelineReadToken(timeline);
      const hostReceipt = versions[timeline.id];
      const prefix = `${readToken}:receipt:`;
      if (
        typeof hostReceipt !== "string" ||
        !hostReceipt.startsWith(prefix) ||
        !/^[A-Za-z0-9._~-]{1,256}$/u.test(hostReceipt.slice(prefix.length))
      ) {
        throw new Error(
          `Timeline ${timeline.id} is missing a live Host read receipt`,
        );
      }
      timelines.push({
        id: timeline.id,
        name: timeline.name,
        revisionId: timeline.revisionId,
        readToken,
        hostReceipt,
        stateSha256: sha256Json(timeline.state),
      });
    }

    const expectedIds =
      input.benchmark.execution?.productReadback?.artifactIds ?? [];
    const submission = await loadSubmission(input.workspace);
    if (submission.error) throw new Error(submission.error);
    const artifacts = expectedIds.map((artifactId) => {
      const artifact = submission.artifacts.find(
        (candidate) => candidate.descriptor.id === artifactId,
      );
      if (
        !artifact ||
        artifact.error ||
        !artifact.evidence ||
        !artifact.absolutePath
      ) {
        throw new Error(
          `Timeline artifact '${artifactId}' is unavailable for product readback matching`,
        );
      }
      return artifact;
    });
    const timelineArtifact = artifacts.find(
      (artifact) => artifact.descriptor.kind === "timeline",
    );
    const videoArtifact = artifacts.find(
      (artifact) => artifact.descriptor.kind === "video",
    );
    if (!timelineArtifact?.content)
      throw new Error(
        "Timeline product readback requires one readable Timeline artifact",
      );
    if (!videoArtifact?.evidence)
      throw new Error(
        "Timeline product readback requires one rendered video artifact",
      );
    let timelineValue: unknown;
    try {
      timelineValue = timelineDslDocumentFromArtifact(
        parseYaml(timelineArtifact.content.toString("utf8")) as unknown,
      );
    } catch (error) {
      throw new Error(
        `Timeline artifact is not YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsedTimeline = TimelineDslSchema.safeParse(timelineValue);
    if (!parsedTimeline.success)
      throw new Error("Timeline artifact does not satisfy TimelineDslSchema");
    const timelineSha256 = sha256Json(
      timelineStateFromArtifact(parsedTimeline.data),
    );
    const renderNodes = await listTimelineRenders(host);

    for (const timeline of parsedTimelines) {
      if (sha256Json(timeline.state) !== timelineSha256) continue;
      const renderNode = renderNodes.find((render) => {
        const data = render.node.data ?? {};
        return (
          data.status === "completed" &&
          render.lineage.sourceTimelineId === timeline.id &&
          render.lineage.sourceTimelineRevisionId === timeline.revisionId &&
          typeof data.assetId === "string" &&
          data.assetId.length > 0
        );
      });
      if (!renderNode) continue;
      const renderAssetId = String(renderNode.node.data!.assetId);
      const renderAssetSha256 = await readRenderedAssetSha256({
        apiUrl: input.ready.apiUrl,
        projectId: input.ready.projectId,
        assetId: renderAssetId,
        expectedSha256: videoArtifact.evidence.sha256,
      });
      matches.push({
        timelineId: timeline.id,
        timelineRevisionId: timeline.revisionId,
        timelineArtifactId: timelineArtifact.descriptor.id,
        timelineSha256,
        videoArtifactId: videoArtifact.descriptor.id,
        videoSha256: videoArtifact.evidence.sha256,
        renderNodeId: renderNode.node.id,
        renderNodeVersion: renderNode.version,
        renderNodeReadToken: renderNode.readToken,
        renderAssetId,
        renderAssetSha256,
      });
    }
    if (matches.length === 0) {
      throw new Error(
        "The submitted Timeline and render do not match live product state",
      );
    }
    matchedArtifactIds.push(
      timelineArtifact.descriptor.id,
      videoArtifact.descriptor.id,
    );
    const report: TimelineProductReadbackReport = {
      schemaVersion: 1,
      status: "pass",
      projectId: input.ready.projectId,
      matchedArtifactIds,
      timelines,
      matches,
      detail: `Matched Timeline revision and completed product render for ${matches.length} live Timeline(s) with Host receipts.`,
    };
    await writeJson(reportPath, report);
    return report;
  } catch (error) {
    const report: TimelineProductReadbackReport = {
      schemaVersion: 1,
      status: "fail",
      projectId: input.ready?.projectId ?? null,
      matchedArtifactIds,
      timelines,
      matches,
      detail: error instanceof Error ? error.message : String(error),
    };
    await writeJson(reportPath, report);
    return report;
  }
}
