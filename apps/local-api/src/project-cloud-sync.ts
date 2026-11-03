import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import {
  createProjectCloudSyncCoordinator,
  isActionRequiredSyncFailure,
  PROJECT_CLOUD_MIRROR_FAILED,
  projectCloudSyncFailureMessage,
} from "@clash/shared-runtime/project-cloud-sync";
import { decodeImportBlobMeta, VersionVector } from "loro-crdt";
import {
  createProjectMetadataReplicator,
  metadataBodyBlobPath,
} from "@clash/shared-runtime";
import { createStructuredLogger } from "@clash/shared-runtime/logging";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import {
  listProjectAssets,
  listProjectTimelines,
  ResourceSchema,
  type ProjectCloudAdmission,
  type ProjectMetadata,
  type Resource,
} from "@clash/shared-types";
import {
  assertContentTransferSize,
  readBoundedContent,
  readContentTransferLimitError,
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  contentTransferMaxBytes,
  pushResource,
  ResourceReplicationError,
  type AssetDeliveryPort,
  type AssetDeliveryUrl,
  type ResourceByteStore,
} from "@clash/asset-sdk/delivery";
import { cloudContentUploadSession } from "./cloud-content-upload-sessions.js";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import { getLocalReplicaId } from "./local-replica-identity.js";
import {
  createLocalResourceStore,
  LocalResourceError,
} from "./local-resource-store.js";
import {
  cloudContentChunks,
  installCloudContentFile,
  uploadCloudContentFile,
  validateCloudContentResponse,
  verifyCloudContentFile,
} from "./project-cloud-content.js";
import {
  createLocalResourcePrefetcher,
  LocalResourceDownloadError,
  PREFETCH_RANK,
  type LocalResourceDownloadContext,
  type LocalResourcePrefetchPlanItem,
  type LocalResourcePrefetchRef,
} from "./local-resource-prefetch.js";
import type { LocalAssetInspectionService } from "./local-asset-inspections.js";
import type { LocalLoroRoomHub, RemoteLoroPersistence } from "./sync.js";

const PROJECT_CLOUD_PULL_STAGING_DISCARD_FAILED =
  "PROJECT_CLOUD_PULL_STAGING_DISCARD_FAILED";
const projectCloudSyncLog = createStructuredLogger({
  component: "local-api",
  module: "project-cloud-sync",
});

class ProjectContentHttpError extends Error {
  constructor(readonly status: number) {
    super(`Project content transport failed (${status})`);
  }
}

export interface LocalProjectCloudSyncOptions {
  dataDir: string;
  rooms: Pick<LocalLoroRoomHub, "mergeRemoteSnapshot" | "inspectProject"> &
    Partial<Pick<LocalLoroRoomHub, "reportResourceStoreState">>;
  remote(projectId: string): Promise<RemoteLoroPersistence | undefined>;
  metadata: {
    list(): Promise<string[]>;
    /** One scoped admission query; the Host wires this to SQLite. */
    listAdmissions?(
      localReplicaId: string,
    ): Promise<ProjectCloudAdmission[]>;
    read(projectId: string): Promise<ProjectMetadata | null>;
    write(metadata: ProjectMetadata): Promise<void>;
    isProvisional?(projectId: string): Promise<boolean>;
  };
  token(baseUrl: string, userId: string): Promise<string | undefined>;
  inspection: Pick<LocalAssetInspectionService, "finalize">;
  fetch?: typeof globalThis.fetch;
  /** Floor for the automatic admission scan; only armed while a syncable Project exists. */
  retryMs?: number;
  /** Extra random delay above the floor, so a fleet does not poll in lockstep. */
  retryJitterMs?: number;
  /** Maximum Project syncs running at once (default 2). */
  maxConcurrent?: number;
  /** First automatic retry delay for a transient failure (default 60 s). */
  retryBackoffBaseMs?: number;
  /** Backoff ceiling for a transient failure (default 30 min). */
  retryBackoffMaxMs?: number;
  /** Injectable network-availability probe; defaults to an up non-loopback interface. */
  online?: () => boolean;
  maxBytes?: number;
  /** Per sync attempt budget; larger media deployments may raise it. */
  networkTimeoutMs?: number;
  /**
   * Quiet period that coalesces local mutations into one cloud run. A drag or
   * typing burst must not export/post the document once per applied update.
   */
  mutationDebounceMs?: number;
  /**
   * Upper bound measured from the first mutation of a window. A stream that
   * never pauses would otherwise postpone the cloud upload forever, so the
   * window is flushed once this elapses even while edits continue.
   */
  mutationMaxWaitMs?: number;
  /** Background download of an opened Project's missing Resource bytes. */
  prefetch?: {
    freeBytes?(path: string): Promise<number>;
    reserveBytes?: number;
    maxConcurrent?: number;
    retryBaseMs?: number;
    diskRetryMs?: number;
  };
}

/** Node adapter around the shared coordinator. All triggers use this one queue;
 * SQLite admission versions guard every completion against later local writes. */
