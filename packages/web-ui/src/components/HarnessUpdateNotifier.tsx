import { useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  Check,
  CircleNotch,
  DownloadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { runtimeFetch } from "../lib/runtimeConfig";
import {
  clearHarnessOperation,
  setHarnessOperation,
  useHarnessOperations,
} from "../lib/harnessOperations";
import { HARNESS_UPDATED_EVENT } from "../lib/sessionRuntime";
import { useAppFeedback } from "./AppFeedback";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

type HarnessUpdate = {
  id: string;
  label: string;
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  installed?: boolean;
  installSource?: string;
};

const MIN_PROGRESS_VISIBLE_MS = 560;
const COMPLETE_VISIBLE_MS = 2_400;
const DISCOVERY_INTERVAL_MS = 30_000;

function updateDescription(harness: HarnessUpdate): string {
  if (harness.installedVersion && harness.latestVersion) {
    return `${harness.installedVersion} → ${harness.latestVersion}`;
  }
  return "A newer local runtime is ready.";
}

function availableUpdateLabel(count: number): string {
  return `${count} ACP update${count === 1 ? "" : "s"} available`;
}

/**
 * Keeps locally managed ACP updates discoverable in desktop chrome. The
 * expanded list is backed by the real local harness catalog and upgrades each
 * managed runtime in place; already-running sessions deliberately keep their
 * current child process until the next session starts.
 */
export function HarnessUpdateNotifier() {
  const { notify } = useAppFeedback();
  const [checkFailed, setCheckFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [harnesses, setHarnesses] = useState<HarnessUpdate[]>([]);
  const harnessOperations = useHarnessOperations();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [recentlyUpdated, setRecentlyUpdated] = useState<HarnessUpdate | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const completionTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const discoverUpdates = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await runtimeFetch(
          "/api/v1/local/harnesses?updates=1",
          { credentials: "include" },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = (await response.json()) as {
          harnesses?: HarnessUpdate[];
        };
        if (!cancelled) {
          setHarnesses(result.harnesses ?? []);
          setCheckFailed(
            (result.harnesses ?? []).some(
              (harness) =>
                harness.installed &&
                harness.installSource === "registry" &&
                !harness.latestVersion,
            ),
          );
        }
      } catch {
        if (!cancelled) setCheckFailed(true);
        // Retry on the next tick when the host was not ready at mount.
      } finally {
        inFlight = false;
      }
    };

    const handleWindowFocus = () => {
      void discoverUpdates();
    };

    void discoverUpdates();
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("online", handleWindowFocus);
    const timer = window.setInterval(handleWindowFocus, DISCOVERY_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("online", handleWindowFocus);
      window.clearInterval(timer);
    };
  }, [retry]);

  useEffect(
    () => () => {
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const handleHarnessUpdated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          id?: unknown;
          label?: unknown;
          installedVersion?: unknown;
        }>
      ).detail;
      if (typeof detail?.id !== "string") return;
      const installedVersion =
        typeof detail.installedVersion === "string"
          ? detail.installedVersion
          : undefined;
      const updatedHarness: HarnessUpdate = {
        id: detail.id,
        label: typeof detail.label === "string" ? detail.label : "ACP",
        installedVersion,
        latestVersion: installedVersion,
        updateAvailable: false,
      };
      setHarnesses((current) =>
        current.map((candidate) =>
          candidate.id === detail.id
            ? { ...candidate, ...updatedHarness }
            : candidate,
        ),
      );
      setRecentlyUpdated(updatedHarness);
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
      }
      completionTimerRef.current = window.setTimeout(() => {
        setRecentlyUpdated(null);
        completionTimerRef.current = null;
      }, COMPLETE_VISIBLE_MS);
    };

    window.addEventListener(HARNESS_UPDATED_EVENT, handleHarnessUpdated);
    return () =>
      window.removeEventListener(HARNESS_UPDATED_EVENT, handleHarnessUpdated);
  }, []);

  const availableHarnesses = useMemo(
    () => harnesses.filter((harness) => harness.updateAvailable),
    [harnesses],
  );
  const activeUpgradeIds = useMemo(
    () =>
      new Set(
        Object.entries(harnessOperations)
          .filter(([, action]) => action === "upgrade")
          .map(([harnessId]) => harnessId),
      ),
    [harnessOperations],
  );

  const startUpgrade = async (harness: HarnessUpdate) => {
    if (activeUpgradeIds.has(harness.id)) return;

    setHarnessOperation(harness.id, "upgrade");
    setErrors((current) => {
      const next = { ...current };
      delete next[harness.id];
      return next;
    });
    const startedAt = Date.now();

    try {
      const response = await runtimeFetch(
        `/api/v1/local/harnesses/${encodeURIComponent(harness.id)}/upgrade`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }

      const result = (await response.json()) as { harnesses?: HarnessUpdate[] };
      const remainingProgressTime = Math.max(
        0,
        MIN_PROGRESS_VISIBLE_MS - (Date.now() - startedAt),
      );
      if (remainingProgressTime > 0) {
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, remainingProgressTime),
        );
      }

      const updatedHarness = result.harnesses?.find(
        (candidate) => candidate.id === harness.id,
      );
      setHarnesses((current) =>
        current.map((candidate) =>
          candidate.id === harness.id
            ? (updatedHarness ?? {
                ...candidate,
                installedVersion: candidate.latestVersion,
                updateAvailable: false,
              })
            : candidate,
        ),
      );
      setRecentlyUpdated(harness);
      window.dispatchEvent(
        new CustomEvent(HARNESS_UPDATED_EVENT, {
          detail: {
            id: harness.id,
            label: harness.label,
            installedVersion: harness.latestVersion,
          },
        }),
      );

      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current);
      }
      completionTimerRef.current = window.setTimeout(() => {
        setRecentlyUpdated(null);
        completionTimerRef.current = null;
      }, COMPLETE_VISIBLE_MS);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Please try again.";
      const description = /^(fetch failed|Failed to fetch|Load failed)$/i.test(message)
        ? "无法连接更新服务，请检查网络或代理后重试。"
        : message;
      setErrors((current) => ({ ...current, [harness.id]: description }));
      notify({ variant: "warning", title: `${harness.label} 更新失败`, message: description });
    } finally {
      clearHarnessOperation(harness.id, "upgrade");
    }
  };

  if (availableHarnesses.length === 0 && !recentlyUpdated) {
    if (!checkFailed) return null;
    return (
      <Button
        aria-label="Retry ACP update check"
        title="Could not check ACP updates. Click to retry."
        onClick={() => setRetry((value) => value + 1)}
        className="desktop-no-drag ml-auto h-7 shrink-0 gap-1.5 px-2.5 text-xs"
        variant="default"
      >
        <WarningCircle className="h-3.5 w-3.5" />
        检查更新失败 · 重试
      </Button>
    );
  }

  const triggerLabel =
    availableHarnesses.length > 0
      ? availableUpdateLabel(availableHarnesses.length)
      : `${recentlyUpdated?.label ?? "ACP"} updated`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={triggerLabel}
          data-harness-update-control="true"
          size={null}
          shape={null}
          className="desktop-no-drag ml-auto h-7 min-h-0 shrink-0 gap-1.5 rounded-lg border border-brand/25 bg-brand/10 px-2.5 text-[11px] font-semibold text-brand shadow-none hover:bg-brand/15 focus-visible:ring-ring focus-visible:ring-offset-warm-muted dark:border-brand/35 dark:bg-brand/15 dark:hover:bg-brand/20"
        >
          {activeUpgradeIds.size > 0 ? (
            <CircleNotch
              className="h-3.5 w-3.5 animate-spin"
              weight="bold"
              aria-hidden="true"
            />
          ) : availableHarnesses.length > 0 ? (
            <DownloadSimple
              className="h-3.5 w-3.5"
              weight="bold"
              aria-hidden="true"
            />
          ) : (
            <Check className="h-3.5 w-3.5" weight="bold" aria-hidden="true" />
          )}
          <span>
            {availableHarnesses.length > 0 ? "ACP updates" : "ACP updated"}
          </span>
          {availableHarnesses.length > 0 ? (
            <span className="inline-flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] leading-4 text-brand-foreground">
              {availableHarnesses.length}
            </span>
          ) : null}
          <CaretDown
            className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
            weight="bold"
            aria-hidden="true"
          />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        aria-label="ACP updates"
        className="desktop-no-drag w-max max-w-[calc(100vw-1.5rem)] overflow-hidden p-1"
      >
        <div className="max-h-[min(24rem,calc(100vh-6rem))] overflow-y-auto">
          {recentlyUpdated ? (
            <div
              role="status"
              className="flex items-center gap-2 border-b border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs font-medium text-emerald-800 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200"
            >
              <Check
                className="h-4 w-4 shrink-0"
                weight="bold"
                aria-hidden="true"
              />
              {recentlyUpdated.label} updated to{" "}
              {recentlyUpdated.latestVersion ?? "the latest version"}
            </div>
          ) : null}

          <div className="divide-y divide-warm-border/75">
            {availableHarnesses.map((harness) => {
              const updating = activeUpgradeIds.has(harness.id);
              const error = errors[harness.id];
              return (
                <div
                  key={harness.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-1"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="max-w-32 truncate text-xs font-medium text-content-primary">
                        {harness.label}
                      </span>
                      <span className="whitespace-nowrap text-xs tabular-nums text-content-muted">
                        {updateDescription(harness)}
                      </span>
                    </div>

                  </div>
                  <Button
                    aria-label={
                      updating
                        ? `Updating ${harness.label}`
                        : error
                          ? `Retry ${harness.label} update`
                          : `Update ${harness.label}`
                    }
                    disabled={updating}
                    onClick={() => void startUpgrade(harness)}
                    size={null}
                    shape={null}
                    className="h-6 min-h-0 rounded-md px-2 py-0 text-xs leading-5 shadow-none"
                  >
                    {updating ? (
                      <>
                        <CircleNotch
                          className="h-3.5 w-3.5 animate-spin"
                          weight="bold"
                          aria-hidden="true"
                        />
                        Updating
                      </>
                    ) : error ? (
                      "Retry"
                    ) : (
                      "Update"
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

      </PopoverContent>
    </Popover>
  );
}
