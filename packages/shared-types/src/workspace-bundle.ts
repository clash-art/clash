import { z } from "zod";

import { ResourceSchema } from "./assets.js";
import { GeneratorDefinitionRefSchema } from "./generator-v2.js";
import { TextAppliedRevisionSchema } from "./text-revisions.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const ContentSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const NonEmptyIdSchema = z.string().trim().min(1).max(500);

/** Fixed, auditable v1 directory-bundle entry points. */
export const WORKSPACE_BUNDLE_MANIFEST_PATH = "workspace.json" as const;
export const WORKSPACE_BUNDLE_PROJECT_PATH = "project.bin" as const;

export const WorkspaceBundleRelativePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    if (
      value.includes("\0") ||
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/u.test(value) ||
      value !== value.normalize("NFC") ||
      value
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..")
    ) {
      context.addIssue({
        code: "custom",
        message: "Workspace bundle paths must be safe POSIX-relative paths",
      });
    }
  });

/** The same fail-closed secret-path policy used by Workspace worktree export. */
export function workspacePortablePathLooksSecret(
  portableRelativePath: string,
): boolean {
  const segments = portableRelativePath.toLocaleLowerCase("en-US").split("/");
  const basename = segments.at(-1) ?? "";
  if (basename === ".env.example") return false;
  if (basename.startsWith(".env") || basename === ".npmrc") return true;
  if (segments.some((segment) => segment === ".ssh" || segment === ".aws")) {
    return true;
  }
  if (
    /\.(?:key|pem|p12|pfx)$/u.test(basename) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(basename)
  ) {
    return true;
  }
  return segments.some((segment) =>
    /(?:^|[._-])(?:credentials?|tokens?|secrets?|keys?|private[._-]?key|api[._-]?key)(?:[._-]|$)/u.test(
      segment,
    ),
  );
}

export const WorkspacePortableSourcePathSchema =
  WorkspaceBundleRelativePathSchema.superRefine((value, context) => {
    if (workspacePortablePathLooksSecret(value)) {
      context.addIssue({
        code: "custom",
        message: "Workspace source paths must not identify secret-like files",
      });
    }
  });

const WORKSPACE_PRIVATE_JSON_KEYS = new Set([
  "provideraccountid",
  "provideraccount",
  "localpath",
  "hostpath",
  "workerurl",
  "runtimeid",
  "storagekey",
  "signedurl",
]);

function workspacePrivateJsonKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/gu, "");
  return (
    WORKSPACE_PRIVATE_JSON_KEYS.has(normalized) ||
    /(?:apikey|tokens?|credentials?|secrets?|password|passphrase|privatekey)$/u.test(
      normalized,
    )
  );
}

function workspaceAbsoluteMachinePath(value: string, key: string): boolean {
  if (/^file:\/\//iu.test(value)) return true;
  const normalizedKey = key
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/gu, "");
  if (!/(?:path|file|root|dir|directory|src|url)$/u.test(normalizedKey)) {
    return false;
  }
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

/**
 * Fail-closed validation for intentional open JSON stored in Project Loro.
 * Core Generator/Canvas/Timeline schemas remain unchanged; Workspace export
 * applies this additional portability boundary before publishing project.bin.
 */
export const WorkspacePortableJsonObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((root, context) => {
    const seen = new WeakSet<object>();
    const visit = (value: unknown, path: Array<string | number>): void => {
      if (
        value === null ||
        typeof value === "boolean" ||
        typeof value === "string"
      ) {
        const key = typeof path.at(-1) === "string" ? String(path.at(-1)) : "";
        if (
          typeof value === "string" &&
          workspaceAbsoluteMachinePath(value, key)
        ) {
          context.addIssue({
            code: "custom",
            path,
            message: "Workspace JSON must not contain absolute machine paths",
          });
        }
        return;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          context.addIssue({
            code: "custom",
            path,
            message: "Workspace JSON numbers must be finite",
          });
        }
        return;
      }
      if (typeof value !== "object") {
        context.addIssue({
          code: "custom",
          path,
          message: "Workspace JSON must contain only JSON values",
        });
        return;
      }
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path,
          message: "Workspace JSON must not be cyclic",
        });
        return;
      }
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, [...path, index]));
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) {
        context.addIssue({
          code: "custom",
          path,
          message: "Workspace JSON objects must be plain records",
        });
        return;
      }
      for (const [key, entry] of Object.entries(value)) {
        if (workspacePrivateJsonKey(key)) {
          context.addIssue({
            code: "custom",
            path: [...path, key],
            message: `Workspace JSON contains machine-private field ${key}`,
          });
        }
        visit(entry, [...path, key]);
      }
    };
    visit(root, []);
  });

