-- Reuse the durable outbox for coalesced checkpoint work; no separate scheduler table.
ALTER TABLE project_replica_outbox ADD COLUMN kind text NOT NULL DEFAULT 'notification'
  CHECK (kind IN ('notification','checkpoint'));
ALTER TABLE project_replica_outbox DROP CONSTRAINT project_replica_outbox_pkey;
ALTER TABLE project_replica_outbox ADD PRIMARY KEY(kind,project_id,cursor);
CREATE UNIQUE INDEX project_replica_checkpoint_pending_idx
  ON project_replica_outbox(project_id) WHERE kind='checkpoint';
DROP INDEX project_replica_outbox_available_idx;
CREATE INDEX project_replica_outbox_available_idx
  ON project_replica_outbox(kind,lease_until,project_id,cursor);
-- Existing dirty history also needs a durable wake-up when upgrading.
INSERT INTO project_replica_outbox(kind,project_id,cursor,lease_until)
SELECT 'checkpoint',h.project_id,h.cursor,CURRENT_TIMESTAMP + interval '10 minutes'
FROM project_replica_head h LEFT JOIN project_replica_checkpoint c USING(project_id)
WHERE h.cursor>COALESCE(c.cursor,0);
