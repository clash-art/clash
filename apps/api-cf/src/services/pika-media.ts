import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
import {
  buildPikaMediaRequest,
  createPikaMediaJob,
  fetchPikaCatalogQuote,
  getPikaMediaContent,
  pikaBillingBasis,
  getPikaMediaJob,
} from "@clash/shared-runtime";
import type { ModelKind, ModelUpstreamRoute } from "@clash/shared-types";

export interface PikaMediaGenerationInput {
  taskId: string;
  kind: ModelKind;
  route: ModelUpstreamRoute;
  prompt: string;
  aspectRatio?: string;
  duration?: number;
  modelParams?: Record<string, unknown>;
  startFrameUrl?: string;
  endFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  onUsageEvent?: (event: PikaUsageLifecycleEvent) => Promise<void>;
}

export interface PikaUsageLifecycleEvent {
  status: "submitted" | "completed" | "failed";
  operation: string;
  providerRequestId?: string;
  idempotencyKey: string;
  estimatedCostMicroUsd?: number;
  estimateComplete: boolean;
  pricingSource: "pika-catalog" | "unavailable";
  billingBasis: Record<string, unknown>;
  errorMessage?: string;
  occurredAt: string;
}

export interface PikaMediaTask {
  requestId: string;
  operation: string;
  idempotencyKey: string;
  estimateComplete: boolean;
  pricingSource: "pika-catalog" | "unavailable";
  estimatedCostMicroUsd?: number;
  billingBasis: Record<string, unknown>;
}

export async function submitPikaMedia(apiKey: string, input: PikaMediaGenerationInput): Promise<PikaMediaTask> {
  const request = buildPikaMediaRequest({
    modelId: input.route.modelCode,
    kind: input.kind,
    upstreamModel: input.route.upstreamModel,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    duration: input.duration,
    modelParams: input.modelParams,
    startFrameUrl: input.startFrameUrl,
    endFrameUrl: input.endFrameUrl,
    referenceImageUrls: input.referenceImageUrls,
    referenceVideoUrls: input.referenceVideoUrls,
    referenceAudioUrls: input.referenceAudioUrls,
  });
  const selectedOperation = request.operation;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const idempotencyKey = input.taskId;
  const body = request.body;
  const quote = await fetchPikaCatalogQuote({
    operation: selectedOperation,
    input: body,
    baseUrl: input.baseUrl,
    fetch: fetchImpl,
  });
  const billingBasis = pikaBillingBasis(body);
  const created = await createPikaMediaJob({
      apiKey,
      operation: selectedOperation,
      input: body,
      idempotencyKey,
      baseUrl: input.baseUrl,
      fetch: fetchImpl,
    });
  return { requestId: created.id, operation: selectedOperation, idempotencyKey,
    estimateComplete: quote.complete, pricingSource: quote.pricingSource,
    ...(quote.estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd: quote.estimatedCostMicroUsd }), billingBasis };
}

export async function pollPikaMediaOnce(
  apiKey: string,
  input: Pick<PikaMediaGenerationInput, "baseUrl" | "fetch" | "onUsageEvent">,
  token: PikaMediaTask,
): Promise<{ url: string; requestId: string; operation: string } | null> {
  const { requestId, ...usage } = token;
  const emit = async (status: PikaUsageLifecycleEvent["status"], error?: unknown) => {
    try {
      await input.onUsageEvent?.({ ...usage, status, providerRequestId: requestId, occurredAt: new Date().toISOString(), ...(error ? { errorMessage: error instanceof Error ? error.message : String(error) } : {}) });
    } catch (cause) {
      throw new ProviderExecutionError({ code: "output_persistence_failed", message: `Provider usage persistence failed: ${String(cause)}`, retryable: true, requestState: "accepted" });
    }
  };
  // Submission is already journaled before this idempotent usage event is attempted.
  await emit("submitted");
  let job;
  try { job = await getPikaMediaJob({ apiKey, jobId: requestId, baseUrl: input.baseUrl, fetch: input.fetch }); }
  catch (error) {
    if (error instanceof ProviderExecutionError && error.failure.providerCode?.startsWith("PIKA_JOB_FAILED:")) await emit("failed", error);
    throw error;
  }
  if (job.status === "failed") {
    const error = new Error(job.error?.message ?? "Pika media generation failed");
    await emit("failed", error);
    throw error;
  }
  if (job.status !== "completed") return null;
  const content = await getPikaMediaContent({ apiKey, jobId: requestId, baseUrl: input.baseUrl, fetch: input.fetch });
  await emit("completed");
  return { url: content.url, requestId, operation: token.operation };
}
