import { CloudWarning } from "@phosphor-icons/react";
import type { ProjectRemoteStateMessage } from "@clash/shared-types";

/**
 * Non-blocking notice that the local room is usable but its cloud replica is
 * behind. It never blocks editing: the Host keeps saving locally and retries the
 * remote snapshot in the background.
 */
export function ProjectRemoteStateNotice({
  state,
}: {
  state?: ProjectRemoteStateMessage;
}) {
  if (!state || state.state === "synced") return null;
  const retryAt = state.retryAt ? new Date(state.retryAt) : undefined;
  const title =
    state.state === "import-failed"
      ? "Cloud changes could not be loaded"
      : state.code === "CLOUD_LINK_ACTION_REQUIRED"
        ? "Cloud sync needs your attention"
        : state.code?.startsWith("CLOUD_LINK_")
          ? "Cloud sync is unavailable"
          : "Cloud state is unavailable";
  return (
    <div
      role="status"
      aria-live="polite"
      data-clash-remote-state={state.state}
      data-clash-remote-code={state.code}
      className="fixed bottom-4 left-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50/95 p-3 text-sm text-amber-950 shadow-lg backdrop-blur"
    >
      <CloudWarning
        size={20}
        weight="bold"
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-amber-600"
      />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{title}</p>
        <p className="text-xs leading-relaxed">
          Showing the revision saved on this device. Your edits are saved
          locally.
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-amber-800/90">
          {state.code && <code className="font-mono">{state.code}</code>}
          {retryAt && (
            <span>Retrying at {retryAt.toLocaleTimeString()}</span>
          )}
        </p>
      </div>
    </div>
  );
}
