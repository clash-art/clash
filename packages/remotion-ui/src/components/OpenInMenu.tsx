import * as Ariakit from '@ariakit/react';
import React from 'react';
import type { NleAvailability, NleTarget } from '@clash/remotion-core';
import type { TimelineExportProgress } from '@clash/shared-types';

const targets: Array<{ id: NleTarget; label: string }> = [
  { id: 'premiere-pro', label: 'Adobe Premiere Pro' },
  { id: 'final-cut-pro', label: 'Final Cut Pro' },
  { id: 'davinci-resolve', label: 'DaVinci Resolve' },
];

function NleIcon({ target }: { target: NleTarget }) {
  return (
    <span
      data-nle-icon={target}
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center text-current"
    >
      {target === 'premiere-pro' ? (
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none">
          <rect
            x="2.5"
            y="2.5"
            width="15"
            height="15"
            rx="3"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M6.3 13.2V6.8h2.45c1.8 0 2.8.9 2.8 2.35 0 1.5-1.05 2.4-2.85 2.4H7.85v1.65H6.3Zm1.55-3h.72c.92 0 1.42-.34 1.42-1.02 0-.66-.47-1-1.37-1h-.77v2.02Zm4.2 3V8.5h1.42l.08.7c.3-.52.75-.8 1.35-.8.18 0 .34.03.47.08v1.35a2.2 2.2 0 0 0-.57-.08c-.78 0-1.18.43-1.18 1.3v2.15h-1.57Z"
            fill="currentColor"
          />
        </svg>
      ) : target === 'final-cut-pro' ? (
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.2 7.2h13.6v9H3.2zM3.5 7.2l1.6-3.4h12l-1.6 3.4M6.3 3.8 4.8 7.2M10.3 3.8 8.8 7.2M14.3 3.8l-1.5 3.4" />
          <path
            d="m7.8 9.6 5 2.3-5 2.3V9.6Z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      ) : (
        <svg
          viewBox="0 0 20 20"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.35"
        >
          <path d="M10 3.1c1.9 0 3.45 1.55 3.45 3.45S11.9 10 10 10 6.55 8.45 6.55 6.55 8.1 3.1 10 3.1Z" />
          <path d="M4.1 13.5c-.95-1.65-.38-3.76 1.27-4.72 1.64-.95 3.75-.38 4.7 1.27.96 1.65.4 3.76-1.26 4.72-1.65.95-3.76.38-4.71-1.27Z" />
          <path d="M15.9 13.5c.95-1.65.38-3.76-1.27-4.72-1.64-.95-3.75-.38-4.7 1.27-.96 1.65-.4 3.76 1.26 4.72 1.65.95 3.76.38 4.71-1.27Z" />
          <circle
            cx="10"
            cy="10.2"
            r="1.45"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      )}
    </span>
  );
}

