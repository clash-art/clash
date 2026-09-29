import type {
  DurableRunJournal,
  DurableRunRecord,
} from "@clash/shared-runtime/durable-run-engine";

/** D1-backed journal for the cloud owner. The table is installed by the app migration. */
export interface D1CloudDurableRunJournal extends DurableRunJournal {
  create(run: DurableRunRecord): Promise<void>;
  listRecoverable(ownerId: string, now: number): Promise<DurableRunRecord[]>;
}

import {
  type CloudRunRow,
  assertIdentity,
  identityText,
  parseRow,
  serialize,
  recoveryAt,
  sameFrozenFields,
} from "@clash/shared-runtime/cloud-run-journal";

/**
 * Build the cloud journal from a D1 binding. Each state transition uses an
 * optimistic `revision` and owner predicate; competing Workflow replays or
 * alarm deliveries therefore produce a CAS miss instead of a second side
 * effect. D1's single-row UPDATE is the only lock needed by the adapter.
 */
export function createD1CloudDurableRunJournal(
  db: D1Database,
): D1CloudDurableRunJournal {
  return {
    async create(run) {
      const json = serialize(run);
      await db
        .prepare(
          `INSERT OR IGNORE INTO cloud_durable_run_journal (
             action_run_id, output_slot, owner_realm, owner_id,
             revision, phase, recover_at, updated_at, record_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          run.actionRunId,
          run.outputSlot,
          run.owner.realm,
          run.owner.id,
          run.revision,
          run.phase,
          recoveryAt(run),
          run.updatedAt,
          json,
        )
        .run();
      const existing = await this.load({
        actionRunId: run.actionRunId,
        outputSlot: run.outputSlot,
      });
      if (!existing || !sameFrozenFields(existing, run)) {
        throw new Error(
          `Cloud durable run ${run.actionRunId}/${run.outputSlot} already exists with different content.`,
        );
      }
    },

    async load(identity) {
      assertIdentity(identity);
      const row = await db
        .prepare(
          `SELECT action_run_id, output_slot, owner_realm, owner_id,
                  revision, phase, recover_at, updated_at, record_json
             FROM cloud_durable_run_journal
            WHERE action_run_id = ? AND output_slot = ?`,
        )
        .bind(identity.actionRunId, identity.outputSlot)
        .first<CloudRunRow>();
      return row ? parseRow(row) : undefined;
    },

    async compareAndSet(identity, expectedRevision, next) {
      assertIdentity(identity);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error(
          "A cloud durable run CAS requires a non-negative expected revision.",
        );
      }
      if (
        next.actionRunId !== identity.actionRunId ||
        next.outputSlot !== identity.outputSlot ||
        next.revision !== expectedRevision + 1
      ) {
        throw new Error(
          `Cloud durable run CAS identity/version is invalid for ${identityText(identity)}.`,
        );
      }
      const current = await this.load(identity);
      if (
        !current ||
        current.revision !== expectedRevision ||
        !sameFrozenFields(current, next)
      ) {
        return false;
      }
      const result = await db
        .prepare(
          `UPDATE cloud_durable_run_journal
              SET owner_realm = ?, owner_id = ?, revision = ?, phase = ?,
                  recover_at = ?, updated_at = ?, record_json = ?
            WHERE action_run_id = ? AND output_slot = ?
              AND revision = ? AND owner_realm = ? AND owner_id = ?`,
        )
        .bind(
          next.owner.realm,
          next.owner.id,
          next.revision,
          next.phase,
          recoveryAt(next),
          next.updatedAt,
          serialize(next),
          identity.actionRunId,
          identity.outputSlot,
          expectedRevision,
          current.owner.realm,
          current.owner.id,
        )
        .run();
      return Number(result.meta.changes) === 1;
    },

    async listRecoverable(ownerId, now) {
      if (!ownerId.trim())
        throw new Error("A cloud recoverable scan requires an owner id.");
      if (!Number.isFinite(now))
        throw new Error("A cloud recoverable scan requires a finite time.");
      const rows = await db
        .prepare(
          `SELECT action_run_id, output_slot, owner_realm, owner_id,
                  revision, phase, recover_at, updated_at, record_json
             FROM cloud_durable_run_journal
            WHERE owner_realm = 'cloud' AND owner_id = ?
              AND recover_at IS NOT NULL AND recover_at <= ?
            ORDER BY recover_at ASC, action_run_id ASC, output_slot ASC`,
        )
        .bind(ownerId, now)
        .all<CloudRunRow>();
      return (rows.results ?? []).map(parseRow);
    },
  };
}
