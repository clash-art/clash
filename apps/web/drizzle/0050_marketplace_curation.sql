-- Marketplace curation overlay (#432). Guide companion: hosted admin.clash.video.
-- Git catalog (skills/registry.json, bundled marketplace plugins) remains identity
-- and install truth. This table only stores ops-controlled display curation.
-- No foreign keys (AGENTS.md). Missing table ⇒ fail open (no overlay).
CREATE TABLE IF NOT EXISTS marketplace_curation (
  kind text NOT NULL CHECK (kind IN ('skill', 'plugin')),
  item_id text NOT NULL,
  featured integer NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
  hidden integer NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  sort_order integer,
  title_override text,
  description_override text,
  updated_at integer NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_by text,
  PRIMARY KEY (kind, item_id)
);

CREATE INDEX IF NOT EXISTS marketplace_curation_featured_idx
  ON marketplace_curation(featured, sort_order);
