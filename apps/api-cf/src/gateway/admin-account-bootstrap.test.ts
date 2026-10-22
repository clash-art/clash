/** Bootstrap of the first admin account (#394) against a fully migrated node:sqlite D1 schema. */
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import {
  adminAccountBootstrapSql,
  bootstrapWranglerArgs,
  checkAdminPassword,
  parseBootstrapArgs,
  redactBootstrapSql,
} from "./admin-account-bootstrap";

const accountId = () => `adm_${crypto.randomUUID().replaceAll("-", "")}`;

describe("admin account bootstrap", () => {
  it("creates one account in the admin store, with a credential Better Auth verifies, and audits once however often it runs", async () => {
    const { sqlite } = createSqliteD1();
    const password = "first-admin-password";
    const passwordHash = await hashPassword(password);
    // Each run of the script draws a new id; the email keeps it idempotent.
    for (let run = 0; run < 3; run += 1)
      sqlite.exec(adminAccountBootstrapSql({ id: accountId(), email: "Ops@Example.com", name: "Ops", passwordHash }));
    const accounts = sqlite.prepare(`SELECT id, email, name, role, disabled_at FROM admin_accounts`).all() as Array<{ id: string }>;
    expect(accounts).toEqual([{ id: expect.stringMatching(/^adm_/), email: "ops@example.com", name: "Ops", role: "platform_admin", disabled_at: null }]);
    const credentials = sqlite.prepare(`SELECT admin_id, provider_id, password FROM admin_credentials`).all() as Array<{ password: string }>;
    expect(credentials).toEqual([{ admin_id: accounts[0]!.id, provider_id: "credential", password: passwordHash }]);
    expect(await verifyPassword({ hash: credentials[0]!.password, password })).toBe(true);
    expect(sqlite.prepare(`SELECT actor_kind, actor_id, action, target_id FROM gateway_admin_audit`).all()).toEqual([
      { actor_kind: "bootstrap", actor_id: "bootstrap", action: "admin_account.create", target_id: accounts[0]!.id },
    ]);
    // Never a product user.
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM users`).get()).toEqual({ n: 0 });
  });

  it("refuses values it cannot embed safely", () => {
    const valid = { id: accountId(), email: "a@example.com", name: "A", passwordHash: `${"a".repeat(32)}:${"b".repeat(128)}` };
    for (const email of ["", "x'; DROP TABLE users; --@x.com", "a b@example.com", "no-at-sign"])
      expect(() => adminAccountBootstrapSql({ ...valid, email }), email).toThrow(/Refusing email/);
    expect(() => adminAccountBootstrapSql({ ...valid, name: "x'); --" })).toThrow(/Refusing name/);
    expect(() => adminAccountBootstrapSql({ ...valid, id: "u1" })).toThrow(/Refusing account id/);
    expect(() => adminAccountBootstrapSql({ ...valid, passwordHash: "plaintext" })).toThrow(/Refusing password hash/);
  });

  it("targets a local or the staging D1 only, and never takes a password on the command line", () => {
    expect(parseBootstrapArgs(["--email", "a@example.com", "--local"])).toEqual({
      email: "a@example.com",
      name: "a",
      target: { kind: "local" },
      dryRun: false,
    });
    expect(parseBootstrapArgs(["--email", "a@example.com", "--name", "Ops", "--env", "staging", "--dry-run"])).toEqual({
      email: "a@example.com",
      name: "Ops",
      target: { kind: "staging" },
      dryRun: true,
    });
    for (const argv of [
      ["--email", "a@example.com", "--env", "production"],
      ["--email", "a@example.com", "--remote"],
      ["--email", "a@example.com", "--production"],
      ["--email", "a@example.com", "--env=production"],
      ["--email", "a@example.com", "--local", "--password", "secret-secret-1"],
      ["--email", "a@example.com", "--local", "--password=secret-secret-1"],
      ["--email", "a@example.com"],
      ["--local"],
      ["--email", "not-an-email", "--local"],
    ])
      expect(() => parseBootstrapArgs(argv), argv.join(" ")).toThrow();
    expect(bootstrapWranglerArgs({ kind: "local" }, "/tmp/x.sql")).toEqual(expect.arrayContaining(["clash-d1", "--local", "--file", "/tmp/x.sql"]));
    const staging = bootstrapWranglerArgs({ kind: "staging" }, "/tmp/x.sql");
    expect(staging).toEqual(expect.arrayContaining(["clash-staging", "--env", "staging", "--file", "/tmp/x.sql"]));
    expect(staging).not.toContain("clash-d1");
  });

  it("checks the password length without echoing it, and the dry run never prints its hash", () => {
    for (const password of ["short", "x".repeat(129)]) {
      let message = "";
      try {
        checkAdminPassword(password);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/12 to 128 characters/);
      expect(message).not.toContain(password);
    }
    expect(() => checkAdminPassword("a-good-password")).not.toThrow();
    const passwordHash = `${"c".repeat(32)}:${"d".repeat(128)}`;
    const printed = redactBootstrapSql(
      adminAccountBootstrapSql({ id: accountId(), email: "a@example.com", name: "A", passwordHash }),
      passwordHash,
    );
    expect(printed).not.toContain(passwordHash);
    expect(printed).toContain("<password hash>");
  });
});
