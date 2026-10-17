/**
 * api-cf Project Asset adapter (composition root).
 *
 * The document half of every operation runs in the ProjectRoom DO through the
 * internal `assets-*` operations; this module only parses HTTP, seals R2
 * Resource facts, issues signed read/import capabilities and projects the
 * shared `ResolvedAsset` contract. It is mounted from the lazy REST graph and
 * the DO imports its own adapter with `import()`, so none of it is in startup.
 */
import { Hono } from "hono";
import {
  AssetKindSchema,
  ProjectAssetPublicationMetadataSchema,
  agentReadReceiptToken,
  type AssetKind,
  type ProjectAssetEntry,
  type Resource,
  type ResolvedAsset,
} from "@clash/shared-types";
import {
  ContentTransferLimitError,
  PROJECT_ASSET_IMPORT_MAX_BYTES,
  PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES,
  sanitizeAssetImportMetadataHints,
  type AssetImportMetadataHints,
} from "@clash/asset-sdk";
import {
  normalizeProjectAssetContentType,
  parseProjectAssetBatchIds,
  projectProjectAsset,
  type ProjectAssetImportCommand,
} from "@clash/shared-runtime/cloud-project-host/project-assets";
import { createHmacAssetDeliverySigner } from "@clash/asset-sdk/delivery";
import type { Env } from "../../config";
import { createD1ProjectAuthorizationStore } from "../../loro/auth";
import { createCloudAssetDeliveryPort, verifyCloudAssetDeliveryCapability } from "../../services/cloud-asset-delivery";
import { signProjectAssetReceipt } from "../../services/project-asset-receipts";
import {
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  ProjectContentConflictError,
  createR2ResourceRegistry,
  resourceLocator,
} from "../../services/project-content-cloud";
import { requireSecret } from "../../services/require-secret";
import {
  INVALID_PROJECT_ASSET_TRASH,
  PROJECT_ASSET_PURGE_DELAY_MS,
  parseProjectAssetDeleteOperationId,
  type ProjectAssetLifecycleCommand,
} from "@clash/shared-runtime/cloud-project-host/project-assets";

const unauthorized = (c: any) =>
  c.json({ error: "unauthorized" }, 401);

class ProjectAssetRequestError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 501 | 503,
    message: string,
    readonly body: Record<string, unknown> = { error: message },
  ) {
    super(message);
    this.name = "ProjectAssetRequestError";
  }
}

function errorResponse(
  c: any,
  error: unknown,
): Response {
  if (error instanceof ContentTransferLimitError)
    return c.json(
      { error: error.message, code: error.code, maxBytes: error.maxBytes },
      413,
    );
  if (error instanceof ProjectAssetRequestError)
    return c.json(error.body, error.status);
  if (error instanceof ProjectContentConflictError)
    return c.json({ error: "resource_facts_conflict" }, 409);
  return c.json({ error: "Project asset storage unavailable" }, 503);
}

async function readJsonBody(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  label: string,
  maximum = 512,
): string {
  if (typeof value !== "string") throw invalidImport(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum)
    throw invalidImport(`Invalid ${label}`);
  return normalized;
}

function invalidImport(message: string): ProjectAssetRequestError {
  return new ProjectAssetRequestError(400, message, {
    error: message,
    code: "INVALID_PROJECT_ASSET_IMPORT",
  });
}

function parseKind(value: unknown): AssetKind {
  const kind = AssetKindSchema.safeParse(value);
  if (!kind.success)
    throw invalidImport("A named, non-empty media file and kind are required");
  return kind.data;
}

function parseDuplicateContent(value: unknown): "allow" | "reject" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "allow" && value !== "reject")
    throw invalidImport("duplicateContent must be allow or reject");
  return value;
}

function parseByteLength(
  value: unknown,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new ContentTransferLimitError(PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES);
  if (parsed > PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES)
    throw new ContentTransferLimitError(PROJECT_ASSET_SINGLE_SHOT_MAX_BYTES);
  return parsed;
}

export interface ParsedProjectAssetImport {
  kind: AssetKind;
  projectAssetId: string;
  fileName: string;
  byteLength: number;
  contentType: string | undefined;
  duplicateContent?: "allow" | "reject";
  metadataHints: AssetImportMetadataHints;
  metadata: Record<string, unknown>;
}

