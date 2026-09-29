import type { CloudDurableRunJournal } from "@clash/shared-runtime/cloud-run-coordinator";
import {
  assertIdentity,
  identityText,
  parseRow,
  recoveryAt,
  sameFrozenFields,
  serialize,
  type CloudRunRow,
} from "@clash/shared-runtime/cloud-run-journal";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";

/** Business state and initial dispatch intent commit together. BullMQ owns subsequent delivery. */
export function createPostgresRunJournal(
  db: PostgresTransactionPort,
): CloudDurableRunJournal {
  return {
    async create(run) {
      const json = serialize(run);
      await db.transaction(async (tx) => {
        const inserted = await tx.query(
          `INSERT INTO cloud_durable_run_journal
          (action_run_id,output_slot,owner_realm,owner_id,revision,phase,recover_at,updated_at,record_json)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING action_run_id`,
          [
            run.actionRunId,
            run.outputSlot,
            run.owner.realm,
            run.owner.id,
            run.revision,
            run.phase,
            recoveryAt(run),
            run.updatedAt,
            json,
          ],
        );
        if (inserted.rows.length) {
          await tx.query(
            "INSERT INTO cloud_run_dispatch(action_run_id,output_slot) VALUES ($1,$2)",
            [run.actionRunId, run.outputSlot],
          );
        } else {
          const rows = await tx.query<CloudRunRow & Record<string, unknown>>(
            "SELECT * FROM cloud_durable_run_journal WHERE action_run_id=$1 AND output_slot=$2",
            [run.actionRunId, run.outputSlot],
          );
          if (!rows.rows[0] || !sameFrozenFields(parseRow(rows.rows[0]), run))
            throw Error("Run already exists with different frozen content");
        }
      });
    },
    async load(identity) {
      assertIdentity(identity);
      const result = await db.query<CloudRunRow & Record<string, unknown>>(
        "SELECT * FROM cloud_durable_run_journal WHERE action_run_id=$1 AND output_slot=$2",
        [identity.actionRunId, identity.outputSlot],
      );
      return result.rows[0] ? parseRow(result.rows[0]) : undefined;
    },
    async compareAndSet(identity, expectedRevision, next) {
      assertIdentity(identity);
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        next.revision !== expectedRevision + 1 ||
        next.actionRunId !== identity.actionRunId ||
        next.outputSlot !== identity.outputSlot
      )
        throw Error(`Invalid run CAS: ${identityText(identity)}`);
      const current = await this.load(identity);
      if (
        !current ||
        current.revision !== expectedRevision ||
        !sameFrozenFields(current, next)
      )
        return false;
      const result = await db.query(
        `UPDATE cloud_durable_run_journal SET revision=$3,phase=$4,recover_at=$5,updated_at=$6,record_json=$7
        WHERE action_run_id=$1 AND output_slot=$2 AND revision=$8 RETURNING action_run_id`,
        [
          identity.actionRunId,
          identity.outputSlot,
          next.revision,
          next.phase,
          recoveryAt(next),
          next.updatedAt,
          serialize(next),
          expectedRevision,
        ],
      );
      return result.rows.length === 1;
    },
    async listRecoverable(ownerId, now) {
      if (!ownerId.trim() || !Number.isFinite(now))
        throw Error("Invalid recovery scan");
      const result = await db.query<CloudRunRow & Record<string, unknown>>(
        "SELECT * FROM cloud_durable_run_journal WHERE owner_id=$1 AND recover_at <= $2 ORDER BY recover_at,action_run_id,output_slot",
        [ownerId, now],
      );
      return result.rows.map(parseRow);
    },
  };
}
