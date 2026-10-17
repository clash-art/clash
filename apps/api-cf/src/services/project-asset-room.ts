/**
 * ProjectRoom-side adapter for the shared Project Asset document logic.
 *
 * `project-room.ts` imports this module with `import()` inside an internal
 * operation, so none of it (or the shared Asset module it pulls) enters the
 * Worker/DO startup graph. Commits follow review R11: run on a fork inside the
 * room's import queue, export only the new update, then persist and broadcast.
 */
import type { LoroDoc } from "loro-crdt";
import { ResourceSchema } from "@clash/shared-types";
import {
  applyProjectAssetLifecycle,
  commitProjectAssetImport,
  observeProjectAsset,
  selectProjectAssets,
  type ProjectAssetImportCommand,
  type ProjectAssetImportResult,
  type ProjectAssetLifecycleCommand,
  type ProjectAssetLifecycleResult,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import { verifyProjectAssetReceipt } from "./project-asset-receipts";
import { createD1ProjectAuthorizationStore } from "../loro/authorization-store";
import { createR2ResourceRegistry } from "./project-content-cloud";
import type { Env } from "../config";

export type ProjectAssetRoomOperation = "list" | "get" | "commit" | "lifecycle";

export interface ProjectAssetRoomInput {
  operation: ProjectAssetRoomOperation;
  request: Request;
  env: Env;
  projectId: string;
  doc: LoroDoc;
  /** The room's one serialized import-queue item. */
  enqueue(run: () => Promise<void>): Promise<void>;
  persist(update: Uint8Array): Promise<void>;
  broadcast(update: Uint8Array): void;
}

export class ProjectAssetRoomError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
    readonly body: Record<string, unknown> = { error: message },
  ) {
    super(message);
    this.name = "ProjectAssetRoomError";
  }
}

async function effectiveTenant(env: Env, projectId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(tenant_id, 'personal:' || owner_id) AS tenant_id FROM project WHERE id = ? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(projectId)
    .first<{ tenant_id: string | null }>();
  if (!row?.tenant_id) throw PROJECT_NOT_FOUND();
  return row.tenant_id;
}

const PROJECT_NOT_FOUND = () =>
  new ProjectAssetRoomError(404, "Project not found", {
    error: "Project not found",
    code: "PROJECT_NOT_FOUND",
  });

/** Ownership can change between the REST check and the queue item. */
async function assertOwner(input: ProjectAssetRoomInput, userId: string) {
  const project = await createD1ProjectAuthorizationStore({
    DB: input.env.DB,
  }).readProject(input.projectId);
  if (!project || project.ownerId !== userId || project.deletedAt !== null)
    throw PROJECT_NOT_FOUND();
}

/**
 * Run `edit` on a fork inside the room's write queue; persist and broadcast
 * only the delta, and only when `edit` reports a change. Persisting applies
 * the update to the live document.
 */
async function writeOnFork<T>(
  input: ProjectAssetRoomInput,
  userId: string,
  edit: (fork: LoroDoc) => Promise<{ value: T; changed: boolean }>,
): Promise<T> {
  let value: T | undefined;
  let done = false;
  await input.enqueue(async () => {
    await assertOwner(input, userId);
    const liveVersion = input.doc.oplogVersion();
    const fork = input.doc.fork();
    try {
      const result = await edit(fork);
      value = result.value;
      done = true;
      if (!result.changed) return;
      fork.commit({ origin: "project-asset" });
      const update = fork.export({ mode: "update", from: liveVersion });
      if (update.byteLength === 0) return;
      await input.persist(update);
      input.broadcast(update);
    } finally {
      fork.free();
    }
  });
  if (!done)
    throw new ProjectAssetRoomError(503, "Project asset write produced no result");
  return value as T;
}

async function lifecycle(
  input: ProjectAssetRoomInput,
  command: ProjectAssetLifecycleCommand,
): Promise<Response> {
  const userId = input.request.headers.get("x-user-id")?.trim();
  if (!userId) throw PROJECT_NOT_FOUND();
  const outcome = await writeOnFork<
    ProjectAssetLifecycleResult & { version?: string }
  >(input, userId, async (fork) => {
    const result = applyProjectAssetLifecycle(fork, command, {
      verifyReceipt: (version, receipt) =>
        verifyProjectAssetReceipt(
          input.env,
          userId,
          input.projectId,
          version,
          receipt,
        ),
    });
    if (!result.ok) return { value: result, changed: false };
    const version = observeProjectAsset(
      fork,
      input.projectId,
      command.projectAssetId,
    )?.version;
    return {
      value: { ...result, ...(version ? { version } : {}) },
      changed: result.mutated,
    };
  });
  return outcome.ok
    ? Response.json({
        entry: outcome.entry,
        ...(outcome.version ? { version: outcome.version } : {}),
      })
    : Response.json(outcome.body, { status: outcome.status });
}

