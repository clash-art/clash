import { ArrowClockwise, House } from "@phosphor-icons/react";
import { Button } from "@clash/gui/components/ui/button";
import { AgentMotion } from "@clash/web-ui/components/copilot/AgentMotion";
import { BrandAsset } from "@clash/web-ui/components/BrandAsset";
import { useEffect, useState } from "react";
import { Link, isRouteErrorResponse, useRouteError } from "react-router";

import { createLogger } from "./lib/logger";
import {
  isRecoverableRouteModuleError,
  recoverFailedRouteModule,
} from "./lib/routeModuleRecovery";

const routeErrorLog = createLogger("route");

type RouteErrorDetails = {
  code: string;
  detail: string;
};

function hasRouteErrorCode(error: unknown): error is { code?: unknown; detail?: unknown; message?: unknown } {
  return Boolean(error && typeof error === "object" && "code" in error);
}

function readRouteErrorDetail(data: unknown): string | null {
  if (typeof data === "string") return data.trim() || null;
  if (!data || typeof data !== "object") return null;
  for (const key of ["detail", "message", "error"] as const) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function describeRouteError(error: unknown): RouteErrorDetails {
  if (isRouteErrorResponse(error)) {
    return {
      code: String(error.status),
      detail:
        readRouteErrorDetail(error.data) ||
        error.statusText ||
        "This route returned without a readable status message.",
    };
  }

  if (hasRouteErrorCode(error)) {
    return {
      code: String(error.code ?? "route_error"),
      detail: String(
        error.message ??
        error.detail ??
        "This view stopped before it could describe the failure.",
      ),
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "route_error",
      detail: error.message || "This view stopped before it could describe the failure.",
    };
  }

  return {
    code: "route_error",
    detail: "This view stopped before it could describe the failure.",
  };
}

export function HydrateFallback() {
  return (
    <main
      role="status"
      aria-label="Opening Clash"
      aria-live="polite"
      className="flex min-h-screen items-center justify-center bg-warm-page"
    >
      <AgentMotion
        state="connecting"
        decorative={false}
        label="Clash is opening"
        className="h-20 w-20"
      />
    </main>
  );
}

export function RouteModuleRecoveryFallback() {
  return (
    <main
      role="status"
      aria-label="Reconnecting Clash"
      aria-live="polite"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-warm-page px-6 text-center"
    >
      <AgentMotion
        state="connecting"
        decorative={false}
        label="Clash renderer is reconnecting"
        className="h-20 w-20"
      />
      <p className="text-sm font-medium text-content-secondary">
        Reconnecting the desktop renderer…
      </p>
    </main>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { code, detail } = describeRouteError(error);
  const shouldRecover =
    import.meta.env.DEV &&
    isRecoverableRouteModuleError(error, window.location.origin);
  const [isRecovering, setIsRecovering] = useState(shouldRecover);

  // A route that fails must leave a coded line in the local logs, not only on
  // screen (a stuck or failed project open used to leave nothing).
  useEffect(() => {
    routeErrorLog.error("ui.route_error", {
      code,
      detail: detail.slice(0, 300),
      path: typeof window === "undefined" ? undefined : window.location.pathname,
    });
  }, [code, detail]);

  useEffect(() => {
    setIsRecovering(shouldRecover);
    if (!shouldRecover) return;

    let active = true;
    void recoverFailedRouteModule({
      error,
      origin: window.location.origin,
      fetchModule: (url, init) => fetch(url, init),
      reload: () => window.location.reload(),
      storage: window.sessionStorage,
    }).then((result) => {
      if (active && result !== "reloaded") setIsRecovering(false);
    });
    return () => {
      active = false;
    };
  }, [error, shouldRecover]);

  if (isRecovering) return <RouteModuleRecoveryFallback />;

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-warm-page px-6 py-16 text-slate-950 dark:text-stone-100">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.32]"
        style={{
          backgroundImage: "radial-gradient(var(--canvas-dot) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />
      <div className="pointer-events-none absolute inset-0 text-brand opacity-[0.024]">
        <svg className="h-full w-full" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <pattern id="route-error-grid" x="0" y="0" width="400" height="400" patternUnits="userSpaceOnUse">
              <path d="M 200 0 L 200 400" stroke="currentColor" strokeDasharray="4 4" />
              <path d="M 0 200 L 400 200" stroke="currentColor" strokeDasharray="4 4" />
              <circle cx="200" cy="200" r="2" fill="currentColor" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#route-error-grid)" />
        </svg>
      </div>

      <section className="relative w-full max-w-xl">
        <div className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <BrandAsset
            name="error"
            alt="Clash error avatar"
            className="h-24 w-24 shrink-0 object-contain sm:h-28 sm:w-28"
          />
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand">Route paused</p>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Clash could not finish this view
            </h1>
          </div>
        </div>

        <div className="clash-route-error-surface rounded-2xl p-5">
          <div className="mb-4 min-w-0">
            <p className="text-sm font-semibold text-slate-950 dark:text-stone-100">The canvas is still here.</p>
            <p className="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-400">
              Reload this route to try again, or go home and reopen the project from a fresh surface.
            </p>
          </div>

          <dl className="clash-route-error-detail grid gap-3 rounded-2xl p-4 text-left">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-500">Code</dt>
              <dd className="mt-1 font-mono text-sm text-slate-950 dark:text-stone-100">{code}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500 dark:text-stone-500">Detail</dt>
              <dd className="mt-1 break-words text-sm leading-6 text-stone-700 dark:text-stone-300">{detail}</dd>
            </div>
          </dl>

          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <Button
              variant="primary"
              onClick={() => window.location.reload()}
              className="clash-route-error-primary inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warm-surface"
            >
              <ArrowClockwise className="h-4 w-4" weight="bold" aria-hidden="true" />
              Reload
            </Button>
            <Link
              to="/"
              className="clash-route-error-secondary inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warm-surface"
            >
              <House className="h-4 w-4" weight="bold" aria-hidden="true" />
              Go home
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