export const WorkspaceBundleFileRoleSchema = z.enum([
  "workspace",
  "project",
  "object",
]);

export const WorkspaceBundleFileSchema = z
  .object({
    path: WorkspaceBundleRelativePathSchema,
    role: WorkspaceBundleFileRoleSchema,
    bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    mode: z.enum(["0644", "0755"]),
  })
  .strict();

export const WorkspaceBundleResourceSchema = z
  .object({
    resource: ResourceSchema,
    path: WorkspaceBundleRelativePathSchema,
  })
  .strict();

export const WorkspaceBundleDocumentBodySchema = z
  .object({
    contentHash: ContentSha256Schema,
    byteLength: z.number().int().nonnegative(),
    contentType: z.literal("application/json"),
    path: WorkspaceBundleRelativePathSchema,
  })
  .strict();

export const WorkspaceBundleTextRevisionSchema = z
  .object({
    revision: TextAppliedRevisionSchema.extend({
      contentHash: z.string().regex(/^[a-f0-9]{16}$/u),
      sourceFilePath: WorkspacePortableSourcePathSchema,
    }).strict(),
    path: WorkspaceBundleRelativePathSchema,
  })
  .strict();

export const WorkspaceBundleProjectSchema = z
  .object({
    path: z.literal(WORKSPACE_BUNDLE_PROJECT_PATH),
    codec: z.literal("loro-shallow-snapshot"),
    codecVersion: z.literal(1),
  })
  .strict();

export const WorkspaceSemanticModelReferenceSchema = z
  .object({
    modelId: NonEmptyIdSchema,
  })
  .strict();

export const WorkspaceBundleExcludedPathSchema = z
  .object({
    path: WorkspaceBundleRelativePathSchema,
    reason: z.enum([
      "vcs-private",
      "target-marker-regenerated",
      "runtime-private",
      "cache",
    ]),
  })
  .strict();

export const WorkspaceBundleSourceSchema = z
  .object({
    projectId: NonEmptyIdSchema,
    display: z
      .object({
        name: z.string().trim().min(1).max(500),
        description: z.string().max(10_000).optional(),
        createdAt: z.string().datetime().optional(),
        updatedAt: z.string().datetime().optional(),
      })
      .strict(),
  })
  .strict();

export const WorkspaceBundleContentSchema = z
  .object({
    workspaceRoot: z.literal("workspace"),
    project: WorkspaceBundleProjectSchema,
    resources: z.array(WorkspaceBundleResourceSchema),
    documentBodies: z.array(WorkspaceBundleDocumentBodySchema),
    textRevisions: z.array(WorkspaceBundleTextRevisionSchema),
  })
  .strict();

export const WorkspaceBundleSemanticRequirementsSchema = z
  .object({
    generatorDefinitions: z.array(GeneratorDefinitionRefSchema),
    modelReferences: z.array(WorkspaceSemanticModelReferenceSchema),
  })
  .strict();

