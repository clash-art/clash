/**
 * Official media/AIGC generation through gateway-core and the ledger (#359),
 * over the real D1 ports on node:sqlite with the web/drizzle migrations and
 * the real hosted generation pipeline. Only the provider adapter is a stub:
 * no provider is called. Seeded amounts are fixture inputs; every expected
 * charge is derived from the price port, never from these numbers.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("agents", () => ({ Agent: class MockAgent {} }));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class MockDurableObject {},
  WorkflowEntrypoint: class MockWorkflowEntrypoint {},
  WorkerEntrypoint: class MockWorkerEntrypoint {},
}));
vi.mock("../containers/render", () => ({
  RenderContainer: class MockRenderContainer {},
}));

import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
import { emptyUsage, isGatewayErrorCode, ledgerStatus, priceUsage, type GatewayPorts } from "@clash/gateway-core";
import type { DurableRunRecord } from "@clash/shared-runtime/durable-run-engine";
import {
  buildEffectiveModelCards,
  listDeclaredModelUpstreamRoutes,
  type ModelCard,
  type ModelUpstreamRoute,
} from "@clash/shared-types";

import { createSqliteD1 } from "../../../web/app/test-support/sqlite-d1";
import type { Env } from "../config";
import { createD1GatewayPorts } from "../gateway";
import { sealGatewayUpstreamCredentials } from "../gateway/d1-credentials";
import { toSeconds } from "../gateway/d1-common";
import type { GenerationAdapter } from "./adapter";
import { credentialsForRoute } from "./adapters/provider-credentials";
import { mediaQuantities, measuredMediaQuantities, recordProviderUsage } from "./media-usage";
import { createCloudExecutorContext } from "./plugin-execution/context";
import {
  admitOfficialMediaRun,
  mediaFailureCode,
  officialMediaCredentials,
  officialMediaRuntime,
  settleOfficialMediaRun,
} from "./official-media";
import type { GenerationParams } from "./params";
import { resolveAdapter } from "./registry";
import {
  createHostedGenerationRuntime,
  enqueueHostedGeneration,
  frozenGeneration,
  type HostedGenerationOptions,
} from "./runtime";

const { d1, sqlite } = createSqliteD1();
const encryptionKey = "official-media-test-kek";
const env = { DB: d1, GATEWAY_ENCRYPTION_KEY: encryptionKey } as unknown as Env;
const officialApiKey = `sk-official-media-${crypto.randomUUID()}`;

const isOfficial = (route: ModelUpstreamRoute) => route.providerId === "official";
const sealable = (route: ModelUpstreamRoute) =>
  !route.credentialRequirements &&
  (route.requiredCredentials ?? []).every((credential) => credential === "apiKey" || credential === "baseUrl");

/** A built-in image card with an official route a hosted adapter executes and an API key can serve. */
function officialImage(): { card: ModelCard; route: ModelUpstreamRoute } {
  for (const card of buildEffectiveModelCards()) {
    if (card.kind !== "image") continue;
    const route = listDeclaredModelUpstreamRoutes([card]).find((candidate) => {
      if (!isOfficial(candidate) || !sealable(candidate)) return false;
      try {
        resolveAdapter({ ...params("probe", card.id), selectedRoute: candidate });
        return true;
      } catch {
        return false;
      }
    });
    if (route) return { card, route };
  }
  throw new Error("shared-types has no official image card a hosted adapter executes");
}

function params(taskId: string, modelName: string, actorUserId = "media-user"): GenerationParams {
  return {
    taskId,
    projectId: `project-${actorUserId}`,
    nodeId: `node-${taskId}`,
    type: "image_gen",
    actorType: "user",
    actorUserId,
    modelName,
    prompt: "a lighthouse at dusk",
  };
}

function journal() {
  const rows = new Map<string, DurableRunRecord>();
  return {
    rows,
    async create(run: DurableRunRecord) {
      if (!rows.has(run.actionRunId)) rows.set(run.actionRunId, structuredClone(run));
    },
    async load(id: { actionRunId: string }) {
      const row = rows.get(id.actionRunId);
      return row && structuredClone(row);
    },
    async compareAndSet(id: { actionRunId: string }, revision: number, next: DurableRunRecord) {
      if (rows.get(id.actionRunId)?.revision !== revision) return false;
      rows.set(id.actionRunId, structuredClone(next));
      return true;
    },
    async listRecoverable() {
      return [...rows.values()];
    },
  };
}

