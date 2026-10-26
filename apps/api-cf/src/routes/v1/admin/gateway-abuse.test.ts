/**
 * Abuse signals, thresholds and suspension (#356) through the Worker app on
 * node:sqlite with every migration: admin accounts only; manual and
 * threshold suspension of keys and tenants refuse the data plane with
 * GATEWAY_SUSPENDED (403); each mutation writes one `gateway_admin_audit` row
 * that rolls back with it; thresholds are validated by the one gateway-core
 * schema; nothing here needs or returns key material, and a support_agent
 * account suspends without any key, credential or prompt permission. Data plane requests
 * carry deliberately empty bodies: they are authenticated and counted, then
 * refused before any upstream (no provider is called).
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../../../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { gatewayClientFingerprint } from "@clash/gateway-core";

import { createApp } from "../../../app";
import { createSqliteD1 } from "../../../../../web/app/test-support/sqlite-d1";
import { evaluateGatewayAbuseNow } from "../../../gateway/d1-abuse";
import { signedInAdmin } from "../../../services/admin-session.test-support";

const ORIGIN = "http://localhost:8789";
const { d1, sqlite } = createSqliteD1();
const app = createApp();

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);

const env = {
  DB: d1,
  ENVIRONMENT: "test",
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-for-gateway-abuse-0123456789",
};

const admin = await signedInAdmin(app, env, ORIGIN);
const support = await signedInAdmin(app, env, ORIGIN, { role: "support_agent" });
const BASE = "/api/v1/admin/gateway";

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { origin: ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    },
    env as never,
  );
}

async function expectCode(res: Response, status: number, code: string) {
  const text = await res.clone().text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("x-clash-error-code"), text).toBe(code);
}

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text) as T;
}

/** A team with an owner (a product user with a clsh_ token) and a virtual key. */
function team() {
  const tenantId = `team:${hex()}`;
  const owner = `user-${hex()}`;
  const clsh = `clsh_${hex()}${hex()}`;
  const parentId = `tok-${hex()}`;
  sqlite.prepare(`INSERT INTO tenant (id, owner_user_id, name, kind) VALUES (?, ?, 'Team', 'team')`).run(tenantId, owner);
  sqlite.prepare(`INSERT INTO tenant_member (tenant_id, user_id, role) VALUES (?, ?, 'owner')`).run(tenantId, owner);
  sqlite
    .prepare("INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, 'gw', ?, 'clsh_gw', 1)")
    .run(parentId, owner, sha256(clsh));
  const keyId = `gwk_${hex()}`;
  sqlite
    .prepare(`INSERT INTO gateway_key (id, tenant_id, user_id, name, token_prefix, token_hash) VALUES (?, ?, ?, 'ci', 'sk_gw_ab', ?)`)
    .run(keyId, tenantId, owner, sha256(`key-${keyId}`));
  /** An sk_gw_ token minted from the virtual key (or from the owner's clsh_ token), expiring in 15 minutes. */
  const token = (fromKey = true, revoked = false) => {
    const publicId = randomBytes(12).toString("hex");
    const raw = `sk_gw_${publicId}.${randomBytes(32).toString("hex")}`;
    const nowS = Math.floor(Date.now() / 1000);
    sqlite
      .prepare(
        `INSERT INTO gateway_token (id, token_hash, key_id, parent_kind, parent_id, tenant_id, user_id, scopes_json,
                                    credential_scope, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '["models:invoke"]', 'official', ?, ?)`,
      )
      .run(
        `gwt_${publicId}`,
        sha256(raw),
        fromKey ? keyId : null,
        fromKey ? null : "api_token",
        fromKey ? null : parentId,
        tenantId,
        owner,
        nowS + 900,
        revoked ? nowS : null,
      );
    return { raw, id: `gwt_${publicId}` };
  };
  return { tenantId, keyId, token, ownerAuth: { authorization: `Bearer ${clsh}` } };
}

