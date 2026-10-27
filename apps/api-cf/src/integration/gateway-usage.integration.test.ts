/**
 * Usage explorer, CSV export, nightly reconciliation and retention (#355) in
 * workerd with the migrated D1 schema (0052 included): requests served through
 * /gateway/v1/chat/completions settle real ledger rows; the admin explorer
 * and its streamed CSV show them; an imported upstream report that differs
 * is reconciled into platform `adjust` rows valued at the price book, once;
 * retention runs as one D1 batch under the audit trigger. Upstreams are fetch
 * stubs. The integration D1 is shared with the other gateway suites, so the
 * served requests are moved to their own past day, priced by a version only
 * this file publishes, and every row this file adds is deleted afterwards.
 */
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GATEWAY_LEDGER_RETENTION_MS, GATEWAY_METADATA_RETENTION_MS, priceUsage, type GatewayLogger } from "@clash/gateway-core";

import { createApp } from "../app";
import type { Env } from "../config";
import { reconcileGatewayUsageNightly } from "../gateway/d1-reconciliation";
import { publishedPriceAt } from "../gateway/d1-routes";
import { seedGateway, type SeededGateway } from "../gateway/test-support";
import { signedInAdmin } from "../services/admin-session.test-support";

const ORIGIN = "https://clash.test";
const DAY_MS = 86_400_000;
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const priceVersion = `itest-rec-${run}`;
const day = new Date(Date.now() - 12 * DAY_MS).toISOString().slice(0, 10);
const noon = Date.parse(`${day}T12:00:00.000Z`);
const silent: GatewayLogger = { info() {}, warn() {}, error() {} };

