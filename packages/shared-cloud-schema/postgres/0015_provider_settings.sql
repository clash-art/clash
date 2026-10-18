-- Hosted provider settings for the Node adapter, mirroring the D1 tables the
-- Cloudflare voice-input route reads. No foreign keys: credential authority is
-- always (user_id, provider_id) and account ids are opaque.
CREATE TABLE provider_account (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  provider_id text NOT NULL,
  upstream_id text,
  api_shape text,
  region text,
  label text,
  enabled integer NOT NULL DEFAULT 1,
  priority integer,
  weight integer,
  encrypted_credentials text,
  configured_credentials text,
  supported_model_ids text,
  model_priorities text,
  created_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::bigint,
  updated_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::bigint
);
CREATE INDEX provider_account_user_idx ON provider_account (user_id);
CREATE INDEX provider_account_provider_idx ON provider_account (user_id, provider_id, upstream_id);

CREATE TABLE model_card_config (
  user_id text NOT NULL,
  model_id text NOT NULL,
  custom integer NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'text',
  name text,
  description text,
  prompt_guidance text,
  created_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::bigint,
  updated_at bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::bigint,
  PRIMARY KEY (user_id, model_id)
);
CREATE INDEX model_card_config_user_idx ON model_card_config (user_id);

CREATE TABLE model_card_provider_binding (
  user_id text NOT NULL,
  model_id text NOT NULL,
  provider_account_id text NOT NULL,
  upstream_model text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, model_id, provider_account_id)
);
CREATE INDEX model_card_provider_binding_user_idx ON model_card_provider_binding (user_id);

CREATE TABLE provider_usage_audit (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  provider_id text NOT NULL,
  provider_account_id text,
  model_id text NOT NULL,
  operation text NOT NULL,
  task_id text NOT NULL,
  project_id text,
  node_id text,
  actor_type text,
  actor_user_id text,
  actor_agent_id text,
  provider_request_id text,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  estimated_cost_micro_usd integer,
  estimate_complete integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  pricing_source text NOT NULL,
  billing_basis text NOT NULL DEFAULT '{}',
  error_code text,
  error_message text,
  occurred_at bigint NOT NULL
);
CREATE INDEX provider_usage_audit_user_time_idx ON provider_usage_audit (user_id, occurred_at);
CREATE INDEX provider_usage_audit_user_task_idx ON provider_usage_audit (user_id, task_id);
