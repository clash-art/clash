/**
 * ProjectRoom publication of a hosted `video_render` run (the render node the
 * shared `request_timeline_render` command creates). Same projection as the
 * browser render path and api-node: the run's bytes become the Project Asset
 * `taskId` (provenance `render`), and `completeTimelineRenderNode` completes
 * the node in the same room transaction. Render nodes are raw Project Loro
 * records (a Project-Asset render lives outside every Canvas), so this never
 * goes through `Canvas.readNode`.
 *
 * Loaded with `import()` from the room's `timeline-render-publication`
 * operation, so the shared Asset module stays out of Durable Object startup.
 */
import type { LoroDoc } from "loro-crdt";
import { completeTimelineRenderNode, type Resource } from "@clash/shared-types";
import type { DurablePublicFailure } from "@clash/shared-runtime/durable-run-engine";
import type {
  ProjectAssetImportCommand,
  ProjectAssetImportResult,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import { GenerationPublicationConflict } from "@clash/shared-runtime/hosted-generation";

/** The staged output of a render run: its bytes already sealed as a Resource. */
export interface TimelineRenderOutput {
  resource: Resource;
  name: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface TimelineRenderNodePublication {
  taskId: string;
  nodeId: string;
  actorUserId: string;
  render?: TimelineRenderOutput;
  failure?: DurablePublicFailure;
}

type NodeRecord = Record<string, unknown> & { data: Record<string, unknown> };

function readNode(doc: LoroDoc, nodeId: string): NodeRecord | undefined {
  const raw = doc.getMap("nodes").get(nodeId) as
    | Record<string, unknown>
    | undefined;
  const data = raw?.data;
  return raw && data && typeof data === "object" && !Array.isArray(data)
    ? (raw as NodeRecord)
    : undefined;
}

/**
 * The delta to persist, or null when there is nothing to do. Run inside the
 * room's import queue; `importAsset` commits onto the given fork.
 */
export async function timelineRenderPublicationUpdate(
  doc: LoroDoc,
  projectId: string,
  publication: TimelineRenderNodePublication,
  importAsset: (
    fork: LoroDoc,
    command: ProjectAssetImportCommand,
  ) => Promise<ProjectAssetImportResult>,
): Promise<Uint8Array | null> {
  const { taskId, nodeId, failure, render } = publication;
  const node = readNode(doc, nodeId);
  if (!node || node.data.pendingTask !== taskId) {
    // Only a node this run still holds; a newer owner keeps its state.
    if (failure) return null;
    // Redelivered after the first publication committed: nothing to do.
    if (node?.data.status === "completed" && node.data.assetId === taskId)
      return null;
    throw new GenerationPublicationConflict(
      `Render node ${nodeId} is no longer claimed by run ${taskId}`,
    );
  }
  if (!failure && !render)
    throw new GenerationPublicationConflict(
      "Timeline render publication has no staged output.",
    );
  const fork = doc.fork();
  try {
    const before = doc.oplogVersion();
    if (failure) {
      fork.getMap("nodes").set(nodeId, {
        ...node,
        data: {
          ...node.data,
          status: "failed",
          error: failure.message,
          pendingTask: undefined,
          pendingTaskAt: undefined,
        },
      });
    } else if (render) {
      const imported = await importAsset(fork, {
        projectId,
        projectAssetId: taskId,
        resource: render.resource,
        name: render.name,
        metadata: render.metadata,
        createdAt: render.createdAt,
        provenance: { kind: "render", actionRunId: taskId },
      });
      if (!imported.ok)
        throw new GenerationPublicationConflict(String(imported.body.error));
      const completed = completeTimelineRenderNode(fork, {
        renderNodeId: nodeId,
        assetId: taskId,
      });
      if (!completed.ok)
        throw new GenerationPublicationConflict(completed.error);
    }
    fork.commit({ origin: "generation-publication" });
    return fork.export({ mode: "update", from: before });
  } finally {
    fork.free();
  }
}
