import {
  createGenerationPipeline,
  enqueueGeneration,
  type GenerationPipelinePorts,
} from "@clash/shared-runtime/hosted-generation";
import type { GenerationParams } from "@clash/shared-runtime/generation-params";
import type { PostgresTransactionPort } from "@clash/shared-runtime/project-cloud-admission-postgres";
import { createPostgresRunJournal } from "./durable-run-journal.ts";

export const NODE_GENERATION_OWNER = "api-node:generation";
export type NodeGenerationPorts = Omit<
  GenerationPipelinePorts,
  "ownerId" | "journal" | "schedule"
>;
/** Supply real product IO here; BullMQ receives coordinator/journal through task-runtime. */
export function createNodeGenerationService(
  db: PostgresTransactionPort,
  product: NodeGenerationPorts,
) {
  const journal = createPostgresRunJournal(db);
  const ports: GenerationPipelinePorts = {
    ...product,
    ownerId: NODE_GENERATION_OWNER,
    journal,
    // PG journal.create commits dispatch intent atomically. The runtime's outbox
    // driver enqueues the Flow; enqueue acknowledgement never implies execution.
    schedule: async () => {},
  };
  return {
    journal,
    coordinator: createGenerationPipeline(ports),
    enqueue: (params: GenerationParams) =>
      enqueueGeneration(ports, params.taskId, params),
  };
}
