/**
 * Canvas plugin Actions on the Node adapter (#238).
 *
 * api-node runs no plugin Action: it has no executable binding resolution, no
 * Action invoker and therefore no remote plugin output path (the Cloudflare
 * adapter's run-scoped upload sessions). A pending custom Action node must not
 * sit `pending` forever, so the outbox worker fails it with the shared
 * `plugin_unavailable` code, the way api-cf fails an Action it cannot bind.
 *
 * The relay is opaque, so the sweep follows each Project's durable log: every
 * append's notification reaches `sweep`, which catches a cached replica up to
 * the head and scans it. Only when a pending custom Action is visible does it
 * take the Project transaction and append the failure, re-checked under the
 * log-head lock. A node another Host already claimed (`pendingTask`) is left
 * to that Host.
 */
import { LoroDoc } from "loro-crdt";
import { pendingCustomActionNode } from "@clash/shared-runtime/canvas-executable-node";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { withProjectDocument } from "./project-document.ts";
import { createRelayStore } from "./relay-store.ts";
import type { ReplicaNotificationPublisher } from "./replica-log.ts";
import { apiNodeLog } from "./log.ts";

export const PLUGIN_ACTIONS_UNAVAILABLE_CODE = "plugin_unavailable";
export const PLUGIN_ACTIONS_UNAVAILABLE_MESSAGE =
  "Plugin Actions are not available on this Host.";

const log = apiNodeLog.child("plugin-actions");

type NodeRecord = Record<string, unknown> & { data: Record<string, unknown> };

/** Pending custom Action nodes no Host has claimed, as the processors select them. */
function unclaimedPluginActions(doc: LoroDoc): Array<[string, NodeRecord]> {
  const found: Array<[string, NodeRecord]> = [];
  for (const [nodeId, raw] of doc.getMap("nodes").entries()) {
    const node = raw as unknown as NodeRecord | undefined;
    const data = node?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    if (typeof data.assetId === "string" && data.assetId) continue;
    if (pendingCustomActionNode(node)) found.push([nodeId, node]);
  }
  return found;
}

/** Fail every unclaimed pending custom Action in `doc`; returns their node ids. */
export function failUnavailablePluginActions(doc: LoroDoc): string[] {
  const nodes = doc.getMap("nodes");
  return unclaimedPluginActions(doc).map(([nodeId, node]) => {
    nodes.set(nodeId, {
      ...node,
      data: {
        ...node.data,
        status: "failed",
        error: PLUGIN_ACTIONS_UNAVAILABLE_MESSAGE,
        errorCode: PLUGIN_ACTIONS_UNAVAILABLE_CODE,
        pendingTask: undefined,
        pendingTaskAt: undefined,
      },
    });
    return nodeId;
  });
}

interface CachedReplica {
  doc: LoroDoc;
  cursor: number;
  scanned: number;
}

/**
 * Per-process sweep with a bounded LRU of caught-up replicas, so a busy
 * Project costs its new log events rather than a full replay per append.
 */
export function createPluginActionSweep(
  db: PostgresTransactionPort,
  options: { maxProjects?: number } = {},
) {
  const maxProjects = options.maxProjects ?? 64;
  const cache = new Map<string, CachedReplica>();
  const forget = (projectId: string) => {
    cache.get(projectId)?.doc.free();
    cache.delete(projectId);
  };

  async function caughtUp(projectId: string): Promise<CachedReplica> {
    const store = createRelayStore(db, projectId);
    let entry = cache.get(projectId);
    cache.delete(projectId);
    if (!entry) {
      const snapshot = await store.loadCheckpoint();
      const doc = new LoroDoc();
      if (snapshot) doc.import(snapshot.data);
      entry = { doc, cursor: snapshot?.cursor ?? 0, scanned: -1 };
    }
    // Reinserted (most recently used) before any await can fail, so a read
    // error drops it through `forget` instead of leaking the document.
    cache.set(projectId, entry);
    const head = await store.head();
    while (entry.cursor < head) {
      const page = await store.readAfter(entry.cursor, head, 256);
      if (!page.length) throw Error("Project replica log is incomplete");
      for (const event of page) {
        if (event.cursor !== entry.cursor + 1)
          throw Error("Project replica log is incomplete");
        if (event.update.byteLength) entry.doc.import(event.update);
        entry.cursor = event.cursor;
      }
    }
    for (const [oldest] of cache) {
      if (cache.size <= maxProjects) break;
      forget(oldest);
    }
    return entry;
  }

  return {
    /** Fail the Project's unclaimed plugin Actions; returns the failed node ids. */
    async sweep(projectId: string): Promise<string[]> {
      let entry: CachedReplica;
      try {
        entry = await caughtUp(projectId);
      } catch (error) {
        forget(projectId);
        throw error;
      }
      if (entry.scanned === entry.cursor) return [];
      if (!unclaimedPluginActions(entry.doc).length) {
        entry.scanned = entry.cursor;
        return [];
      }
      const { rows } = await db.query<{ owner_id: string }>(
        "SELECT owner_id FROM project WHERE id=$1 AND deleted_at IS NULL",
        [projectId],
      );
      const owner = rows[0]?.owner_id;
      // A deleted Project has no Canvas left to show the failure on.
      if (!owner) return [];
      let failed: string[];
      try {
        failed = await withProjectDocument(
          db,
          owner,
          projectId,
          (ids: string[]) => ids.length > 0,
          (doc) => failUnavailablePluginActions(doc),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "Project not found")
          return [];
        throw error;
      }
      // The failure append advances the head, so the next notification
      // rescans; an unchanged head needs no second transaction.
      entry.scanned = entry.cursor;
      if (failed.length)
        log.warn("plugin_action.unavailable", {
          code: PLUGIN_ACTIONS_UNAVAILABLE_CODE,
          project_id: projectId,
          nodes: failed.length,
        });
      return failed;
    },
    close() {
      for (const projectId of [...cache.keys()]) forget(projectId);
    },
  };
}

/**
 * The notification publisher, followed by the sweep. A sweep failure fails
 * the delivery, so the outbox lease retries both (notifications are already
 * at-least-once).
 */
export function withPluginActionSweep(
  publisher: ReplicaNotificationPublisher,
  sweep: ReturnType<typeof createPluginActionSweep>,
): ReplicaNotificationPublisher {
  return {
    async publish(event) {
      await publisher.publish(event);
      await sweep.sweep(event.projectId);
    },
  };
}