export const WorkspaceBundleManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.bundle"),
    source: WorkspaceBundleSourceSchema,
    content: WorkspaceBundleContentSchema,
    semanticRequirements: WorkspaceBundleSemanticRequirementsSchema,
    files: z.array(WorkspaceBundleFileSchema).min(1),
    excluded: z.array(WorkspaceBundleExcludedPathSchema),
    integrity: z
      .object({
        algorithm: z.literal("sha256"),
        canonicalization: z.literal("clash.workspace-manifest-json.v1"),
        bundleDigest: Sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const materializedPaths = new Map<string, string>();
    const filesByPath = new Map(
      manifest.files.map((file) => [file.path, file] as const),
    );
    const issue = (path: Array<string | number>, message: string) =>
      context.addIssue({ code: "custom", path, message });
    const requireCanonicalOrder = <T>(
      values: readonly T[],
      key: (value: T) => string,
      path: Array<string | number>,
    ) => {
      for (let index = 1; index < values.length; index += 1) {
        const previous = key(values[index - 1]!);
        const current = key(values[index]!);
        if (previous >= current) {
          issue(
            [...path, index],
            previous === current
              ? `Duplicate canonical identity: ${current}`
              : `Entries must be sorted by canonical identity; ${current} follows ${previous}`,
          );
        }
      }
    };
    requireCanonicalOrder(manifest.files, (file) => file.path, ["files"]);
    requireCanonicalOrder(
      manifest.content.resources,
      (entry) => entry.resource.id,
      ["content", "resources"],
    );
    requireCanonicalOrder(
      manifest.content.documentBodies,
      (entry) => entry.contentHash,
      ["content", "documentBodies"],
    );
    requireCanonicalOrder(
      manifest.content.textRevisions,
      (entry) => entry.revision.revisionId,
      ["content", "textRevisions"],
    );
    requireCanonicalOrder(
      manifest.semanticRequirements.generatorDefinitions,
      (entry) =>
        `${entry.pluginId}\u0000${entry.definitionId}\u0000${entry.version}\u0000${entry.schemaHash}`,
      ["semanticRequirements", "generatorDefinitions"],
    );
    requireCanonicalOrder(
      manifest.semanticRequirements.modelReferences,
      (entry) => entry.modelId,
      ["semanticRequirements", "modelReferences"],
    );
    requireCanonicalOrder(manifest.excluded, (entry) => entry.path, [
      "excluded",
    ]);
    manifest.files.forEach((file, index) => {
      const collisionKey = file.path
        .normalize("NFC")
        .toLocaleLowerCase("en-US");
      const existing = materializedPaths.get(collisionKey);
      if (existing !== undefined) {
        issue(
          ["files", index, "path"],
          `Workspace bundle path collides with ${existing}`,
        );
      } else {
        materializedPaths.set(collisionKey, file.path);
      }
      if (
        file.role === "workspace" &&
        !file.path.startsWith(`${manifest.content.workspaceRoot}/`)
      ) {
        issue(
          ["files", index, "path"],
          "Workspace payload files must stay beneath content.workspaceRoot",
        );
      }
      if (file.role !== "workspace" && file.mode !== "0644") {
        issue(
          ["files", index, "mode"],
          "Authority and content-addressed payload files cannot be executable",
        );
      }
    });

    const projectFile = filesByPath.get(manifest.content.project.path);
    if (projectFile?.role !== "project") {
      issue(
        ["content", "project", "path"],
        "Project state must identify the tagged project.bin payload file",
      );
    }

    const resourcePaths = new Set<string>();
    manifest.content.resources.forEach((entry, index) => {
      resourcePaths.add(entry.path);
      const digest = entry.resource.digest.value;
      const canonicalPath = `objects/sha256/${digest}`;
      if (entry.path !== canonicalPath) {
        issue(
          ["content", "resources", index, "path"],
          `Resource payload path must be its canonical content identity: ${canonicalPath}`,
        );
      }
      if (entry.resource.id !== `sha256:${digest}`) {
        issue(
          ["content", "resources", index, "resource", "id"],
          "Resource id must be the sha256 content identity",
        );
      }
      const file = filesByPath.get(entry.path);
      if (
        file?.role !== "object" ||
        file.sha256 !== digest ||
        file.bytes !== entry.resource.byteLength
      ) {
        issue(
          ["content", "resources", index, "path"],
          "Resource descriptor must match one exact resource payload file",
        );
      }
    });

    const documentPaths = new Set<string>();
    manifest.content.documentBodies.forEach((entry, index) => {
      documentPaths.add(entry.path);
      const digest = entry.contentHash.slice("sha256:".length);
      const canonicalPath = `objects/sha256/${digest}`;
      if (entry.path !== canonicalPath) {
        issue(
          ["content", "documentBodies", index, "path"],
          `Document body path must be its canonical content identity: ${canonicalPath}`,
        );
      }
      const file = filesByPath.get(entry.path);
      if (
        file?.role !== "object" ||
        file.sha256 !== digest ||
        file.bytes !== entry.byteLength
      ) {
        issue(
          ["content", "documentBodies", index, "path"],
          "Document body descriptor must match one exact document-body payload file",
        );
      }
    });

    const textRevisionPaths = new Set<string>();
    manifest.content.textRevisions.forEach((entry, index) => {
      textRevisionPaths.add(entry.path);
      if (entry.revision.projectId !== manifest.source.projectId) {
        issue(
          ["content", "textRevisions", index, "revision", "projectId"],
          "Text revision must belong to the exported Project",
        );
      }
      if (filesByPath.get(entry.path)?.role !== "object") {
        issue(
          ["content", "textRevisions", index, "path"],
          "Text revision must identify one text-revision-body payload file",
        );
      }
      const file = filesByPath.get(entry.path);
      if (
        file?.role === "object" &&
        !file.sha256.startsWith(entry.revision.contentHash)
      ) {
        issue(
          ["content", "textRevisions", index, "revision", "contentHash"],
          "Text revision contentHash must match the exported body SHA-256 prefix",
        );
      }
      if (
        file?.role === "object" &&
        entry.path !== `objects/sha256/${file.sha256}`
      ) {
        issue(
          ["content", "textRevisions", index, "path"],
          "Text revision body path must be its canonical content identity",
        );
      }
    });

    manifest.files.forEach((file, index) => {
      const referenced =
        file.role === "workspace" ||
        (file.role === "project" &&
          file.path === manifest.content.project.path) ||
        (file.role === "object" &&
          (resourcePaths.has(file.path) ||
            documentPaths.has(file.path) ||
            textRevisionPaths.has(file.path)));
      if (!referenced) {
        issue(
          ["files", index, "path"],
          "Workspace bundle payload file is not part of the declared content closure",
        );
      }
    });
  });

