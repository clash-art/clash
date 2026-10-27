/**
 * Request schemas of the gateway admin API shared by every host (#371): the
 * catalog, budget allocation, prompt-access and suspension bodies that api-cf
 * (/api/v1/admin/gateway on the Worker) and api-node (the separate admin
 * listener) both parse, with the same (single) zod. Host-specific bodies
 * (upstream secret kinds, ledger kinds, admin identities) stay with the host.
 */
import { z } from "zod";

import { GATEWAY_SUSPENSION_SUBJECTS } from "./abuse.js";
import { GatewayPriceVersionSchema } from "./billing-schemas.js";
import { GATEWAY_BUDGET_ENFORCEMENTS } from "./budget.js";
import { GatewayRateLimitSchema } from "./limits.js";

const reason = () => z.string().trim().min(1).max(500);
const safeInt = () =>
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Catalog version name, e.g. `2026-11-01` or `c12`. */
export const GatewayCatalogVersionSchema = GatewayPriceVersionSchema;
export const GatewayModelCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]{1,256}$/);

/** PUT /api/v1/admin/gateway/catalog/versions/:version/models/:modelCode (draft only). */
export const GatewayCatalogModelRequestSchema = z
  .object({
    /** A shared-types ModelCard whose id is the model code. */
    card: z.record(z.string(), z.unknown()),
    displayName: z.string().trim().min(1).max(128).nullable().optional(),
    enabled: z.boolean().default(true),
    maxOutputTokens: safeInt().positive().nullable().optional(),
    rateLimit: GatewayRateLimitSchema.nullable().optional(),
  })
  .strict();

/** POST /api/v1/admin/gateway/catalog/versions/:version/clone: a new draft copying `from`. */
export const GatewayCatalogCloneRequestSchema = z
  .object({ from: GatewayCatalogVersionSchema })
  .strict();

/**
 * PUT …/tenants/:tenantId/budgets/(user|key)/:scopeId: allocate a member or
 * key budget (team settings on api-cf, #354; the admin API on api-node).
 */
export const GatewayBudgetSetRequestSchema = z
  .object({
    /** null: explicitly unlimited (the tenant wallet still caps it). */
    limitMicroCredits: safeInt().nullable(),
    status: z.enum(["active", "suspended"]).optional(),
    /** hard (refuse), soft (admit and flag) or alert (admit and notify); unchanged when omitted, hard for a new budget. */
    enforcement: z.enum(GATEWAY_BUDGET_ENFORCEMENTS).optional(),
    /** 1-100: alert at this share of the limit; null clears it; unchanged when omitted. */
    alertThresholdPct: z.number().int().min(1).max(100).nullable().optional(),
    /**
     * Set a limit below what is already spent and held (refused otherwise
     * with GATEWAY_BUDGET_BELOW_USAGE). An override needs a reason and is
     * audited as `budget.override`.
     */
    override: z.literal(true).optional(),
    reason: reason().optional(),
  })
  .strict()
  .refine((body) => !body.override || body.reason !== undefined, {
    message: "an override needs a reason",
    path: ["reason"],
  });

/** POST /api/v1/admin/gateway/prompts/:requestId/access: break-glass, so a reason is required. */
export const GatewayPromptAccessRequestSchema = z
  .object({ reason: reason() })
  .strict();

/**
 * POST /api/v1/admin/gateway/abuse/suspensions (#356): suspend a tenant or a
 * key by id. Ids only: suspending never needs or discloses key material.
 */
export const GatewaySuspendRequestSchema = z
  .object({
    subjectKind: z.enum(GATEWAY_SUSPENSION_SUBJECTS),
    subjectId: z.string().regex(/^[A-Za-z0-9._:@/-]{1,256}$/),
    reason: reason(),
  })
  .strict();

/** POST /api/v1/admin/gateway/abuse/suspensions/:suspensionId/lift (#356). */
export const GatewayLiftSuspensionRequestSchema = z
  .object({ reason: reason() })
  .strict();