/** Pure request parser, unit-tested without a Worker runtime. */
export function parseProjectAssetImportRequest(
  url: URL,
  requestContentType: string | null,
): ParsedProjectAssetImport {
  const kind = parseKind(url.searchParams.get("kind"));
  const projectAssetId = requiredString(
    url.searchParams.get("projectAssetId"),
    "Asset ID",
  );
  const fileName = requiredString(
    url.searchParams.get("fileName"),
    "file name",
  );
  const byteLength = parseByteLength(url.searchParams.get("byteLength"));
  const duplicateContent = parseDuplicateContent(
    url.searchParams.get("duplicateContent"),
  );
  const contentType = normalizeProjectAssetContentType({
    contentType: requestContentType ?? undefined,
    fileName,
    kind,
  });
  const metadataHints = sanitizeAssetImportMetadataHints({
    durationMs: url.searchParams.get("durationMs") ?? undefined,
    width: url.searchParams.get("width") ?? undefined,
    height: url.searchParams.get("height") ?? undefined,
    frameRate: url.searchParams.get("frameRate") ?? undefined,
    hasAudio: url.searchParams.get("hasAudio") ?? undefined,
  });
  return {
    kind,
    projectAssetId,
    fileName,
    byteLength,
    contentType,
    ...(duplicateContent ? { duplicateContent } : {}),
    metadataHints,
    metadata: ProjectAssetPublicationMetadataSchema.parse({
      bytes: byteLength,
      ...(contentType ? { contentType } : {}),
      originalName: fileName,
      ...metadataHints,
    }),
  };
}

export function projectAssetImportMetadata(
  input: {
    byteLength: number;
    fileName: string;
    contentType?: string;
    metadataHints?: AssetImportMetadataHints;
  },
): Record<string, unknown> {
  return ProjectAssetPublicationMetadataSchema.parse({
    bytes: input.byteLength,
    ...(input.contentType ? { contentType: input.contentType } : {}),
    originalName: input.fileName,
    ...sanitizeAssetImportMetadataHints(input.metadataHints),
  });
}

async function effectiveTenant(env: Env, projectId: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(tenant_id, 'personal:' || owner_id) AS tenant_id FROM project WHERE id = ? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(projectId)
    .first<{ tenant_id: string | null }>();
  if (!row?.tenant_id)
    throw new ProjectAssetRequestError(404, "Project not found");
  return row.tenant_id;
}

async function persistTenant(env: Env, projectId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE project SET tenant_id = COALESCE(tenant_id, 'personal:' || owner_id) WHERE id = ?",
  )
    .bind(projectId)
    .run();
}

async function roomCall(
  env: Env,
  projectId: string,
  operation: string,
  init: RequestInit,
): Promise<Response> {
  const id = env.ROOM.idFromName(projectId);
  return env.ROOM.get(id).fetch(
    new Request(
      `http://internal/loro/${encodeURIComponent(projectId)}/${operation}`,
      {
        ...init,
        headers: {
          "x-internal-loro": "true",
          "x-loro-project-id": projectId,
          ...(init.headers as Record<string, string> | undefined),
        },
      },
    ),
  );
}

async function roomJson<T>(
  env: Env,
  projectId: string,
  operation: string,
  init: RequestInit,
): Promise<T> {
  const response = await roomCall(env, projectId, operation, init);
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: unknown })
    | null;
  if (!response.ok)
    throw new ProjectAssetRequestError(
      response.status === 400 || response.status === 404 || response.status === 409
        ? response.status
        : 503,
      typeof body?.error === "string"
        ? body.error
        : `Project asset operation failed (${response.status})`,
      (body ?? { error: "Project asset operation failed" }) as Record<
        string,
        unknown
      >,
    );
  return body as T;
}

async function listEntries(
  env: Env,
  projectId: string,
  userId: string,
): Promise<ProjectAssetEntry[]> {
  const body = await roomJson<{ assets: ProjectAssetEntry[] }>(
    env,
    projectId,
    "assets-list",
    {
      method: "GET",
      headers: { "x-user-id": userId },
    },
  );
  return body.assets;
}

async function observeEntry(
  env: Env,
  projectId: string,
  userId: string,
  assetId: string,
): Promise<{
  entry: ProjectAssetEntry;
  references: unknown[];
  version: string;
}> {
  const query = new URLSearchParams({ assetId });
  return roomJson(
    env,
    projectId,
    `assets-get?${query.toString()}`,
    {
      method: "GET",
      headers: { "x-user-id": userId },
    },
  );
}