let seq = 0;
const fresh = (prefix: string) => `${prefix}-${++seq}-${crypto.randomUUID().slice(0, 8)}`;

/** A user with a project in their personal tenant and a tenant wallet of `limit` micro-credits. */
async function member(limit: number | null = 1_000_000_000) {
  const userId = fresh("media-user");
  const tenantId = `personal:${userId}`;
  const budgetId = fresh("gwb-wallet");
  await d1.batch([
    d1.prepare(`INSERT INTO project (id, owner_id, name) VALUES (?, ?, 'media')`).bind(`project-${userId}`, userId),
    d1
      .prepare(
        `INSERT INTO gateway_budget (id, tenant_id, scope, scope_id, limit_micro_credits) VALUES (?, ?, 'tenant', ?, ?)`,
      )
      .bind(budgetId, tenantId, tenantId, limit),
  ]);
  return { userId, tenantId, budgetId };
}

interface Harness {
  card: ModelCard;
  accountId: string;
  ports: GatewayPorts;
}
let harness: Harness;

beforeAll(async () => {
  const { card, route } = officialImage();
  const nowS = toSeconds(Date.now());
  const accountId = `gwu_media_${crypto.randomUUID().replaceAll("-", "")}`;
  await d1.batch([
    d1
      .prepare(
        `INSERT INTO gateway_model (id, catalog_version, model_code, kind, enabled, card_json, published_at)
         VALUES (?, 'media-catalog-1', ?, ?, 1, ?, ?)`,
      )
      .bind("gwm_media", card.id, card.kind, JSON.stringify(card), nowS - 60),
    d1
      .prepare(
        `INSERT INTO gateway_price (id, price_version, model_code, upstream_id, unit, amount_micro, per, effective_from, published_at)
         VALUES ('gwp_media_image', 'price-media-1', ?, '', 'image', 40000, 1, ?, ?)`,
      )
      .bind(card.id, nowS - 60, nowS - 60),
    d1
      .prepare(
        `INSERT INTO gateway_upstream_account
           (id, provider_id, upstream_id, api_shape, region, enabled, encrypted_credentials, configured_credentials, supported_model_ids_json)
         VALUES (?, 'official', ?, ?, ?, 1, ?, '["apiKey"]', ?)`,
      )
      .bind(
        accountId,
        route.upstreamId,
        route.apiShape ?? null,
        route.region ?? "",
        await sealGatewayUpstreamCredentials({ apiKey: officialApiKey }, encryptionKey),
        JSON.stringify([card.id]),
      ),
  ]);
  harness = { card, accountId, ports: createD1GatewayPorts({ db: d1, secrets: { encryptionKey, secret: () => undefined } }) };
});

/** A provider stub that resolves the run's credentials the way every hosted adapter does. */
function stubAdapter(behaviour: "succeed" | "fail_after_acceptance") {
  const seenKeys: string[] = [];
  const adapter: GenerationAdapter = {
    name: "media-stub",
    async submit(ctx) {
      seenKeys.push((await credentialsForRoute(ctx, ctx.params.selectedRoute!)).apiKey ?? "");
      return behaviour === "succeed" ? ctx.completedValue({ assetId: ctx.params.taskId }) : ctx.accepted({ id: "vendor-job" }, 1);
    },
    async poll() {
      throw new ProviderExecutionError({
        code: "content_rejected",
        message: "The provider rejected the job after accepting it.",
        retryable: false,
        requestState: "accepted",
      });
    },
  };
  return { adapter, seenKeys };
}

/** Ended and projected: a success published, or a failure published as the node's error. */
const ended = (run: DurableRunRecord | undefined) =>
  run?.phase === "succeeded" || (run?.phase === "failed" && run.projectedAt !== undefined);

