import {
  ResolvedAssetSchema,
  type AssetKind,
  type ResolvedAsset,
} from "@clash/shared-types";

import type {
  ProjectAssetHttpClientOptions,
  ProjectAssetHttpConnection,
} from "./project-asset-http-client.js";

export interface PersonalGlobalAssetHttpClient {
  list(): Promise<ResolvedAsset[]>;
  get(input: { globalAssetId: string }): Promise<ResolvedAsset>;
  importFile(input: {
    file: Blob;
    fileName?: string;
    kind: AssetKind;
    globalAssetId: string;
  }): Promise<ResolvedAsset>;
  publish(input: {
    projectId: string;
    projectAssetId: string;
  }): Promise<ResolvedAsset>;
  trash(input: {
    globalAssetId: string;
    deleteOperationId?: string;
  }): Promise<ResolvedAsset>;
  restore(input: {
    globalAssetId: string;
    deleteOperationId: string;
  }): Promise<ResolvedAsset>;
}

export type PersonalGlobalAssetHttpClientOptions =
  ProjectAssetHttpClientOptions;

function cleanErrorField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export class PersonalGlobalAssetHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    const record =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)
        : undefined;
    const reason = [
      cleanErrorField(record?.code),
      cleanErrorField(record?.error),
    ]
      .filter(Boolean)
      .join(": ");
    super(
      reason
        ? `${reason} (Personal Global Asset HTTP ${status})`
        : `Personal Global Asset request failed with HTTP ${status}`,
    );
    this.name = "PersonalGlobalAssetHttpError";
  }
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function libraryAssetsUrl(endpoint: string): string {
  return `${endpoint.trim().replace(/\/+$/, "")}/api/v1/libraries/personal/assets`;
}

function fileNameOf(file: Blob): string | undefined {
  return "name" in file && typeof file.name === "string"
    ? file.name
    : undefined;
}

function newOperationId(prefix: string): string {
  const cryptoObject = typeof crypto === "undefined" ? undefined : crypto;
  if (typeof cryptoObject?.randomUUID !== "function") {
    throw new Error("crypto.randomUUID is required for Asset operation ids");
  }
  return `${prefix}:${cryptoObject.randomUUID()}`;
}

function stableOperationId(
  input: object,
  requested: string | undefined,
  generatedIds: WeakMap<object, string>,
  prefix: string,
  label: string,
): string {
  if (requested !== undefined) return required(requested, label);
  const existing = generatedIds.get(input);
  if (existing) return existing;
  const generated = newOperationId(prefix);
  generatedIds.set(input, generated);
  return generated;
}

export function createPersonalGlobalAssetHttpClient(
  options: PersonalGlobalAssetHttpClientOptions = {},
): PersonalGlobalAssetHttpClient {
  const fetch = options.fetch ?? globalThis.fetch;
  const generatedTrashIds = new WeakMap<object, string>();
  const connection = async (): Promise<ProjectAssetHttpConnection> => {
    if (options.resolveConnection) return options.resolveConnection();
    return {
      endpoint: options.endpoint?.trim() ?? "",
      ...(options.token?.trim() ? { token: options.token.trim() } : {}),
    };
  };
  const target = async (suffix = "") => {
    const connected = await connection();
    return {
      connected,
      url: `${libraryAssetsUrl(connected.endpoint)}${suffix}`,
    };
  };
  const headers = (
    connected: ProjectAssetHttpConnection,
    additions: Record<string, string> = {},
  ): Record<string, string> => ({
    ...(connected.token ? { authorization: `Bearer ${connected.token}` } : {}),
    ...additions,
  });
  const requestInit = (input: RequestInit): RequestInit => ({
    ...input,
    ...(options.credentials === undefined
      ? {}
      : { credentials: options.credentials }),
  });
  const responseBody = async (response: Response): Promise<unknown> => {
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      throw (
        options.createHttpError?.(response.status, body) ??
        new PersonalGlobalAssetHttpError(response.status, body)
      );
    }
    return body;
  };
  const resolvedAsset = async (response: Response): Promise<ResolvedAsset> =>
    ResolvedAssetSchema.parse(await responseBody(response));

  return {
    async list() {
      const { connected, url } = await target();
      const response = await fetch(
        url,
        requestInit({ method: "GET", headers: headers(connected) }),
      );
      const body = (await responseBody(response)) as { assets?: unknown };
      return ResolvedAssetSchema.array().parse(body.assets);
    },
    async get(input) {
      const globalAssetId = required(input.globalAssetId, "global asset id");
      const { connected, url } = await target(
        `/${encodeURIComponent(globalAssetId)}`,
      );
      return resolvedAsset(
        await fetch(
          url,
          requestInit({ method: "GET", headers: headers(connected) }),
        ),
      );
    },
    async importFile(input) {
      const globalAssetId = required(input.globalAssetId, "global asset id");
      const fileName = required(
        input.fileName ?? fileNameOf(input.file),
        "file name",
      );
      const { connected, url } = await target("/import-file");
      const form = new FormData();
      if (input.fileName === undefined && fileNameOf(input.file) === fileName) {
        form.append("file", input.file);
      } else {
        form.append("file", input.file, fileName);
      }
      form.append("kind", input.kind);
      form.append("globalAssetId", globalAssetId);
      return resolvedAsset(
        await fetch(
          url,
          requestInit({
            method: "POST",
            headers: headers(connected),
            body: form,
          }),
        ),
      );
    },
    async publish(input) {
      const projectId = required(input.projectId, "project id");
      const projectAssetId = required(input.projectAssetId, "project asset id");
      const { connected, url } = await target("/publish");
      return resolvedAsset(
        await fetch(
          url,
          requestInit({
            method: "POST",
            headers: headers(connected, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({ projectId, projectAssetId }),
          }),
        ),
      );
    },
    async trash(input) {
      const globalAssetId = required(input.globalAssetId, "global asset id");
      const deleteOperationId = stableOperationId(
        input,
        input.deleteOperationId,
        generatedTrashIds,
        "delete",
        "delete operation id",
      );
      const { connected, url } = await target(
        `/${encodeURIComponent(globalAssetId)}`,
      );
      return resolvedAsset(
        await fetch(
          url,
          requestInit({
            method: "DELETE",
            headers: headers(connected, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({ deleteOperationId }),
          }),
        ),
      );
    },
    async restore(input) {
      const globalAssetId = required(input.globalAssetId, "global asset id");
      const deleteOperationId = required(
        input.deleteOperationId,
        "delete operation id",
      );
      const { connected, url } = await target(
        `/${encodeURIComponent(globalAssetId)}/restore`,
      );
      return resolvedAsset(
        await fetch(
          url,
          requestInit({
            method: "POST",
            headers: headers(connected, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({ deleteOperationId }),
          }),
        ),
      );
    },
  };
}
