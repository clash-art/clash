import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { createRequire } from "node:module";
// Drizzle Kit 0.28 ships its Node API with CommonJS filesystem dependencies.
const { generateSQLiteDrizzleJson, generateSQLiteMigration } = createRequire(
  import.meta.url,
)("drizzle-kit/api") as typeof import("drizzle-kit/api");
import { expect, it } from "vitest";
import * as auth from "./auth";
import * as app from "./app";
import * as broker from "./broker";
import * as runtime from "./runtime";

it("generates executable SQLite schema and preserves auth relations without SQL foreign-key coupling", async () => {
  const schema = { ...auth, ...app, ...broker, ...runtime };
  const blank = await generateSQLiteDrizzleJson({});
  const generated = await generateSQLiteDrizzleJson(schema, blank.id);
  const statements = await generateSQLiteMigration(blank, generated);
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  try {
    for (const statement of statements) sqlite.exec(statement);
    const db = drizzle(
      async (sql, params, method) => {
        const statement = sqlite.prepare(sql);
        if (method === "run") {
          statement.run(...params);
          return { rows: [] };
        }
        statement.setReturnArrays(true);
        const rows =
          method === "get"
            ? statement.get(...params)
            : statement.all(...params);
        if (rows === undefined) return { rows: [] };
        if (!Array.isArray(rows))
          throw new Error("SQLite array result mode was not applied");
        return { rows };
      },
      { schema },
    );
    const externalId = "external-auth-boundary-user";
    await db
      .insert(app.installedSkills)
      .values({
        userId: externalId,
        skillId: "legacy-skill",
        name: "Historical skill",
      });
    await db
      .insert(auth.sessions)
      .values({
        id: "external-session",
        userId: externalId,
        token: "external-token",
        expiresAt: new Date(Date.now() + 60_000),
      });
    const userId = "same-auth-user";
    await db
      .insert(auth.users)
      .values({ id: userId, email: "local@example.invalid", name: "Local" });
    await db
      .insert(auth.sessions)
      .values({
        id: "session",
        userId,
        token: "token",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await db
      .insert(auth.accounts)
      .values({
        id: "account",
        accountId: "account",
        providerId: "credential",
        userId,
      });
    const user = await db.query.users.findFirst({
      with: { sessions: true, accounts: true },
    });
    expect(user?.sessions.map((session) => session.userId)).toEqual([userId]);
    expect(user?.accounts.map((account) => account.userId)).toEqual([userId]);
    expect((await db.select().from(app.installedSkills))[0]?.userId).toBe(
      externalId,
    );
    expect(
      await db.query.sessions.findFirst({
        where: (sessions, { eq }) => eq(sessions.id, "session"),
        with: { users: true },
      }),
    ).toMatchObject({ users: { id: userId } });
  } finally {
    sqlite.close();
  }
});
