import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import type { FrozenExecutableInput } from "@clash/shared-runtime/executable-run";
import type { GenerationParams } from "./params";

/** The hosted publication/admission view of one frozen executable Action run. */
export function executableActionGenerationParams(
  identity: DurableRunIdentity,
  executor: Omit<FrozenExecutableInput, "schemaVersion">,
  userId: string,
): GenerationParams {
  if (!executor.nodeId) {
    throw new Error("An executable Action requires a Canvas target node.");
  }
  return {
    taskId: identity.actionRunId,
    projectId: executor.projectId,
    nodeId: executor.nodeId,
    type:
      executor.kind === "text"
        ? "text_gen"
        : executor.kind === "video"
          ? "video_gen"
          : executor.kind === "audio"
            ? "audio_gen"
            : "image_gen",
    actorType: executor.actor?.kind === "agent" ? "agent" : "user",
    actorUserId: userId,
    ...(executor.actor?.kind === "agent" && executor.actor.id
      ? { actorAgentId: executor.actor.id }
      : {}),
  };
}
