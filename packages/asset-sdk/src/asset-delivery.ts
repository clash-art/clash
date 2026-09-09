/**
 * Host-neutral delivery contract for immutable Resources.
 *
 * The Asset SDK never knows whether the returned URL is backed by a local
 * loopback server, Cloudflare R2, S3, or another object store. A signer may
 * keep its storage locator private; callers only receive a short-lived URL
 * and the method needed to use it.
 */

export type AssetDeliveryOperation = "read" | "upload";

export type AssetDeliveryPurpose =
  "preview" | "provider-input" | "download" | "host-staging";

export interface AssetDeliveryScope {
  tenantId: string;
  projectId?: string;
}

export interface AssetDeliveryReadRequest {
  resourceId: string;
  scope: AssetDeliveryScope;
  purpose: Exclude<AssetDeliveryPurpose, "host-staging">;
}

export interface AssetDeliveryUploadRequest {
  resourceId: string;
  scope: AssetDeliveryScope;
  purpose: "host-staging";
  byteLength: number;
  digest?: string;
  contentType?: string;
}

export interface AssetDeliveryAuthorizationInput {
  operation: AssetDeliveryOperation;
  resourceId: string;
  scope: AssetDeliveryScope;
  purpose: AssetDeliveryPurpose;
}

export interface AssetDeliverySignerInput extends AssetDeliveryAuthorizationInput {
  method: "GET" | "PUT";
  expiresAt: string;
  byteLength?: number;
  digest?: string;
  contentType?: string;
}

export interface AssetDeliverySignerResult {
  /** Absolute URL. The URL must not expose a private storage key. */
  url: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export interface AssetDeliverySigner {
  sign(
    input: AssetDeliverySignerInput,
  ): AssetDeliverySignerResult | Promise<AssetDeliverySignerResult>;
}

export interface AssetDeliveryAuthorizer {
  authorize(input: AssetDeliveryAuthorizationInput): boolean | Promise<boolean>;
}

export interface AssetDeliveryUrl {
  resourceId: string;
  operation: AssetDeliveryOperation;
  purpose: AssetDeliveryPurpose;
  method: "GET" | "PUT";
  url: string;
  expiresAt: string;
  headers?: Record<string, string>;
}

export interface AssetDeliveryPort {
  issueReadUrl(input: AssetDeliveryReadRequest): Promise<AssetDeliveryUrl>;
  issueUploadUrl(input: AssetDeliveryUploadRequest): Promise<AssetDeliveryUrl>;
}

export type AssetDeliveryErrorCode =
  "INVALID_INPUT" | "FORBIDDEN" | "SIGNING_FAILED";

export class AssetDeliveryError extends Error {
  constructor(
    readonly code: AssetDeliveryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AssetDeliveryError";
  }
}

export interface AssetDeliveryPortOptions {
  signer: AssetDeliverySigner;
  authorize: AssetDeliveryAuthorizer["authorize"];
  now?: () => number;
  readTtlSeconds?: number;
  uploadTtlSeconds?: number;
}

const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AssetDeliveryError("INVALID_INPUT", `${label} is required.`);
  }
  return normalized;
}

function validateScope(scope: AssetDeliveryScope): AssetDeliveryScope {
  if (!scope || typeof scope !== "object") {
    throw new AssetDeliveryError(
      "INVALID_INPUT",
      "delivery scope is required.",
    );
  }
  return {
    tenantId: required(scope.tenantId, "scope.tenantId"),
    ...(scope.projectId === undefined
      ? {}
      : { projectId: required(scope.projectId, "scope.projectId") }),
  };
}

function validateResourceId(resourceId: string): string {
  return required(resourceId, "resourceId");
}

function validatePurpose(
  purpose: AssetDeliveryPurpose,
  operation: AssetDeliveryOperation,
): AssetDeliveryPurpose {
  if (
    purpose !== "preview" &&
    purpose !== "provider-input" &&
    purpose !== "download" &&
    purpose !== "host-staging"
  ) {
    throw new AssetDeliveryError("INVALID_INPUT", "invalid delivery purpose.");
  }
  if (operation === "upload" && purpose !== "host-staging") {
    throw new AssetDeliveryError(
      "INVALID_INPUT",
      "uploads must use the host-staging purpose.",
    );
  }
  if (operation === "read" && purpose === "host-staging") {
    throw new AssetDeliveryError(
      "INVALID_INPUT",
      "host-staging is only valid for uploads.",
    );
  }
  return purpose;
}

