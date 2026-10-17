-- Issue #130: content-reference index (see apps/web/drizzle/0028_project_content_ref.sql).
CREATE TABLE IF NOT EXISTS project_content_ref (
  project_id text NOT NULL,
  ref_kind text NOT NULL,
  ref_key text NOT NULL,
  byte_length bigint,
  content_type text,
  asset_kind text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, ref_kind, ref_key)
);