const WorkspaceTransferTimestampSchema = z.string().datetime({ offset: true });
const WorkspaceTransferCapabilitySchema = z
  .string()
  .min(16)
  .max(500)
  .regex(/^[A-Za-z0-9_-]+$/u);
const WorkspaceTransferIdempotencyKeySchema = z.string().trim().min(1).max(500);

function validateWorkspaceImportIdempotency(
  value: { idempotencyKey: string; bundleDigest: string },
  context: z.RefinementCtx,
): void {
  if (value.idempotencyKey !== `workspace-import:${value.bundleDigest}`) {
    context.addIssue({
      code: "custom",
      path: ["idempotencyKey"],
      message: "Workspace import idempotency key must bind the bundle digest",
    });
  }
}

export const WorkspaceTransferFileCapabilitySchema =
  WorkspaceBundleFileSchema.extend({
    fileId: WorkspaceTransferCapabilitySchema,
  }).strict();

function validateTransferFileIdentities(
  files: ReadonlyArray<{
    fileId: string;
    path: string;
  }>,
  context: z.RefinementCtx,
): void {
  const fileIds = new Set<string>();
  const paths = new Set<string>();
  files.forEach((file, index) => {
    if (fileIds.has(file.fileId)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "fileId"],
        message: "Duplicate Workspace transfer file capability",
      });
    }
    if (paths.has(file.path)) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Duplicate Workspace transfer logical path",
      });
    }
    if (index > 0 && files[index - 1]!.path >= file.path) {
      context.addIssue({
        code: "custom",
        path: ["files", index, "path"],
        message: "Workspace transfer files must be sorted by logical path",
      });
    }
    fileIds.add(file.fileId);
    paths.add(file.path);
  });
}

export const WorkspaceExportRequestSchema = z
  .object({
    sourceWorkspaceId: NonEmptyIdSchema,
  })
  .strict();

export const WorkspaceExportSourceSchema = WorkspaceBundleSourceSchema.extend({
  sourceWorkspaceId: NonEmptyIdSchema,
}).strict();

export const WorkspaceExportPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.export-plan"),
    exportId: WorkspaceTransferCapabilitySchema,
    expiresAt: WorkspaceTransferTimestampSchema,
    source: WorkspaceExportSourceSchema,
    content: WorkspaceBundleContentSchema,
    semanticRequirements: WorkspaceBundleSemanticRequirementsSchema,
    files: z.array(WorkspaceTransferFileCapabilitySchema).min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    validateTransferFileIdentities(plan.files, context);
    const { sourceWorkspaceId: _sourceWorkspaceId, ...bundleSource } =
      plan.source;
    const closure = WorkspaceBundleManifestSchema.safeParse({
      schemaVersion: 1,
      kind: "clash.workspace.bundle",
      source: bundleSource,
      content: plan.content,
      semanticRequirements: plan.semanticRequirements,
      files: plan.files.map(({ fileId: _fileId, ...file }) => file),
      excluded: [],
      integrity: {
        algorithm: "sha256",
        canonicalization: "clash.workspace-manifest-json.v1",
        bundleDigest: "0".repeat(64),
      },
    });
    if (!closure.success) {
      closure.error.issues.forEach((issue) =>
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        }),
      );
    }
  });

export const WorkspaceImportStartSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.import-start"),
    idempotencyKey: WorkspaceTransferIdempotencyKeySchema,
    bundleDigest: Sha256Schema,
    manifest: WorkspaceBundleManifestSchema,
  })
  .strict()
  .superRefine((start, context) => {
    validateWorkspaceImportIdempotency(start, context);
    if (start.bundleDigest !== start.manifest.integrity.bundleDigest) {
      context.addIssue({
        code: "custom",
        path: ["bundleDigest"],
        message: "Import bundle digest must match the manifest identity",
      });
    }
  });

