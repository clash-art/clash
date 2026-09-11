import {
  assertContentTransferSize,
  readBoundedContent,
  readContentTransferLimitError,
  type ContentTransferLimits,
} from "./content-transfer.js";
import { ResourceSchema, type Resource } from "@clash/shared-types/assets";

import type {
  AssetDeliveryPort,
  AssetDeliveryScope,
} from "./asset-delivery.js";

export interface ResourceByteStore {
  /** Return an immutable local copy, or undefined when this Host has no bytes. */
  read(resourceId: string): Promise<Uint8Array | undefined>;
  /** Install bytes after the caller has verified the Resource facts. */
  write(input: { resource: Resource; bytes: Uint8Array }): Promise<void>;
}

export type ResourceReplicationStatus =
  "uploaded" | "downloaded" | "already-present";

export interface ResourceReplicationResult {
  status: ResourceReplicationStatus;
  resourceId: string;
  byteLength: number;
}

export type ResourceReplicationErrorCode =
  | "INVALID_RESOURCE"
  | "LOCAL_RESOURCE_MISSING"
  | "UPLOAD_FAILED"
  | "REMOTE_NOT_FOUND"
  | "DOWNLOAD_FAILED"
  | "INTEGRITY_MISMATCH";

export class ResourceReplicationError extends Error {
  constructor(
    readonly code: ResourceReplicationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResourceReplicationError";
  }
}

export interface ResourceReplicationBaseOptions extends ContentTransferLimits {
  resource: Resource;
  local: ResourceByteStore;
  delivery: AssetDeliveryPort;
  scope: AssetDeliveryScope;
  fetch?: typeof globalThis.fetch;
}

export interface PushResourceOptions extends ResourceReplicationBaseOptions {}

export interface PullResourceOptions extends ResourceReplicationBaseOptions {}

export interface ProjectResourceReplicationOptions extends ContentTransferLimits {
  resources: readonly Resource[];
  local: ResourceByteStore;
  delivery: AssetDeliveryPort;
  scope: AssetDeliveryScope;
  fetch?: typeof globalThis.fetch;
  /** Bound concurrent uploads so a large Project does not starve the Host. */
  concurrency?: number;
}

export interface ProjectResourceReplicationResult {
  uploaded: ResourceReplicationResult[];
  failed: Array<{ resourceId: string; error: ResourceReplicationError }>;
}

function validatedResource(input: Resource): Resource {
  const parsed = ResourceSchema.safeParse(input);
  if (!parsed.success) {
    throw new ResourceReplicationError(
      "INVALID_RESOURCE",
      parsed.error.issues[0]?.message ?? "Invalid immutable Resource.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return hex(new Uint8Array(digest));
}

async function assertBytes(
  resource: Resource,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength !== resource.byteLength) {
    throw new ResourceReplicationError(
      "INTEGRITY_MISMATCH",
      `Resource ${resource.id} has ${bytes.byteLength} bytes; expected ${resource.byteLength}.`,
    );
  }
  const actualDigest = await sha256(bytes);
  if (actualDigest !== resource.digest.value) {
    throw new ResourceReplicationError(
      "INTEGRITY_MISMATCH",
      `Resource ${resource.id} digest does not match its immutable facts.`,
    );
  }
}

function responseError(
  operation: "upload" | "download",
  response: Response,
): ResourceReplicationError {
  if (operation === "download" && response.status === 404) {
    return new ResourceReplicationError(
      "REMOTE_NOT_FOUND",
      `Remote Resource is unavailable (${response.status}).`,
    );
  }
  return new ResourceReplicationError(
    operation === "upload" ? "UPLOAD_FAILED" : "DOWNLOAD_FAILED",
    `Resource ${operation} failed with HTTP ${response.status}.`,
  );
}

async function fetchResource(
  fetch: typeof globalThis.fetch,
  operation: "upload" | "download",
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw new ResourceReplicationError(
      operation === "upload" ? "UPLOAD_FAILED" : "DOWNLOAD_FAILED",
      `Resource ${operation} transport failed; retry is safe.`,
      { cause: error },
    );
  }
}

