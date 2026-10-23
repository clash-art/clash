/**
 * Configurable rate limits over D1 (#354) on node:sqlite with every
 * migration: per-member and tenant-wide limits set by the team owner, the
 * tightest of the owner's and the subscription's tenant limit, media jobs in
 * flight, and tenant-scoped counters (a user in two teams, two tenants side by
 * side). Limits are inputs here; expectations follow from them.
 */
import { describe, expect, it } from "vitest";
import { GatewayError, type LimitInput } from "@clash/gateway-core";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import { createD1GatewayLimitPort, gatewayLimitSubjects } from "./d1-limits";

const { d1, sqlite } = createSqliteD1();
// Mid-window, so a test never straddles a one-minute boundary.
let now = Math.floor(Date.now() / 60_000) * 60_000 + 30_000;
let sequence = 0;
const limits = createD1GatewayLimitPort(d1, { clock: { now: () => now }, ids: { requestId: () => `r${(sequence += 1)}` } });

const id = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

function team(limit?: Record<string, number>) {
  const tenantId = `team:${id()}`;
  sqlite
    .prepare(`INSERT INTO tenant (id, owner_user_id, name, kind, rate_limit_json) VALUES (?, 'o', 'T', 'team', ?)`)
    .run(tenantId, limit ? JSON.stringify(limit) : null);
  return tenantId;
}

function join(tenantId: string, userId: string, limit?: Record<string, number> | string) {
  sqlite
    .prepare(`INSERT INTO tenant_member (tenant_id, user_id, role, rate_limit_json) VALUES (?, ?, 'member', ?)`)
    .run(tenantId, userId, limit === undefined ? null : typeof limit === "string" ? limit : JSON.stringify(limit));
}

const admit = (input: Partial<LimitInput> & Pick<LimitInput, "tenantId" | "userId">) =>
  limits.admit({ modelCode: "m", estimatedTokens: 1, ...input });

describe("D1 limits: owner-configured and tenant-scoped", () => {
  it("counts a member limit per tenant: the same user in another team is not throttled", async () => {
    const userId = `u-${id()}`;
    const teamA = team();
    const teamB = team();
    join(teamA, userId, { requestsPerMinute: 2 });
    join(teamB, userId, { requestsPerMinute: 2 });
    for (let index = 0; index < 2; index += 1) expect((await admit({ tenantId: teamA, userId })).allowed).toBe(true);
    const denied = await admit({ tenantId: teamA, userId });
    expect(denied).toMatchObject({ allowed: false, code: "GATEWAY_RATE_LIMITED", scope: "user" });
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
    for (let index = 0; index < 2; index += 1) expect((await admit({ tenantId: teamB, userId })).allowed).toBe(true);
    const subjects = (sqlite.prepare(`SELECT subject FROM gateway_rate_window WHERE subject LIKE ?`).all(`%${userId}`) as Array<{ subject: string }>).map(
      (row) => row.subject,
    );
    expect(subjects.sort()).toEqual([gatewayLimitSubjects.member(teamA, userId), gatewayLimitSubjects.member(teamB, userId)].sort());
  });

  it("applies the tightest of the owner's tenant limit and the subscription's, and one tenant's burst never throttles another", async () => {
    const busy = team({ requestsPerMinute: 1 });
    sqlite
      .prepare(
        `INSERT INTO gateway_tenant_subscription (id, tenant_id, package_id, status, current_period_start, current_period_end, rate_limit_json)
         VALUES (?, ?, 'pkg', 'active', 0, 9999999999, ?)`,
      )
      .run(`sub-${id()}`, busy, JSON.stringify({ requestsPerMinute: 5 }));
    const quiet = team({ requestsPerMinute: 1 });
    for (const tenantId of [busy, quiet]) join(tenantId, "shared-user");
    expect((await admit({ tenantId: busy, userId: "shared-user" })).allowed).toBe(true);
    expect(await admit({ tenantId: busy, userId: "shared-user" })).toMatchObject({ allowed: false, scope: "tenant" });
    expect((await admit({ tenantId: quiet, userId: "shared-user" })).allowed).toBe(true);
  });

  it("bounds media jobs in flight separately from text requests, and frees the slot on release", async () => {
    const tenantId = team();
    const userId = `u-${id()}`;
    join(tenantId, userId, { mediaJobs: 1 });
    const first = await admit({ tenantId, userId, media: true });
    expect(first.allowed).toBe(true);
    expect(await admit({ tenantId, userId, media: true })).toMatchObject({ allowed: false, code: "GATEWAY_CONCURRENCY_LIMITED", scope: "user" });
    // A text request is not a media job.
    expect((await admit({ tenantId, userId })).allowed).toBe(true);
    if (first.allowed) await limits.release({ leaseId: first.leaseId });
    expect((await admit({ tenantId, userId, media: true })).allowed).toBe(true);
  });

  it("fails closed on a malformed stored limit", async () => {
    const tenantId = team();
    const userId = `u-${id()}`;
    join(tenantId, userId, JSON.stringify({ requestsPerMinute: 0 }));
    await expect(admit({ tenantId, userId })).rejects.toSatisfy(
      (error: unknown) => error instanceof GatewayError && error.code === "GATEWAY_INTERNAL",
    );
  });

  it("starts a fresh window after the minute ends", async () => {
    const tenantId = team();
    const userId = `u-${id()}`;
    join(tenantId, userId, { requestsPerMinute: 1 });
    expect((await admit({ tenantId, userId })).allowed).toBe(true);
    expect((await admit({ tenantId, userId })).allowed).toBe(false);
    now += 60_000;
    expect((await admit({ tenantId, userId })).allowed).toBe(true);
  });
});
