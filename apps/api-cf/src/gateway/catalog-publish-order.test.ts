/**
 * Catalog publish order (#351, migration 0051). `published_at` is unix
 * seconds, so the version published last must win a same-second tie through
 * `publish_seq`, never through the larger version name; and the backfill keeps
 * the version that routed before the migration routing after it.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createSqliteD1, WEB_DRIZZLE_MIGRATIONS } from "../../../web/app/test-support/sqlite-d1";
import { createD1CatalogAdmin } from "./d1-catalog-admin";
import { publishedCatalogVersionSql } from "./d1-common";
import { createD1GatewayRoutesPort } from "./d1-routes";
import { officialChatCard, officialMessagesCard } from "./test-support";

const MIGRATION = "0051_gateway_catalog_publish_seq.sql";
const actor = { kind: "admin", id: "adm_order", role: "platform_admin" } as const;
const silent = { info: () => {}, warn: () => {}, error: () => {} };
const identity = { tenantId: "", userId: "", budgetIds: [], credentialScope: "official" } as const;

function apply(db: DatabaseSync, file: string) {
  for (const part of readFileSync(join(WEB_DRIZZLE_MIGRATIONS, file), "utf8").split("--> statement-breakpoint"))
    if (part.trim()) db.exec(part);
}

describe("catalog publish order", () => {
  it("routes the version published last within one second, whatever its name", async () => {
    const { d1, sqlite } = createSqliteD1();
    const at = Date.now();
    const clock = { now: () => at };
    const admin = createD1CatalogAdmin(d1, { clock });
    const later = `aaa-${crypto.randomUUID().slice(0, 8)}`;
    const earlier = `zzz-${crypto.randomUUID().slice(0, 8)}`;
    for (const version of [earlier, later])
      for (const card of [officialChatCard(), officialMessagesCard()])
        await admin.putModel({ version, modelCode: card.id, card, enabled: true, actor });

    await admin.publish({ version: earlier, actor });
    await admin.publish({ version: later, actor });

    const routes = createD1GatewayRoutesPort(d1, { clock, logger: silent });
    expect((await routes.catalog(identity)).version).toBe(later);
    const seqs = sqlite
      .prepare(`SELECT catalog_version, publish_seq FROM gateway_model WHERE catalog_version IN (?, ?) ORDER BY rowid`)
      .all(earlier, later) as Array<{ catalog_version: string; publish_seq: number }>;
    const of = (version: string) => new Set(seqs.filter((row) => row.catalog_version === version).map((row) => row.publish_seq));
    // Every row of a version carries one sequence number, and the later publish the larger one.
    expect(of(earlier).size).toBe(1);
    expect(of(later).size).toBe(1);
    expect([...of(later)][0]!).toBeGreaterThan([...of(earlier)][0]!);
    expect((await admin.list()).find((summary) => summary.live)?.version).toBe(later);
  });

  it("backfills published versions in the order the live query chose before, leaving drafts unnumbered", () => {
    const db = new DatabaseSync(":memory:");
    for (const file of readdirSync(WEB_DRIZZLE_MIGRATIONS).filter((f) => f.endsWith(".sql")).sort())
      if (file < MIGRATION) apply(db, file);
    const insert = db.prepare(
      `INSERT INTO gateway_model (id, catalog_version, model_code, kind, card_json, published_at) VALUES (?, ?, ?, 'text', '{}', ?)`,
    );
    insert.run("m1", "b-old", "x", 100);
    insert.run("m2", "a-tie", "x", 200);
    insert.run("m3", "c-tie", "x", 200);
    insert.run("m4", "c-tie", "y", 200);
    insert.run("m5", "draft", "x", null);
    // The live query as it was before 0051: newest second, then the larger name.
    const liveBefore = (
      db
        .prepare(
          `SELECT catalog_version AS version FROM gateway_model WHERE published_at IS NOT NULL
            ORDER BY published_at DESC, catalog_version DESC LIMIT 1`,
        )
        .get() as { version: string }
    ).version;

    apply(db, MIGRATION);

    const live = (db.prepare(`SELECT ${publishedCatalogVersionSql("?")} AS version`).get(1_000) as { version: string }).version;
    expect(live).toBe(liveBefore);
    const seq = Object.fromEntries(
      (db.prepare(`SELECT id, publish_seq FROM gateway_model`).all() as Array<{ id: string; publish_seq: number | null }>).map(
        (row) => [row.id, row.publish_seq],
      ),
    );
    expect(seq.m1!).toBeLessThan(seq.m2!);
    expect(seq.m2!).toBeLessThan(seq.m3!);
    expect(seq.m4).toBe(seq.m3);
    expect(seq.m5).toBeNull();
  });
});
