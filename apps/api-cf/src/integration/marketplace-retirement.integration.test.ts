import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { settingsD1Routes } from "../routes/settings-d1";
import type { Env } from "../config";

it("keeps authenticated historical Action reads/removal while refusing new Worker records", async () => {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS installed_action (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action_id TEXT NOT NULL,
    name TEXT NOT NULL, description TEXT, manifest TEXT NOT NULL, runtime TEXT NOT NULL,
    version TEXT, author TEXT, repository TEXT, worker_url TEXT, icon TEXT, color TEXT,
    tags TEXT, created_at INTEGER
  )`,
  ).run();
  const id = crypto.randomUUID();
  for (const user of ["dev-user", "other-user"]) {
    await env.DB.prepare(
      "INSERT INTO installed_action (id, user_id, action_id, name, manifest, runtime) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(`${user}-${id}`, user, id, "Historical Worker", "{}", "worker")
      .run();
  }
  const bindings = {
    ...env,
    ENVIRONMENT: "test",
    SKIP_LOGIN: "true",
    AUTH_SECRET: "local-test-auth-secret-for-marketplace",
  } as unknown as Env;
  const rejected = await settingsD1Routes.request(
    "/actions",
    {
      method: "POST",
      body: JSON.stringify({
        manifest: {
          id: "new-worker",
          workerUrl: "https://example.invalid/worker",
        },
      }),
    },
    bindings,
  );
  expect(rejected.status).toBe(410);
  expect(await rejected.json()).toMatchObject({
    code: "LEGACY_ACTION_INSTALL_RETIRED",
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT id FROM installed_action WHERE action_id = ?",
      )
        .bind("new-worker")
        .all()
    ).results,
  ).toEqual([]);
  const denied = await settingsD1Routes.request(
    "/actions",
    { method: "POST" },
    { ...bindings, SKIP_LOGIN: undefined } as Env,
  );
  expect(denied.status).toBe(401);
  const historical = (await (
    await settingsD1Routes.request("/actions", {}, bindings)
  ).json()) as Array<{ actionId: string }>;
  expect(historical.filter((row) => row.actionId === id)).toHaveLength(1);
  expect(
    (
      await settingsD1Routes.request(
        `/actions/${id}`,
        { method: "DELETE" },
        bindings,
      )
    ).status,
  ).toBe(204);
  const remaining = await env.DB.prepare(
    "SELECT user_id FROM installed_action WHERE action_id = ?",
  )
    .bind(id)
    .all();
  expect(remaining.results).toEqual([{ user_id: "other-user" }]);
});