function validateTtl(seconds: number | undefined, label: string): number {
  const value = seconds ?? 15 * 60;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AssetDeliveryError(
      "INVALID_INPUT",
      `${label} must be a positive integer.`,
    );
  }
  return value;
}

function validateSignedResult(
  result: AssetDeliverySignerResult,
  now: number,
): AssetDeliverySignerResult {
  let url: URL;
  try {
    url = new URL(result.url);
  } catch (error) {
    throw new AssetDeliveryError(
      "SIGNING_FAILED",
      "Asset delivery signer returned an invalid URL.",
      { cause: error },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AssetDeliveryError(
      "SIGNING_FAILED",
      "Asset delivery signer returned a non-HTTP URL.",
    );
  }
  const expiresAt = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new AssetDeliveryError(
      "SIGNING_FAILED",
      "Asset delivery signer returned an expired URL.",
    );
  }
  return {
    url: url.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
    ...(result.headers ? { headers: { ...result.headers } } : {}),
  };
}

export function createAssetDeliveryPort(
  options: AssetDeliveryPortOptions,
): AssetDeliveryPort {
  const now = options.now ?? Date.now;
  const readTtlSeconds = validateTtl(options.readTtlSeconds, "readTtlSeconds");
  const uploadTtlSeconds = validateTtl(
    options.uploadTtlSeconds,
    "uploadTtlSeconds",
  );

  async function issue(input: {
    operation: AssetDeliveryOperation;
    resourceId: string;
    scope: AssetDeliveryScope;
    purpose: AssetDeliveryPurpose;
    byteLength?: number;
    digest?: string;
    contentType?: string;
  }): Promise<AssetDeliveryUrl> {
    const resourceId = validateResourceId(input.resourceId);
    const scope = validateScope(input.scope);
    const purpose = validatePurpose(input.purpose, input.operation);

    if (input.operation === "upload") {
      if (
        !Number.isSafeInteger(input.byteLength) ||
        (input.byteLength as number) < 0
      ) {
        throw new AssetDeliveryError(
          "INVALID_INPUT",
          "upload byteLength must be a non-negative integer.",
        );
      }
      if (input.digest !== undefined && !SHA256_DIGEST.test(input.digest)) {
        throw new AssetDeliveryError(
          "INVALID_INPUT",
          "upload digest must use sha256:<64 lowercase hex characters>.",
        );
      }
      if (input.contentType !== undefined) {
        required(input.contentType, "contentType");
      }
    }

    const authorized = await options.authorize({
      operation: input.operation,
      resourceId,
      scope,
      purpose,
    });
    if (!authorized) {
      throw new AssetDeliveryError(
        "FORBIDDEN",
        "The current scope cannot access this Resource.",
      );
    }

    const expiresAt = new Date(
      now() +
        (input.operation === "read" ? readTtlSeconds : uploadTtlSeconds) * 1000,
    ).toISOString();
    const signed = validateSignedResult(
      await options.signer.sign({
        operation: input.operation,
        resourceId,
        scope,
        purpose,
        method: input.operation === "read" ? "GET" : "PUT",
        expiresAt,
        ...(input.byteLength === undefined
          ? {}
          : { byteLength: input.byteLength }),
        ...(input.digest === undefined ? {} : { digest: input.digest }),
        ...(input.contentType === undefined
          ? {}
          : { contentType: input.contentType }),
      }),
      now(),
    );
    return {
      resourceId,
      operation: input.operation,
      purpose,
      method: input.operation === "read" ? "GET" : "PUT",
      url: signed.url,
      expiresAt: signed.expiresAt,
      ...(signed.headers ? { headers: signed.headers } : {}),
    };
  }

  return {
    issueReadUrl(input) {
      return issue({ ...input, operation: "read" });
    },
    issueUploadUrl(input) {
      return issue({ ...input, operation: "upload" });
    },
  };
}
