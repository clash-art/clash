-- Cloud owner-private Durable Run journal.
-- Do not add foreign keys: project/user identities cross auth boundaries.
CREATE TABLE IF NOT EXISTS cloud_durable_run_journal (
  action_run_id TEXT NOT NULL,
  output_slot TEXT NOT NULL,
  owner_realm TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  phase TEXT NOT NULL,
  recover_at INTEGER,
  updated_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (action_run_id, output_slot)
);

CREATE INDEX IF NOT EXISTS cloud_durable_run_journal_recovery
  ON cloud_durable_run_journal (owner_realm, owner_id, recover_at);
