import type {
  GeneratorRunDiagnostics,
  ProjectActionRun,
} from "@clash/shared-types";
import type { DurableProviderFailure } from "@clash/shared-runtime";
import { parseFrozenExecutorInput } from "./durable-run-coordinator.js";
import type { SqliteDurableRunJournal } from "./durable-run-journal.js";

/** Never copy arbitrary Provider messages, URLs, response bodies, credentials, or paths into this projection. */
function safeFailureMessage(
  failure: DurableProviderFailure,
  pluginId: string,
): string {
  if (
    pluginId === "clash.media-analysis" &&
    failure.code === "execution_failed" &&
    failure.message === "Media analysis model did not return valid JSON."
  ) {
    return "The selected media-analysis category requires JSON, but the model response could not be parsed. Inspect local format evidence with clash logs --event media-analysis.invalid-json --json and match context.actionRunId to this run. Use a custom prompt for a free-form description, or correct the structured output before starting a new run.";
  }
  if (pluginId === "clash.asset-edit" && failure.code === "invalid_request") {
    switch (failure.providerCode) {
      case "ASSET_EDIT_CROP_OUT_OF_BOUNDS":
        return "Crop rectangle exceeds the source image. Keep x + width and y + height within its dimensions.";
      case "ASSET_EDIT_FRAME_OUT_OF_RANGE":
      case "ASSET_EDIT_FRAME_UNAVAILABLE":
        return "Choose a frame time at or after zero and strictly before the source video duration; if no frame decodes near the end, choose an earlier time.";
      case "ASSET_EDIT_TRIM_OUT_OF_RANGE":
        return "Choose a trim range with 0 <= startSec < endSec <= the source video duration.";
      case "ASSET_EDIT_DURATION_UNAVAILABLE":
        return "The source video duration could not be determined. Use a video with a finite duration before selecting a frame or trim range.";
    }
  }
  if (
    /\b(?:credentials\.)?region\b/i.test(failure.message) &&
    /missing|required|not configured|not set|empty/i.test(failure.message)
  ) {
    return "The Provider account has no configured region. Set its runtime region before retrying.";
  }
  switch (failure.code) {
    case "authentication_failed":
      return "Provider authentication failed. Check the selected account credentials.";
    case "permission_denied":
      return "The selected Provider account does not have permission for this operation.";
    case "quota_exhausted":
      return "The selected Provider account has no remaining quota.";
    case "rate_limited":
      return "The Provider rate limit was reached. Check the existing run before submitting again.";
    case "provider_unavailable":
      return "The Provider is unavailable. Check the existing run before submitting again.";
    case "transport_timeout":
    case "transport_error":
      return "Communication with the Provider failed. Its acceptance of the request may be unknown; check the existing run before submitting again.";
    case "output_persistence_failed":
      return "The output could not be saved to local storage. Check available storage and recover this run's saved result.";
    case "publication_failed":
      return "The prepared output could not be published to the Project. Check its output contract and recover publication from this run.";
    case "plugin_unavailable":
      return "The required execution plugin is unavailable. Check the installed plugin before retrying.";
    case "invalid_request":
      return "The Provider rejected the request. Check the selected model and input parameters.";
    case "invalid_response":
    case "contract_violation":
      return "The returned output did not satisfy the declared contract. Check the output format and plugin version.";
    case "content_rejected":
      return "The Provider rejected the submitted content.";
    case "task_not_found":
      return "The Provider could not find the previously accepted task.";
    case "task_expired":
    case "deadline_exceeded":
      return "The run exceeded its allowed lifetime. Check existing output before starting another run.";
    case "cancelled":
      return "The run was cancelled.";
    default:
      return "Execution failed. Inspect the owning Host's local diagnostics for the underlying error.";
  }
}

export async function readLocalGeneratorRunDiagnostics(input: {
  projectId: string;
  ownerId: string;
  run: ProjectActionRun;
  journal: Pick<SqliteDurableRunJournal, "load">;
}): Promise<GeneratorRunDiagnostics> {
  const failures: GeneratorRunDiagnostics["failures"] = [];
  for (const output of input.run.outputContract) {
    const task = await input.journal.load({
      actionRunId: input.run.actionRunId,
      outputSlot: output.slot,
    });
    if (
      !task ||
      task.owner.realm !== "local" ||
      task.owner.id !== input.ownerId
    )
      continue;
    const executor = parseFrozenExecutorInput(task.executorInput);
    if (
      executor.projectId !== input.projectId ||
      executor.targetKind !== "generator-action"
    )
      continue;
    const failure =
      task.projectionFailure ??
      (task.phase === "succeeded" ? undefined : task.failure);
    if (!failure) continue;
    failures.push({
      outputSlot: output.slot,
      code: failure.code,
      phase: task.phase,
      retryable: failure.retryable,
      message: safeFailureMessage(failure, executor.binding.pluginId),
    });
  }
  return { failures };
}
