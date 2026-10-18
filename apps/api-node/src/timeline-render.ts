/**
 * Node execution of the pending render node that the shared
 * `request_timeline_render` command creates, over the shared hosted
 * generation pipeline (`type: "video_render"`).
 *
 * - Admission runs inside the host-command's Project transaction: the node is
 *   claimed (`generating` + `pendingTask`) and the run journaled with its
 *   dispatch intent, all with the same log append. A synced local Host
 *   therefore never sees an unclaimed pending render node, and a rejected
 *   admission leaves no node behind.
 * - The run id is `projectTimelineRenderActionRunId(renderNodeId)`; BullMQ job
 *   ids and the journal CAS derive from it, so a redelivered job advances the
 *   same run instead of starting a second render.
 * - Publication imports the Project Asset under the run id and completes the
 *   node in one transaction; republishing the same run is a no-op.
 *
 * apps/render-server stays the only renderer: media is handed to it as
 * short-lived signed URLs (project-media-url.ts).
 */
import type { LoroDoc } from "loro-crdt";
import {
  completeTimelineRenderNode,
  projectTimelineRenderActionRunId,
  ResourceSchema,
} from "@clash/shared-types";
import type { ExecutablePluginJsonValue } from "@clash/shared-types/executable-plugin";
import { resolveTimelineMediaReferences } from "@clash/shared-runtime/cloud-project-host/project-asset-references";
import type { DurableRunClock } from "@clash/shared-runtime/durable-run-engine";
import type { GenerationParams } from "@clash/shared-runtime/generation-params";
import {
  frozenGeneration,
  GenerationPublicationConflict,
  HOSTED_GENERATION_OUTPUT_SLOT,
} from "@clash/shared-runtime/hosted-generation";
import type { PostgresQueryPort } from "@clash/shared-runtime/project-authorization-postgres";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import {
  renderTimelineVideo,
  type RenderServerPort,
} from "@clash/shared-runtime/render-server";
import {
  createNodeGenerationService,
  NODE_GENERATION_OWNER,
  type NodeGenerationPorts,
} from "./generation.ts";
import { storeMediaBytes } from "./media-store.ts";
import { admitProjectMedia } from "./project-assets.ts";
import { nodeProjectAssetReferences } from "./project-media-url.ts";
import { withProjectDocument } from "./project-document.ts";

/** What the render worker process needs; the API process only admits. */
export interface NodeTimelineRenderWorkerOptions {
  renderServer: RenderServerPort;
  /** BETTER_AUTH_SECRET: signs media URLs that the API server verifies. */
  mediaSecret: string;
  /** CLOUD_PUBLIC_URL, which serves the signed media route. */
  publicUrl: string;
  /** CLOUD_ASSET_DIR, shared with the API server. */
  assetDirectory: string;
  clock?: DurableRunClock;
}

