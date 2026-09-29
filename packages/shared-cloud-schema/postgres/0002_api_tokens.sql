-- Credential authority for the Node control plane. Issuance remains an administrative operation.
CREATE TABLE api_token (
 id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL,
 token_hash text NOT NULL UNIQUE, token_prefix text NOT NULL,
 last_used_at timestamptz, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX api_token_user_idx ON api_token(user_id);
