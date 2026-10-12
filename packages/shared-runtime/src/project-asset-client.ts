import {
  PROJECT_ASSET_READ_RECEIPT_HEADER as SHARED_PROJECT_ASSET_READ_RECEIPT_HEADER,
  createPersonalGlobalAssetHttpClient,
  createProjectAssetHttpClient,
  type AssetImportProgressListener,
} from "@clash/asset-sdk";
import type {
  ActionAssetBinding,
  AssetKind,
  ResolvedAsset,
} from "@clash/shared-types";

import {
  ProjectHostHttpError,
  resolveProjectHostContext,
  type ProjectHostConnection,
  type ProjectHostClient,
  type ResolvedProjectHostContext,
} from "./project-host-client.js";

export type { AssetImportProgressListener };

export const PROJECT_ASSET_READ_RECEIPT_HEADER =
  SHARED_PROJECT_ASSET_READ_RECEIPT_HEADER;

export type AssetImportFileType = {
  kind: AssetKind;
  contentType: string;
};

const ASSET_IMPORT_FILE_TYPES: Record<string, AssetImportFileType> = {
  ".png": { kind: "image", contentType: "image/png" },
  ".jpg": { kind: "image", contentType: "image/jpeg" },
  ".jpeg": { kind: "image", contentType: "image/jpeg" },
  ".gif": { kind: "image", contentType: "image/gif" },
  ".webp": { kind: "image", contentType: "image/webp" },
  ".svg": { kind: "image", contentType: "image/svg+xml" },
  ".avif": { kind: "image", contentType: "image/avif" },
  ".mp4": { kind: "video", contentType: "video/mp4" },
  ".webm": { kind: "video", contentType: "video/webm" },
  ".mov": { kind: "video", contentType: "video/quicktime" },
  ".m4v": { kind: "video", contentType: "video/mp4" },
  ".mkv": { kind: "video", contentType: "video/x-matroska" },
  ".mp3": { kind: "audio", contentType: "audio/mpeg" },
  ".wav": { kind: "audio", contentType: "audio/wav" },
  ".m4a": { kind: "audio", contentType: "audio/mp4" },
  ".aac": { kind: "audio", contentType: "audio/aac" },
  ".flac": { kind: "audio", contentType: "audio/flac" },
  ".ogg": { kind: "audio", contentType: "audio/ogg" },
  ".glb": { kind: "model", contentType: "model/gltf-binary" },
  ".gltf": { kind: "model", contentType: "model/gltf+json" },
};

export function resolveAssetImportFileType(
  filePath: string,
  requestedKind?: AssetKind,
): AssetImportFileType {
  const fileName = filePath.replace(/^.*[/\\]/u, "");
  const dot = fileName.lastIndexOf(".");
  const extension = dot > 0 ? fileName.slice(dot).toLowerCase() : "";
  const inferred = ASSET_IMPORT_FILE_TYPES[extension];
  if (!inferred) {
    if (requestedKind) {
      return { kind: requestedKind, contentType: "application/octet-stream" };
    }
    throw new Error(`Asset file type is unsupported: ${filePath}`);
  }
  if (requestedKind && requestedKind !== inferred.kind) {
    throw new Error(
      `Asset kind ${requestedKind} does not match the selected ${inferred.kind} file`,
    );
  }
  return { ...inferred, ...(requestedKind ? { kind: requestedKind } : {}) };
}

export type ProjectAssetHostScope = {
  cwd?: string;
  projectId?: string;
};

export type ProjectAssetHostResult<T> = {
  projectId: string;
  workspaceRoot?: string;
  value: T;
};

export type ProjectAssetHostObservation<T> = ProjectAssetHostResult<T> & {
  receipt: string;
};

