import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

export let ProviderUsageStatusSchema = lazySchema(() => (
z.enum(["submitted", "completed", "failed"])
), (real) => { ProviderUsageStatusSchema = real; });
export let ProviderUsagePricingSourceSchema = lazySchema(() => (
z.enum(["pika-catalog", "unavailable"])
), (real) => { ProviderUsagePricingSourceSchema = real; });

export let ProviderUsageAuditEventSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  providerId: z.string().min(1),
  providerAccountId: z.string().min(1).optional(),
  modelId: z.string().min(1),
  operation: z.string().min(1),
  taskId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  nodeId: z.string().min(1).optional(),
  actorType: z.enum(["user", "agent"]).optional(),
  actorUserId: z.string().min(1).optional(),
  actorAgentId: z.string().min(1).optional(),
  providerRequestId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  status: ProviderUsageStatusSchema,
  estimatedCostMicroUsd: z.number().int().nonnegative().optional(),
  estimateComplete: z.boolean(),
  currency: z.literal("USD"),
  pricingSource: ProviderUsagePricingSourceSchema,
  billingBasis: z.record(z.string(), z.unknown()),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  occurredAt: z.string().datetime(),
})
), (real) => { ProviderUsageAuditEventSchema = real; });

export type ProviderUsageStatus = z.infer<typeof ProviderUsageStatusSchema>;
export type ProviderUsagePricingSource = z.infer<typeof ProviderUsagePricingSourceSchema>;
export type ProviderUsageAuditEvent = z.infer<typeof ProviderUsageAuditEventSchema>;