export const WorkspaceImportFileStateSchema = z.enum(["missing", "present"]);

export const WorkspaceImportFileSlotSchema =
  WorkspaceTransferFileCapabilitySchema.extend({
    state: WorkspaceImportFileStateSchema,
  }).strict();

export const WorkspaceImportTargetSchema = z
  .object({
    projectId: NonEmptyIdSchema,
  })
  .strict();

const WorkspaceImportIdentityShape = {
  importId: WorkspaceTransferCapabilitySchema,
  idempotencyKey: WorkspaceTransferIdempotencyKeySchema,
  bundleDigest: Sha256Schema,
  source: WorkspaceBundleSourceSchema,
  target: WorkspaceImportTargetSchema,
} as const;

export const WorkspaceImportSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.import-session"),
    ...WorkspaceImportIdentityShape,
    expiresAt: WorkspaceTransferTimestampSchema,
    status: z.enum(["staging", "committed"]),
    files: z.array(WorkspaceImportFileSlotSchema).min(1),
    committedAt: WorkspaceTransferTimestampSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    validateWorkspaceImportIdempotency(session, context);
    validateTransferFileIdentities(session.files, context);
    session.files.forEach((file, index) => {
      if (file.role === "workspace") {
        context.addIssue({
          code: "custom",
          path: ["files", index, "role"],
          message:
            "Workspace worktree files are materialized by the CLI, not uploaded to the Host",
        });
      }
    });
    if (session.status === "committed") {
      if (session.committedAt === undefined) {
        context.addIssue({
          code: "custom",
          path: ["committedAt"],
          message: "Committed imports require a commit timestamp",
        });
      }
      session.files.forEach((file, index) => {
        if (file.state === "missing") {
          context.addIssue({
            code: "custom",
            path: ["files", index, "state"],
            message: "Committed imports cannot contain missing file slots",
          });
        }
      });
    } else if (session.committedAt !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["committedAt"],
        message: "Staging imports cannot claim a commit timestamp",
      });
    }
  });

export const WorkspaceImportFileUploadReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.import-file-upload-receipt"),
    importId: WorkspaceTransferCapabilitySchema,
    fileId: WorkspaceTransferCapabilitySchema,
    state: z.literal("present"),
    bytes: z.number().int().nonnegative(),
    sha256: Sha256Schema,
  })
  .strict();

export const WorkspaceImportCommitRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.import-commit"),
    idempotencyKey: WorkspaceTransferIdempotencyKeySchema,
    bundleDigest: Sha256Schema,
  })
  .strict()
  .superRefine(validateWorkspaceImportIdempotency);

export const WorkspaceImportCommitResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("clash.workspace.import-commit-response"),
    status: z.enum(["committed", "already-committed"]),
    ...WorkspaceImportIdentityShape,
    committedAt: WorkspaceTransferTimestampSchema,
  })
  .strict()
  .superRefine(validateWorkspaceImportIdempotency);

export type WorkspaceBundleFileRole = z.infer<
  typeof WorkspaceBundleFileRoleSchema
>;
export type WorkspaceBundleFile = z.infer<typeof WorkspaceBundleFileSchema>;
export type WorkspaceBundleManifest = z.infer<
  typeof WorkspaceBundleManifestSchema
>;
export type WorkspaceExportRequest = z.infer<
  typeof WorkspaceExportRequestSchema
>;
export type WorkspaceExportPlan = z.infer<typeof WorkspaceExportPlanSchema>;
export type WorkspaceTransferFileCapability = z.infer<
  typeof WorkspaceTransferFileCapabilitySchema
>;
export type WorkspaceImportStart = z.infer<typeof WorkspaceImportStartSchema>;
export type WorkspaceImportFileState = z.infer<
  typeof WorkspaceImportFileStateSchema
>;
export type WorkspaceImportFileSlot = z.infer<
  typeof WorkspaceImportFileSlotSchema
>;
export type WorkspaceImportTarget = z.infer<typeof WorkspaceImportTargetSchema>;
export type WorkspaceImportSession = z.infer<
  typeof WorkspaceImportSessionSchema
>;
export type WorkspaceImportFileUploadReceipt = z.infer<
  typeof WorkspaceImportFileUploadReceiptSchema
>;
export type WorkspaceImportCommitRequest = z.infer<
  typeof WorkspaceImportCommitRequestSchema
>;
export type WorkspaceImportCommitResponse = z.infer<
  typeof WorkspaceImportCommitResponseSchema
>;
