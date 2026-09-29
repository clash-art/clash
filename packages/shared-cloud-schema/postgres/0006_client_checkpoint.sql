-- Computation leases only. Log durability and append availability never depend on them.
CREATE TABLE project_replica_checkpoint_task (
  project_id text PRIMARY KEY,
  task_id text NOT NULL,
  user_id text NOT NULL,
  base_cursor bigint NOT NULL CHECK (base_cursor >= 0),
  target_cursor bigint NOT NULL CHECK (target_cursor > base_cursor),
  expires_at timestamptz NOT NULL,
  completed boolean NOT NULL DEFAULT false
);
