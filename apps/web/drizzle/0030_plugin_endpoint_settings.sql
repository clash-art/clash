-- Third-party executable plugin endpoints, one per user + plugin.
-- The signing secret is sealed with ACTION_SECRET_KEY by the Cloudflare
-- adapter; this table stores only the envelope. No foreign keys.
CREATE TABLE IF NOT EXISTS plugin_endpoint_settings (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  plugin_id text NOT NULL,
  endpoint text NOT NULL,
  encrypted_secret text NOT NULL,
  version text,
  schema_hash text,
  export_ids text,
  idempotent_submit integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS plugin_endpoint_settings_user_plugin_idx
  ON plugin_endpoint_settings(user_id, plugin_id);