function requiredImportId(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

/** One concrete action that resolves a Project Asset failure. */
export type ProjectAssetRecoveryStep = {
  /** Why this step is the right one, written as the start of a sentence. */
  why: string;
  operation: "list" | "get" | "references" | "trash" | "restore" | "import";
  assetId?: string;
  /** For `import`: the identity to pass. */
  projectAssetId?: string;
  /** For `import`: opt in to a second Asset over the same bytes. */
  allowDuplicate?: true;
};

export type ProjectAssetRecovery = {
  code: string;
  problem: string;
  steps: ProjectAssetRecoveryStep[];
};

function hostErrorBody(error: unknown): Record<string, unknown> | undefined {
  const body =
    error && typeof error === "object" && "body" in error
      ? (error as { body?: unknown }).body
      : undefined;
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Existing ids an agent most plausibly meant by an id the Project does not have. */
export function suggestProjectAssetIds(
  requested: string,
  assets: readonly Pick<ResolvedAsset, "id" | "name">[],
): string[] {
  const wanted = requested.trim().toLowerCase();
  if (!wanted) return [];
  const stem = (value: string) => value.replace(/\.[a-z0-9]+$/u, "");
  return assets
    .filter(({ id, name }) => {
      const candidate = id.toLowerCase();
      const label = name?.toLowerCase();
      return (
        candidate.endsWith(`:${wanted}`) ||
        candidate.includes(wanted) ||
        wanted.includes(candidate) ||
        (label !== undefined && (label === wanted || stem(label) === wanted))
      );
    })
    .map(({ id }) => id)
    .sort()
    .slice(0, 5);
}

/**
 * Turns a Host Project Asset failure into what went wrong and the exact next
 * operations. MCP and CLI render the same steps in their own call syntax, so
 * the two surfaces cannot give different advice.
 */
export function projectAssetRecovery(
  error: unknown,
  /** Facts the caller knows when the failure did not come from the Host. */
  known: { code?: string; projectAssetId?: string } = {},
): ProjectAssetRecovery | undefined {
  const body = hostErrorBody(error) ?? {};
  const code = typeof body.code === "string" ? body.code : known.code;
  if (!code) return undefined;
  const requested =
    typeof body.projectAssetId === "string"
      ? body.projectAssetId
      : known.projectAssetId?.trim() || undefined;
  switch (code) {
    case "PROJECT_ASSET_NOT_FOUND": {
      const suggestions = stringList(body.suggestedProjectAssetIds);
      return {
        code,
        problem: `Project Asset ${requested ?? "(unknown id)"} does not exist in this Project. Project Asset IDs must be passed exactly as list returns them, including any prefix such as asset:.`,
        steps: [
          ...suggestions.map((assetId): ProjectAssetRecoveryStep => ({
            why: "Closest existing Project Asset",
            operation: "get",
            assetId,
          })),
          { why: "See every Project Asset ID", operation: "list" },
        ],
      };
    }
    case "PROJECT_ASSET_DUPLICATE_CONTENT": {
      const existing = stringList(body.existingProjectAssetIds);
      const first = existing[0];
      if (!first) return undefined;
      return {
        code,
        problem: `This file is already imported as Project Asset ${existing.join(", ")}; nothing new was imported${requested ? ` as ${requested}` : ""}. Importing the same bytes again would add a second Asset, not rename the first.`,
        steps: [
          { why: "Use the existing Asset", operation: "get", assetId: first },
          ...(requested
            ? ([
                {
                  why: `Only if the Asset must be identified as ${requested}: read ${first}, trash it`,
                  operation: "trash",
                  assetId: first,
                },
                {
                  why: "and then import the file under that id",
                  operation: "import",
                  projectAssetId: requested,
                },
              ] satisfies ProjectAssetRecoveryStep[])
            : []),
          {
            why: "Only if a second independent Asset over the same bytes is intended",
            operation: "import",
            ...(requested ? { projectAssetId: requested } : {}),
            allowDuplicate: true,
          },
        ],
      };
    }
    case "PROJECT_ASSET_TRASHED":
      if (!requested) return undefined;
      return {
        code,
        problem: `Project Asset ${requested} already holds this content and is in the trash. Importing it again does not bring it back.`,
        steps: [
          {
            why: "Read the trashed Asset",
            operation: "get",
            assetId: requested,
          },
          { why: "then restore it", operation: "restore", assetId: requested },
        ],
      };
    case "PROJECT_ASSET_ID_COLLISION":
      if (!requested) return undefined;
      return {
        code,
        problem: `Project Asset ID ${requested} is already taken by different content. An existing Asset is never overwritten.`,
        steps: [
          {
            why: "See what already owns the id",
            operation: "get",
            assetId: requested,
          },
          {
            why: "or import this file under an id that is not in use",
            operation: "import",
          },
        ],
      };
    case "ASSET_IN_USE":
      if (!requested) return undefined;
      return {
        code,
        problem: `Project Asset ${requested} is still used by Actions and was not trashed.`,
        steps: [
          {
            why: "See which Actions reference it; trash a different Asset or leave this one",
            operation: "references",
            assetId: requested,
          },
        ],
      };
    case "READ_REQUIRED":
    case "STALE_READ":
    case "INVALID_READ_PROOF":
      if (!requested) return undefined;
      return {
        code,
        problem:
          code === "READ_REQUIRED"
            ? `Project Asset ${requested} must be read before it is trashed or restored, so the change applies to the state you saw.`
            : `Project Asset ${requested} changed since it was last read; nothing was changed.`,
        steps: [
          {
            why: "Read it, check it is the Asset you mean and its lifecycle state",
            operation: "get",
            assetId: requested,
          },
        ],
      };
    default:
      return undefined;
  }
}

export type ProjectAssetHostClient = {
  resolveContext(
    input?: ProjectAssetHostScope,
  ): Promise<ResolvedProjectHostContext>;
  list(
    input?: ProjectAssetHostScope,
  ): Promise<ProjectAssetHostResult<ResolvedAsset[]>>;
  batch(
    input: ProjectAssetHostScope & { assetIds: readonly string[] },
  ): Promise<ProjectAssetHostResult<ResolvedAsset[]>>;
  get(
    input: ProjectAssetHostScope & {
      assetId: string;
    },
  ): Promise<ProjectAssetHostObservation<ResolvedAsset>>;
  references(
    input: ProjectAssetHostScope & {
      assetId: string;
    },
  ): Promise<ProjectAssetHostObservation<ActionAssetBinding[]>>;
  importFile(
    input: ProjectAssetHostScope & {
      /** Sent as the request body; a file-backed Blob is never read into memory whole. */
      file: Blob;
      fileName: string;
      kind: AssetKind;
      projectAssetId: string;
      duplicateContent?: "allow" | "reject";
      onProgress?: AssetImportProgressListener;
    },
  ): Promise<ProjectAssetHostResult<ResolvedAsset>>;
  admit(
    input: ProjectAssetHostScope & {
      globalAssetId: string;
    },
  ): Promise<ProjectAssetHostResult<ResolvedAsset>>;
  trash(
    input: ProjectAssetHostScope & {
      assetId: string;
      deleteOperationId?: string;
      actorClientType?: string;
      receipt?: string;
    },
  ): Promise<ProjectAssetHostObservation<ResolvedAsset>>;
  restore(
    input: ProjectAssetHostScope & {
      assetId: string;
      actorClientType?: string;
      receipt?: string;
    },
  ): Promise<ProjectAssetHostObservation<ResolvedAsset>>;
};

export type PersonalGlobalAssetHostClient = {
  list(): Promise<ResolvedAsset[]>;
  get(input: { globalAssetId: string }): Promise<ResolvedAsset>;
  importFile(input: {
    /** Sent as the request body; a file-backed Blob is never read into memory whole. */
    file: Blob;
    fileName: string;
    kind: AssetKind;
    globalAssetId: string;
    onProgress?: AssetImportProgressListener;
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
};

type ProjectAssetHostClientOptions = {
  endpoint?: string;
  token?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof globalThis.fetch;
  hostClient?: Pick<ProjectHostClient, "resolveConnection" | "resolveContext">;
  resolveConnection?: () => Promise<ProjectHostConnection>;
};

function createAssetHostConnectionResolver(
  options: ProjectAssetHostClientOptions,
): () => Promise<ProjectHostConnection> {
  const env = options.env ?? process.env;
  return async () => {
    if (options.hostClient?.resolveConnection) {
      return options.hostClient.resolveConnection();
    }
    if (options.resolveConnection) return options.resolveConnection();
    return {
      endpoint:
        options.endpoint?.trim() ||
        env.CLASH_API_URL?.trim() ||
        "http://127.0.0.1:8789",
      ...(options.token?.trim() || env.CLASH_API_KEY?.trim()
        ? { token: options.token?.trim() || env.CLASH_API_KEY?.trim() }
        : {}),
    };
  };
}

export function createProjectAssetHostClient(
  options: ProjectAssetHostClientOptions = {},
): ProjectAssetHostClient {
  const env = options.env ?? process.env;
  const connection = createAssetHostConnectionResolver(options);
  const context = (input: ProjectAssetHostScope = {}) =>
    options.hostClient
      ? options.hostClient.resolveContext(input)
      : resolveProjectHostContext({
          cwd: input.cwd,
          projectId: input.projectId,
          env,
        });
  const http = createProjectAssetHttpClient({
    fetch: options.fetch,
    resolveConnection: connection,
    createHttpError: (status, body) => new ProjectHostHttpError(status, body),
  });
  type ProjectImportSnapshot = {
    resolved: ResolvedProjectHostContext;
    command: Parameters<typeof http.importFile>[0];
  };
  // Object identity is the in-process logical command boundary. Equal bytes in
  // a different object are a new import; retrying this object replays its first
  // immutable Blob snapshot.
  const importCommands = new WeakMap<object, ProjectImportSnapshot>();
  type HttpTrashCommand = Parameters<typeof http.trash>[0] & {
    deleteOperationId?: string;
  };
  const trashCommands = new WeakMap<object, HttpTrashCommand>();
  const result = <T>(
    resolved: ResolvedProjectHostContext,
    value: T,
  ): ProjectAssetHostResult<T> => ({
    projectId: resolved.projectId,
    ...(resolved.workspaceRoot
      ? { workspaceRoot: resolved.workspaceRoot }
      : {}),
    value,
  });

  // A wrong id is the commonest lifecycle mistake. Answer it with the ids that
  // do exist instead of a bare 404, without a second round trip by the caller.
  const withKnownIds = async <T>(
    projectId: string,
    assetId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      const body = hostErrorBody(error);
      if (
        !(error instanceof ProjectHostHttpError) ||
        body?.code !== "PROJECT_ASSET_NOT_FOUND"
      ) {
        throw error;
      }
      const known = await http.list({ projectId }).catch(() => []);
      throw new ProjectHostHttpError(error.status, {
        ...body,
        projectAssetId: assetId,
        suggestedProjectAssetIds: suggestProjectAssetIds(assetId, known),
      });
    }
  };

  return {
    resolveContext: context,
    async list(input = {}) {
      const resolved = await context(input);
      return result(
        resolved,
        await http.list({ projectId: resolved.projectId }),
      );
    },
    async batch(input) {
      const resolved = await context(input);
      return result(
        resolved,
        await http.batch({
          projectId: resolved.projectId,
          assetIds: input.assetIds,
        }),
      );
    },
    async get(input) {
      const resolved = await context(input);
      const observed = await withKnownIds(
        resolved.projectId,
        input.assetId,
        () =>
          http.get({
            projectId: resolved.projectId,
            assetId: input.assetId,
          }),
      );
      return {
        ...result(resolved, observed.value),
        receipt: observed.receipt,
      };
    },
    async references(input) {
      const resolved = await context(input);
      const observed = await withKnownIds(
        resolved.projectId,
        input.assetId,
        () =>
          http.references({
            projectId: resolved.projectId,
            assetId: input.assetId,
          }),
      );
      return {
        ...result(resolved, observed.value),
        receipt: observed.receipt,
      };
    },
    async importFile(input) {
      let snapshot = importCommands.get(input);
      if (!snapshot) {
        const resolved = await context(input);
        snapshot = {
          resolved,
          command: {
            projectId: resolved.projectId,
            file: input.file,
            fileName: input.fileName,
            kind: input.kind,
            projectAssetId: requiredImportId(
              input.projectAssetId,
              "project asset id",
            ),
            ...(input.duplicateContent
              ? { duplicateContent: input.duplicateContent }
              : {}),
            ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          },
        };
        importCommands.set(input, snapshot);
      }
      return result(snapshot.resolved, await http.importFile(snapshot.command));
    },
    async admit(input) {
      const resolved = await context(input);
      return result(
        resolved,
        await http.admit({
          projectId: resolved.projectId,
          globalAssetId: input.globalAssetId,
        }),
      );
    },
    async trash(input) {
      const resolved = await context(input);
      let command = trashCommands.get(input);
      if (!command) {
        command = {
          projectId: resolved.projectId,
          assetId: input.assetId,
          ...(input.deleteOperationId !== undefined
            ? { deleteOperationId: input.deleteOperationId }
            : {}),
          ...(input.actorClientType
            ? { actorClientType: input.actorClientType }
            : {}),
          ...(input.receipt ? { receipt: input.receipt } : {}),
        };
        trashCommands.set(input, command);
      }
      const trashCommand = command;
      const observed = await withKnownIds(
        resolved.projectId,
        input.assetId,
        () => http.trash(trashCommand),
      );
      return {
        ...result(resolved, observed.value),
        receipt: observed.receipt,
      };
    },
    async restore(input) {
      const resolved = await context(input);
      const observed = await withKnownIds(
        resolved.projectId,
        input.assetId,
        () =>
          http.restore({
            projectId: resolved.projectId,
            assetId: input.assetId,
            actorClientType: input.actorClientType,
            receipt: input.receipt,
          }),
      );
      return {
        ...result(resolved, observed.value),
        receipt: observed.receipt,
      };
    },
  };
}

export function createPersonalGlobalAssetHostClient(
  options: ProjectAssetHostClientOptions = {},
): PersonalGlobalAssetHostClient {
  const connection = createAssetHostConnectionResolver(options);
  const http = createPersonalGlobalAssetHttpClient({
    fetch: options.fetch,
    resolveConnection: connection,
    createHttpError: (status, body) => new ProjectHostHttpError(status, body),
  });
  // Keep the same narrow command boundary as Project imports; this is not
  // content-addressed library deduplication.
  const importCommands = new WeakMap<
    object,
    Parameters<typeof http.importFile>[0]
  >();

  return {
    list: () => http.list(),
    get: (input) => http.get(input),
    async importFile(input) {
      let command = importCommands.get(input);
      if (!command) {
        command = {
          file: input.file,
          fileName: input.fileName,
          kind: input.kind,
          globalAssetId: requiredImportId(
            input.globalAssetId,
            "global asset id",
          ),
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        };
        importCommands.set(input, command);
      }
      return http.importFile(command);
    },
    publish: (input) => http.publish(input),
    trash: (input) => http.trash(input),
    restore: (input) => http.restore(input),
  };
}
