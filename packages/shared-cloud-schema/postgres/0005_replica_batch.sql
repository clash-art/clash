-- One durable idempotency record for the complete protocol batch, including its length.
CREATE TABLE project_replica_batch (
  project_id text NOT NULL,
  batch_id text NOT NULL,
  payload_hash text NOT NULL,
  PRIMARY KEY (project_id, batch_id)
);
