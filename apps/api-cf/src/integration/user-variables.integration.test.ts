import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  getVariable,
  listVariableKeys,
  setVariable,
} from "../services/user-variables";

const SECRET_KEY = "integration-user-variable-secret";

it("upserts a variable when the same key is set twice against the migrated schema", async () => {
  const userId = `vars-${crypto.randomUUID()}`;

  await setVariable(env.DB, userId, "API_KEY", "first", SECRET_KEY);
  await setVariable(env.DB, userId, "API_KEY", "second", SECRET_KEY);

  expect(await getVariable(env.DB, userId, "API_KEY", SECRET_KEY)).toBe(
    "second",
  );
  expect(
    (await listVariableKeys(env.DB, userId)).map((entry) => entry.key),
  ).toEqual(["API_KEY"]);
});

it("the unique-index migration keeps the most recently updated duplicate", async () => {
  const migration = (
    env.TEST_MIGRATIONS as Array<{ name: string; queries: string[] }>
  ).find(
    (candidate) => candidate.name === "0027_user_variable_unique.sql",
  );
  if (!migration) throw new Error("0027_user_variable_unique.sql not loaded");

  // Rebuild the pre-migration index from 0004 so duplicates can exist.
  await env.DB.exec("DROP INDEX IF EXISTS user_variable_unique_idx");
  await env.DB.exec(
    "CREATE INDEX user_variable_unique_idx ON user_variable (user_id, key)",
  );
  const userId = `vars-${crypto.randomUUID()}`;
  const insert = env.DB.prepare(
    "INSERT INTO user_variable (id, user_id, key, encrypted_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch([
    insert.bind(crypto.randomUUID(), userId, "DUP", "newest", 100, 300),
    insert.bind(crypto.randomUUID(), userId, "DUP", "older", 100, 200),
    insert.bind(crypto.randomUUID(), userId, "DUP", "undated", 100, null),
    insert.bind(crypto.randomUUID(), userId, "OTHER", "untouched", 100, 100),
  ]);

  for (const query of migration.queries) {
    await env.DB.prepare(query).run();
  }

  const rows = await env.DB.prepare(
    "SELECT key, encrypted_value FROM user_variable WHERE user_id = ? ORDER BY key",
  )
    .bind(userId)
    .all<{ key: string; encrypted_value: string }>();
  expect(rows.results).toEqual([
    { key: "DUP", encrypted_value: "newest" },
    { key: "OTHER", encrypted_value: "untouched" },
  ]);

  await expect(
    insert.bind(crypto.randomUUID(), userId, "DUP", "again", 100, 400).run(),
  ).rejects.toThrow(/UNIQUE/);
});
