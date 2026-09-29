CREATE TABLE cloud_durable_run_journal (
  action_run_id text NOT NULL,
  output_slot text NOT NULL,
  owner_realm text NOT NULL CHECK (owner_realm = 'cloud'),
  owner_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  phase text NOT NULL,
  recover_at double precision,
  updated_at double precision NOT NULL,
  record_json text NOT NULL,
  PRIMARY KEY (action_run_id, output_slot)
);
CREATE INDEX cloud_run_recovery ON cloud_durable_run_journal(owner_id, recover_at) WHERE recover_at IS NOT NULL;
CREATE TABLE cloud_run_dispatch (
  action_run_id text NOT NULL,
  output_slot text NOT NULL,
  PRIMARY KEY (action_run_id, output_slot)
);