export function createLocalProjectCloudSync(
  options: LocalProjectCloudSyncOptions,
) {
  const store = createLocalMetadataStore(options.dataDir);
  const resources = createLocalResourceStore({ dataDir: options.dataDir });
  const runs = new Map<string, Promise<void>>(),
    queued = new Set<string>();
  let closed = false;
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  const fetcher = options.fetch ?? globalThis.fetch;

  const runSignal = () =>
    AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(options.networkTimeoutMs ?? 600_000),
    ]);

  /**
   * The authenticated cloud transport of one admitted Project, bound to one
   * attempt's signal. Every request re-checks the admission first.
   */
  async function projectTransport(projectId: string, signal: AbortSignal) {
    const replicaId = await getLocalReplicaId(options.dataDir);
    const initial = await store.getProjectCloudSyncState(projectId, replicaId);
    if (!initial || initial.admission.status === "local-only") return undefined;
    const assertCurrent = async () => {
      signal.throwIfAborted();
      const current = await store.getProjectCloudAdmission(
        projectId,
        replicaId,
      );
      const metadata = await options.metadata.read(projectId);
      if (
        !current ||
        current.status === "local-only" ||
        current.syncBaseUrl !== initial.admission.syncBaseUrl ||
        current.tenantId !== initial.admission.tenantId ||
        current.userId !== initial.admission.userId ||
        !current.capabilities.canvas ||
        !current.capabilities.resources ||
        !current.capabilities.projectMetadata ||
        !metadata ||
        metadata.deletedAt
      )
        throw new Error("Project cloud admission revoked or Project deleted");
    };
    const authenticated = async (path: string, init: RequestInit = {}) => {
      await assertCurrent();
      const headers = new Headers(init.headers);
      const token = await options.token(initial.admission.syncBaseUrl, initial.admission.userId);
      if (!token) throw new Error("Sign in to the Project cloud account to resume sync");
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-local-replica-id", replicaId);
      const response = await fetcher(
        `${initial.admission.syncBaseUrl.replace(/\/+$/, "")}${path}`,
        { ...init, headers, signal, redirect: "error" },
      );
      if (response.status === 413) {
        const limit = await readContentTransferLimitError(response);
        if (limit) throw limit;
      }
      if (!response.ok) throw new ProjectContentHttpError(response.status);
      return response;
    };
    const base = `/api/v1/projects/${encodeURIComponent(projectId)}`;
    const deliveryFor = (resource: Resource): AssetDeliveryPort => {
      const issue = async (
        operation: "read" | "upload",
      ): Promise<AssetDeliveryUrl> => {
        const result = (await (
          await authenticated(
            `${base}/resources/${encodeURIComponent(resource.id)}/delivery`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                operation,
                localReplicaId: replicaId,
                ...(operation === "upload" ? { resource } : {}),
              }),
            },
          )
        ).json()) as { resource: unknown; capability: AssetDeliveryUrl };
        const returned = ResourceSchema.parse(result.resource);
        if (
          returned.id !== resource.id ||
          returned.digest.value !== resource.digest.value ||
          returned.byteLength !== resource.byteLength ||
          returned.kind !== resource.kind
        )
          throw new Error("Remote immutable Resource facts conflict");
        if (
          result.capability.resourceId !== resource.id ||
          result.capability.operation !== operation ||
          result.capability.method !== (operation === "read" ? "GET" : "PUT")
        )
          throw new Error("Invalid Resource capability response");
        return result.capability;
      };
      return {
        issueReadUrl: () => issue("read"),
        issueUploadUrl: () => issue("upload"),
      };
    };
    /** Remote immutable facts for a Resource this Host has not registered. */
    const remoteFacts = async (resourceId: string): Promise<Resource> => {
      const response = (await (
        await authenticated(
          `${base}/resources/${encodeURIComponent(resourceId)}/delivery`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operation: "read",
              localReplicaId: replicaId,
            }),
          },
        )
      ).json()) as { resource: unknown };
      return ResourceSchema.parse(response.resource);
    };
    const guardedFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      await assertCurrent();
      return fetcher(input, { ...init, signal });
    };
    /**
     * Seals staged download bytes under their replicated identity. A failed
     * pull drops its staging name; bytes it already sealed have no reference
     * yet, so the blob sweep reclaims them after the grace period.
     */
    const installPulled = async (
      resource: Resource,
      resourceId: string,
    ): Promise<void> => {
      try {
        await assertCurrent();
        const inspected = await options.inspection.finalize({
          resourceId,
          kind: resource.kind,
          contentType: resource.contentType,
        });
        await resources.installReplica({
          resource,
          verifiedResourceId: inspected.source.resource.id,
        });
        // The download is sealed; its staging copy is no longer needed.
        await resources.releaseStaged(resourceId);
      } catch (error) {
        await resources.discardStaged(resourceId).catch((discardError) => {
          projectCloudSyncLog.error("project_cloud_sync.staging_discard_failed", {
            code: PROJECT_CLOUD_PULL_STAGING_DISCARD_FAILED,
            projectId,
            resourceId,
            message:
              discardError instanceof Error
                ? discardError.message
                : String(discardError),
          });
        });
        throw error;
      }
    };
    /**
     * The one cloud → store download path, shared by the coordinator and the
     * prefetch queue. The digest is verified once, while streaming.
     */
    const download = async (
      ref: LocalResourcePrefetchRef,
      context: LocalResourceDownloadContext,
    ): Promise<void> => {
      await assertCurrent();
      let resource = await resources.readFacts(ref.resourceId);
      if (!resource) {
        try {
          resource = await remoteFacts(ref.resourceId);
        } catch (error) {
          if (error instanceof ProjectContentHttpError && error.status === 404)
            throw new LocalResourceDownloadError(
              "LOCAL_RESOURCE_REMOTE_MISSING",
              `Resource ${ref.resourceId} has no bytes in the Project cloud.`,
              { cause: error },
            );
          throw error;
        }
      }
      assertContentTransferSize(resource.byteLength, options.maxBytes);
      if (resource.id !== ref.resourceId || resource.kind !== ref.kind)
        throw new Error("Project Resource facts conflict");
      await context.preflight(resource.byteLength);
      const capability = await deliveryFor(resource).issueReadUrl({
        resourceId: resource.id,
        scope: {
          tenantId: initial.admission.tenantId,
          projectId,
          localReplicaId: replicaId,
        },
        purpose: "download",
      });
      const response = await guardedFetch(capability.url, {
        headers: capability.headers,
      });
      if (!response.ok)
        throw (
          (await readContentTransferLimitError(response)) ??
          new ProjectContentHttpError(response.status)
        );
      await validateCloudContentResponse(
        response,
        resource.byteLength,
        options.maxBytes,
      );
      if (!response.body) throw new Error("Remote Resource bytes unavailable");
      const byteLength = resource.byteLength;
      async function* counted(source: AsyncIterable<Uint8Array>) {
        let received = 0;
        for await (const chunk of source) {
          received += chunk.byteLength;
          context.progress(received, byteLength);
          yield chunk;
        }
      }
      const staged = await resources.stageStream({
        source: counted(cloudContentChunks(response.body, signal)),
        declaredByteLength: resource.byteLength,
        maxByteLength: contentTransferMaxBytes(options.maxBytes),
        expectedDigest: resource.digest.value,
      });
      await installPulled(resource, staged.resourceId);
    };
    return {
      replicaId,
      initial,
      base,
      assertCurrent,
      authenticated,
      deliveryFor,
      guardedFetch,
      installPulled,
      download,
    };
  }

  /** Resolves the bytes of an admitted Project's Resource on the queue's own attempt. */
  async function prefetchDownload(
    projectId: string,
    ref: LocalResourcePrefetchRef,
    context: LocalResourceDownloadContext,
  ): Promise<void> {
    const transport = await projectTransport(projectId, runSignal());
    // A Project that left the cloud has nothing to fetch; its Assets fall
    // back to the coded `unavailable` state.
    if (!transport) return;
    // The coordinator may have installed it since the plan was made.
    if (await resources.resolve(ref.resourceId).catch(() => undefined)) return;
    await transport.download(ref, context);
  }

  const prefetcher = createLocalResourcePrefetcher({
    storePath: options.dataDir,
    download: prefetchDownload,
    ...(options.prefetch?.freeBytes ? { freeBytes: options.prefetch.freeBytes } : {}),
    ...(options.prefetch?.reserveBytes !== undefined
      ? { reserveBytes: options.prefetch.reserveBytes }
      : {}),
    ...(options.prefetch?.maxConcurrent !== undefined
      ? { maxConcurrent: options.prefetch.maxConcurrent }
      : {}),
    ...(options.prefetch?.retryBaseMs !== undefined
      ? { retryBaseMs: options.prefetch.retryBaseMs }
      : {}),
    ...(options.prefetch?.diskRetryMs !== undefined
      ? { diskRetryMs: options.prefetch.diskRetryMs }
      : {}),
    onStoreState: (projectId, state) =>
      options.rooms.reportResourceStoreState?.(projectId, state),
  });

  async function runOnce(projectId: string) {
    const signal = runSignal();
    const transport = await projectTransport(projectId, signal);
    if (!transport) return;
    const {
      replicaId,
      initial,
      base,
      assertCurrent,
      authenticated,
      deliveryFor,
      guardedFetch,
      installPulled,
    } = transport;
    let remote: RemoteLoroPersistence;
    let refs: ReturnType<typeof projectSyncContent> = {
      resources: [],
      documents: [],
    };
    // The soft-delete tombstone lives in Project metadata, and the cloud
    // refuses every other transport once it is set. Reconcile it first so a
    // remote delete is pulled (and a local restore pushed) instead of
    // surfacing as an authorization failure on the snapshot.
    const syncTombstone = async (configured: RemoteLoroPersistence) => {
      const pulled = await configured.loadProjectMetadata!(projectId, signal);
      const local = await options.metadata.read(projectId);
      if (!local || !pulled || (!local.deletedAt && !pulled.deletedAt)) return;
      await createProjectMetadataReplicator({
        enabled: true,
        local: { read: async () => local, write: options.metadata.write },
        remote: {
          pull: async () => pulled,
          push: (metadata) =>
            configured.saveProjectMetadata!(projectId, metadata, signal),
        },
      }).sync();
    };
    if ((await options.metadata.read(projectId))?.deletedAt) {
      // A locally deleted Project replicates nothing but its tombstone; this
      // is how a restore made on another Host reaches this one.
      const configured = initial.admission.capabilities.projectMetadata
        ? await options.remote(projectId)
        : undefined;
      if (configured?.loadProjectMetadata && configured.saveProjectMetadata)
        await syncTombstone(configured);
      if ((await options.metadata.read(projectId))?.deletedAt) return;
    }
    // Mirrors what the cloud binds a staging session to, so a restarted Host
    // finds the session it left behind and never one for different bytes.
    const uploadSession = (kind: string, id: string, digest: string) =>
      cloudContentUploadSession(
        options.dataDir,
        JSON.stringify([
          initial.admission.syncBaseUrl,
          initial.admission.tenantId,
          projectId,
          replicaId,
          kind,
          id,
          digest,
        ]),
      );
    const readLocalBytes = async (
      path: string,
    ): Promise<Uint8Array | undefined> => {
      const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) return undefined;
      assertContentTransferSize(info.size, options.maxBytes);
      return readBoundedContent(
        Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
        options,
      );
    };
    const bytes: ResourceByteStore = {
      async read(id) {
        const facts = await resources.readFacts(id);
        if (facts)
          assertContentTransferSize(facts.byteLength, options.maxBytes);
        const source = await resources.resolve(id).catch(() => undefined);
        return source ? readLocalBytes(source.path) : undefined;
      },
      async write({ resource, bytes }) {
        const staged = await resources.stage({ bytes });
        await installPulled(resource, staged.resourceId);
      },
    };
    const coordinator = createProjectCloudSyncCoordinator({
      state: {
        async read() {
          const value = await store.getProjectCloudSyncState(
            projectId,
            replicaId,
          );
          if (!value) throw new Error("Project admission missing");
          return value;
        },
        async compareAndSet(expected, next) {
          if (next.status === "ready") await assertCurrent();
          return store.compareAndSetProjectCloudAdmission(expected, next);
        },
      },
      steps: {
        async syncLoro() {
          await assertCurrent();
          if (
            !initial.admission.capabilities.canvas ||
            !initial.admission.capabilities.projectMetadata ||
            !initial.admission.capabilities.resources
          )
            throw new Error(
              "Project cloud content capabilities unavailable; re-admit this Project",
            );
          const configured = await options.remote(projectId);
          if (
            !configured?.loadSnapshot ||
            !configured.loadProjectMetadata ||
            !configured.saveProjectMetadata
          )
            throw new Error(
              "Cloud deployment does not support Project snapshot and metadata replication",
            );
          remote = configured;
          await syncTombstone(remote);
          await assertCurrent();
          // Fetch before taking a room: an idle eviction may close it while
          // this network wait is in flight, and holding the stale handle would
          // persist a spurious coded failure instead of merging into the room
          // the hub opens next.
          const incoming = await remote.loadSnapshot!(projectId, signal);
          if (incoming)
            await options.rooms.mergeRemoteSnapshot(projectId, incoming);
          // The cursor is the durable version marker of the last acknowledged
          // update. With one, a run posts only the delta the user just made;
          // without one (first sync, re-admission, recovery) it posts a
          // snapshot so the remote can never miss the baseline.
          const cursor = await store.getProjectCloudSyncCursor(
            projectId,
            replicaId,
          );
          const captured = await options.rooms.inspectProject(projectId, (doc) => {
            const version = doc.version();
            try {
              let update: Uint8Array;
              if (cursor) {
                let from: VersionVector | undefined;
                let remoteVersion: VersionVector | undefined;
                try {
                  from = VersionVector.decode(cursor);
                  // A delta is only applicable if the remote already holds the
                  // cursor's version. A room that was reset or restored
                  // server-side would otherwise park the delta as a pending
                  // import behind a 204: an acknowledged upload that never
                  // applies. Re-send the baseline in that case.
                  remoteVersion = incoming
                    ? decodeImportBlobMeta(incoming, false)
                        .partialEndVersionVector
                    : undefined;
                  const order = remoteVersion
                    ? from.compare(remoteVersion)
                    : undefined;
                  if (order === undefined || order > 0)
                    throw new Error("remote does not cover the sync cursor");
                  update = doc.export({ mode: "update", from });
                } catch {
                  // A cursor the remote does not cover, or one from another
                  // lineage/retention window, cannot be replayed as a delta;
                  // recover with a full snapshot.
                  update = doc.export({ mode: "snapshot" });
                } finally {
                  from?.free();
                  remoteVersion?.free();
                }
              } else {
                update = doc.export({ mode: "snapshot" });
              }
              return {
                update,
                version: version.encode(),
                refs: projectSyncContent(doc),
              };
            } finally {
              version.free();
            }
          });
          refs = captured.refs;
          // HTTP response acknowledges durable ProjectRoom persistence, unlike
          // starting a WebSocket or merely opening the local room.
          if (captured.update.byteLength > 0) {
            await remote.appendUpdate(projectId, captured.update, signal);
            await store.setProjectCloudSyncCursor(
              projectId,
              replicaId,
              captured.version,
            );
          }
        },
        async syncMetadata() {
          await assertCurrent();
          await createProjectMetadataReplicator({
            enabled: true,
            local: {
              read: () => options.metadata.read(projectId),
              write: options.metadata.write,
              isProvisional: async () =>
                (await options.metadata.isProvisional?.(projectId)) === true,
            },
            remote: {
              pull: () => remote.loadProjectMetadata!(projectId, signal),
              push: (metadata) =>
                remote.saveProjectMetadata!(projectId, metadata, signal),
            },
          }).sync();
        },
        async syncResources() {
          for (const ref of refs.resources) {
            await assertCurrent();
            const resource = await resources.readFacts(ref.resourceId);
            if (resource)
              assertContentTransferSize(resource.byteLength, options.maxBytes);
            const local = resource
              ? await resources.resolve(ref.resourceId).catch(() => undefined)
              : undefined;
            if (!resource || !local) {
              // Joins a prefetch already downloading this Resource instead of
              // fetching it a second time.
              await prefetcher.run(projectId, ref, (context) =>
                transport.download(ref, context),
              );
              continue;
            }
            if (resource.id !== ref.resourceId || resource.kind !== ref.kind)
              throw new Error("Project Resource facts conflict");
            const common = {
              resource,
              maxBytes: options.maxBytes,
              local: bytes,
              delivery: deliveryFor(resource),
              scope: {
                tenantId: initial.admission.tenantId,
                projectId,
                localReplicaId: replicaId,
              },
              fetch: guardedFetch,
            };
            // A read capability is issued only for a verified stored object.
            // Missing bytes trigger a safe upload; auth/server errors remain failures.
            try {
              await common.delivery.issueReadUrl({
                resourceId: resource.id,
                scope: common.scope,
                purpose: "download",
              });
            } catch (error) {
              if (
                !(error instanceof ProjectContentHttpError) ||
                error.status !== 404
              )
                throw error;
              if (resource.byteLength > PROJECT_CLOUD_CONTENT_PART_BYTES) {
                const capability = await common.delivery.issueUploadUrl({
                  resourceId: resource.id,
                  scope: common.scope,
                  purpose: "host-staging",
                  byteLength: resource.byteLength,
                  digest: `sha256:${resource.digest.value}`,
                  contentType: resource.contentType,
                });
                await uploadCloudContentFile({
                  path: local.path,
                  byteLength: resource.byteLength,
                  digest: `sha256:${resource.digest.value}`,
                  maxBytes: options.maxBytes,
                  signal,
                  url: capability.url,
                  headers: capability.headers,
                  fetch: common.fetch,
                  session: uploadSession(
                    "resource",
                    resource.id,
                    resource.digest.value,
                  ),
                });
              } else {
                // pushResource verifies the bytes it read against the
                // Resource digest before it requests an upload URL.
                await pushResource(common).catch((error: unknown) => {
                  if (
                    error instanceof ResourceReplicationError &&
                    (error.code === "LOCAL_RESOURCE_DIGEST_MISMATCH" ||
                      error.code === "LOCAL_RESOURCE_SIZE_MISMATCH")
                  )
                    throw new LocalResourceError(
                      error.code,
                      `${error.message} Nothing was uploaded.`,
                      { cause: error, resourceId: resource.id },
                    );
                  throw error;
                });
              }
            }
          }
          for (const body of refs.documents) {
            await assertCurrent();
            assertContentTransferSize(body.byteLength, options.maxBytes);
            const path = `${base}/document-bodies/${encodeURIComponent(body.digest)}`;
            const file = {
              path: metadataBodyBlobPath(options.dataDir, body.digest),
              digest: body.digest,
              byteLength: body.byteLength,
              maxBytes: options.maxBytes,
              signal,
            };
            const local = await verifyCloudContentFile(file);
            if (local) {
              try {
                await authenticated(path, { method: "HEAD" });
              } catch (error) {
                if (
                  !(error instanceof ProjectContentHttpError) ||
                  error.status !== 404
                )
                  throw error;
                if (body.byteLength > PROJECT_CLOUD_CONTENT_PART_BYTES) {
                  await uploadCloudContentFile({
                    ...file,
                    session: uploadSession(
                      "document",
                      body.digest,
                      body.digest,
                    ),
                    url: `${initial.admission.syncBaseUrl.replace(/\/+$/, "")}${path}`,
                    fetch: async (input, init) => {
                      const target = new URL(String(input));
                      return authenticated(
                        `${target.pathname}${target.search}`,
                        init,
                      );
                    },
                  });
                } else {
                  const value = await readLocalBytes(file.path);
                  if (!value)
                    throw new Error("Local Document bytes unavailable");
                  await authenticated(path, {
                    method: "PUT",
                    body: Uint8Array.from(value),
                    headers: { "content-type": body.contentType },
                  });
                }
              }
            } else {
              const response = await authenticated(path);
              await validateCloudContentResponse(
                response,
                body.byteLength,
                options.maxBytes,
              );
              if (!response.body)
                throw new Error("Remote Document bytes unavailable");
              await installCloudContentFile({ ...file, body: response.body });
            }
          }
        },
      },
    });
    // Injected transports may ignore cancellation. Stop waiting on shutdown,
    // and assertCurrent prevents their late completion from publishing ready.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void coordinator
        .run()
        .then(() => resolve(), reject)
        .finally(() => signal.removeEventListener("abort", abort));
    });
  }

  const retryMs = options.retryMs ?? 300_000;
  const retryJitterMs = Math.max(0, options.retryJitterMs ?? retryMs);
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
  const retryBackoffBaseMs = options.retryBackoffBaseMs ?? 60_000;
  const retryBackoffMaxMs = options.retryBackoffMaxMs ?? 30 * 60_000;
  const retryStates = new Map<string, { attempt: number; nextAt: number }>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const backoffQueues = new Map<string, Promise<void>>();
  const mutationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mutationMaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const mutationWindowStartedAt = new Map<string, number>();
  const mutationDirty = new Set<string>();
  const mutationDebounceMs = Math.max(0, options.mutationDebounceMs ?? 400);
  const mutationMaxWaitMs = Math.max(0, options.mutationMaxWaitMs ?? 2_000);
  /** One in-flight report per Project; repeated publish failures coalesce. */
  const mirrorReports = new Map<string, Promise<void>>();
  /** Set once a mirror failure is visible; cleared only by a successful run. */
  const mirrorFailureEpisode = new Set<string>();
  const waiters: Array<() => void> = [];
  let active = 0;

  function networkAvailable(): boolean {
    if (options.online) return options.online();
    return Object.values(networkInterfaces()).some((addresses) =>
      addresses?.some(
        (address) =>
          address.internal === false &&
          (address.family === "IPv4" || address.family === "IPv6"),
      ),
    );
  }
  async function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  }
  function release(): void {
    active -= 1;
    waiters.shift()?.();
  }
  function armRetryTimer(): void {
    if (timer || closed) return;
    // A jittered floor, not a fixed interval: every Host with an admitted
    // Project polls for remote catch-up, and they must not stampede together.
    const delay = retryMs + Math.round(Math.random() * retryJitterMs);
    timer = setTimeout(() => {
      timer = undefined;
      void retry({ catchUp: true }).catch((error) => {
        console.error("[project-cloud-sync] retry", error);
        // The scan failed before it could decide eligibility; keep polling.
        if (!closed) armRetryTimer();
      });
    }, delay);
    timer.unref?.();
  }
  function stopRetryTimer(): void {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  }
  function clearProjectRetry(projectId: string): void {
    const pending = retryTimers.get(projectId);
    if (pending) clearTimeout(pending);
    retryTimers.delete(projectId);
  }
  function clearMutationWindow(projectId: string): void {
    const pending = mutationTimers.get(projectId);
    if (pending) clearTimeout(pending);
    mutationTimers.delete(projectId);
    const maxWait = mutationMaxTimers.get(projectId);
    if (maxWait) clearTimeout(maxWait);
    mutationMaxTimers.delete(projectId);
    mutationWindowStartedAt.delete(projectId);
    mutationDirty.delete(projectId);
  }
  async function candidateAdmissions(): Promise<ProjectCloudAdmission[]> {
    const replicaId = await getLocalReplicaId(options.dataDir);
    if (options.metadata.listAdmissions)
      return options.metadata.listAdmissions(replicaId);
    // Test/embedded callers may only provide the legacy list; keep their
    // behaviour without making the production Host load the whole snapshot.
    const admissions: ProjectCloudAdmission[] = [];
    for (const projectId of await options.metadata.list()) {
      const admission = await store.getProjectCloudAdmission(
        projectId,
        replicaId,
      );
      if (admission && admission.status !== "local-only")
        admissions.push(admission);
    }
    return admissions;
  }
  async function scheduleBackoff(projectId: string): Promise<void> {
    // Serialize per Project: a publish failure report and a mutation run can
    // settle together, and both must observe the timer the first one armed.
    const previous = backoffQueues.get(projectId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => scheduleBackoffOnce(projectId));
    const tracked = task.finally(() => {
      if (backoffQueues.get(projectId) === tracked)
        backoffQueues.delete(projectId);
    });
    backoffQueues.set(projectId, tracked);
    return tracked;
  }
  async function scheduleBackoffOnce(projectId: string): Promise<void> {
    if (closed) return;
    const replicaId = await getLocalReplicaId(options.dataDir);
    const state = await store.getProjectCloudSyncState(projectId, replicaId);
    // Any admitted Project that was just synced (admission, mutation, retry)
    // must leave the catch-up poll armed, including a run that ended ready.
    if (
      state &&
      state.admission.status !== "local-only" &&
      !isActionRequiredSyncFailure(state.admission)
    )
      armRetryTimer();
    if (
      !state ||
      state.admission.status === "local-only" ||
      state.admission.status !== "failed" ||
      isActionRequiredSyncFailure(state.admission)
    ) {
      retryStates.delete(projectId);
      clearProjectRetry(projectId);
      mirrorFailureEpisode.delete(projectId);
      return;
    }
    // A failure is already persisted as coded status/lastError; backoff only
    // decides when the next automatic attempt starts. An armed timer already
    // represents this failure episode, so repeated reports (one per local
    // edit while offline) must not advance the counter again.
    if (retryTimers.has(projectId)) return;
    const attempt = (retryStates.get(projectId)?.attempt ?? 0) + 1;
    const base = Math.min(
      retryBackoffMaxMs,
      retryBackoffBaseMs * 2 ** Math.min(attempt - 1, 8),
    );
    const delay = Math.max(0, Math.round(base * (0.5 + Math.random())));
    if (closed) return;
    retryStates.set(projectId, { attempt, nextAt: Date.now() + delay });
    clearProjectRetry(projectId);
    const pending = setTimeout(() => {
      retryTimers.delete(projectId);
      if (closed) return;
      if (!networkAvailable()) {
        void retry().catch((error) =>
          console.error("[project-cloud-sync] retry", error),
        );
        return;
      }
      void schedule(projectId);
    }, delay);
    pending.unref?.();
    retryTimers.set(projectId, pending);
  }

  function schedule(projectId: string): Promise<void> {
    if (closed) return Promise.resolve();
    // An explicit trigger supersedes the quiet period: the dirty marker is
    // already durable on the admission row.
    clearMutationWindow(projectId);
    queued.add(projectId);
    const existing = runs.get(projectId);
    if (existing) return existing;
    const task = (async () => {
      await acquire();
      try {
        while (!closed && queued.delete(projectId)) await runOnce(projectId);
      } finally {
        release();
      }
    })()
      .catch((error) => {
        console.error(`[project-cloud-sync] ${projectId}`, error);
      })
      .then(async () => {
        if (!closed) await scheduleBackoff(projectId);
      })
      .catch((error) => {
        console.error(
          `[project-cloud-sync] ${projectId} retry scheduling`,
          error,
        );
      })
      .finally(() => {
        runs.delete(projectId);
        // A trigger that arrived while the last run/backoff was settling must
        // not be lost: start a fresh task now that this Project has no run.
        if (!closed && queued.has(projectId)) void schedule(projectId);
      });
    runs.set(projectId, task);
    return task;
  }
  /** Durably mark a local mutation before it can be exported; one write per
   * coalesced window is enough because a run captures the whole replica. */
  async function markPending(projectId: string): Promise<boolean> {
    const replicaId = await getLocalReplicaId(options.dataDir);
    for (;;) {
      const state = await store.getProjectCloudSyncState(projectId, replicaId);
      if (!state || state.admission.status === "local-only") return false;
      if (state.admission.status === "pending" && !state.admission.lastError)
        return true;
      if (
        await store.compareAndSetProjectCloudAdmission(state, {
          ...state.admission,
          status: "pending",
          updatedAt: new Date().toISOString(),
          lastError: null,
        })
      )
        return true;
    }
  }
  async function invalidate(projectId: string) {
    if (closed) return;
    // A failed episode keeps its backoff attempt: every local edit while the
    // cloud is down must not reset (or repeatedly advance) the counter.
    if (!mutationDirty.has(projectId)) {
      const startedAt = Date.now();
      // Persist the dirty marker first: a crash inside the debounce window
      // leaves a `pending` admission that `start()` replays at boot.
      if (!(await markPending(projectId))) return;
      mutationDirty.add(projectId);
      mutationWindowStartedAt.set(projectId, startedAt);
    }
    armRetryTimer();
    const pending = mutationTimers.get(projectId);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      mutationTimers.delete(projectId);
      clearMutationWindow(projectId);
      void schedule(projectId);
    }, mutationDebounceMs);
    timer.unref?.();
    mutationTimers.set(projectId, timer);
    if (mutationMaxTimers.has(projectId)) return;
    // The first mutation of this window starts the max-wait clock. A stream
    // that never goes quiet still flushes once it elapses.
    const startedAt = mutationWindowStartedAt.get(projectId) ?? Date.now();
    const maxWaitDelay = Math.max(
      0,
      startedAt + mutationMaxWaitMs - Date.now(),
    );
    if (maxWaitDelay === 0) {
      clearMutationWindow(projectId);
      void schedule(projectId);
      return;
    }
    const maxWait = setTimeout(() => {
      mutationMaxTimers.delete(projectId);
      clearMutationWindow(projectId);
      void schedule(projectId);
    }, maxWaitDelay);
    maxWait.unref?.();
    mutationMaxTimers.set(projectId, maxWait);
  }
  async function retry(
    trigger: { catchUp?: boolean } = {},
  ): Promise<number> {
    if (closed) return 0;
    const admissions = (await candidateAdmissions()).filter(
      (admission) =>
        admission.status !== "local-only" &&
        // Auth/disk/size failures cannot fix themselves; the user's Retry sync
        // (invalidate) resumes them.
        !isActionRequiredSyncFailure(admission),
    );
    if (admissions.length === 0) {
      stopRetryTimer();
      return 0;
    }
    // Any syncable admission keeps the timer armed. A ready Project is neither
    // retried from a local trigger (invalidate already schedules it) nor at
    // boot, but the catch-up tick must re-pull it: a snapshot/metadata change
    // made on another device is otherwise invisible until a local mutation.
    armRetryTimer();
    if (!networkAvailable()) return 0;
    const now = Date.now();
    let scheduled = 0;
    for (const admission of admissions) {
      if (admission.status === "ready") {
        if (!trigger.catchUp) continue;
      } else {
        const state = retryStates.get(admission.projectId);
        if (state && state.nextAt > now) continue;
      }
      scheduled += 1;
      void schedule(admission.projectId);
    }
    return scheduled;
  }
  /**
   * A direct replica-link publish failed. Persist a coded failure on the
   * admission the UI already reads and arm the normal backoff; the next
   * coordinator run replays the local replica, including any edits made while
   * the link was down. Never log-only.
   *
   * While the cloud is down every local edit can publish and fail, so a
   * failure episode is reported once: at most one in-flight CAS per Project,
   * no rewrite once the coded failure is already visible, and at most one
   * backoff advance (scheduleBackoff keeps an armed timer). A successful run
   * clears both the coded state and the episode marker.
   */
  function reportMirrorFailure(
    projectId: string,
    error: unknown,
  ): Promise<void> {
    const inFlight = mirrorReports.get(projectId);
    if (inFlight) return inFlight;
    const task = reportMirrorFailureOnce(projectId, error).finally(() => {
      if (mirrorReports.get(projectId) === task) mirrorReports.delete(projectId);
    });
    mirrorReports.set(projectId, task);
    return task;
  }
  async function reportMirrorFailureOnce(
    projectId: string,
    error: unknown,
  ): Promise<void> {
    const replicaId = await getLocalReplicaId(options.dataDir);
    for (;;) {
      const state = await store.getProjectCloudSyncState(projectId, replicaId);
      if (!state || state.admission.status === "local-only") return;
      if (
        state.admission.status === "failed" &&
        state.admission.lastError?.includes(PROJECT_CLOUD_MIRROR_FAILED)
      ) {
        mirrorFailureEpisode.add(projectId);
        return;
      }
      if (
        mirrorFailureEpisode.has(projectId) &&
        state.admission.status !== "ready"
      )
        return;
      // A ready admission starts a new episode; until one is reported the
      // first failure of that episode must be visible.
      mirrorFailureEpisode.delete(projectId);
      if (
        await store.compareAndSetProjectCloudAdmission(state, {
          ...state.admission,
          status: "failed",
          updatedAt: new Date().toISOString(),
          lastError: projectCloudSyncFailureMessage(
            error,
            PROJECT_CLOUD_MIRROR_FAILED,
          ),
        })
      ) {
        mirrorFailureEpisode.add(projectId);
        break;
      }
    }
    await scheduleBackoff(projectId);
  }

  /** Pending visible-Asset hints per Project; a key means a plan is due. */
  const prefetchRequests = new Map<string, Set<string>>();
  const prefetchPlans = new Map<string, Promise<void>>();

  /**
   * Queues an admitted Project's missing Resources: visible Assets first, then
   * Timeline media, then the rest by recency. A local-only Project costs one
   * admission read and no fetch.
   */
  async function planPrefetch(
    projectId: string,
    visibleAssetIds: ReadonlySet<string>,
  ): Promise<void> {
    const replicaId = await getLocalReplicaId(options.dataDir);
    const admission = await store.getProjectCloudAdmission(
      projectId,
      replicaId,
    );
    if (
      closed ||
      !admission ||
      admission.status === "local-only" ||
      !admission.capabilities.resources
    )
      return;
    const planned = await options.rooms.inspectProject(projectId, (doc) => {
      const onTimeline = new Set<string>();
      for (const timeline of listProjectTimelines(doc)) {
        const tracks = (timeline.state as { tracks?: unknown } | null)?.tracks;
        if (!Array.isArray(tracks)) continue;
        for (const track of tracks) {
          const items = (track as { items?: unknown } | null)?.items;
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            const assetId = (item as { assetId?: unknown } | null)?.assetId;
            if (typeof assetId === "string") onTimeline.add(assetId);
          }
        }
      }
      return listProjectAssets(doc)
        .filter((asset) => asset.lifecycle.state === "active")
        .map((asset) => ({
          resourceId: asset.source.resourceId,
          kind: asset.kind,
          createdAt: asset.createdAt ?? 0,
          rank: visibleAssetIds.has(asset.id)
            ? PREFETCH_RANK.visible
            : onTimeline.has(asset.id)
              ? PREFETCH_RANK.timeline
              : PREFETCH_RANK.rest,
        }))
        .sort((a, b) => a.rank - b.rank || b.createdAt - a.createdAt);
    });
    const items: LocalResourcePrefetchPlanItem[] = [];
    const seen = new Set<string>();
    for (const { createdAt: _createdAt, ...item } of planned) {
      if (seen.has(item.resourceId)) continue;
      seen.add(item.resourceId);
      const installed = await resources
        .resolve(item.resourceId)
        .catch(() => undefined);
      if (!installed) items.push(item);
    }
    if (items.length > 0 && !closed) prefetcher.enqueue(projectId, items);
  }

  /**
   * Starts (or coalesces into) one prefetch plan for a Project. Open, remote
   * merges and visible-Asset hints all land here.
   */
  function prefetch(
    projectId: string,
    input: { visibleAssetIds?: readonly string[] } = {},
  ): Promise<void> {
    if (closed) return Promise.resolve();
    const pending = prefetchRequests.get(projectId) ?? new Set<string>();
    for (const id of input.visibleAssetIds ?? []) pending.add(id);
    prefetchRequests.set(projectId, pending);
    const existing = prefetchPlans.get(projectId);
    if (existing) return existing;
    const task = (async () => {
      for (;;) {
        const visible = prefetchRequests.get(projectId);
        if (closed || !visible) return;
        prefetchRequests.delete(projectId);
        await planPrefetch(projectId, visible);
      }
    })()
      .catch((error) => {
        projectCloudSyncLog.warn("project_cloud_sync.prefetch_plan_failed", {
          projectId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        prefetchPlans.delete(projectId);
        if (!closed && prefetchRequests.has(projectId))
          void prefetch(projectId);
      });
    prefetchPlans.set(projectId, task);
    return task;
  }

  return {
    schedule,
    invalidate,
    reportMirrorFailure,
    prefetch,
    /** Download state of a Resource this Host has not installed yet. */
    resourceAvailability: (resourceId: string) =>
      prefetcher.availability(resourceId),
    /** Settles once no prefetch plan or download is pending. */
    async prefetchIdle(): Promise<void> {
      while (prefetchPlans.size > 0)
        await Promise.all(prefetchPlans.values());
      await prefetcher.idle();
    },
    async start() {
      // In the Host this runs after host.listening; it must never gate local
      // requests. No timer is armed while every Project is local-only.
      await retry();
    },
    async close() {
      closed = true;
      shutdown.abort(new Error("Project sync Host stopped"));
      stopRetryTimer();
      for (const projectId of [...retryTimers.keys()])
        clearProjectRetry(projectId);
      for (const projectId of [...mutationTimers.keys()])
        clearMutationWindow(projectId);
      for (const projectId of [...mutationMaxTimers.keys()])
        clearMutationWindow(projectId);
      mirrorReports.clear();
      mirrorFailureEpisode.clear();
      backoffQueues.clear();
      retryStates.clear();
      prefetchRequests.clear();
      await Promise.all([
        ...runs.values(),
        ...prefetchPlans.values(),
        prefetcher.close(),
      ]);
    },
  };
}
