import { Canvas } from "@clash/shared-types";
import { LoroDoc } from "loro-crdt";
import type { DurablePublicFailure } from "@clash/shared-runtime/durable-run-engine";
import type {
  ProjectAssetImportCommand,
  ProjectAssetImportResult,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import type { Env } from "../config";
import { Status } from "../domain/canvas";
import {
  addAssetRef,
  getAssetById,
  type CreateAssetParams,
} from "../services/assets";
import type { GenerationParams } from "./params";
import type {
  StagedProjectAsset,
  TimelineRenderNodePublication,
} from "./timeline-render-publication";

import { GenerationPublicationConflict } from "@clash/shared-runtime/hosted-generation";
export { GenerationPublicationConflict };
export interface HostedGenerationPublication {
  updates: Record<string, unknown>;
  asset?: CreateAssetParams;
  /** `video_render`: the sealed Resource to import as the run's Project Asset. */
  render?: StagedProjectAsset;
  /**
   * A remote plugin's uploaded output: imported as Project Asset
   * `updates.assetId` in the same room transaction that completes the node.
   */
  projectAsset?: StagedProjectAsset;
  failure?: DurablePublicFailure;
}
export async function assertHostedGenerationAccess(
  env: Pick<Env, "DB">,
  params: GenerationParams,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT owner_id, deleted_at FROM project WHERE id = ?",
  )
    .bind(params.projectId)
    .first<{ owner_id: string; deleted_at: number | null }>();
  if (!row || row.deleted_at != null || row.owner_id !== params.actorUserId)
    throw new GenerationPublicationConflict(
      "Generation actor no longer has Project access.",
    );
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
async function publishAsset(
  env: Env,
  params: GenerationParams,
  asset: CreateAssetParams,
) {
  if (
    asset.id !== params.taskId ||
    asset.sourceTaskId !== params.taskId ||
    asset.userId !== params.actorUserId ||
    asset.projectId !== params.projectId
  )
    throw new GenerationPublicationConflict(
      "Prepared Asset identity conflicts with its run.",
    );
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO assets (id, user_id, kind, src_r2_key, cover_r2_key, metadata, source_model, source_prompt, source_task_id, sources, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      asset.id,
      asset.userId,
      asset.kind,
      asset.srcR2Key,
      asset.coverR2Key ?? null,
      JSON.stringify(asset.metadata ?? {}),
      asset.sourceModel ?? null,
      asset.sourcePrompt ?? null,
      asset.sourceTaskId,
      asset.sources?.length ? JSON.stringify(asset.sources) : null,
      now,
      now,
    )
    .run();
  const existing = await getAssetById(env.DB, asset.id!);
  if (
    !existing ||
    existing.userId !== asset.userId ||
    existing.kind !== asset.kind ||
    existing.srcR2Key !== asset.srcR2Key ||
    existing.coverR2Key !== (asset.coverR2Key ?? null) ||
    existing.sourceTaskId !== asset.sourceTaskId ||
    existing.sourceModel !== (asset.sourceModel ?? null) ||
    existing.sourcePrompt !== (asset.sourcePrompt ?? null) ||
    canonical(existing.metadata ?? {}) !== canonical(asset.metadata ?? {}) ||
    canonical(existing.sources ?? []) !== canonical(asset.sources ?? [])
  ) {
    throw new GenerationPublicationConflict(
      "Generation Asset publication conflicts with the existing immutable output.",
    );
  }
}

/**
 * Acknowledge real ProjectRoom publication before the durable run reports success.
 * A Timeline render (`video_render`) publishes a Project Asset and its render node
 * in one room transaction; every other generation keeps the library Asset path.
 */
export async function publishHostedGeneration(
  env: Env,
  params: GenerationParams,
  publication: HostedGenerationPublication,
): Promise<void> {
  await assertHostedGenerationAccess(env, params);
  const render = params.type === "video_render";
  if (render && !publication.failure && !publication.render)
    throw new GenerationPublicationConflict(
      "Timeline render output was not staged as a Project Resource.",
    );
  if (publication.asset) await publishAsset(env, params, publication.asset);
  const identity = {
    taskId: params.taskId,
    nodeId: params.nodeId,
    actorUserId: params.actorUserId,
  };
  const response = await env.ROOM.get(
    env.ROOM.idFromName(params.projectId),
  ).fetch(
    new Request(
      `https://do/loro/${encodeURIComponent(params.projectId)}/${render ? "timeline-render-publication" : "generation-publication"}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-loro": "true",
          "x-loro-project-id": params.projectId,
        },
        body: JSON.stringify(
          render
            ? ({
                ...identity,
                ...(publication.failure
                  ? { failure: publication.failure }
                  : { render: publication.render }),
              } satisfies TimelineRenderNodePublication)
            : ({
                ...identity,
                updates: publication.updates,
                ...(publication.failure
                  ? { failure: publication.failure }
                  : {}),
                ...(publication.projectAsset
                  ? { projectAsset: publication.projectAsset }
                  : {}),
              } satisfies GenerationNodePublication),
        ),
      },
    ),
  );
  await response.body?.cancel();
  if (
    response.status === 409 ||
    response.status === 403 ||
    response.status === 404
  )
    throw new GenerationPublicationConflict(
      `Project generation publication rejected: HTTP ${response.status}`,
    );
  if (!response.ok)
    throw new Error(
      `Project generation publication failed: HTTP ${response.status}`,
    );
  if (publication.asset)
    await addAssetRef(env.DB, publication.asset.id!, params.projectId);
}

export interface GenerationNodePublication {
  taskId: string;
  nodeId: string;
  actorUserId: string;
  updates: Record<string, unknown>;
  failure?: DurablePublicFailure;
  projectAsset?: StagedProjectAsset;
}

export type ProjectAssetImporter = (
  candidate: LoroDoc,
  command: ProjectAssetImportCommand,
) => Promise<ProjectAssetImportResult>;

/**
 * Build on a detached candidate. Caller serializes the task check with durable
 * append. A `projectAsset` is imported on the same candidate as the node
 * update, so the Asset and its node output land together or not at all; a
 * republished run is a no-op before any import.
 */
export async function generationPublicationUpdate(
  doc: LoroDoc,
  publication: GenerationNodePublication,
  projectAssets?: { projectId: string; importAsset: ProjectAssetImporter },
): Promise<Uint8Array | null> {
  const canvas = new Canvas(doc, () => undefined);
  const current = canvas.readNode(publication.nodeId);
  if (!current) {
    if (publication.failure) return null;
    throw new GenerationPublicationConflict(
      "Generation output node is missing.",
    );
  }
  const data = current.data as Record<string, unknown>;
  if (publication.failure && data.pendingTask !== publication.taskId)
    return null;
  const status = publication.failure ? Status.Failed : Status.Completed;
  const updates = {
    ...publication.updates,
    // The run's failure is the node's failure; success clears any earlier one.
    error: publication.failure?.message,
    errorCode: publication.failure?.code,
    pendingTask: undefined,
    status,
    generationRunId: publication.taskId,
    _log: undefined,
  };
  if (data.generationRunId === publication.taskId && data.pendingTask == null) {
    if (
      Object.entries(updates).every(([key, value]) =>
        value === undefined
          ? data[key] == null
          : canonical(data[key]) === canonical(value),
      )
    )
      return null;
    throw new GenerationPublicationConflict(
      "Generation publication conflicts with an existing terminal projection.",
    );
  }
  if (data.pendingTask !== publication.taskId)
    throw new GenerationPublicationConflict(
      "Generation output node belongs to a different task.",
    );
  const asset = publication.failure ? undefined : publication.projectAsset;
  const projectAssetId = publication.updates.assetId;
  if (asset && (!projectAssets || typeof projectAssetId !== "string"))
    throw new GenerationPublicationConflict(
      "A Project Asset output must be published with its Asset id and importer.",
    );
  const candidate = new LoroDoc();
  try {
    candidate.import(doc.export({ mode: "snapshot" }));
    const before = candidate.version();
    if (asset && projectAssets) {
      const imported = await projectAssets.importAsset(candidate, {
        projectId: projectAssets.projectId,
        projectAssetId: projectAssetId as string,
        resource: asset.resource,
        name: asset.name,
        metadata: asset.metadata,
        createdAt: asset.createdAt,
        duplicateContent: "allow",
        provenance: { kind: "generation", actionRunId: publication.taskId },
      });
      if (!imported.ok)
        throw new GenerationPublicationConflict(String(imported.body.error));
    }
    if (
      !new Canvas(candidate, () => undefined).updateNode(
        publication.nodeId,
        updates,
      )
    )
      throw new GenerationPublicationConflict(
        "Generation output node is missing.",
      );
    return candidate.export({ mode: "update", from: before });
  } finally {
    candidate.free();
  }
}

export async function claimHostedGenerationNode(
  env: Env,
  params: GenerationParams,
): Promise<void> {
  const response = await env.ROOM.get(
    env.ROOM.idFromName(params.projectId),
  ).fetch(
    new Request(
      `https://do/loro/${encodeURIComponent(params.projectId)}/generation-admission`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-loro": "true",
          "x-loro-project-id": params.projectId,
        },
        body: JSON.stringify({
          taskId: params.taskId,
          nodeId: params.nodeId,
          actorUserId: params.actorUserId,
          updates: {},
        }),
      },
    ),
  );
  await response.body?.cancel();
  if ([403, 404, 409].includes(response.status))
    throw new GenerationPublicationConflict(
      `Project generation admission rejected: HTTP ${response.status}`,
    );
  if (!response.ok)
    throw Object.assign(
      new Error(
        `Project generation admission unavailable: HTTP ${response.status}`,
      ),
      { status: response.status },
    );
}

export function generationAdmissionUpdate(
  doc: LoroDoc,
  publication: GenerationNodePublication,
): Uint8Array | null {
  const node = new Canvas(doc, () => undefined).readNode(publication.nodeId);
  if (!node)
    throw new GenerationPublicationConflict("Generation node is missing.");
  const data = node.data as Record<string, unknown>;
  if (
    data.pendingTask === publication.taskId ||
    data.generationRunId === publication.taskId
  )
    return null;
  if (data.pendingTask != null)
    throw new GenerationPublicationConflict(
      "Generation node already has another task.",
    );
  const candidate = new LoroDoc();
  try {
    candidate.import(doc.export({ mode: "snapshot" }));
    const before = candidate.version();
    new Canvas(candidate, () => undefined).updateNode(publication.nodeId, {
      pendingTask: publication.taskId,
      status: Status.Generating,
      error: undefined,
      errorMessage: undefined,
      errorCode: undefined,
    });
    return candidate.export({ mode: "update", from: before });
  } finally {
    candidate.free();
  }
}