async function projectAsset(
  env: Env,
  projectId: string,
  tenantId: string,
  entry: ProjectAssetEntry,
  requestOrigin: string,
): Promise<ResolvedAsset> {
  const registry = createR2ResourceRegistry(env.R2_BUCKET as never);
  const delivery = createCloudAssetDeliveryPort(env, {
    // Ownership/tenant was already checked for this request; the capability
    // resolver re-checks it again when the URL is consumed.
    origin: env.WORKER_PUBLIC_URL ?? requestOrigin,
    authorize: async () => true,
  });
  return projectProjectAsset(
    {
      readResource: (_projectId, resourceId) => registry(tenantId, resourceId),
      available: async (_projectId, resource) => {
        const head = await env.R2_BUCKET.head(
          await resourceLocator(tenantId, resource),
        );
        return !!head && head.size === resource.byteLength;
      },
      mediaUrl: async ({ resource }) => {
        const capability = await delivery.issueReadUrl({
          resourceId: resource.id,
          scope: { tenantId, projectId },
          purpose: "preview",
        });
        return capability.url;
      },
    },
    { projectId, entry },
  );
}

async function signReceipt(
  env: Env,
  userId: string,
  projectId: string,
  version: string,
): Promise<string> {
  return signProjectAssetReceipt(env, userId, projectId, version);
}

function setReadReceipt(
  c: any,
  version: string,
  receipt: string,
): void {
  c.header(
    "x-clash-read-receipt",
    agentReadReceiptToken({ readToken: version, receipt }),
  );
}

function stagingKey(): string {
  return `${PROJECT_ASSET_IMPORT_STAGING_PREFIX}${crypto.randomUUID()}`;
}

function digestHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function resourceFor(input: {
  digest: string;
  kind: AssetKind;
  byteLength: number;
  contentType?: string;
}): Resource {
  return {
    id: `sha256:${input.digest}`,
    kind: input.kind,
    digest: { algorithm: "sha256", value: input.digest },
    byteLength: input.byteLength,
    ...(input.contentType ? { contentType: input.contentType } : {}),
  };
}

async function claimResource(
  env: Env,
  tenantId: string,
  resource: Resource,
): Promise<Resource> {
  const registry = createR2ResourceRegistry(env.R2_BUCKET as never);
  return (await registry(tenantId, resource.id, resource)) ?? resource;
}

async function placeContent(
  env: Env,
  tenantId: string,
  stagedKey: string,
  resource: Resource,
): Promise<void> {
  const contentKey = await resourceLocator(tenantId, resource);
  const existing = await env.R2_BUCKET.head(contentKey);
  if (existing?.size === resource.byteLength) return;
  const staged = await env.R2_BUCKET.get(stagedKey);
  if (!staged) throw new Error("Staged Project Asset bytes are missing");
  await env.R2_BUCKET.put(
    contentKey,
    staged.body,
    resource.contentType
      ? { httpMetadata: { contentType: resource.contentType } }
      : undefined,
  );
}

async function stageImportBody(
  env: Env,
  tenantId: string,
  input: ParsedProjectAssetImport,
  body: ReadableStream<Uint8Array> | null,
): Promise<Resource> {
  if (!body) throw invalidImport("Project Asset import body is required");
  const stagedKey = stagingKey();
  const fixed = new FixedLengthStream(input.byteLength);
  const digestStream = new crypto.DigestStream("SHA-256");
  let received = 0;
  const counted = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > input.byteLength)
          throw invalidImport("Project Asset upload length mismatch");
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== input.byteLength)
          throw invalidImport("Project Asset upload length mismatch");
      },
    }),
  );
  const [forDigest, forStorage] = counted.tee();
  const stored = env.R2_BUCKET.put(
    stagedKey,
    fixed.readable,
    input.contentType
      ? { httpMetadata: { contentType: input.contentType } }
      : undefined,
  );
  try {
    await Promise.all([
      forDigest.pipeTo(digestStream),
      forStorage.pipeTo(fixed.writable),
      stored,
    ]);
    const resource = resourceFor({
      digest: digestHex(await digestStream.digest),
      kind: input.kind,
      byteLength: input.byteLength,
      ...(input.contentType ? { contentType: input.contentType } : {}),
    });
    const claimed = await claimResource(env, tenantId, resource);
    await placeContent(env, tenantId, stagedKey, claimed);
    return claimed;
  } finally {
    await env.R2_BUCKET.delete(stagedKey).catch(() => undefined);
  }
}

