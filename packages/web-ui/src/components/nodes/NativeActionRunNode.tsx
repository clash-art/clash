import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { LoroDoc } from "loro-crdt";
import { Handle, Position } from "@xyflow/react";
import { X } from "@phosphor-icons/react";
import { ACTION_BADGE_NODE_SIZE } from "@clash/shared-layout";
import {
  readGeneratorRevision,
  readOutputCommit,
  readProjectActionRun,
  readProjectAsset,
  GeneratorRunDiagnosticsSchema,
  type GeneratorRunDiagnostics,
} from "@clash/shared-types";
import { createGeneratorClient } from "@clash/shared-runtime/generator-client";
import { NodeModalDialog } from "./NodeModalDialog";
import { IconButton } from "../ui/icon-button";
import { GeneratorRunFailures } from "../GeneratorRunFailures";
import { runtimeApiUrl } from "../../lib/runtimeConfig";

function NativeRunFailure({
  projectId,
  actionRunId,
}: {
  projectId: string;
  actionRunId: string;
}) {
  const [value, setValue] = useState<{
    diagnostics?: GeneratorRunDiagnostics;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const client = createGeneratorClient((path, init) =>
      fetch(runtimeApiUrl(path), {
        ...init,
        credentials: "include",
        signal: controller.signal,
      }),
    );
    void client
      .getActionRun(projectId, actionRunId)
      .then((raw) => {
        const response = raw as {
          run?: { actionRunId?: string };
          diagnostics?: unknown;
        };
        if (response.run?.actionRunId !== actionRunId)
          throw new Error("The returned Run does not match this operation.");
        const diagnostics = GeneratorRunDiagnosticsSchema.parse(
          response.diagnostics ?? { failures: [] },
        );
        if (active) setValue({ diagnostics });
      })
      .catch((cause) => {
        if (active)
          setValue({
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, actionRunId]);
  return (
    <div role="alert">
      <GeneratorRunFailures diagnostics={value?.diagnostics} />
      {value?.error && (
        <p className="mt-2 text-xs text-red-700">
          Could not load failure details: {value.error}
        </p>
      )}
    </div>
  );
}

/** A placed operation is a receipt for one frozen Run, not an editable model prompt. */
export function NativeActionRunNode({
  projectId,
  doc,
  actionRunId,
  label,
}: {
  projectId: string;
  doc: LoroDoc | null;
  actionRunId: string;
  label?: string;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const read = useCallback(() => {
    const run = doc && readProjectActionRun(doc, actionRunId);
    const revision =
      run && doc && readGeneratorRevision(doc, run.generatorRevision);
    const inputs =
      run && revision && doc
        ? [...revision.persistentInputRefs, ...run.invocationInputRefs].map(
            (ref) => ({
              ...ref,
              label:
                "kind" in ref.target && ref.target.kind === "media"
                  ? (readProjectAsset(doc, ref.target.projectAssetId)?.name ??
                    ref.target.projectAssetId)
                  : ref.slot,
            }),
          )
        : [];
    const outputs =
      run && doc
        ? run.outputContract.map(({ slot }) => ({
            slot,
            commit: readOutputCommit(doc, { actionRunId, outputSlot: slot }),
          }))
        : [];
    return { run, revision, inputs, outputs };
  }, [actionRunId, doc]);
  const subscribe = useCallback(
    (notify: () => void) => doc?.subscribe(notify) ?? (() => {}),
    [doc],
  );
  const snapshot = useCallback(() => JSON.stringify(read()), [read]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { run, revision, inputs, outputs } = JSON.parse(value) as ReturnType<
    typeof read
  >;
  if (!run || !revision)
    return (
      <div
        role="alert"
        style={ACTION_BADGE_NODE_SIZE}
        className="overflow-hidden rounded-xl border border-warm-border bg-warm-surface p-3 text-xs"
      >
        Operation record is unavailable.
      </div>
    );
  const title = label ?? run.actionId;
  return (
    <>
      <article
        aria-label={title}
        style={ACTION_BADGE_NODE_SIZE}
        className="rounded-xl border border-warm-border bg-warm-surface text-content-primary shadow-sm"
      >
        <Handle type="target" position={Position.Left} isConnectable={false} />
        <button
          type="button"
          aria-label="Operation details"
          title={title}
          onClick={() => setDetailsOpen(true)}
          className="nodrag nopan flex h-full w-full items-center justify-between gap-3 rounded-xl px-3 text-left hover:bg-warm-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{title}</h3>
            <p className="truncate text-[10px] text-content-secondary">
              {run.executor.pluginId} · {run.actionId}
            </p>
          </div>
          <span
            role="status"
            className={`shrink-0 text-[10px] capitalize ${run.status === "failed" ? "text-red-700" : "text-content-secondary"}`}
          >
            {run.status}
          </span>
        </button>
        <Handle type="source" position={Position.Right} isConnectable={false} />
      </article>
      <NodeModalDialog
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        ariaLabel={`${title} operation details`}
        contentClassName="h-auto max-h-[85vh] max-w-xl"
      >
        <div className="nowheel overflow-y-auto p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="break-words text-lg font-semibold">{title}</h2>
              <p className="mt-1 break-all text-xs text-content-secondary">
                {run.executor.pluginId} · {run.actionId} ·{" "}
                <span className="capitalize">{run.status}</span>
              </p>
            </div>
            <IconButton
              label="Close operation details"
              icon={<X weight="bold" className="h-4 w-4" />}
              onClick={() => setDetailsOpen(false)}
            />
          </div>
          {run.status === "failed" && detailsOpen && (
            <NativeRunFailure
              key={actionRunId}
              projectId={projectId}
              actionRunId={actionRunId}
            />
          )}
          {inputs.length ? (
            <section className="mt-5">
              <h3 className="text-xs font-semibold">Inputs</h3>
              <ul
                aria-label="Operation inputs"
                className="mt-2 space-y-1 text-xs"
              >
                {inputs.map((input, index) => (
                  <li key={`${input.slot}:${index}`} className="break-words">
                    <span className="text-content-muted">{input.slot}: </span>
                    {input.label}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="mt-5 border-t border-warm-border pt-4">
            <p className="break-all text-[10px] text-content-muted">
              Run {run.actionRunId} · Revision {revision.id}
            </p>
            <pre className="nowheel mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-warm-muted p-2 text-[11px]">
              {JSON.stringify(run.parameters, null, 2)}
            </pre>
            <ul
              aria-label="Operation outputs"
              className="mt-2 space-y-1 text-xs"
            >
              {outputs.map(({ slot, commit }) => (
                <li key={slot} className="break-all">
                  {slot}:{" "}
                  {commit?.asset.kind === "media"
                    ? commit.asset.projectAssetId
                    : commit?.asset.kind === "document"
                      ? commit.asset.documentAssetId
                      : run.status === "failed"
                        ? "Not published"
                        : "Pending"}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </NodeModalDialog>
    </>
  );
}