describe("usage explorer, reconciliation and retention in workerd", () => {
  const app = createApp();
  let gateway: SeededGateway;
  let bindings: Env;
  let adminAuth: Record<string, string>;
  let tenantId: string;
  let upstreamId: string;
  const requestIds: string[] = [];

  const api = (method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { origin: ORIGIN, ...adminAuth, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      bindings,
    );

  beforeAll(async () => {
    gateway = await seedGateway(env.DB);
    bindings = { ...env, BETTER_AUTH_URL: ORIGIN, GATEWAY_ENCRYPTION_KEY: gateway.encryptionKey } as unknown as Env;
    adminAuth = (await signedInAdmin(app, bindings as never, ORIGIN)).auth;
    const caller = await gateway.tenantToken();
    tenantId = caller.tenantId;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input as RequestInfo, init);
      if (!request.url.endsWith("/chat/completions")) throw new Error(`Unexpected external request: ${request.url}`);
      const body = (await request.clone().json()) as { model: string };
      return Response.json({
        id: "chatcmpl-usage",
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "secret answer text" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
      });
    });
    for (let index = 0; index < 2; index += 1) {
      const res = await app.request(
        "/gateway/v1/chat/completions",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, authorization: `Bearer ${caller.token}` },
          body: JSON.stringify({ model: gateway.textModel, messages: [{ role: "user", content: "secret prompt text" }], max_tokens: 16 }),
        },
        bindings,
      );
      expect(res.status, await res.clone().text()).toBe(200);
      requestIds.push(res.headers.get("x-clash-request-id")!);
    }
    vi.restoreAllMocks();
    // Served on their own past day, priced there by a version only this file publishes.
    await env.DB.prepare(
      `UPDATE gateway_usage_ledger SET occurred_at = ?1 WHERE request_id IN (SELECT value FROM json_each(?2))`,
    )
      .bind(Math.floor(noon / 1000), JSON.stringify(requestIds))
      .run();
    upstreamId = (await env.DB.prepare(`SELECT upstream_id FROM gateway_upstream_account WHERE id = ?`)
      .bind(gateway.upstreamAccountId)
      .first<{ upstream_id: string }>())!.upstream_id;
    await env.DB.batch(
      (["input_token", "output_token"] as const).map((unit, index) =>
        env.DB.prepare(
          `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per, effective_from, published_at)
           VALUES (?, ?, ?, ?, ?, ?, 1000, 0, 1)`,
        ).bind(`gwp_${priceVersion}_${unit}`, priceVersion, gateway.textModel, upstreamId, unit, 1_000 * (index + 1)),
      ),
    );
  });

  afterAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM gateway_price WHERE price_version = ?`).bind(priceVersion),
      env.DB.prepare(`DELETE FROM gateway_usage_ledger WHERE kind = 'adjust' AND account_id = ?`).bind(gateway.upstreamAccountId),
      env.DB.prepare(`DELETE FROM gateway_upstream_usage WHERE day = ?`).bind(day),
      env.DB.prepare(`DELETE FROM gateway_upstream_report WHERE day = ?`).bind(day),
      env.DB.prepare(`DELETE FROM gateway_reconciliation_run WHERE day = ?`).bind(day),
    ]);
  });

  it("shows the served requests in the explorer and streams them as CSV, metadata only", async () => {
    const res = await api("GET", `/api/v1/admin/gateway/usage?tenantId=${encodeURIComponent(tenantId)}&kind=settle`);
    const page = (await res.json()) as { entries: Array<{ requestId: string; upstreamId: string | null; chargeMicroCredits: number }> };
    expect(page.entries.map((entry) => entry.requestId).sort()).toEqual([...requestIds].sort());
    expect(page.entries.every((entry) => entry.upstreamId === upstreamId && entry.chargeMicroCredits > 0)).toBe(true);

    const exported = await api("GET", `/api/v1/admin/gateway/usage/export?tenantId=${encodeURIComponent(tenantId)}&kind=settle`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toMatch(/^text\/csv/);
    const text = await exported.text();
    const lines = text.split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(requestIds.length + 1);
    for (const requestId of requestIds) expect(text).toContain(requestId);
    expect(text).not.toContain("secret prompt text");
    expect(text).not.toContain("secret answer text");
  });

  it("reconciles the day against an imported report into one valued adjustment, nightly and idempotently", async () => {
    const { results } = await env.DB.prepare(
      `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM gateway_usage_ledger
        WHERE kind = 'settle' AND request_id IN (SELECT value FROM json_each(?1))
          AND budget_id = (SELECT MIN(s.budget_id) FROM gateway_usage_ledger s WHERE s.request_id = gateway_usage_ledger.request_id AND s.kind = 'settle')`,
    )
      .bind(JSON.stringify(requestIds))
      .all<{ input: number; output: number }>();
    const ledger = { inputTokens: results[0]!.input, outputTokens: results[0]!.output };
    const upstream = { inputTokens: ledger.inputTokens + 40, outputTokens: ledger.outputTokens + 20 };
    const imported = await api("PUT", `/api/v1/admin/gateway/reconciliation/reports/${day}/ai_gateway`, {
      groups: [{ upstreamId, accountId: gateway.upstreamAccountId, modelCode: gateway.textModel, requests: 3, ...upstream }],
    });
    expect(imported.status, await imported.clone().text()).toBe(200);

    const nightly = await reconcileGatewayUsageNightly(bindings, { logger: silent });
    expect(nightly.runs.find((entry) => entry.day === day)).toMatchObject({ status: "adjusted", posted: 1 });
    const price = await publishedPriceAt(
      env.DB,
      { modelCode: gateway.textModel, upstreamId, at: Date.parse(`${day}T23:59:59.000Z`) },
      { logger: silent },
    );
    const empty = { cachedInputTokens: 0, cacheWriteTokens: 0, units: {}, source: "reported" as const };
    const delta = priceUsage({ ...upstream, ...empty }, price).microCredits - priceUsage({ ...ledger, ...empty }, price).microCredits;
    const adjustments = async () =>
      (
        await env.DB.prepare(
          `SELECT tenant_id, status, amount_micro_credits, ref_kind FROM gateway_usage_ledger WHERE kind = 'adjust' AND account_id = ?`,
        )
          .bind(gateway.upstreamAccountId)
          .all()
      ).results;
    expect(await adjustments()).toEqual([{ tenant_id: "", status: "upstream_over", amount_micro_credits: delta, ref_kind: "reconcile" }]);

    // On demand, the same day again posts nothing more.
    const again = await api("POST", "/api/v1/admin/gateway/reconciliation/runs", { day });
    expect(again.status, await again.clone().text()).toBe(201);
    expect(((await again.json()) as { posted: number }).posted).toBe(0);
    expect(await adjustments()).toHaveLength(1);
  });

  it("enforces retention in one batch under the audit trigger", async () => {
    const tag = `itest-ret-${run}`;
    const now = Date.now();
    const metaOld = Math.floor((now - GATEWAY_METADATA_RETENTION_MS - DAY_MS) / 1000);
    const ledgerOld = Math.floor((now - GATEWAY_LEDGER_RETENTION_MS - DAY_MS) / 1000);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO gateway_usage_ledger (id, request_id, kind, status, tenant_id, amount_micro_credits, upstream_id, provider_request_id, occurred_at)
         VALUES (?1 || ':meta', ?1 || ':meta', 'settle', 'settled', ?1, 3, 'openai', 'prov', ?2),
                (?1 || ':gone', ?1 || ':gone', 'settle', 'settled', ?1, 3, 'openai', 'prov', ?3)`,
      ).bind(tag, metaOld, ledgerOld),
      env.DB.prepare(
        `INSERT INTO gateway_admin_audit (id, tenant_id, actor_id, actor_kind, action, target_type, target_id, occurred_at)
         VALUES (?1 || ':old', ?1, 'a', 'admin', 'test', 'test', 't', ?2), (?1 || ':new', ?1, 'a', 'admin', 'test', 'test', 't', ?3)`,
      ).bind(tag, ledgerOld, Math.floor(now / 1000)),
    ]);
    const res = await api("POST", "/api/v1/admin/gateway/retention/enforce", {});
    expect(res.status, await res.clone().text()).toBe(200);
    const ledger = await env.DB.prepare(`SELECT id, amount_micro_credits, upstream_id, provider_request_id FROM gateway_usage_ledger WHERE tenant_id = ?`)
      .bind(tag)
      .all();
    expect(ledger.results).toEqual([{ id: `${tag}:meta`, amount_micro_credits: 3, upstream_id: null, provider_request_id: null }]);
    const audit = await env.DB.prepare(`SELECT id FROM gateway_admin_audit WHERE tenant_id = ?`).bind(tag).all();
    expect(audit.results).toEqual([{ id: `${tag}:new` }]);
    await env.DB.prepare(`DELETE FROM gateway_usage_ledger WHERE tenant_id = ?`).bind(tag).run();
  });
});
