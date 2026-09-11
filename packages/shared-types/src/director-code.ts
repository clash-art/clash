import type { DirectorStageState } from "./director-stage.js";
import { z } from "zod";
import { DocumentAssetRevisionRefSchema } from "./generator-v2.js";

export const DirectorCodeComponentRegistrySchema = z.array(
  z
    .object({
    id: z.string().trim().min(1),
      name: z.string().min(1),
      source: DocumentAssetRevisionRefSchema,
    })
    .strict(),
);

/** This slot and source interpretation belong to the Director plugin protocol. */
export const DIRECTOR_CODE_INPUT_SLOT = "stage:code";

export function directorCodeRegistryError(
  state: DirectorStageState,
): string | undefined {
  const ids = new Set<string>();
  for (const component of state.codeComponents ?? []) {
    if (ids.has(component.id))
      return `Duplicate Director code component ${component.id}`;
    ids.add(component.id);
  }
  for (const object of state.objects) {
    if (object.kind === "code" && !ids.has(object.code.componentId)) {
      return `Object ${object.id} uses unregistered Director component ${object.code.componentId}`;
    }
  }
  return undefined;
}

/** Decode a public exact-revision read. Never substitute a Document's current head. */
export function directorCodeDocumentBody(
  source: NonNullable<DirectorStageState["codeComponents"]>[number]["source"],
  response: unknown,
): string {
  const value = response as {
    revision?: {
      id?: string;
      documentAssetId?: string;
      documentKind?: string;
      schemaVersion?: number;
    };
    body?: unknown;
  } | null;
  if (
    !value?.revision ||
    value.revision.id !== source.revisionId ||
    value.revision.documentAssetId !== source.documentAssetId ||
    value.revision.documentKind !== "text.plain" ||
    value.revision.schemaVersion !== 1 ||
    typeof value.body !== "string" ||
    !value.body.trim()
  ) {
    throw new Error(
      `Director component requires exact text.plain revision ${source.documentAssetId}/${source.revisionId}`,
    );
  }
  return value.body;
}
