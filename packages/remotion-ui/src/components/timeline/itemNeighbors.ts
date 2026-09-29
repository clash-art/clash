/** Temporal neighbors for roll editing. Preserve authored order for equal starts. */
export function indexItemNeighbors<T extends { id: string; from: number }>(items: readonly T[]) {
  const ordered = [...items].sort((left, right) => left.from - right.from);
  return new Map(ordered.map((item, index) => [item.id, {
    left: ordered[index - 1] ?? null,
    right: ordered[index + 1] ?? null,
  }]));
}