async function commitAsset(
  env: Env,
  projectId: string,
  userId: string,
  command: ProjectAssetImportCommand,
): Promise<ProjectAssetEntry> {
  const body = await roomJson<{
    ok: true;
    created: boolean;
    entry: ProjectAssetEntry;
  }>(env, projectId, "assets-commit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-user-id": userId,
    },
    body: JSON.stringify(command),
  });
  return body.entry;
}

function ownerMiddleware() {
  return async (c: any, next: () => Promise<void>) => {
    const userId = c.req.header("x-user-id")?.trim();
    if (!userId) return unauthorized(c);
    const projectId = c.req.param("projectId");
    const project = await createD1ProjectAuthorizationStore(c.env).readProject(
      projectId,
    );
    if (!project || project.ownerId !== userId || project.deletedAt !== null)
      return c.json({ error: "Project not found" }, 404);
    c.header("Cache-Control", "private, no-store");
    await next();
  };
}

export function createProjectAssetRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  const owner = ownerMiddleware();
  app.use("/:projectId/assets", owner);
  app.use("/:projectId/assets/*", owner);

  app.get("/:projectId/assets", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    try {
      const tenantId = await effectiveTenant(c.env, projectId);
      const entries = await listEntries(c.env, projectId, userId);
      return c.json({
        assets: await Promise.all(
          entries.map((entry) =>
            projectAsset(
              c.env,
              projectId,
              tenantId,
              entry,
              new URL(c.req.url).origin,
            ),
          ),
        ),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/:projectId/assets/batch", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    const ids = parseProjectAssetBatchIds(await readJsonBody(c.req.raw));
    if (!ids) return c.json({ error: "Invalid asset IDs" }, 400);
    try {
      const tenantId = await effectiveTenant(c.env, projectId);
      const wanted = new Set(ids);
      const entries = (await listEntries(c.env, projectId, userId)).filter(
        (entry) => wanted.has(entry.id),
      );
      return c.json({
        assets: await Promise.all(
          entries.map((entry) =>
            projectAsset(
              c.env,
              projectId,
              tenantId,
              entry,
              new URL(c.req.url).origin,
            ),
          ),
        ),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/:projectId/assets/import-file", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    try {
      const input = parseProjectAssetImportRequest(
        new URL(c.req.url),
        c.req.header("content-type") ?? null,
      );
      const tenantId = await effectiveTenant(c.env, projectId);
      // Review R7: pin the effective tenant on the first content write so a
      // later Desktop admission lands in the same tenant.
      await persistTenant(c.env, projectId);
      const resource = await stageImportBody(
        c.env,
        tenantId,
        input,
        c.req.raw.body,
      );
      const entry = await commitAsset(c.env, projectId, userId, {
        projectId,
        projectAssetId: input.projectAssetId,
        resource,
        name: input.fileName,
        metadata: input.metadata,
        createdAt: Date.now(),
        ...(input.duplicateContent
          ? { duplicateContent: input.duplicateContent }
          : {}),
      });
      return c.json(
        await projectAsset(
          c.env,
          projectId,
          tenantId,
          entry,
          new URL(c.req.url).origin,
        ),
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/:projectId/assets/import-sessions", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    try {
      const body = await readJsonBody(c.req.raw);
      if (!isRecord(body)) throw invalidImport("Invalid import session");
      const kind = parseKind(body.kind);
      const projectAssetId = requiredString(
        body.projectAssetId,
        "Asset ID",
      );
      const fileName = requiredString(body.fileName, "file name");
      if (
        !Number.isSafeInteger(body.byteLength) ||
        (body.byteLength as number) <= 0
      )
        throw invalidImport("Invalid import byte length");
      const byteLength = body.byteLength as number;
      if (byteLength > PROJECT_ASSET_IMPORT_MAX_BYTES)
        throw new ContentTransferLimitError(PROJECT_ASSET_IMPORT_MAX_BYTES);
      const duplicateContent = parseDuplicateContent(body.duplicateContent);
      const contentType = normalizeProjectAssetContentType({
        contentType:
          typeof body.contentType === "string" ? body.contentType : undefined,
        fileName,
        kind,
      });
      const metadataHints = sanitizeAssetImportMetadataHints(
        body.metadataHints,
      );
      const tenantId = await effectiveTenant(c.env, projectId);
      const origin =
        c.env.WORKER_PUBLIC_URL ?? new URL(c.req.url).origin;
      const signed = await createHmacAssetDeliverySigner({
        secret: requireSecret(
          c.env,
          "JWT_SECRET",
          c.env.JWT_SECRET,
          "dev-asset-delivery-secret",
        ),
        origin,
      }).sign({
        operation: "upload",
        method: "PUT",
        resourceId: `import-session:${crypto.randomUUID()}`,
        scope: { tenantId, projectId },
        purpose: "host-staging",
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        byteLength,
        ...(contentType ? { contentType } : {}),
        importSession: {
          ownerId: userId,
          stagingKey: stagingKey(),
          kind,
          projectAssetId,
          fileName,
          ...(duplicateContent ? { duplicateContent } : {}),
          ...(Object.keys(metadataHints).length
            ? { metadataHints }
            : {}),
        },
      });
      const sessionId = new URL(signed.url).pathname.split("/").pop()!;
      return c.json({ sessionId, upload: { url: signed.url } }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(
    "/:projectId/assets/import-sessions/:sessionId/finalize",
    async (c) => {
      const userId = c.req.header("x-user-id")!;
      const projectId = c.req.param("projectId");
      try {
        const claims = await verifySession(c.env, c.req.param("sessionId"));
        const session = claims.importSession;
        if (
          !session ||
          claims.operation !== "upload" ||
          claims.scope.projectId !== projectId ||
          session.ownerId !== userId ||
          claims.byteLength === undefined
        )
          throw new ProjectAssetRequestError(403, "Invalid import session");
        const project = await createD1ProjectAuthorizationStore(
          c.env,
        ).readProject(projectId);
        if (
          !project ||
          project.ownerId !== userId ||
          project.deletedAt !== null
        )
          throw new ProjectAssetRequestError(404, "Project not found");
        const tenantId = await effectiveTenant(c.env, projectId);
        if (claims.scope.tenantId !== tenantId)
          throw new ProjectAssetRequestError(403, "Invalid import session");
        const staged = await c.env.R2_BUCKET.head(session.stagingKey);
        if (!staged)
          throw new ProjectAssetRequestError(
            404,
            "Import session staging not found",
          );
        if (staged.size !== claims.byteLength)
          throw new ProjectAssetRequestError(
            409,
            "Import session byte length does not match",
          );
        const object = await c.env.R2_BUCKET.get(session.stagingKey);
        if (!object)
          throw new ProjectAssetRequestError(
            404,
            "Import session staging not found",
          );
        const digestStream = new crypto.DigestStream("SHA-256");
        await object.body.pipeTo(digestStream);
        const resource = resourceFor({
          digest: digestHex(await digestStream.digest),
          kind: session.kind,
          byteLength: claims.byteLength,
          ...(claims.contentType ? { contentType: claims.contentType } : {}),
        });
        await persistTenant(c.env, projectId);
        const claimed = await claimResource(c.env, tenantId, resource);
        await placeContent(c.env, tenantId, session.stagingKey, claimed);
        let entry: ProjectAssetEntry;
        try {
          entry = await commitAsset(c.env, projectId, userId, {
            projectId,
            projectAssetId: session.projectAssetId,
            resource: claimed,
            name: session.fileName,
            metadata: projectAssetImportMetadata({
              byteLength: claims.byteLength,
              fileName: session.fileName,
              ...(claims.contentType
                ? { contentType: claims.contentType }
                : {}),
              ...(session.metadataHints
                ? { metadataHints: session.metadataHints }
                : {}),
            }),
            createdAt: Date.now(),
            ...(session.duplicateContent
              ? { duplicateContent: session.duplicateContent }
              : {}),
          });
        } finally {
          await c.env.R2_BUCKET.delete(session.stagingKey).catch(
            () => undefined,
          );
        }
        return c.json(
          await projectAsset(
            c.env,
            projectId,
            tenantId,
            entry,
            new URL(c.req.url).origin,
          ),
          201,
        );
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  app.get("/:projectId/assets/:assetId", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    const assetId = c.req.param("assetId");
    try {
      const tenantId = await effectiveTenant(c.env, projectId);
      const observed = await observeEntry(c.env, projectId, userId, assetId);
      const receipt = await signReceipt(
        c.env,
        userId,
        projectId,
        observed.version,
      );
      setReadReceipt(c, observed.version, receipt);
      return c.json(
        await projectAsset(
          c.env,
          projectId,
          tenantId,
          observed.entry,
          new URL(c.req.url).origin,
        ),
      );
    } catch (error) {
      return error instanceof ProjectAssetRequestError &&
        error.status === 404
        ? c.json({ error: "Asset not found" }, 404)
        : errorResponse(c, error);
    }
  });

  app.get("/:projectId/assets/:assetId/references", async (c) => {
    const userId = c.req.header("x-user-id")!;
    const projectId = c.req.param("projectId");
    const assetId = c.req.param("assetId");
    try {
      const observed = await observeEntry(c.env, projectId, userId, assetId);
      const receipt = await signReceipt(
        c.env,
        userId,
        projectId,
        observed.version,
      );
      setReadReceipt(c, observed.version, receipt);
      return c.json({
        projectAssetId: assetId,
        references: observed.references,
      });
    } catch (error) {
      return error instanceof ProjectAssetRequestError &&
        error.status === 404
        ? c.json({ error: "Asset not found" }, 404)
        : errorResponse(c, error);
    }
  });

  // Trash / restore: soft deletes decided by the shared lifecycle logic
  // inside ProjectRoom's write queue. Bytes and Resources are untouched.
  const lifecycle = async (c: any, command: ProjectAssetLifecycleCommand) => {
    const userId = c.req.header("x-user-id")!;
    const { projectId } = command;
    try {
      const tenantId = await effectiveTenant(c.env, projectId);
      const result = await roomJson<{
        entry: ProjectAssetEntry;
        version?: string;
      }>(c.env, projectId, "assets-lifecycle", {
        method: "POST",
        headers: { "content-type": "application/json", "x-user-id": userId },
        body: JSON.stringify(command),
      });
      if (result.version)
        setReadReceipt(
          c,
          result.version,
          await signReceipt(c.env, userId, projectId, result.version),
        );
      return c.json(
        await projectAsset(
          c.env,
          projectId,
          tenantId,
          result.entry,
          new URL(c.req.url).origin,
        ),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  };
  const writeObservation = (c: any) => {
    const actorClientType = c.req.header("x-clash-client-type")?.trim();
    const expectedReadToken = c.req.header("x-clash-if-match")?.trim();
    return {
      ...(actorClientType ? { actorClientType } : {}),
      ...(expectedReadToken ? { expectedReadToken } : {}),
    };
  };
  app.delete("/:projectId/assets/:assetId", async (c) => {
    const deleteOperationId = parseProjectAssetDeleteOperationId(
      await readJsonBody(c.req.raw),
    );
    if (!deleteOperationId)
      return c.json(
        INVALID_PROJECT_ASSET_TRASH.body,
        INVALID_PROJECT_ASSET_TRASH.status,
      );
    const now = Date.now();
    return lifecycle(c, {
      action: "trash",
      projectId: c.req.param("projectId"),
      projectAssetId: c.req.param("assetId"),
      deleteOperationId,
      deletedAt: new Date(now).toISOString(),
      purgeAfter: new Date(now + PROJECT_ASSET_PURGE_DELAY_MS).toISOString(),
      observation: writeObservation(c),
    });
  });
  app.post("/:projectId/assets/:assetId/restore", (c) =>
    lifecycle(c, {
      action: "restore",
      projectId: c.req.param("projectId"),
      projectAssetId: c.req.param("assetId"),
      observation: writeObservation(c),
    }),
  );

  return app;
}

async function verifySession(env: Env, sessionId: string) {
  const claims = await verifyCloudAssetDeliveryCapability(env, sessionId);
  if (!claims)
    throw new ProjectAssetRequestError(403, "Invalid import session");
  return claims;
}

/** Hosted has no personal library yet: an empty list, never a 404. */
export function createPersonalAssetLibraryRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/personal/assets", (c) => {
    if (!c.req.header("x-user-id")) return unauthorized(c);
    return c.json({ assets: [] });
  });
  return app;
}