function pipeline(adapter: GenerationAdapter, extra: Pick<HostedGenerationOptions, "recordUsage" | "resolveRoute"> = {}) {
  const state = journal();
  let now = Date.now();
  const options: HostedGenerationOptions = {
    journal: state,
    assertAccess: async () => undefined,
    claim: async () => undefined,
    hooks: {},
    clock: { now: () => now },
    adapter: () => adapter,
    publish: async () => undefined,
    hookCheckpoint: async (_name, action) => action(),
    ...extra,
  };
  return {
    state,
    enqueue: (run: GenerationParams) =>
      enqueueHostedGeneration({ ...env, GENERATION_WORKFLOW: { create: async () => {} } } as never, run.taskId, run, options),
    async drive(taskId: string) {
      const identity = { actionRunId: taskId, outputSlot: "output" };
      for (let i = 0; i < 12 && !ended(state.rows.get(taskId)); i++) {
        await createHostedGenerationRuntime(env, options).coordinate({ type: "advance", identity });
        now += 60_000;
      }
      return state.rows.get(taskId)!;
    },
  };
}

const jobRow = (taskId: string) =>
  sqlite.prepare(`SELECT request_id, status, error_code FROM gateway_media_job WHERE task_id = ?`).get(taskId) as
    | { request_id: string; status: string; error_code: string | null }
    | undefined;
const usageRows = (taskId: string) =>
  sqlite.prepare(`SELECT id, status, error_code, billing_basis FROM provider_usage_audit WHERE task_id = ?`).all(taskId) as Array<{
    id: string;
    status: string;
    error_code: string | null;
    billing_basis: string;
  }>;
const ledgerRows = (requestId: string) =>
  sqlite
    .prepare(`SELECT kind, status, amount_micro_credits FROM gateway_usage_ledger WHERE request_id = ? ORDER BY kind`)
    .all(requestId) as Array<{ kind: string; status: string; amount_micro_credits: number }>;
const wallet = async (ports: GatewayPorts, tenantId: string) =>
  (await ports.budgets.snapshot({ tenantId })).find((budget) => budget.scope === "tenant")!;

