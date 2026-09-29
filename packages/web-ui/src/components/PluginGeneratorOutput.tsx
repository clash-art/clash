import { GeneratorRunDiagnosticsSchema, OutputCommitSchema, type GeneratorRunDiagnostics } from "@clash/shared-types";
import { useEffect, useRef, useState } from "react";
import { Spinner, WarningCircle } from "@phosphor-icons/react";
import type { GeneratorOutputProps } from "@clash/action-sdk/ui";
import { createGeneratorClient } from "@clash/shared-runtime/generator-client";
import { useProject } from "./ProjectContext";
import { runtimeApiUrl } from "../lib/runtimeConfig";
import { GeneratorRunFailures } from "./GeneratorRunFailures";

const client = createGeneratorClient((path, init) =>
  fetch(runtimeApiUrl(path), { ...init, credentials: "include" }),
);
export function PluginGeneratorOutput({
  output,
  onReady,
  presentation = "thumbnail",
  onPreview,
}: GeneratorOutputProps) {
  const { projectId } = useProject();
  const ready = useRef(onReady);
  ready.current = onReady;
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<GeneratorRunDiagnostics>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const { run, diagnostics: details } = (await client.getActionRun(
          projectId,
          output.actionRunId,
        )) as { run: { status: string; actionRunId?: string }; diagnostics?: unknown };
        if (run.actionRunId && run.actionRunId !== output.actionRunId) throw new Error("The returned Run does not match this output.");
        if (!active) return;
        setStatus(run.status);
        setError(undefined);
        setDiagnostics(details === undefined ? undefined : GeneratorRunDiagnosticsSchema.parse(details));
        if (run.status === "failed") return;
        if (run.status === "succeeded") {
          const response = (await client.getOutputCommit(
            projectId,
            output.actionRunId,
            output.outputSlot,
          )) as { commit: unknown };
          const commit = OutputCommitSchema.parse(response.commit);
          if (
            commit.actionRunId !== output.actionRunId ||
            commit.outputSlot !== output.outputSlot
          )
            throw new Error("Output does not belong to this run");
          const outputCommitId = `${commit.actionRunId}:${commit.outputSlot}`;
          if (commit.asset.kind !== "media" || !commit.asset.projectAssetId)
            throw new Error("Output is not a media asset");
          if (active)
            ready.current({
              id: outputCommitId,
              projectAssetId: commit.asset.projectAssetId,
              mediaKind: output.mediaKind,
              modelName: output.modelName,
              generatedBy: {
                generatorId: output.generatorId,
                generatorRevisionId: output.generatorRevisionId,
                actionRunId: output.actionRunId,
                outputSlot: output.outputSlot,
                outputCommitId,
              },
            });
          return;
        }
      } catch (cause) {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "Unable to load run",
          );
      }
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectId, output.actionRunId, output.outputSlot]);
  const failed = status === "failed";
  const content = (
    <div
      className={
        presentation === "preview"
          ? "flex h-full min-h-48 w-full flex-col items-center justify-center bg-warm-muted p-6"
          : "w-24 shrink-0 rounded-lg border border-warm-border bg-warm-muted p-1"
      }
      role={failed ? "alert" : "status"}
      aria-label={failed ? "Generation failed" : "Pending material"}
      title={error}
    >
      <div className="flex h-16 items-center justify-center">
        {failed ? (
          <WarningCircle className="h-5 w-5 text-red-600" />
        ) : (
          <Spinner className="h-5 w-5 motion-safe:animate-spin text-content-secondary" />
        )}
      </div>
      <p className="truncate text-xs text-content-secondary">
        {failed
          ? "Failed"
          : error
            ? "Reconnecting…"
            : status === "running"
              ? "Generating…"
              : "Pending…"}
      </p>
      <GeneratorRunFailures diagnostics={diagnostics} outputSlot={output.outputSlot} />
    </div>
  );
  return onPreview ? (
    <button
      type="button"
      aria-label="Preview pending material"
      onClick={onPreview}
      className="shrink-0 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
    >
      {content}
    </button>
  ) : (
    content
  );
}
