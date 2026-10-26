/**
 * Child process for the gateway lite harness (#379). One OS process, its own
 * pg pool, one job against the shared Postgres; the result goes back over
 * IPC. Roles (LITE_ROLE):
 *   charge     chargeText for the same request ids as its sibling processes
 *   debit      debitMedia (prepay) for the same request ids as its siblings
 *   refund     refundMedia for the same request ids as its siblings
 *   rollover   rolloverDueBudgets in small batches until no backlog
 *   reencrypt  credential re-encryption to the current kid
 * Test-only; never points at anything but the harness database.
 */
import { createPgGatewayBudgetStore } from "../gateway-budget.ts";
import { rolloverDueBudgets } from "../gateway-budget-rollover.ts";
import { createPgGatewayCredentialStore } from "../gateway-credentials.ts";
import { gatewayKeyRingFromEnv } from "../gateway-keyring.ts";
import { openPostgres } from "../postgres.ts";

const database = openPostgres({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});
const db = database.db;
const role = process.env.LITE_ROLE;
const input = JSON.parse(process.env.LITE_INPUT ?? "{}") as Record<
  string,
  unknown
>;

/** Every sibling waits for the same wall-clock instant, so the jobs overlap. */
async function barrier() {
  const at = Number(input.startAt ?? 0);
  if (at > Date.now()) await new Promise((r) => setTimeout(r, at - Date.now()));
}

async function run(): Promise<unknown> {
  if (role === "charge") {
    const store = createPgGatewayBudgetStore(db);
    const ids = input.requestIds as string[];
    await barrier();
    const results = await Promise.all(
      ids.map(async (requestId) => {
        try {
          const r = await store.chargeText({
            requestId,
            tenantId: String(input.tenantId),
            userId: String(input.userId),
            budgetIds: input.budgetIds as string[],
            costMicroCredits: Number(input.cost),
            modelCode: "lite",
            modelKind: "text",
          });
          return {
            requestId,
            charged: r.chargedMicroCredits,
            duplicate: r.duplicate,
          };
        } catch (error) {
          return {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { results };
  }
  if (role === "debit" || role === "refund") {
    const store = createPgGatewayBudgetStore(db);
    const ids = input.requestIds as string[];
    await barrier();
    const results = await Promise.all(
      ids.map(async (requestId) => {
        try {
          if (role === "refund") {
            const r = await store.refundMedia({
              requestId,
              tenantId: String(input.tenantId),
              reason: "lite",
            });
            return {
              requestId,
              charged: r.refundedMicroCredits,
              duplicate: r.duplicate,
            };
          }
          const r = await store.debitMedia({
            requestId,
            tenantId: String(input.tenantId),
            userId: String(input.userId),
            budgetIds: input.budgetIds as string[],
            costMicroCredits: Number(input.cost),
            modelCode: "lite-media",
            modelKind: "image",
          });
          return {
            requestId,
            charged: r.debitMicroCredits,
            duplicate: r.duplicate,
          };
        } catch (error) {
          return {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { results };
  }
  if (role === "rollover") {
    await barrier();
    let rolled = 0;
    let batches = 0;
    const nowS = Number(input.nowS);
    for (;;) {
      const r = await rolloverDueBudgets(db, {
        limit: Number(input.limit ?? 20),
        nowS,
      });
      batches += 1;
      rolled += r.rolled;
      if (r.rolled === 0 && r.backlog === 0) break;
      if (r.rolled === 0) await new Promise((res) => setTimeout(res, 5));
      if (batches > 10_000) throw Error("rollover did not converge");
    }
    return { rolled, batches };
  }
  if (role === "reencrypt") {
    const store = createPgGatewayCredentialStore({
      db,
      ring: gatewayKeyRingFromEnv(process.env),
    });
    await barrier();
    let resealed = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = (await store.reencrypt({
        limit: Number(input.limit ?? 5),
      })) as {
        resealed: number;
        failed: number;
        skipped?: number;
      };
      resealed += r.resealed;
      failed += r.failed;
      skipped += r.skipped ?? 0;
      if (r.resealed === 0 && r.failed === 0 && !r.skipped) break;
    }
    return { resealed, failed, skipped };
  }
  throw Error(`unknown LITE_ROLE ${role}`);
}

try {
  const result = await run();
  process.send?.({ ok: true, result });
} catch (error) {
  process.send?.({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
} finally {
  await database.close();
  process.disconnect?.();
}
