import { expect, it } from "vitest";
import { is, Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as api from "./app.schema";
import * as web from "../../../web/app/lib/db/app.schema";
import * as apiAuth from "../auth-schema";
import * as apiDbAuth from "./better-auth.schema";
import * as webAuth from "../../../web/app/lib/db/better-auth.schema";

it("shares actual table and relation identity across backend import paths", () => {
  for (const [name, table] of Object.entries(api)) {
    if (name in web) expect(web[name as keyof typeof web], name).toBe(table);
  }
  for (const [name, value] of Object.entries(apiAuth)) {
    expect(apiDbAuth[name as keyof typeof apiDbAuth], name).toBe(value);
    expect(webAuth[name as keyof typeof webAuth], name).toBe(value);
  }
});
it("exports active backend schemas without SQL foreign keys", () => {
  for (const schema of [api, web, apiAuth, apiDbAuth, webAuth]) {
    for (const table of Object.values(schema)) {
      if (!is(table, Table)) continue;
      const config = getTableConfig(
        table as Parameters<typeof getTableConfig>[0],
      );
      expect(config.foreignKeys, config.name).toEqual([]);
    }
  }
});
