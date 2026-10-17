-- Text revision history (`clash text apply`) for the Cloudflare adapter of the
-- shared text-revisions module. Rows are immutable revision metadata scoped
-- per Project; Markdown bodies live in R2 under text-revisions/<projectId>/.
-- Same columns as the local Host's text_revisions table. No foreign keys.
CREATE TABLE IF NOT EXISTS text_revisions (
  project_id text NOT NULL,
  revision_id text NOT NULL,
  node_id text NOT NULL,
  created_at text NOT NULL,        -- ISO 8601 from the revision
  revision_json text NOT NULL,     -- canonical TextAppliedRevision
  PRIMARY KEY (project_id, revision_id)
);
CREATE INDEX IF NOT EXISTS text_revisions_project_created_idx
  ON text_revisions(project_id, created_at DESC, revision_id DESC);
CREATE INDEX IF NOT EXISTS text_revisions_project_node_idx
  ON text_revisions(project_id, node_id, created_at DESC, revision_id DESC);
