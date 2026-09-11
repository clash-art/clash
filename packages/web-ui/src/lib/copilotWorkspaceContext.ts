import {
  serializeAgentAnnotationPromptBlock,
  type AgentAnnotationDraft,
  type ResolvedAsset,
} from "@clash/shared-types";
import { assetThumbnailImageUrl } from "../features/assets/media-url";

export type CopilotMentionKind =
  "agent" | "node" | "asset" | "timeline" | "director-stage";
export type CopilotMentionScope =
  | "agents"
  | "current-surface"
  | "current-canvas"
  | "project-assets"
  | "global-assets"
  | "timelines"
  | "director-stages"
  | "other-canvases";

export interface CopilotMentionSource {
  id: string;
  type: string;
  label: string;
  kind: CopilotMentionKind;
  scope: CopilotMentionScope;
  description?: string;
  thumbnail?: string;
  canvasId?: string;
  canvasName?: string;
}

export interface BrowserAgentInteractiveElement {
  tag: string;
  label: string;
  selector: string;
}

export interface BrowserAgentContext {
  url: string;
  title: string;
  text: string;
  interactiveElements: BrowserAgentInteractiveElement[];
}

type CopilotWorkspaceActiveSurface =
  | {
      kind: "canvas" | "timeline" | "director-stage" | "asset";
      id: string;
      name: string;
    }
  | {
      kind: "browser";
      id: string;
      name: string;
      browser: BrowserAgentContext;
    };

export interface CopilotWorkspaceContext {
  projectId: string;
  projectName: string;
  activeSurface: CopilotWorkspaceActiveSurface;
}

type MentionNodeInput = {
  id: string;
  type?: string;
  canvasId?: string;
  data?: Record<string, unknown>;
};

type MentionCanvasInput = { id: string; name: string };
type MentionAssetInput = Pick<
  ResolvedAsset,
  "id" | "kind" | "name" | "metadata" | "thumbnailUrl" | "url"
>;
type MentionTimelineInput = { id: string; name: string };
type MentionDirectorStageInput = { id: string; name: string };
type ActiveSurfaceInput =
  | { kind: "canvas"; canvasId: string }
  | { kind: "timeline"; timelineId: string }
  | { kind: "director-stage"; stageId: string }
  | { kind: "asset"; assetId: string };

function humanizeType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function nodeLabel(node: MentionNodeInput): string {
  const data = node.data ?? {};
  for (const value of [data.label, data.name, data.title, data.fileName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return `${humanizeType(node.type ?? "node")} ${node.id}`;
}

function nodeDescription(type: string, canvasName: string): string {
  return `${humanizeType(type)} node · ${canvasName}`;
}

export function buildProjectMentionSources(input: {
  activeCanvasId: string;
  activeSurface: ActiveSurfaceInput;
  canvases: MentionCanvasInput[];
  nodes: MentionNodeInput[];
  assets: MentionAssetInput[];
  timelines: MentionTimelineInput[];
  directorStages?: MentionDirectorStageInput[];
}): CopilotMentionSource[] {
  const canvasNames = new Map(
    input.canvases.map((canvas) => [canvas.id, canvas.name]),
  );
  const assetsById = new Map<string, MentionAssetInput>();
  for (const asset of input.assets) {
    assetsById.set(asset.id, asset);
  }
  const currentCanvas: CopilotMentionSource[] = [];
  const otherCanvases: CopilotMentionSource[] = [];

  for (const node of input.nodes) {
    const canvasId = node.canvasId || input.activeCanvasId;
    const canvasName = canvasNames.get(canvasId) || canvasId;
    const assetId =
      typeof node.data?.assetId === "string" ? node.data.assetId : undefined;
    const nodeAsset = assetId ? assetsById.get(assetId) : undefined;
    const source: CopilotMentionSource = {
      id: node.id,
      type: node.type || "node",
      label: nodeLabel(node),
      kind: "node",
      scope:
        canvasId === input.activeCanvasId ? "current-canvas" : "other-canvases",
      description: nodeDescription(node.type || "node", canvasName),
      canvasId,
      canvasName,
      thumbnail: nodeAsset
        ? (assetThumbnailImageUrl(nodeAsset) ?? undefined)
        : undefined,
    };
    if (canvasId === input.activeCanvasId) currentCanvas.push(source);
    else otherCanvases.push(source);
  }

  const assets: CopilotMentionSource[] = input.assets.map((asset) => ({
    id: asset.id,
    type: asset.kind,
    label:
      asset.name?.trim() || asset.metadata.originalName?.trim() || asset.id,
    kind: "asset",
    scope:
      input.activeSurface.kind === "asset" &&
      input.activeSurface.assetId === asset.id
        ? "current-surface"
        : "project-assets",
    description: `${humanizeType(asset.kind)} · Project asset`,
    thumbnail: assetThumbnailImageUrl(asset) ?? undefined,
  }));

  const timelines: CopilotMentionSource[] = input.timelines.map((timeline) => ({
    id: timeline.id,
    type: "timeline",
    label: timeline.name,
    kind: "timeline",
    scope:
      input.activeSurface.kind === "timeline" &&
      input.activeSurface.timelineId === timeline.id
        ? "current-surface"
        : "timelines",
    description: "Timeline · Project",
  }));

  const directorStages: CopilotMentionSource[] = (
    input.directorStages ?? []
  ).map((stage) => ({
    id: stage.id,
    type: "director-stage",
    label: stage.name,
    kind: "director-stage",
    scope:
      input.activeSurface.kind === "director-stage" &&
      input.activeSurface.stageId === stage.id
        ? "current-surface"
        : "director-stages",
    description: "Director Stage · Project 3D scene",
  }));

  const activeSurface = [...assets, ...timelines, ...directorStages].filter(
    (source) => source.scope === "current-surface",
  );
  const remainingAssets = assets.filter(
    (source) => source.scope !== "current-surface",
  );
  const remainingTimelines = timelines.filter(
    (source) => source.scope !== "current-surface",
  );
  const remainingDirectorStages = directorStages.filter(
    (source) => source.scope !== "current-surface",
  );
  return [
    ...activeSurface,
    ...currentCanvas,
    ...remainingAssets,
    ...remainingTimelines,
    ...remainingDirectorStages,
    ...otherCanvases,
  ];
}

export function buildCopilotPrompt(
  prompt: string,
  context?: CopilotWorkspaceContext,
  _sources: CopilotMentionSource[] = [],
  annotations: readonly AgentAnnotationDraft[] = [],
): string {
  const contextBlocks: string[] = [];
  if (context) {
    const payload = JSON.stringify({
      version: 1,
      projectId: context.projectId,
      projectName: context.projectName,
      activeSurface: context.activeSurface,
      trust:
        context.activeSurface.kind === "browser"
          ? "untrusted-browser-content"
          : "untrusted-workspace-data",
    })
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e");
    contextBlocks.push(`<!-- clash-workspace-context ${payload} -->`);
  }
  const annotationBlock = serializeAgentAnnotationPromptBlock(annotations);
  if (annotationBlock) contextBlocks.push(annotationBlock);
  return contextBlocks.length > 0
    ? `${contextBlocks.join("\n")}\n${prompt}`
    : prompt;
}
