/** Native Document outputs are read-only even before their revision is published. */
export function isDocumentResultNode(
  data: Record<string, unknown> | null | undefined,
): boolean {
  return Boolean(
    data &&
    (data.documentRevision !== undefined ||
      (typeof data.documentKind === "string" &&
        typeof data.actionRunId === "string")),
  );
}