describe("official media generation through the gateway ledger", () => {
  it("routes a model the user has no account for to the official gateway, holds before the provider, charges a success once", async () => {
    const { userId, tenantId } = await member();
    const { adapter, seenKeys } = stubAdapter("succeed");
    const run = pipeline(adapter);
    const input = params(fresh("task-ok"), harness.card.id, userId);

    await run.enqueue(input);
    const frozen = frozenGeneration(run.state.rows.get(input.taskId)!).params;
    expect(frozen.selectedRoute).toMatchObject({ accountId: harness.accountId, providerId: "official" });
    const planned = jobRow(input.taskId)!;
    expect(planned.status).toBe("planned");
    // Planning holds nothing.
    expect((await wallet(harness.ports, tenantId)).reservedMicroCredits).toBe(0);

    expect((await run.drive(input.taskId)).phase).toBe("succeeded");
    // The provider was called once, with the official key resolved for this run only.
    expect(seenKeys).toEqual([officialApiKey]);

    const price = await harness.ports.routes.price({
      identity: { tenantId, userId, budgetIds: [], credentialScope: "official" },
      catalogVersion: "media-catalog-1",
      route: frozen.selectedRoute!,
    });
    const units = { image: 1 };
    const cost = priceUsage({ ...emptyUsage(), units }, price).microCredits;
    expect(cost).toBeGreaterThan(0);
    expect(jobRow(input.taskId)!.status).toBe("settled");
    expect(await harness.ports.ledger.get({ tenantId, requestId: planned.request_id })).toMatchObject({
      status: ledgerStatus("completed"),
      costMicroCredits: cost,
      kind: "image",
      modelCode: harness.card.id,
    });
    expect(await wallet(harness.ports, tenantId)).toMatchObject({ spentMicroCredits: cost, reservedMicroCredits: 0 });
    // Metered by the ledger alone: no BYOK usage row for an official run.
    expect(usageRows(input.taskId)).toEqual([]);

    // A replayed afterGenerate (lost checkpoint) settles nothing new.
    const runtime = officialMediaRuntime(env);
    expect(await settleOfficialMediaRun(runtime, frozen, { status: "succeeded", run: {} })).toBe(true);
    expect(await wallet(harness.ports, tenantId)).toMatchObject({ spentMicroCredits: cost, reservedMicroCredits: 0 });
    expect(ledgerRows(planned.request_id).filter((row) => row.kind === "settle")).toHaveLength(1);
  });

  it("a provider failure after acceptance never charges, and no replay or late success charges it twice", async () => {
    const { userId, tenantId } = await member();
    const { adapter, seenKeys } = stubAdapter("fail_after_acceptance");
    const run = pipeline(adapter);
    const input = params(fresh("task-fail"), harness.card.id, userId);

    await run.enqueue(input);
    const done = await run.drive(input.taskId);
    expect(done.phase).toBe("failed");
    expect(seenKeys).toEqual([officialApiKey]);

    const { request_id: requestId, status } = jobRow(input.taskId)!;
    expect(status).toBe("settled");
    expect(await harness.ports.ledger.get({ tenantId, requestId })).toMatchObject({
      status: "upstream_failed",
      costMicroCredits: 0,
      errorCode: mediaFailureCode(done.failure),
    });
    // The hold was reserved, then released at zero.
    expect(ledgerRows(requestId).map((row) => row.kind)).toContain("hold");
    expect(await wallet(harness.ports, tenantId)).toMatchObject({ spentMicroCredits: 0, reservedMicroCredits: 0 });

    const frozen = frozenGeneration(done).params;
    const runtime = officialMediaRuntime(env);
    await settleOfficialMediaRun(runtime, frozen, { status: "failed", failure: done.failure });
    await settleOfficialMediaRun(runtime, frozen, { status: "succeeded", run: {} });
    expect(await wallet(harness.ports, tenantId)).toMatchObject({ spentMicroCredits: 0, reservedMicroCredits: 0 });
    expect(ledgerRows(requestId).filter((row) => row.kind === "settle")).toEqual([
      expect.objectContaining({ amount_micro_credits: 0 }),
    ]);
    expect(usageRows(input.taskId)).toEqual([]);
  });

  it("a hard wallet the hold does not fit fails the run before the provider, holding nothing", async () => {
    const { userId, tenantId } = await member(0);
    const { adapter, seenKeys } = stubAdapter("succeed");
    const run = pipeline(adapter);
    const input = params(fresh("task-broke"), harness.card.id, userId);

    await run.enqueue(input);
    const done = await run.drive(input.taskId);
    expect(done.phase).toBe("failed");
    expect(done.failure).toMatchObject({ code: "quota_exhausted", providerCode: "GATEWAY_BUDGET_EXCEEDED" });
    expect(seenKeys).toEqual([]);
    expect(jobRow(input.taskId)).toMatchObject({ status: "refused", error_code: "GATEWAY_BUDGET_EXCEEDED" });
    expect(ledgerRows(jobRow(input.taskId)!.request_id)).toEqual([]);
    expect(await wallet(harness.ports, tenantId)).toMatchObject({ spentMicroCredits: 0, reservedMicroCredits: 0 });
  });

  it("refuses with a code before the run exists: no tenant membership, no budget", async () => {
    const { adapter } = stubAdapter("succeed");
    const run = pipeline(adapter);

    // A Project in a team tenant the actor is not a member of.
    const outsider = fresh("outsider");
    const teamProject = fresh("team-project");
    sqlite
      .prepare(`INSERT INTO project (id, owner_id, name, tenant_id) VALUES (?, 'someone-else', 'team', ?)`)
      .run(teamProject, fresh("team-tenant"));
    const forbidden = { ...params(fresh("task-outsider"), harness.card.id, outsider), projectId: teamProject };
    await expect(run.enqueue(forbidden)).rejects.toMatchObject({ code: "GATEWAY_FORBIDDEN", status: 403 });
    expect(jobRow(forbidden.taskId)).toBeUndefined();
    expect(run.state.rows.has(forbidden.taskId)).toBe(false);

    // A personal workspace with no wallet at all.
    const unfunded = fresh("unfunded");
    sqlite.prepare(`INSERT INTO project (id, owner_id, name) VALUES (?, ?, 'p')`).run(`project-${unfunded}`, unfunded);
    const noBudget = params(fresh("task-unfunded"), harness.card.id, unfunded);
    await expect(run.enqueue(noBudget)).rejects.toMatchObject({ code: "GATEWAY_BUDGET_EXCEEDED" });
    expect(jobRow(noBudget.taskId)).toBeUndefined();
  });

  it("official credentials resolve only for the admitted run that planned them", async () => {
    const { userId } = await member();
    const { adapter } = stubAdapter("succeed");
    const run = pipeline(adapter);
    const input = params(fresh("task-custody"), harness.card.id, userId);
    await run.enqueue(input);
    const frozen = frozenGeneration(run.state.rows.get(input.taskId)!).params;
    const runtime = officialMediaRuntime(env);

    // Planned, not yet admitted: no hold, no key.
    await expect(officialMediaCredentials(runtime, frozen)).rejects.toMatchObject({ code: "GATEWAY_KEY_UNAVAILABLE" });
    // Another actor replaying the same task and route never reaches the official key.
    await expect(officialMediaCredentials(runtime, { ...frozen, actorUserId: "intruder" })).rejects.toMatchObject({
      code: "GATEWAY_FORBIDDEN",
    });
    // A route on the user's own account never reads the job table.
    expect(
      await officialMediaCredentials(runtime, { ...frozen, selectedRoute: { ...frozen.selectedRoute!, accountId: "byok-1" } }),
    ).toBeUndefined();
    // A run whose task has no job: not official, whatever its route claims.
    expect(await officialMediaCredentials(runtime, { ...frozen, taskId: fresh("task-unplanned") })).toBeUndefined();

    // Admitted: executable plugins read the official key through the hosted credential store.
    await admitOfficialMediaRun(runtime, frozen);
    const record = run.state.rows.get(input.taskId)!;
    const pluginEnv = { ...env, R2_BUCKET: {} } as unknown as Env;
    expect(await createCloudExecutorContext(pluginEnv, record).store!.get("apiKey")).toBe(officialApiKey);
    const intruder = structuredClone(record);
    (intruder.executorInput as unknown as { params: GenerationParams }).params.actorUserId = "intruder";
    await expect(createCloudExecutorContext(pluginEnv, intruder).store!.get("apiKey")).rejects.toMatchObject({
      code: "GATEWAY_FORBIDDEN",
    });

    // A run that ends before it was admitted holds nothing and is only refused.
    const other = params(fresh("task-unadmitted"), harness.card.id, userId);
    await run.enqueue(other);
    const unadmitted = frozenGeneration(run.state.rows.get(other.taskId)!).params;
    await settleOfficialMediaRun(runtime, unadmitted, { status: "failed", failure: { code: "deadline_exceeded" } });
    expect(jobRow(other.taskId)).toMatchObject({
      status: "refused",
      error_code: mediaFailureCode({ code: "deadline_exceeded" }),
    });
    expect(ledgerRows(jobRow(other.taskId)!.request_id)).toEqual([]);
  });

  it("a repeated enqueue answers the frozen job; one task never has two ledger requests", async () => {
    const { userId } = await member();
    const { adapter } = stubAdapter("succeed");
    const run = pipeline(adapter);
    const input = params(fresh("task-repeat"), harness.card.id, userId);
    await run.enqueue(input);
    const first = jobRow(input.taskId)!;
    run.state.rows.delete(input.taskId);
    await run.enqueue(input);
    expect(jobRow(input.taskId)).toEqual(first);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM gateway_media_job WHERE task_id = ?`).get(input.taskId)).toEqual({ n: 1 });
  });
});

describe("usage writers for runs on the user's own accounts", () => {
  const byokRoute: ModelUpstreamRoute = {
    modelCode: "byok-image",
    kind: "image",
    providerId: "openai",
    accountId: "byok-account",
    upstreamId: "openai",
    upstreamModel: "upstream-image",
    apiShape: "openai-compatible",
    priority: 1,
    requiredCredentials: ["apiKey"],
  };
  const byok = (taskId: string): GenerationParams => ({ ...params(taskId, "byok-image"), selectedRoute: byokRoute });

  it("every hosted adapter's run gets one usage row when it ends, written by the lifecycle", async () => {
    for (const behaviour of ["succeed", "fail_after_acceptance"] as const) {
      const adapter: GenerationAdapter = {
        name: "byok-stub",
        submit: async (ctx) =>
          behaviour === "succeed" ? ctx.completedValue({ assetId: ctx.params.taskId }) : ctx.accepted({ id: "v" }, 1),
        poll: stubAdapter(behaviour).adapter.poll!,
      };
      const run = pipeline(adapter, { resolveRoute: async () => byokRoute });
      const input = byok(fresh(`task-byok-${behaviour}`));
      await run.enqueue(input);
      expect(ended(await run.drive(input.taskId))).toBe(true);
      const rows = usageRows(input.taskId);
      expect(rows).toHaveLength(1);
      if (behaviour === "succeed") {
        expect(rows[0]).toMatchObject({ status: "completed", error_code: null });
        expect(JSON.parse(rows[0]!.billing_basis)).toEqual(measuredMediaQuantities(input));
      } else {
        expect(rows[0]).toMatchObject({ status: "failed", error_code: "content_rejected" });
      }
      // Never a gateway job for a BYOK run.
      expect(jobRow(input.taskId)).toBeUndefined();
    }
  });

  it("a replayed hook writes nothing new", async () => {
    const input = byok(fresh("task-byok-replay"));
    await recordProviderUsage(env, input, { status: "completed" });
    await recordProviderUsage(env, input, { status: "completed" });
    expect(usageRows(input.taskId)).toHaveLength(1);
  });

  it("an adapter that records the provider's own usage events gets no second row", async () => {
    const recordUsage = vi.fn(async () => undefined);
    const adapter: GenerationAdapter = {
      name: "self-metering",
      recordsProviderUsage: () => true,
      submit: async (ctx) => ctx.completedValue({ assetId: ctx.params.taskId }),
    };
    const run = pipeline(adapter, { recordUsage, resolveRoute: async () => byokRoute });
    const input = byok(fresh("task-self-metering"));
    await run.enqueue(input);
    expect((await run.drive(input.taskId)).phase).toBe("succeeded");
    expect(recordUsage).not.toHaveBeenCalled();
    expect(usageRows(input.taskId)).toEqual([]);
  });

  it("a usage write that fails never fails or wedges the run", async () => {
    for (const behaviour of ["succeed", "fail_after_acceptance"] as const) {
      const recordUsage = vi.fn(async () => {
        throw new Error("usage store unavailable");
      });
      const adapter: GenerationAdapter = {
        name: "byok-stub",
        submit: async (ctx) =>
          behaviour === "succeed" ? ctx.completedValue({ assetId: ctx.params.taskId }) : ctx.accepted({ id: "v" }, 1),
        poll: stubAdapter(behaviour).adapter.poll!,
      };
      const run = pipeline(adapter, { recordUsage, resolveRoute: async () => byokRoute });
      const input = byok(fresh(`task-usage-down-${behaviour}`));
      await run.enqueue(input);
      const done = await run.drive(input.taskId);
      expect(done.phase).toBe(behaviour === "succeed" ? "succeeded" : "failed");
      expect(ended(done)).toBe(true);
      expect(recordUsage).toHaveBeenCalledTimes(1);
    }
  });
});

describe("media quantities", () => {
  it("asks for one request, one image per image run, whole seconds of a timed run", () => {
    expect(mediaQuantities(params("q", "m"))).toMatchObject({ request: 1, image: 1 });
    const video = { ...params("q", "m"), type: "video_gen" as const, duration: 4.2 };
    const seconds = mediaQuantities(video).video_second!;
    // Whole seconds that never undercount the requested duration.
    expect(Number.isInteger(seconds) && seconds >= video.duration && seconds < video.duration + 1).toBe(true);
    expect(mediaQuantities(video)).toMatchObject({ request: 1 });
    expect(mediaQuantities(video)).not.toHaveProperty("image");
    // No duration: the run cannot measure seconds, so a per-second price refuses it at planning.
    expect(mediaQuantities({ ...video, duration: undefined })).not.toHaveProperty("video_second");
  });

  it("measures delivered seconds from the staged output's probed duration", () => {
    const video = { ...params("q", "m"), type: "video_gen" as const };
    const durationMs = 3_001;
    const measured = measuredMediaQuantities(video, { stagedOutput: { asset: { metadata: { durationMs } } } });
    expect(Object.keys(measured)).toEqual(["video_second"]);
    expect(Number.isInteger(measured.video_second) && measured.video_second! * 1000 >= durationMs).toBe(true);
    expect(measuredMediaQuantities(video, { stagedOutput: { updates: {} } })).toEqual({});
  });

  it("settles every run failure with a gateway code, passing a gateway refusal's own code through", () => {
    for (const failure of [
      undefined,
      { code: "deadline_exceeded" },
      { code: "content_rejected" },
      { code: "authentication_failed" },
      { code: "an_unknown_failure" },
    ])
      expect(isGatewayErrorCode(mediaFailureCode(failure))).toBe(true);
    expect(mediaFailureCode({ code: "quota_exhausted", providerCode: "GATEWAY_BUDGET_EXCEEDED" })).toBe(
      "GATEWAY_BUDGET_EXCEEDED",
    );
  });
});
