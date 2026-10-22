/**
 * Price book and credit billing (#352) in workerd with the migrated D1 schema:
 * an admin drafts and publishes price versions through /api/v1/admin/gateway,
 * /gateway/v1/chat/completions charges the version effective at request time,
 * settled rows keep their version when a newer one is published, and a top-up
 * funds the tenant wallet the next request draws on. Upstreams are fetch
 * stubs. The versions this file publishes are deleted afterwards, because the
 * integration D1 is shared with the other gateway suites.
 */
import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../app";
import type { Env } from "../config";
import { sha256Hex } from "../services/api-token";
import { signedInAdmin } from "../services/admin-session.test-support";
import { seedGateway, type SeededGateway } from "../gateway/test-support";

const ORIGIN = "https://clash.test";
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const versionA = `itest-a-${run}`;
const versionB = `itest-b-${run}`;
const draftOnly = `itest-z-${run}`;

describe("price book publish -> request -> settle in workerd", () => {
  const app = createApp();
  let gateway: SeededGateway;
  let bindings: Env;
  let adminAuth: Record<string, string>;

  beforeAll(async () => {
    gateway = await seedGateway(env.DB);
    bindings = {
      ...env,
      BETTER_AUTH_URL: ORIGIN,
      GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey,
    } as unknown as Env;
    // An admin account signed in through /api/admin-auth (#394), never a product-user grant.
    adminAuth = (await signedInAdmin(app, bindings as never, ORIGIN)).auth;
  });
  afterAll(async () => {
    await env.DB.prepare(`DELETE FROM gateway_price WHERE price_version IN (?, ?, ?)`)
      .bind(versionA, versionB, draftOnly)
      .run();
  });
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions")) throw new Error(`Unexpected external request: ${request.url}`);
      const body = (await request.clone().json()) as { model: string };
      return Response.json({
        id: "chatcmpl-price-book",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const api = (method: string, path: string, body?: unknown, auth: Record<string, string> = adminAuth) =>
    app.request(
      path,
      {
        method,
        headers: { origin: ORIGIN, ...auth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      bindings,
    );
  /** A clsh_ token of the tenant owner: tenant billing is a product route, never an admin one (#394). */
  async function ownerAuth(userId: string) {
    const raw = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
    await env.DB.prepare(`INSERT INTO api_token (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, 'owner', ?, 'clsh_ow')`)
      .bind(`tok-owner-${run}`, userId, await sha256Hex(raw))
      .run();
    return { authorization: `Bearer ${raw}` };
  }
  const draft = (version: string, input: number, output: number) =>
    api("PUT", `/api/v1/admin/gateway/prices/versions/${version}`, {
      effectiveFrom: new Date().toISOString(),
      rates: [
        { modelCode: gateway.textModel, unit: "input_token", amountMicroCredits: input, per: 1 },
        { modelCode: gateway.textModel, unit: "output_token", amountMicroCredits: output, per: 1 },
      ],
    });
  const publish = (version: string) => api("POST", `/api/v1/admin/gateway/prices/versions/${version}/publish`);

  async function chat(token: string) {
    const res = await app.request(
      "/gateway/v1/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${token}` },
        body: JSON.stringify({ model: gateway.textModel, messages: [{ role: "user", content: "hello" }], max_tokens: 32 }),
      },
      bindings,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const { results } = await env.DB.prepare(
      `SELECT * FROM gateway_usage_ledger WHERE request_id = ? AND kind = 'settle' ORDER BY budget_id`,
    )
      .bind(res.headers.get("x-clash-request-id"))
      .all<{ budget_id: string; price_version: string; amount_micro_credits: number }>();
    expect(results.length).toBeGreaterThan(0);
    return results;
  }

  it("charges only published versions, never reprices settled usage, and funds the wallet by top-up", async () => {
    const caller = await gateway.tenantToken();

    expect((await draft(draftOnly, 1_000, 1_000)).status).toBe(200);
    const beforePublish = await chat(caller.token);
    expect(beforePublish.map((entry) => entry.price_version)).not.toContain(draftOnly);

    expect((await draft(versionA, 1, 2)).status).toBe(200);
    const publishedA = await publish(versionA);
    expect(publishedA.status, await publishedA.clone().text()).toBe(200);
    const chargedA = await chat(caller.token);
    expect(new Set(chargedA.map((entry) => entry.price_version))).toEqual(new Set([versionA]));
    const settledA = await env.DB.prepare(
      `SELECT * FROM gateway_usage_ledger WHERE request_id = (SELECT request_id FROM gateway_usage_ledger WHERE price_version = ? LIMIT 1) ORDER BY id`,
    )
      .bind(versionA)
      .all();

    expect((await draft(versionB, 10, 20)).status).toBe(200);
    expect((await publish(versionB)).status).toBe(200);
    const again = await env.DB.prepare(
      `SELECT * FROM gateway_usage_ledger WHERE request_id = (SELECT request_id FROM gateway_usage_ledger WHERE price_version = ? LIMIT 1) ORDER BY id`,
    )
      .bind(versionA)
      .all();
    expect(again.results).toEqual(settledA.results);
    const chargedB = await chat(caller.token);
    expect(new Set(chargedB.map((entry) => entry.price_version))).toEqual(new Set([versionB]));
    expect(chargedB[0]!.amount_micro_credits).toBeGreaterThan(chargedA[0]!.amount_micro_credits);

    // A top-up raises the tenant wallet the next request draws on.
    const pack = (await (
      await api("POST", "/api/v1/admin/gateway/topup-packs", {
        name: "Integration pack",
        priceMinor: 500,
        priceCurrency: "USD",
        microCredits: 5_000_000,
      })
    ).json()) as { pack: { id: string; microCredits: number } };
    const walletBefore = await env.DB.prepare(
      `SELECT id, limit_micro_credits FROM gateway_budget WHERE tenant_id = ?1 AND scope = 'tenant' AND scope_id = ?1`,
    )
      .bind(caller.tenantId)
      .first<{ id: string; limit_micro_credits: number }>();
    const owner = await ownerAuth(caller.userId);
    const topupPath = `/api/v1/gateway/tenants/${encodeURIComponent(caller.tenantId)}/topups`;
    const order = { packId: pack.pack.id, idempotencyKey: `itest-${run}` };
    // The admin session buys nothing on the product route.
    expect((await api("POST", topupPath, order)).status).toBe(401);
    const topup = await api("POST", topupPath, order, owner);
    expect(topup.status, await topup.clone().text()).toBe(201);
    const replay = await api("POST", topupPath, order, owner);
    expect(((await replay.json()) as { replayed: boolean }).replayed).toBe(true);
    const walletAfter = await env.DB.prepare(`SELECT limit_micro_credits FROM gateway_budget WHERE id = ?`)
      .bind(walletBefore!.id)
      .first<{ limit_micro_credits: number }>();
    expect(walletAfter!.limit_micro_credits).toBe(walletBefore!.limit_micro_credits + pack.pack.microCredits);
    const afterTopup = await chat(caller.token);
    expect(afterTopup.map((entry) => entry.budget_id)).toContain(walletBefore!.id);
  });
});