export function OpenInMenu({
  onExport,
  exportProgress = [],
  onCancelExport,
  onOpenInNle,
  availability,
  availabilityError,
  onRefreshAvailability,
}: {
  onExport?: () => Promise<void>;
  exportProgress?: readonly TimelineExportProgress[];
  onCancelExport?: () => void;
  onOpenInNle?: (target: NleTarget) => Promise<void>;
  availability: NleAvailability[] | null;
  availabilityError?: string | null;
  onRefreshAvailability?: () => Promise<void>;
}) {
  const [exporting, setExporting] = React.useState(false);
  const [opening, setOpening] = React.useState<NleTarget | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const activeExports = exportProgress.filter(
    (entry) => entry.status === 'queued' || entry.status === 'rendering',
  );
  const hasActiveExport = activeExports.length > 0;

  const exportVideo = React.useCallback(async () => {
    if (!onExport || exporting || opening || hasActiveExport) return;
    setExporting(true);
    setError(null);
    try {
      await onExport();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Video export failed.',
      );
    } finally {
      setExporting(false);
    }
  }, [exporting, hasActiveExport, onExport, opening]);

  const open = React.useCallback(
    async (target: NleTarget) => {
      if (!onOpenInNle || exporting || opening) return;
      setOpening(target);
      setError(null);
      try {
        await onOpenInNle(target);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : 'Could not open this Timeline.',
        );
      } finally {
        setOpening(null);
      }
    },
    [exporting, onOpenInNle, opening],
  );

  const operationBusy = exporting || opening !== null;
  const exportBusy = operationBusy || hasActiveExport;

  return (
    <div className="min-w-0">
      <Ariakit.MenuProvider>
        {/* Stays openable while exporting: progress and Cancel live in this menu. */}
        <Ariakit.MenuButton
          disabled={opening !== null}
          className="clash-workbench-control-button flex h-8 min-w-[92px] items-center justify-between gap-2 bg-brand px-3 text-xs font-semibold text-brand-foreground shadow-sm transition-colors hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait disabled:opacity-80"
        >
          <span>
            {exporting || hasActiveExport
              ? 'Exporting…'
              : opening
                ? 'Opening…'
                : 'Export'}
          </span>
          <svg
            viewBox="0 0 12 12"
            className="h-3 w-3 text-brand-foreground/75"
            aria-hidden="true"
          >
            <path
              d="m3 4.5 3 3 3-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Ariakit.MenuButton>
        <Ariakit.Menu
          portal
          gutter={6}
          className="z-40 min-w-[232px] rounded-lg border border-overlay-border bg-overlay-surface p-1.5 text-content-primary shadow-overlay outline-none backdrop-blur-xl"
        >
          {activeExports.map((entry) => {
            const percentage =
              entry.progress === undefined
                ? null
                : Math.round(entry.progress * 100);
            return (
              <div
                key={entry.renderNodeId}
                className="rounded-md bg-info-soft px-2.5 py-2 text-xs text-content-primary"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold">Exporting video</span>
                  <span className="text-[10px] font-semibold tabular-nums text-info">
                    {percentage === null
                      ? entry.status === 'queued'
                        ? 'Queued'
                        : 'Rendering'
                      : `${percentage}%`}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label="Video export progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(percentage === null
                    ? { 'aria-valuetext': 'Rendering' }
                    : { 'aria-valuenow': percentage })}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-overlay-border"
                >
                  <div
                    className={`h-full rounded-full bg-info transition-[width] duration-200 motion-reduce:transition-none ${percentage === null ? 'w-1/3 animate-pulse motion-reduce:animate-none' : ''}`}
                    style={
                      percentage === null
                        ? undefined
                        : { width: `${percentage}%` }
                    }
                  />
                </div>
                {onCancelExport ? (
                  <button
                    type="button"
                    aria-label="Cancel video export"
                    onClick={() => onCancelExport()}
                    className="mt-2 text-[10px] font-semibold text-content-muted underline-offset-2 hover:text-content-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    Cancel
                  </button>
                ) : null}
              </div>
            );
          })}
          {hasActiveExport && onExport ? (
            <Ariakit.MenuSeparator className="mx-2 my-1 h-px border-0 bg-overlay-border" />
          ) : null}
          {onExport ? (
            <Ariakit.MenuItem
              aria-label="Export video"
              disabled={exportBusy}
              onClick={() => void exportVideo()}
              className="flex min-h-10 items-center justify-between gap-4 rounded-md px-2.5 text-xs font-semibold text-content-primary outline-none data-[active-item]:bg-warm-muted/80 disabled:opacity-60"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-brand"
                >
                  <svg
                    viewBox="0 0 20 20"
                    className="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3.5v8.25m0 0 3-3m-3 3-3-3" />
                    <path d="M4 12.5v2.25c0 .97.78 1.75 1.75 1.75h8.5c.97 0 1.75-.78 1.75-1.75V12.5" />
                  </svg>
                </span>
                <span>Export video</span>
              </span>
              <span className="shrink-0 text-[10px] font-medium text-content-muted">
                MP4
              </span>
            </Ariakit.MenuItem>
          ) : null}
          {onExport && onOpenInNle ? (
            <Ariakit.MenuSeparator className="mx-2 my-1 h-px border-0 bg-overlay-border" />
          ) : null}
          {onOpenInNle ? (
            <div className="px-2.5 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-content-muted">
              Open in
            </div>
          ) : null}
          {onOpenInNle ? (
            availability === null ? (
              <Ariakit.MenuItem
                disabled={!availabilityError || !onRefreshAvailability}
                onClick={() => void onRefreshAvailability?.()}
                className="flex min-h-9 cursor-default items-center justify-between gap-3 rounded-md px-2.5 text-xs font-medium text-content-secondary outline-none data-[active-item]:bg-warm-muted/80 disabled:text-content-disabled"
              >
                <span>
                  {availabilityError
                    ? 'Could not check installed editors.'
                    : 'Checking installed editors…'}
                </span>
                {availabilityError && onRefreshAvailability ? (
                  <span className="font-semibold text-brand">Retry</span>
                ) : null}
              </Ariakit.MenuItem>
            ) : (
              targets.map((target) => {
                const entry = availability.find(
                  (candidate) => candidate.target === target.id,
                ) ?? {
                  target: target.id,
                  applicationName: target.label,
                  installed: false,
                };
                return (
                  <Ariakit.MenuItem
                    key={target.id}
                    disabled={!entry.installed || opening !== null}
                    onClick={() => void open(target.id)}
                    className={`flex min-h-10 items-center justify-between gap-4 rounded-md px-2.5 text-xs font-medium outline-none data-[active-item]:bg-warm-muted/80 ${entry.installed ? 'text-content-primary' : 'cursor-not-allowed text-content-disabled'}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <NleIcon target={target.id} />
                      <span className="truncate">{target.label}</span>
                    </span>
                    <span
                      className={`shrink-0 text-[10px] font-medium ${entry.installed ? 'text-content-secondary' : 'text-current'}`}
                    >
                      {entry.installed ? 'Installed' : 'Not installed'}
                    </span>
                  </Ariakit.MenuItem>
                );
              })
            )
          ) : null}
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
      {error ? (
        <p role="alert" className="mt-1.5 text-[10px] leading-4 text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
