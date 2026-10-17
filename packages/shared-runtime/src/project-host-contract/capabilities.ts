/**
 * Capabilities of the shared Project Host contract (the HTTP surface UI clients
 * use through `ProjectAssetHttpClient`, `createTimelineClient` and the plugin
 * catalog). Every adapter declares each one; there are no defaults, so adding a
 * capability here fails to compile until every harness answers for it.
 */
export const PROJECT_HOST_CAPABILITIES = [
  "catalog.generators",
  "catalog.views",
  "catalog.actions",
  "timeline.list",
  "timeline.create",
  "timeline.update",
  "timeline.attach",
  "timeline.detach",
  "timeline.delete",
  "timeline.render",
  "assets.list",
  "assets.batch",
  "assets.get",
  "assets.references",
  "assets.import",
  "assets.import.chunked",
  "assets.trash",
  "assets.restore",
  "assets.media",
  "text.revisions",
] as const;

export type CapabilityId = (typeof PROJECT_HOST_CAPABILITIES)[number];

/**
 * What the editor needs to open a Timeline, play imported media and manage
 * its Assets, and keep text version history. Trash/restore are soft deletes of document state, so every
 * Host must offer them; only work that needs the user's own machine (local
 * render) may be `unavailable`.
 */
export const EDITOR_REQUIRED_CAPABILITIES = [
  "catalog.generators",
  "catalog.views",
  "catalog.actions",
  "timeline.list",
  "timeline.create",
  "timeline.update",
  "timeline.attach",
  "timeline.detach",
  "timeline.delete",
  "assets.list",
  "assets.batch",
  "assets.get",
  "assets.import",
  "assets.trash",
  "assets.restore",
  "assets.media",
  "text.revisions",
] as const satisfies readonly CapabilityId[];

/**
 * `unavailable` must still be answered: 501 for a command, or absence from the
 * catalog. A 404 never stands for "not implemented".
 */
export type ContractCapabilities = Record<
  CapabilityId,
  "supported" | "unavailable"
>;
