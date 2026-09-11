import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import type {
  DocumentRead,
  DocumentAttachmentRead,
} from "@clash/shared-runtime/document-client";
import type { ResolvedProjectContext } from "./project-context";
import { resolveAgentFilePathInsideCwd } from "./projection-cas";
import {
  readWorktreeObservation,
  recordWorktreeObservation,
} from "./worktree-observations";

type Observation = Pick<DocumentRead, "revision" | "projection" | "readToken">;
type Draft = Observation & { originalHash: string };
const fileHash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function identity(
  context: ResolvedProjectContext,
  entityKind: string,
  entityId: string,
) {
  if (!context.workspaceRoot)
    throw new Error(
      "READ_REQUIRED: Link this working tree with clash init before editing Documents.",
    );
  return {
    workspaceRoot: context.workspaceRoot,
    projectId: context.projectId,
    entityKind,
    entityId,
  };
}
export function documentFile(context: ResolvedProjectContext, file: string) {
  if (!context.workspaceRoot)
    throw new Error(
      "Link this working tree with clash init before pulling Documents.",
    );
  return resolveAgentFilePathInsideCwd({
    cwd: context.workspaceRoot,
    filePath: file,
    writeVerb: "Document projection",
  });
}
export async function observeDocument(
  context: ResolvedProjectContext,
  value: DocumentRead,
) {
  if (!context.workspaceRoot || !value.readToken || !value.revision) return;
  const observation: Observation = {
    revision: value.revision,
    projection: value.projection,
    readToken: value.readToken,
  };
  for (const entityId of [
    value.revision.documentAssetId,
    `${value.revision.documentAssetId}@${value.revision.id}`,
  ]) {
    await recordWorktreeObservation({
      ...identity(context, "document", entityId),
      revision: JSON.stringify(observation),
    });
  }
}
export async function observedDocument(
  context: ResolvedProjectContext,
  asset: string,
  revision?: string,
): Promise<Observation> {
  const raw = await readWorktreeObservation(
    identity(context, "document", revision ? `${asset}@${revision}` : asset),
  );
  if (!raw)
    throw new Error(
      `READ_REQUIRED: clash assets documents get ${asset}${revision ? ` --revision ${revision}` : ""} before modifying it.`,
    );
  return JSON.parse(raw) as Observation;
}
export function decodeDocument(
  text: string,
  projection: DocumentRead["projection"],
) {
  return projection.format === "text" ? text : JSON.parse(text);
}
export function encodeDocument(
  body: unknown,
  projection: DocumentRead["projection"],
) {
  if (projection.format === "text") {
    if (typeof body !== "string")
      throw new Error("Document text projection did not return text.");
    return body;
  }
  return `${JSON.stringify(body, null, 2)}\n`;
}
function draftIdentity(context: ResolvedProjectContext, file: string) {
  return identity(
    context,
    "document-file",
    relative(context.workspaceRoot!, file),
  );
}
export async function saveDocumentDraft(
  context: ResolvedProjectContext,
  file: string,
  value: DocumentRead,
  original: string,
) {
  const draft: Draft = {
    revision: value.revision,
    projection: value.projection,
    readToken: value.readToken,
    originalHash: fileHash(original),
  };
  await recordWorktreeObservation({
    ...draftIdentity(context, file),
    revision: JSON.stringify(draft),
  });
}
export async function readDocumentDraft(
  context: ResolvedProjectContext,
  file: string,
  asset: string,
): Promise<Draft> {
  const raw = await readWorktreeObservation(draftIdentity(context, file));
  if (!raw)
    throw new Error(
      `READ_REQUIRED: Pull Document ${asset} to this file before applying it.`,
    );
  const draft = JSON.parse(raw) as Draft;
  if (draft.revision.documentAssetId !== asset)
    throw new Error(
      "READ_REQUIRED: This file was pulled from a different Document.",
    );
  return draft;
}
export async function pullDocumentFile(
  context: ResolvedProjectContext,
  file: string,
  value: DocumentRead,
) {
  const encoded = encodeDocument(value.body, value.projection);
  let existing: string | undefined;
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && existing !== encoded) {
    const raw = await readWorktreeObservation(draftIdentity(context, file));
    const prior = raw ? (JSON.parse(raw) as Draft) : undefined;
    if (
      !prior ||
      prior.originalHash !== fileHash(existing) ||
      prior.revision.documentAssetId !== value.revision.documentAssetId
    ) {
      throw new Error(
        "DIRTY_PROJECTION: Preserve or merge this file's edits before pulling; use a new file for a fresh copy.",
      );
    }
  }
  await writeFile(file, encoded, "utf8");
  await saveDocumentDraft(context, file, value, encoded);
}
export function requireEditableDocument(value: Observation) {
  if (!value.projection.editable)
    throw new Error(
      "READ_ONLY_DOCUMENT: This Document kind has no editable projection; exact reads and unchanged copies remain available.",
    );
  if (value.revision.mutability === "immutable")
    throw new Error(
      "COPY_ON_WRITE_REQUIRED: Copy this Document explicitly; existing references remain pinned to the source.",
    );
}

export async function observeAttachment(
  context: ResolvedProjectContext,
  value: DocumentAttachmentRead,
) {
  if (!context.workspaceRoot) return;
  await recordWorktreeObservation({
    ...identity(context, "document-attachment", value.attachment.id),
    revision: JSON.stringify(value),
  });
}
export async function observedAttachment(
  context: ResolvedProjectContext,
  id: string,
): Promise<DocumentAttachmentRead> {
  const raw = await readWorktreeObservation(
    identity(context, "document-attachment", id),
  );
  if (!raw)
    throw new Error(
      `READ_REQUIRED: Read attachment ${id} before advancing it.`,
    );
  return JSON.parse(raw) as DocumentAttachmentRead;
}
export async function observeDocumentCollection(
  context: ResolvedProjectContext,
  collection: string,
  value: unknown,
) {
  if (!context.workspaceRoot) return;
  await recordWorktreeObservation({
    ...identity(context, "document-collection", collection),
    revision: JSON.stringify(value),
  });
}
