/** All HTTP, Canvas and agent generation requests use journal-first admission. */
import type { Env } from "../config";
import type { GenerationParams } from "./params";
import { enqueueHostedGeneration } from "./runtime";

export async function startGeneration(
  env: Env,
  taskId: string,
  params: GenerationParams,
): Promise<void> {
  await enqueueHostedGeneration(env, taskId, params);
}
