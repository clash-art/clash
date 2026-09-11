import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createProjectCloudSyncCoordinator } from "@clash/shared-runtime/project-cloud-sync";
import {
  createProjectMetadataReplicator,
  metadataBodyBlobPath,
  storeMetadataBody,
} from "@clash/shared-runtime";
import { projectSyncContent } from "@clash/shared-types/project-sync-content";
import {
  ResourceSchema,
  type ProjectMetadata,
  type Resource,
} from "@clash/shared-types";
import {
  assertContentTransferSize,
  readBoundedContent,
  readContentTransferLimitError,
  pullResource,
  pushResource,
  type AssetDeliveryPort,
  type AssetDeliveryUrl,
  type ResourceByteStore,
} from "@clash/asset-sdk/delivery";
import { createLocalMetadataStore } from "./local-metadata-store.js";
import { getLocalReplicaId } from "./local-replica-identity.js";
import { createLocalResourceStore } from "./local-resource-store.js";
import type { LocalAssetInspectionService } from "./local-asset-inspections.js";
import type { LocalLoroRoomHub, RemoteLoroPersistence } from "./sync.js";

class ProjectContentHttpError extends Error {
  constructor(readonly status: number) {
    super(`Project content transport failed (${status})`);
  }
}

export interface LocalProjectCloudSyncOptions {
  dataDir: string;
  rooms: Pick<LocalLoroRoomHub, "room" | "inspectProject">;
  remote(projectId: string): Promise<RemoteLoroPersistence | undefined>;
  metadata: {
    list(): Promise<string[]>;
    read(projectId: string): Promise<ProjectMetadata | null>;
    write(metadata: ProjectMetadata): Promise<void>;
  };
  token(): Promise<string | undefined>;
  inspection: Pick<LocalAssetInspectionService, "finalize">;
  fetch?: typeof globalThis.fetch;
  retryMs?: number;
  maxBytes?: number;
  /** Per sync attempt budget; larger media deployments may raise it. */
  networkTimeoutMs?: number;
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