interface StagedRender {
  resource: unknown;
  name: string;
  metadata: Record<string, unknown>;
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

const claimedBy = (node: NodeRecord | undefined, taskId: string) =>
  node?.data.pendingTask === taskId && node.data.status === "generating";
const publishedBy = (node: NodeRecord | undefined, taskId: string) =>
  node?.data.status === "completed" && node.data.assetId === taskId;

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** The actor's Project transaction; a lost Project or owner is a conflict, not a retry. */
async function inProject<T>(
  db: PostgresTransactionPort,
  params: GenerationParams,
  mutate: boolean | ((result: T) => boolean),
  work: (doc: LoroDoc, tx: PostgresQueryPort) => T | Promise<T>,
): Promise<T> {
  try {
    return await withProjectDocument(
      db,
      params.actorUserId,
      params.projectId,
      mutate,
      work,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Project not found")
      throw new GenerationPublicationConflict("Project not found");
    throw error;
  }
}

/**
 * Each media item's Project Asset becomes a fresh signed URL render-server can
 * fetch, through the shared resolver; an unavailable Asset fails the run with
 * `reference_unavailable` before anything is rendered.
 */
function withSignedMedia(
  db: PostgresTransactionPort,
  worker: NodeTimelineRenderWorkerOptions,
  params: GenerationParams,
): Promise<Record<string, unknown>> {
  const now = worker.clock?.now() ?? Date.now();
  return inProject(db, params, false, (doc, tx) =>
    resolveTimelineMediaReferences(params.timelineDsl ?? {}, {
      projectId: params.projectId,
      references: nodeProjectAssetReferences({
        doc,
        tx,
        secret: worker.mediaSecret,
        publicUrl: worker.publicUrl,
        now,
      }),
      assetIdOf: (item) =>
        typeof item.assetId === "string" ? item.assetId : undefined,
    }),
  );
}

/**
 * The generation ports for Timeline renders. `worker` is absent at admission,
 * which only journals and claims; execution happens in the outbox worker.
 */
export function nodeTimelineRenderPorts(
  db: PostgresTransactionPort,
  worker?: NodeTimelineRenderWorkerOptions,
): NodeGenerationPorts {
  const params = (run: Parameters<typeof frozenGeneration>[0]) =>
    frozenGeneration(run, NODE_GENERATION_OWNER).params;
  const executing = () => {
    if (!worker) throw Error("Timeline render executes only in the render worker.");
    return worker;
  };
  const now = () => worker?.clock?.now() ?? Date.now();
  return {
    ...(worker?.clock ? { clock: worker.clock } : {}),
    async assertAccess(p) {
      if (p.type !== "video_render")
        throw new GenerationPublicationConflict(
          "The Node render worker executes only Timeline renders.",
        );
      const owned = await db.query(
        "SELECT id FROM project WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL",
        [p.projectId, p.actorUserId],
      );
      if (!owned.rows.length)
        throw new GenerationPublicationConflict("Project not found");
    },
    resolveRoute: async () => undefined,
    beforeStart: async () => {},
    // Before rendering: the node must still belong to this run.
    async claim(p) {
      const node = await inProject(db, p, false, (doc) => readNode(doc, p.nodeId));
      if (!claimedBy(node, p.taskId) && !publishedBy(node, p.taskId))
        throw new GenerationPublicationConflict(
          `Render node ${p.nodeId} is no longer claimed by run ${p.taskId}`,
        );
    },
    checkpoint: (_run, _name, action) => action(),
    provider: {
      async submit({ run }) {
        const w = executing();
        const p = params(run);
        const rendered = await renderTimelineVideo(w.renderServer, {
          timelineDsl: await withSignedMedia(db, w, p),
          projectId: p.projectId,
          taskId: p.taskId,
        });
        const stored = await storeMediaBytes(w.assetDirectory, {
          kind: "video",
          name: `${p.nodeId}.mp4`,
          type: "video/mp4",
          bytes: new Uint8Array(rendered.bytes),
        });
        const staged: StagedRender = {
          resource: stored.resource,
          name: stored.name,
          metadata: json({ ...stored.metadata, ...rendered.metadata }),
        };
        return {
          status: "completed",
          outputs: [
            {
              slot: HOSTED_GENERATION_OUTPUT_SLOT,
              kind: "value",
              value: json(staged) as unknown as ExecutablePluginJsonValue,
            },
          ],
        };
      },
      poll: async () => {
        throw Error("Timeline render completes in one submit.");
      },
    },
    async stage({ outputs }) {
      const output = outputs.find(
        (candidate) => candidate.slot === HOSTED_GENERATION_OUTPUT_SLOT,
      );
      if (output?.kind !== "value")
        throw Error("Timeline render did not produce its output.");
      return output.value;
    },
    async publish({ run, stagedOutput }) {
      const p = params(run);
      const staged = stagedOutput as unknown as StagedRender;
      const resource = ResourceSchema.parse(staged.resource);
      await inProject(db, p, (changed: boolean) => changed, async (doc, tx) => {
        const node = readNode(doc, p.nodeId);
        // Redelivered after the first publication committed: nothing to do.
        if (publishedBy(node, p.taskId)) return false;
        if (!claimedBy(node, p.taskId))
          throw new GenerationPublicationConflict(
            `Render node ${p.nodeId} is no longer claimed by run ${p.taskId}`,
          );
        const imported = await admitProjectMedia(doc, tx, {
          projectId: p.projectId,
          projectAssetId: p.taskId,
          resource,
          name: staged.name,
          metadata: staged.metadata,
          createdAt: now(),
          provenance: { kind: "render", actionRunId: p.taskId },
        });
        if (!imported.ok)
          throw new GenerationPublicationConflict(String(imported.body.error));
        const completed = completeTimelineRenderNode(doc, {
          renderNodeId: p.nodeId,
          assetId: p.taskId,
        });
        if (!completed.ok)
          throw new GenerationPublicationConflict(completed.error);
        return true;
      });
    },
    async publishFailure({ run, failure }) {
      const p = params(run);
      try {
        await inProject(db, p, (changed: boolean) => changed, (doc) => {
          const node = readNode(doc, p.nodeId);
          // Only a node this run still holds; a newer owner keeps its state.
          if (!node || !claimedBy(node, p.taskId)) return false;
          doc.getMap("nodes").set(p.nodeId, {
            ...node,
            data: {
              ...node.data,
              status: "failed",
              error: failure.message,
              errorCode: failure.code,
              pendingTask: undefined,
              pendingTaskAt: undefined,
            },
          });
          return true;
        });
      } catch (error) {
        // A deleted Project has no node left to project the failure onto.
        if (!(error instanceof GenerationPublicationConflict)) throw error;
      }
    },
  };
}

/** Coordinator and journal for the outbox worker's BullMQ generation queue. */
export function createNodeTimelineRenderService(
  db: PostgresTransactionPort,
  worker: NodeTimelineRenderWorkerOptions,
) {
  return createNodeGenerationService(db, nodeTimelineRenderPorts(db, worker));
}

/**
 * Journal and claim the render node the shared command just created, inside
 * the same Project transaction. A retried host-command still creates a second
 * render node (issue #218); deduplication here is per render node.
 */
export async function admitNodeTimelineRender(input: {
  doc: LoroDoc;
  tx: PostgresQueryPort;
  projectId: string;
  renderNodeId: string;
  clock?: DurableRunClock;
}): Promise<void> {
  const { doc, tx, projectId, renderNodeId } = input;
  const node = readNode(doc, renderNodeId);
  if (!node || typeof node.data.actorUserId !== "string")
    throw Error(`Render node ${renderNodeId} is missing its actor`);
  const data = node.data;
  const db: PostgresTransactionPort = {
    query: tx.query.bind(tx),
    transaction: async (callback) => callback(tx),
  };
  const now = () => input.clock?.now() ?? Date.now();
  const ports: NodeGenerationPorts = {
    ...nodeTimelineRenderPorts(db),
    ...(input.clock ? { clock: input.clock } : {}),
    // Claimed in the admitting transaction, so the local Host's processor
    // (pending, no pendingTask) never picks the node up.
    async claim(p) {
      const current = readNode(doc, p.nodeId);
      if (!current) throw Error(`Render node ${p.nodeId} was not found`);
      doc.getMap("nodes").set(p.nodeId, {
        ...current,
        data: {
          ...current.data,
          status: "generating",
          pendingTask: p.taskId,
          pendingTaskAt: now(),
        },
      });
    },
  };
  await createNodeGenerationService(db, ports).enqueue({
    taskId: projectTimelineRenderActionRunId(renderNodeId),
    nodeId: renderNodeId,
    projectId,
    type: "video_render",
    actorType: data.actorType === "agent" ? "agent" : "user",
    actorUserId: data.actorUserId as string,
    ...(typeof data.actorAgentId === "string"
      ? { actorAgentId: data.actorAgentId }
      : {}),
    timelineDsl: data.timelineDsl as Record<string, unknown>,
  });
}
