-- setVariable upserts with ON CONFLICT (user_id, key), which SQLite only accepts
-- against a UNIQUE index. 0004 created user_variable_unique_idx as a plain index.
-- Keep the most recently updated row per (user_id, key); rowid breaks ties.
DELETE FROM user_variable
WHERE EXISTS (
  SELECT 1 FROM user_variable AS newer
  WHERE newer.user_id = user_variable.user_id
    AND newer.key = user_variable.key
    AND (
      COALESCE(newer.updated_at, 0) > COALESCE(user_variable.updated_at, 0)
      OR (
        COALESCE(newer.updated_at, 0) = COALESCE(user_variable.updated_at, 0)
        AND newer.rowid > user_variable.rowid
      )
    )
);

DROP INDEX IF EXISTS user_variable_unique_idx;

CREATE UNIQUE INDEX user_variable_unique_idx ON user_variable (user_id, key);