/**
 * Import a sealed Resource as a Project Asset on `fork` (a room-queue fork).
 * The one Cloudflare commit path: Asset uploads and Timeline render
 * publication (`generation/timeline-render-publication.ts`) both use it.
 */
export async function importProjectAsset(
  env: Env,
  projectId: string,
  fork: LoroDoc,
  command: ProjectAssetImportCommand,
): Promise<ProjectAssetImportResult> {
  const tenantId = await effectiveTenant(env, projectId);
  const registry = createR2ResourceRegistry(env.R2_BUCKET as never);
  return commitProjectAssetImport(fork, command, {
    readResource: (resourceId) => registry(tenantId, resourceId),
  });
}

async function commit(
  input: ProjectAssetRoomInput,
  command: ProjectAssetImportCommand,
): Promise<Response> {
  const userId = input.request.headers.get("x-user-id")?.trim();
  if (!userId) throw PROJECT_NOT_FOUND();
  const outcome = await writeOnFork<ProjectAssetImportResult>(
    input,
    userId,
    async (fork) => {
      const result = await importProjectAsset(
        input.env,
        input.projectId,
        fork,
        command,
      );
      // A refused import leaves the live document untouched.
      return { value: result, changed: result.ok };
    },
  );
  return outcome.ok
    ? Response.json(outcome)
    : Response.json(outcome.body, { status: outcome.status });
}

export async function handleProjectAssetRoomOperation(
  input: ProjectAssetRoomInput,
): Promise<Response> {
  try {
    if (input.operation === "list") {
      return Response.json({
        assets: selectProjectAssets(input.doc, input.projectId),
      });
    }
    if (input.operation === "get") {
      const assetId = new URL(input.request.url).searchParams
        .get("assetId")
        ?.trim();
      if (!assetId)
        throw new ProjectAssetRoomError(400, "assetId is required");
      const observed = observeProjectAsset(
        input.doc,
        input.projectId,
        assetId,
      );
      if (!observed)
        throw new ProjectAssetRoomError(404, "Asset not found");
      return Response.json({
        entry: observed.entry,
        references: observed.references,
        version: observed.version,
      });
    }
    if (input.operation === "commit") {
      const raw = (await input.request.json().catch(() => null)) as {
        projectId?: unknown;
        projectAssetId?: unknown;
        resource?: unknown;
        name?: unknown;
        metadata?: unknown;
        createdAt?: unknown;
        duplicateContent?: unknown;
      } | null;
      if (
        !raw ||
        raw.projectId !== input.projectId ||
        typeof raw.projectAssetId !== "string" ||
        !raw.projectAssetId.trim() ||
        typeof raw.name !== "string" ||
        !raw.name.trim() ||
        !Number.isSafeInteger(raw.createdAt) ||
        !raw.metadata ||
        typeof raw.metadata !== "object"
      )
        throw new ProjectAssetRoomError(400, "Invalid asset commit");
      const resource = ResourceSchema.safeParse(raw.resource);
      if (!resource.success)
        throw new ProjectAssetRoomError(400, "Invalid Resource");
      const duplicateContent =
        raw.duplicateContent === "allow" || raw.duplicateContent === "reject"
          ? raw.duplicateContent
          : undefined;
      return await commit(input, {
        projectId: input.projectId,
        projectAssetId: raw.projectAssetId.trim(),
        resource: resource.data,
        name: raw.name.trim(),
        metadata: raw.metadata as Record<string, unknown>,
        createdAt: raw.createdAt as number,
        ...(duplicateContent ? { duplicateContent } : {}),
      });
    }
    if (input.operation === "lifecycle") {
      const raw = (await input.request.json().catch(() => null)) as
        | ProjectAssetLifecycleCommand
        | null;
      if (
        !raw ||
        raw.projectId !== input.projectId ||
        (raw.action !== "trash" && raw.action !== "restore") ||
        typeof raw.projectAssetId !== "string" ||
        !raw.projectAssetId.trim() ||
        typeof raw.observation !== "object" ||
        raw.observation === null ||
        (raw.action === "trash" &&
          (typeof raw.deleteOperationId !== "string" ||
            typeof raw.deletedAt !== "string" ||
            typeof raw.purgeAfter !== "string"))
      )
        throw new ProjectAssetRoomError(400, "Invalid asset lifecycle command");
      return await lifecycle(input, raw);
    }
    throw new ProjectAssetRoomError(400, "Unknown asset operation");
  } catch (error) {
    if (error instanceof ProjectAssetRoomError)
      return Response.json(error.body, { status: error.status });
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Project asset operation failed",
      },
      { status: 503 },
    );
  }
}

