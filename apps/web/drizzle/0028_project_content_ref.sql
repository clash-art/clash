-- Issue #130: content-reference index maintained by the ProjectRoom so the
-- upload path admits Document bodies / Resources without loading the Project's
-- Loro snapshot. Rebuildable at any time from the room (it is a cache of
-- projectSyncContent(doc)); no foreign keys, same as project_cloud_admission.
CREATE TABLE IF NOT EXISTS project_content_ref (
  project_id text NOT NULL,
  ref_kind text NOT NULL,          -- 'document' | 'resource'
  ref_key text NOT NULL,           -- document digest ("sha256:…") or resourceId
  byte_length integer,             -- documents only
  content_type text,               -- documents only
  asset_kind text,                 -- resources only
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (project_id, ref_kind, ref_key)
);
