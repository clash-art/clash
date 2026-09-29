-- Resource facts and library entries belong to the authenticated owner.
-- Files are immutable, content-addressed objects on the configured persistent volume.
CREATE TABLE personal_asset (
  owner_id text NOT NULL,
  id text NOT NULL,
  entry jsonb NOT NULL,
  resource jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, id)
);
CREATE TABLE personal_asset_deletion (
  owner_id text NOT NULL,
  asset_id text NOT NULL,
  operation_id text NOT NULL,
  PRIMARY KEY (owner_id, asset_id, operation_id)
);
