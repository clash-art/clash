-- Text revision history for the Node adapter of the shared text-revisions
-- module (see apps/web/drizzle/0029_text_revisions.sql). Bodies live on disk.
CREATE TABLE IF NOT EXISTS text_revisions (
  project_id text NOT NULL,
  revision_id text NOT NULL,
  node_id text NOT NULL,
  created_at text NOT NULL,
  revision jsonb NOT NULL,
  PRIMARY KEY (project_id, revision_id)
);
CREATE INDEX IF NOT EXISTS text_revisions_project_created_idx
  ON text_revisions (project_id, created_at DESC, revision_id DESC);
CREATE INDEX IF NOT EXISTS text_revisions_project_node_idx
  ON text_revisions (project_id, node_id, created_at DESC, revision_id DESC);
