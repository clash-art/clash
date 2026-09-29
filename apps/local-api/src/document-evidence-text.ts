import { MODEL_TEXT_DOCUMENT_KIND } from "@clash/shared-types";

export type DocumentEvidenceText = {
  text: string;
  startMs?: number;
  endMs?: number;
};
type JsonRecord = Record<string, unknown>;
function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function strings(values: unknown[]): string {
  return values
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join(" · ");
}
function textEntry(value: unknown): DocumentEvidenceText[] {
  return typeof value === "string" && value.trim() ? [{ text: value }] : [];
}
function entries(value: unknown, fields: string[]): DocumentEvidenceText[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const item = record(raw);
    const text = strings(fields.map((key) => item[key]));
    if (!text) return [];
    const range =
      typeof item.startMs === "number" &&
      Number.isInteger(item.startMs) &&
      item.startMs >= 0 &&
      typeof item.endMs === "number" &&
      Number.isInteger(item.endMs) &&
      item.endMs > item.startMs
        ? { startMs: item.startMs, endMs: item.endMs }
        : {};
    return [{ text, ...range }];
  });
}

/** Search declared prose only; serialized metadata, hashes, and model identifiers are not content. */
export function documentEvidenceText(
  kind: string,
  raw: unknown,
): DocumentEvidenceText[] {
  if (kind === MODEL_TEXT_DOCUMENT_KIND) return textEntry(raw);
  const body = record(raw);
  const result = record(body.result);
  switch (kind) {
    case "media.operation-trace":
      return textEntry(strings([body.title, body.detail]));
    case "media.observation":
      return [
        ...textEntry(body.summary),
        ...entries(body.observations, ["text"]),
      ];
    case "media.description":
      return textEntry(body.text);
    case "media.transcript": {
      const segments = entries(body.segments, ["text"]);
      return segments.length ? segments : entries(body.words, ["text"]);
    }
    case "media.analysis.description":
      return textEntry(result.text);
    case "media.analysis.tags":
      return textEntry(strings(Array.isArray(result.tags) ? result.tags : []));
    case "media.analysis.subjects":
      return entries(result.items, ["name", "description"]);
    case "media.analysis.actions-events":
      return entries(result.items, ["label", "description"]);
    case "media.analysis.scene-shot":
      return entries(result.scenes, ["description", "shotType"]);
    case "media.analysis.ocr":
      return entries(result.items, ["text"]);
    case "media.analysis.style":
      return textEntry(
        strings([
          result.summary,
          ...(Array.isArray(result.mood) ? result.mood : []),
          ...(Array.isArray(result.composition) ? result.composition : []),
        ]),
      );
    case "media.analysis.audio-semantics":
      return textEntry(
        strings([
          result.summary,
          result.speechSummary,
          ...(Array.isArray(result.music) ? result.music : []),
          ...(Array.isArray(result.sounds) ? result.sounds : []),
        ]),
      );
    default:
      return [];
  }
}

export function normalizedContentText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}
