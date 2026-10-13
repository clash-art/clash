import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Staging owns isolated state (issue #64). `ProjectRoom` re-checks ownership
 * and credentials against the database of the Worker that hosts it, so a
 * staging Worker that delegates Durable Objects to the production script, or
 * binds the production D1 / R2, either fails or writes test data into
 * production. These tests read the `[env.staging]` tables of both deployed
 * configs and assert none of them reaches a production resource.
 */
const PRODUCTION_RESOURCES = [
  "master-clash-api-hosted",
  "aab16eeb-a375-490b-ad1e-cd092cd9f4bb",
  "clash-d1",
  "clash-r2",
];

/** Lines of every `[env.staging]` / `[env.staging.*]` table, comments removed. */
function stagingTables(toml: string): string[] {
  const lines: string[] = [];
  let inStaging = false;
  for (const raw of toml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header) {
      const table = header[1].trim();
      inStaging = table === "env.staging" || table.startsWith("env.staging.");
    }
    if (inStaging) lines.push(line);
  }
  return lines;
}

describe.each(["apps/api-cf/wrangler.toml", "apps/web/wrangler.toml"])(
  "%s [env.staging]",
  (config) => {
    const staging = stagingTables(
      readFileSync(resolve(__dirname, "../../..", config), "utf8"),
    );

    it("declares a staging environment with its own D1 binding", () => {
      expect(staging).toContain("[env.staging]");
      expect(staging).toContain("[[env.staging.d1_databases]]");
    });

    it.each(PRODUCTION_RESOURCES)("never references %s", (resource) => {
      expect(staging.filter((line) => line.includes(resource))).toEqual([]);
    });

    it("binds no Durable Object or Workflow hosted by another script", () => {
      expect(staging.filter((line) => /^script_name\b/.test(line))).toEqual([]);
    });
  },
);