  async function runOnce(projectId: string) {
    const signal = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(options.networkTimeoutMs ?? 600_000),
    ]);
    const replicaId = await getLocalReplicaId(options.dataDir);
    const initial = await store.getProjectCloudSyncState(projectId, replicaId);
    if (!initial || initial.admission.status === "local-only") return;
    let remote: RemoteLoroPersistence;
    let refs: ReturnType<typeof projectSyncContent> = {
      resources: [],
      documents: [],
    };
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
      const token = await options.token();
      if (token) headers.set("authorization", `Bearer ${token}`);
      headers.set("x-local-replica-id", replicaId);
      const response = await fetcher(
        `${initial.admission.syncBaseUrl.replace(/\/+$/, "")}${path}`,
        { ...init, headers, signal },
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
        const inspected = await options.inspection.finalize({
          resourceId: staged.resourceId,
          kind: resource.kind,
          contentType: resource.contentType,
        });
        await resources.installReplica({
          resource,
          verifiedResourceId: inspected.source.resource.id,
        });
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
          const room = await options.rooms.room(projectId);
          const incoming = await remote.loadSnapshot!(projectId, signal);
          if (incoming) await room.mergeRemoteSnapshot(incoming);
          const captured = await options.rooms.inspectProject(
            projectId,
            (doc) => ({
              snapshot: doc.export({ mode: "snapshot" }),
              refs: projectSyncContent(doc),
            }),
          );
          refs = captured.refs;
          // HTTP response acknowledges durable ProjectRoom persistence, unlike
          // starting a WebSocket or merely opening the local room.
          await remote.appendUpdate(projectId, captured.snapshot, signal);
        },
        async syncMetadata() {
          await assertCurrent();
          await createProjectMetadataReplicator({
            enabled: true,
            local: {
              read: () => options.metadata.read(projectId),
              write: options.metadata.write,
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
            let resource = await resources.readFacts(ref.resourceId);
            if (resource)
              assertContentTransferSize(resource.byteLength, options.maxBytes);
            const local = resource
              ? await resources.resolve(ref.resourceId).catch(() => undefined)
              : undefined;
            if (!resource) {
              const response = (await (
                await authenticated(
                  `${base}/resources/${encodeURIComponent(ref.resourceId)}/delivery`,
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
              resource = ResourceSchema.parse(response.resource);
            }
            assertContentTransferSize(resource.byteLength, options.maxBytes);
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
              fetch: async (
                input: Parameters<typeof fetch>[0],
                init?: RequestInit,
              ) => {
                await assertCurrent();
                return fetcher(input, { ...init, signal });
              },
            };
            if (local) {
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
                await pushResource(common);
              }
            } else await pullResource(common);
          }
          for (const body of refs.documents) {
            await assertCurrent();
            assertContentTransferSize(body.byteLength, options.maxBytes);
            const path = `${base}/document-bodies/${encodeURIComponent(body.digest)}`;
            const local = await readLocalBytes(
              metadataBodyBlobPath(options.dataDir, body.digest),
            );
            if (local) {
              if (
                local.length !== body.byteLength ||
                `sha256:${createHash("sha256").update(local).digest("hex")}` !==
                  body.digest
              )
                throw new Error("Local Document body integrity mismatch");
              try {
                await authenticated(path, { method: "HEAD" });
              } catch (error) {
                if (
                  !(error instanceof ProjectContentHttpError) ||
                  error.status !== 404
                )
                  throw error;
                await authenticated(path, {
                  method: "PUT",
                  body: new Uint8Array(local).buffer,
                  headers: { "content-type": body.contentType },
                });
              }
            } else {
              const response = await authenticated(path);
              const declaredLength = response.headers.get("content-length");
              if (declaredLength !== null)
                assertContentTransferSize(
                  Number(declaredLength),
                  options.maxBytes,
                );
              const value = await readBoundedContent(response.body, options);
              if (
                value.length !== body.byteLength ||
                `sha256:${createHash("sha256").update(value).digest("hex")}` !==
                  body.digest
              )
                throw new Error("Remote Document body integrity mismatch");
              await storeMetadataBody({
                dataDir: options.dataDir,
                body: JSON.parse(new TextDecoder().decode(value)),
                expectedContentHash: body.digest,
              });
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

  function schedule(projectId: string): Promise<void> {
    if (closed) return Promise.resolve();
    queued.add(projectId);
    const existing = runs.get(projectId);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(async () => {
        while (!closed && queued.delete(projectId)) await runOnce(projectId);
      })
      .catch((error) => {
        console.error(`[project-cloud-sync] ${projectId}`, error);
      })
      .finally(() => {
        runs.delete(projectId);
      });
    runs.set(projectId, task);
    return task;
  }
  async function invalidate(projectId: string) {
    const replicaId = await getLocalReplicaId(options.dataDir);
    for (;;) {
      const state = await store.getProjectCloudSyncState(projectId, replicaId);
      if (!state || state.admission.status === "local-only") return;
      if (
        await store.compareAndSetProjectCloudAdmission(state, {
          ...state.admission,
          status: "pending",
          updatedAt: new Date().toISOString(),
          lastError: null,
        })
      )
        break;
    }
    void schedule(projectId);
  }
  async function retry() {
    for (const projectId of await options.metadata.list()) {
      const replicaId = await getLocalReplicaId(options.dataDir);
      const admission = await store.getProjectCloudAdmission(
        projectId,
        replicaId,
      );
      if (admission && admission.status !== "local-only")
        void schedule(projectId);
    }
  }
  return {
    schedule,
    invalidate,
    async start() {
      await retry();
      timer = setInterval(() => {
        void retry().catch((error) =>
          console.error("[project-cloud-sync] retry", error),
        );
      }, options.retryMs ?? 30_000);
      timer.unref?.();
    },
    async close() {
      closed = true;
      shutdown.abort(new Error("Project sync Host stopped"));
      if (timer) clearInterval(timer);
      await Promise.all(runs.values());
    },
  };
}
