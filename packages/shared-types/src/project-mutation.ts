import type { LoroDoc } from "loro-crdt";

/**
 * Prepare a synchronous domain operation away from the live replica. Nested
 * Canvas exports may commit the draft, but cannot publish incomplete state.
 * Applying the final diff produces local operations (unlike importing a fork),
 * so normal sync and undo subscriptions observe one complete mutation.
 */
export function commitProjectMutation<T extends { ok: boolean }>(
  doc: LoroDoc,
  prepare: (draft: LoroDoc) => T,
): T {
  const draft = doc.fork();
  try {
    const before = draft.frontiers();
    const result = prepare(draft);
    if (!result.ok) return result;
    draft.commit();
    const diff = draft.diff(before, draft.frontiers());
    doc.applyDiff(diff);
    doc.commit();
    return result;
  } finally {
    draft.free();
  }
}