export async function pushResource(
  options: PushResourceOptions,
): Promise<ResourceReplicationResult> {
  const resource = validatedResource(options.resource);
  assertContentTransferSize(resource.byteLength, options.maxBytes);
  const bytes = await options.local.read(resource.id);
  if (!bytes) {
    throw new ResourceReplicationError(
      "LOCAL_RESOURCE_MISSING",
      `Local Resource ${resource.id} is not available for upload.`,
    );
  }
  await assertBytes(resource, bytes);

  const delivery = await options.delivery.issueUploadUrl({
    resourceId: resource.id,
    scope: options.scope,
    purpose: "host-staging",
    byteLength: resource.byteLength,
    digest: `sha256:${resource.digest.value}`,
    ...(resource.contentType ? { contentType: resource.contentType } : {}),
  });
  const fetch = options.fetch ?? globalThis.fetch;
  const headers = new Headers(delivery.headers);
  if (resource.contentType && !headers.has("content-type")) {
    headers.set("content-type", resource.contentType);
  }
  const response = await fetchResource(fetch, "upload", delivery.url, {
    method: delivery.method,
    headers,
    body: bytes as unknown as RequestInit["body"],
  });
  if (!response.ok)
    throw (
      (await readContentTransferLimitError(response)) ??
      responseError("upload", response)
    );
  return {
    status: "uploaded",
    resourceId: resource.id,
    byteLength: resource.byteLength,
  };
}

export async function pullResource(
  options: PullResourceOptions,
): Promise<ResourceReplicationResult> {
  const resource = validatedResource(options.resource);
  assertContentTransferSize(resource.byteLength, options.maxBytes);
  const existing = await options.local.read(resource.id);
  if (existing) {
    try {
      await assertBytes(resource, existing);
      return {
        status: "already-present",
        resourceId: resource.id,
        byteLength: resource.byteLength,
      };
    } catch (error) {
      if (!(error instanceof ResourceReplicationError)) throw error;
      // A damaged local projection is replaceable; fetch a verified copy below.
    }
  }

  const delivery = await options.delivery.issueReadUrl({
    resourceId: resource.id,
    scope: options.scope,
    purpose: "download",
  });
  const fetch = options.fetch ?? globalThis.fetch;
  const response = await fetchResource(fetch, "download", delivery.url, {
    method: delivery.method,
    headers: delivery.headers,
  });
  if (!response.ok)
    throw (
      (await readContentTransferLimitError(response)) ??
      responseError("download", response)
    );
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null)
    assertContentTransferSize(Number(declaredLength), options.maxBytes);
  const bytes = await readBoundedContent(response.body, options);
  await assertBytes(resource, bytes);
  await options.local.write({ resource, bytes });
  return {
    status: "downloaded",
    resourceId: resource.id,
    byteLength: resource.byteLength,
  };
}

/**
 * Best-effort Project resource admission. Every resource is addressed by its
 * immutable Resource identity, so rerunning this function after a partial
 * failure is safe and naturally idempotent.
 */
export async function pushProjectResources(
  options: ProjectResourceReplicationOptions,
): Promise<ProjectResourceReplicationResult> {
  const concurrency = Math.max(
    1,
    Math.min(32, Math.floor(options.concurrency ?? 4)),
  );
  const resources = Array.from(
    new Map(
      options.resources.map((resource) => [resource.id, resource]),
    ).values(),
  );
  const uploaded: ResourceReplicationResult[] = [];
  const failed: Array<{ resourceId: string; error: ResourceReplicationError }> =
    [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < resources.length) {
      const resource = resources[cursor++];
      try {
        uploaded.push(
          await pushResource({
            resource,
            local: options.local,
            delivery: options.delivery,
            scope: options.scope,
            maxBytes: options.maxBytes,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
        );
      } catch (error) {
        const normalized =
          error instanceof ResourceReplicationError
            ? error
            : new ResourceReplicationError(
                "UPLOAD_FAILED",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              );
        failed.push({ resourceId: resource.id, error: normalized });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, resources.length) }, worker),
  );
  uploaded.sort((left, right) =>
    left.resourceId.localeCompare(right.resourceId),
  );
  failed.sort((left, right) => left.resourceId.localeCompare(right.resourceId));
  return { uploaded, failed };
}
