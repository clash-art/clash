import type { GeneratorAssetType } from "./generator-v2.js";

export const MODEL_TEXT_DOCUMENT_KIND = "text.plain";
export const MODEL_TEXT_DOCUMENT_SCHEMA_VERSION = 1;

/** Models generate media or plain text; typed analysis Documents have their own Actions. */
export function isModelGenerationOutputType(type: GeneratorAssetType): boolean {
  return type.kind === "media" ||
    (type.documentKind === MODEL_TEXT_DOCUMENT_KIND && type.schemaVersion === MODEL_TEXT_DOCUMENT_SCHEMA_VERSION);
}