/** A data plane call: authenticated and counted, then refused or answered before any upstream. */
const invoke = (token: string, headers: Record<string, string> = {}) =>
  call("POST", "/gateway/v1/chat/completions", { authorization: `Bearer ${token}`, ...headers }, {});

const suspended = async (res: Response) => expectCode(res, 403, "GATEWAY_SUSPENDED");
/** Authenticated and admitted past the abuse gate: the empty body is what refuses it. */
const notSuspended = async (res: Response) => expectCode(res, 400, "GATEWAY_INVALID_REQUEST");

function auditRows(action: string, targetId: string) {
  return sqlite
    .prepare(`SELECT * FROM gateway_admin_audit WHERE action = ? AND target_id = ? ORDER BY occurred_at, rowid`)
    .all(action, targetId) as Array<{
    actor_kind: string;
    actor_id: string;
    actor_role: string;
    tenant_id: string;
    target_type: string;
    before_json: string | null;
    after_json: string | null;
    reason: string | null;
  }>;
}

function withAuditFailing<T>(run: () => Promise<T>): Promise<T> {
  sqlite.exec(`CREATE TRIGGER test_audit_down BEFORE INSERT ON gateway_admin_audit BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
  return run().finally(() => sqlite.exec(`DROP TRIGGER test_audit_down`));
}

interface Suspension {
  id: string;
  subjectKind: string;
  subjectId: string;
  tenantId: string;
  source: string;
  signal: string | null;
  liftedAt: string | number | null;
}
const suspend = (body: unknown, auth = admin.auth) => call("POST", `${BASE}/abuse/suspensions`, auth, body);
const lift = (id: string, body: unknown = { reason: "cleared" }) => call("POST", `${BASE}/abuse/suspensions/${id}/lift`, admin.auth, body);
const setThreshold = (signal: string, body: unknown) => call("PUT", `${BASE}/abuse/thresholds/${signal}`, admin.auth, body);

describe("abuse console routes", () => {
  it("answers admin accounts only: a team owner's product credential is refused on every route", async () => {
    const t = team();
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `${BASE}/abuse`],
      ["PUT", `${BASE}/abuse/thresholds/velocity`, { threshold: null }],
      ["POST", `${BASE}/abuse/suspensions`, { subjectKind: "tenant", subjectId: t.tenantId, reason: "x" }],
      ["POST", `${BASE}/abuse/suspensions/gws_abc/lift`, { reason: "x" }],
    ];
    for (const [method, path, body] of routes) {
      await expectCode(await call(method, path, t.ownerAuth, body), 403, "GATEWAY_ADMIN_SESSION_REQUIRED");
      await expectCode(await call(method, path, {}, body), 401, "GATEWAY_AUTH_REQUIRED");
    }
  });

  it("lets a support_agent account suspend and lift by id, audited under its role, while every key, credential and prompt route refuses it", async () => {
    const t = team();
    const token = t.token();
    const created = await json<{ suspension: Suspension }>(
      await suspend({ subjectKind: "key", subjectId: t.keyId, reason: "leaked in a public repo" }, support.auth),
      201,
    );
    await suspended(await invoke(token.raw));
    const text = JSON.stringify(created) + JSON.stringify(await json(await call("GET", `${BASE}/abuse`, support.auth)));
    for (const secret of [token.raw, sha256(token.raw), sha256(`key-${t.keyId}`), "sk_gw_"]) expect(text).not.toContain(secret);
    await json(await call("POST", `${BASE}/abuse/suspensions/${created.suspension.id}/lift`, support.auth, { reason: "rotated" }));
    await notSuspended(await invoke(token.raw));
    expect(auditRows("abuse.suspend", t.keyId).concat(auditRows("abuse.lift", t.keyId))).toEqual([
      expect.objectContaining({ actor_kind: "admin", actor_id: support.id, actor_role: "support_agent" }),
      expect.objectContaining({ actor_kind: "admin", actor_id: support.id, actor_role: "support_agent" }),
    ]);
    const refused: Array<[string, string, unknown?]> = [
      ["GET", `${BASE}/tenants/${encodeURIComponent(t.tenantId)}/keys`],
      ["GET", `${BASE}/upstreams`],
      ["POST", `${BASE}/prompts/req_x/access`, { reason: "look" }],
      ["PUT", `${BASE}/abuse/thresholds/velocity`, { threshold: null }],
      ["GET", `${BASE}/admin-accounts`],
    ];
    for (const [method, path, body] of refused) await expectCode(await call(method, path, support.auth, body), 403, "GATEWAY_FORBIDDEN");
  });

  it("suspends a virtual key manually: its tokens are refused with 403, others of the tenant are not; lifting restores them; both audited", async () => {
    const t = team();
    const fromKey = t.token();
    const standalone = t.token(false);
    const { suspension } = await json<{ suspension: Suspension }>(
      await suspend({ subjectKind: "key", subjectId: t.keyId, reason: "velocity spike" }),
      201,
    );
    expect(suspension).toMatchObject({ subjectKind: "key", subjectId: t.keyId, tenantId: t.tenantId, source: "manual", signal: null, liftedAt: null });
    await suspended(await invoke(fromKey.raw));
    await notSuspended(await invoke(standalone.raw));
    expect(auditRows("abuse.suspend", t.keyId)).toEqual([
      expect.objectContaining({
        actor_kind: "admin",
        actor_id: admin.id,
        actor_role: "platform_admin",
        tenant_id: t.tenantId,
        target_type: "gateway_key",
        reason: "velocity spike",
      }),
    ]);
    await expectCode(await suspend({ subjectKind: "key", subjectId: t.keyId, reason: "again" }), 409, "GATEWAY_SUSPENSION_EXISTS");

    const lifted = await json<{ suspension: Suspension }>(await lift(suspension.id, { reason: "rotated" }));
    expect(lifted.suspension.liftedAt).not.toBeNull();
    await notSuspended(await invoke(fromKey.raw));
    expect(auditRows("abuse.lift", t.keyId)).toEqual([expect.objectContaining({ actor_kind: "admin", reason: "rotated" })]);
    await expectCode(await lift(suspension.id), 404, "GATEWAY_SUSPENSION_NOT_FOUND");
  });

  it("suspends a tenant: every credential of it is refused, a token by its own id too", async () => {
    const t = team();
    const [a, b] = [t.token(), t.token(false)];
    const { suspension } = await json<{ suspension: Suspension }>(
      await suspend({ subjectKind: "tenant", subjectId: t.tenantId, reason: "fraud" }),
      201,
    );
    await suspended(await invoke(a.raw));
    await suspended(await invoke(b.raw));
    await lift(suspension.id);
    await notSuspended(await invoke(b.raw));

    const token = await json<{ suspension: Suspension }>(await suspend({ subjectKind: "key", subjectId: b.id, reason: "one token" }), 201);
    expect(token.suspension.tenantId).toBe(t.tenantId);
    await suspended(await invoke(b.raw));
    await notSuspended(await invoke(a.raw));
    await lift(token.suspension.id);
  });

  it("refuses unknown subjects and malformed requests with coded errors", async () => {
    await expectCode(await suspend({ subjectKind: "tenant", subjectId: "team:nope", reason: "x" }), 404, "GATEWAY_ABUSE_SUBJECT_NOT_FOUND");
    await expectCode(await suspend({ subjectKind: "key", subjectId: "gwk_nope", reason: "x" }), 404, "GATEWAY_ABUSE_SUBJECT_NOT_FOUND");
    await expectCode(await suspend({ subjectKind: "client", subjectId: "abc", reason: "x" }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await suspend({ subjectKind: "tenant", subjectId: team().tenantId }), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await lift("gws_unknown"), 404, "GATEWAY_SUSPENSION_NOT_FOUND");
    await expectCode(await lift("not-an-id"), 400, "GATEWAY_INVALID_REQUEST");
  });

  it("writes nothing when the audit row cannot be written", async () => {
    const t = team();
    await withAuditFailing(async () => {
      expect((await suspend({ subjectKind: "tenant", subjectId: t.tenantId, reason: "x" })).status).toBe(500);
      expect((await setThreshold("spend", { threshold: { windowMinutes: 5, alertAt: 1, suspendAt: null } })).status).toBe(500);
    });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_suspension WHERE subject_id = ?`).get(t.tenantId)).toEqual({ n: 0 });
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_abuse_threshold WHERE signal = 'spend'`).get()).toEqual({ n: 0 });
    await notSuspended(await invoke(t.token().raw));
  });

  it("configures thresholds through the one schema, audited, and clears them", async () => {
    const threshold = { windowMinutes: 10, alertAt: 5, suspendAt: 20 };
    const set = await json<{ threshold: unknown; changed: boolean }>(await setThreshold("shared_key", { threshold, reason: "baseline" }));
    expect(set).toEqual({ signal: "shared_key", threshold, changed: true });
    expect((await json<{ changed: boolean }>(await setThreshold("shared_key", { threshold }))).changed).toBe(false);
    for (const bad of [
      { threshold: { ...threshold, suspendAt: 4 } },
      { threshold: { ...threshold, alertAt: 0 } },
      { threshold: { ...threshold, windowMinutes: 1441 } },
      { threshold: { ...threshold, extra: true } },
      { threshold, extra: true },
    ])
      await expectCode(await setThreshold("shared_key", bad), 400, "GATEWAY_INVALID_REQUEST");
    await expectCode(await setThreshold("bogus", { threshold }), 400, "GATEWAY_INVALID_REQUEST");
    const abuse = await json<{ abuse: { signals: Array<{ signal: string; threshold: unknown; windowMinutes: number }> } }>(
      await call("GET", `${BASE}/abuse`, admin.auth),
    );
    expect(abuse.abuse.signals.find((entry) => entry.signal === "shared_key")).toMatchObject({ threshold, windowMinutes: 10 });
    expect((await json<{ threshold: unknown }>(await setThreshold("shared_key", { threshold: null }))).threshold).toBeNull();
    const audits = auditRows("abuse.threshold", "shared_key");
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actor_kind: "admin", actor_id: admin.id, target_type: "abuse_signal", reason: "baseline" });
    expect(JSON.parse(audits[0]!.after_json!)).toEqual(threshold);
    expect(JSON.parse(audits[1]!.before_json!)).toEqual(threshold);
    expect(audits[1]!.after_json).toBeNull();
  });
});

describe("abuse signals and auto-suspension", () => {
  it("counts 401s per client fingerprint and against a revoked token's tenant, never storing the address", async () => {
    const t = team();
    const address = "198.51.100.23";
    const userAgent = `agent-${hex()}`;
    for (let index = 0; index < 3; index += 1)
      await expectCode(
        await invoke(`sk_gw_${hex()}.${hex()}`, { "cf-connecting-ip": address, "user-agent": userAgent }),
        401,
        "GATEWAY_AUTH_REQUIRED",
      );
    await expectCode(await invoke(t.token(true, true).raw), 401, "GATEWAY_TOKEN_REVOKED");
    const fingerprint = await gatewayClientFingerprint({ address, userAgent });
    const abuse = await json<{ abuse: { signals: Array<{ signal: string; top: Array<Record<string, unknown>> }> } }>(
      await call("GET", `${BASE}/abuse`, admin.auth),
    );
    const failures = abuse.abuse.signals.find((entry) => entry.signal === "auth_failures")!.top;
    expect(failures).toContainEqual({ signal: "auth_failures", subjectKind: "client", subjectId: fingerprint, tenantId: null, value: 3 });
    expect(failures).toContainEqual({ signal: "auth_failures", subjectKind: "tenant", subjectId: t.tenantId, tenantId: t.tenantId, value: 1 });
    const stored = JSON.stringify(sqlite.prepare(`SELECT * FROM gateway_abuse_observation`).all());
    expect(stored).not.toContain(address);
    expect(stored).not.toContain(userAgent);
  });

  it("suspends a key past suspendAt on the scheduled evaluation, alerts once per window, audits as system, and refuses its next request", async () => {
    const t = team();
    const other = team();
    const token = t.token();
    const busiest = (
      await json<{ abuse: { signals: Array<{ signal: string; top: Array<{ value: number }> }> } }>(
        await call("GET", `${BASE}/abuse`, admin.auth),
      )
    ).abuse.signals.find((entry) => entry.signal === "velocity")!.top[0]?.value ?? 0;
    // Above every other key's count, so only this team's key crosses it.
    const threshold = { windowMinutes: 5, alertAt: busiest + 2, suspendAt: busiest + 3 };
    await json(await setThreshold("velocity", { threshold }));
    try {
      for (let index = 0; index < threshold.suspendAt; index += 1) await notSuspended(await invoke(token.raw));
      await notSuspended(await invoke(other.token().raw));
      const first = await evaluateGatewayAbuseNow({ DB: d1 });
      expect(first).toMatchObject({ suspended: 1, failed: 0 });
      await suspended(await invoke(token.raw));
      await notSuspended(await invoke(other.token().raw));
      expect(await evaluateGatewayAbuseNow({ DB: d1 })).toMatchObject({ alerts: 0, suspended: 0 });

      const abuse = await json<{
        abuse: {
          alerts: Array<{ subjectId: string; action: string; suspensionId: string | null; value: number; threshold: number }>;
          suspensions: Suspension[];
        };
      }>(await call("GET", `${BASE}/abuse`, admin.auth));
      const alert = abuse.abuse.alerts.find((entry) => entry.subjectId === t.keyId)!;
      expect(alert).toMatchObject({ action: "suspend", value: threshold.suspendAt, threshold: threshold.suspendAt });
      const suspension = abuse.abuse.suspensions.find((entry) => entry.id === alert.suspensionId)!;
      expect(suspension).toMatchObject({ subjectKind: "key", subjectId: t.keyId, tenantId: t.tenantId, source: "auto", signal: "velocity" });
      expect(auditRows("abuse.suspend", t.keyId)).toEqual([
        expect.objectContaining({ actor_kind: "system", actor_id: "threshold:velocity", tenant_id: t.tenantId }),
      ]);
      // An admin lifts it; the same window never suspends it again.
      await lift(suspension.id, { reason: "false positive" });
      await evaluateGatewayAbuseNow({ DB: d1 });
      await notSuspended(await invoke(token.raw));
    } finally {
      await setThreshold("velocity", { threshold: null });
    }
  });

  it("alerts first and still suspends once the same window crosses suspendAt", async () => {
    const t = team();
    const token = t.token();
    const busiest = (
      await json<{ abuse: { signals: Array<{ signal: string; top: Array<{ value: number }> }> } }>(
        await call("GET", `${BASE}/abuse`, admin.auth),
      )
    ).abuse.signals.find((entry) => entry.signal === "velocity")!.top[0]?.value ?? 0;
    const threshold = { windowMinutes: 5, alertAt: busiest + 1, suspendAt: busiest + 3 };
    await json(await setThreshold("velocity", { threshold }));
    try {
      for (let index = 0; index < threshold.alertAt; index += 1) await invoke(token.raw);
      expect(await evaluateGatewayAbuseNow({ DB: d1 })).toMatchObject({ suspended: 0 });
      await notSuspended(await invoke(token.raw));
      await invoke(token.raw);
      expect(await evaluateGatewayAbuseNow({ DB: d1 })).toMatchObject({ suspended: 1 });
      await suspended(await invoke(token.raw));
      const alerts = sqlite
        .prepare(`SELECT action FROM gateway_abuse_alert WHERE subject_id = ? ORDER BY created_at, action`)
        .all(t.keyId) as Array<{ action: string }>;
      expect(alerts.map((row) => row.action).sort()).toEqual(["alert", "suspend"]);
    } finally {
      await setThreshold("velocity", { threshold: null });
    }
  });
});
