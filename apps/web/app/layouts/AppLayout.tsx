import {
  Outlet,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router";
import LayoutContent from "@clash/web-ui/components/LayoutContent";
import DevLogBridge from "@clash/web-ui/components/DevLogBridge";
import { ConfirmDialogProvider } from "@clash/web-ui/components/ConfirmDialog";
import { getEffectiveChromeAuth } from "./authChrome";
import { isDesktopRuntime } from "@clash/web-ui/lib/runtimeConfig";
import { useSessionSignedIn } from "@clash/web-ui/lib/sessionStore";
import type { loader } from "./appLayoutLoader";

function routeLoadingName(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (/^\/projects\/[^/]+$/.test(pathname)) return "Project";
  if (pathname === "/projects") return "Projects";
  if (pathname === "/assets") return "Assets";
  if (pathname.startsWith("/marketplace")) return "Marketplace";
  if (pathname === "/settings") return "Settings";
  return "View";
}

function LoadingBlock({ className }: { className: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-xl bg-warm-muted motion-reduce:animate-none ${className}`}
    />
  );
}

function DesktopRouteLoadingState({ pathname }: { pathname: string }) {
  const routeName = routeLoadingName(pathname);
  const isProject = /^\/projects\/[^/]+$/.test(pathname);
  const isSettings = pathname === "/settings";

  if (isProject) {
    return (
      <section
        role="status"
        aria-label="Opening Project"
        aria-live="polite"
        data-slot="desktop-route-loading"
        className="flex h-full min-h-0 flex-col bg-warm-page text-content-primary"
      >
        <span className="sr-only">Opening Project</span>
        <div aria-hidden="true" className="flex h-12 shrink-0 items-center gap-3 border-b border-warm-border px-4">
          <LoadingBlock className="h-7 w-44" />
          <LoadingBlock className="ml-auto h-8 w-24" />
        </div>
        <div aria-hidden="true" className="flex min-h-0 flex-1">
          <div className="w-64 shrink-0 space-y-3 border-r border-warm-border p-4">
            <LoadingBlock className="h-9 w-full" />
            <LoadingBlock className="h-20 w-full" />
            <LoadingBlock className="h-20 w-full" />
          </div>
          <div className="relative min-w-0 flex-1 overflow-hidden p-6">
            <LoadingBlock className="absolute left-[12%] top-[18%] h-32 w-52" />
            <LoadingBlock className="absolute right-[14%] top-[38%] h-40 w-64" />
            <LoadingBlock className="absolute bottom-[14%] left-[35%] h-28 w-48" />
          </div>
        </div>
      </section>
    );
  }

  if (isSettings) {
    return (
      <section
        role="status"
        aria-label="Opening Settings"
        aria-live="polite"
        data-slot="desktop-route-loading"
        className="flex h-full min-h-0 bg-warm-page text-content-primary"
      >
        <span className="sr-only">Opening Settings</span>
        <div aria-hidden="true" className="w-56 shrink-0 space-y-3 border-r border-warm-border p-5">
          <LoadingBlock className="mb-7 h-7 w-28" />
          {[0, 1, 2, 3, 4].map((slot) => (
            <LoadingBlock key={slot} className="h-9 w-full" />
          ))}
        </div>
        <div aria-hidden="true" className="min-w-0 flex-1 space-y-5 p-8">
          <LoadingBlock className="h-8 w-48" />
          <LoadingBlock className="h-32 w-full max-w-3xl" />
          <LoadingBlock className="h-48 w-full max-w-3xl" />
        </div>
      </section>
    );
  }

  return (
    <section
      role="status"
      aria-label={`Opening ${routeName}`}
      aria-live="polite"
      data-slot="desktop-route-loading"
      className="min-h-full bg-warm-page text-content-primary"
    >
      <span className="sr-only">Opening {routeName}</span>
      <div
        aria-hidden="true"
        className="mx-auto w-full max-w-[76rem] px-[var(--app-page-inline-inset)] pb-[var(--app-page-block-end)] pt-[var(--app-page-block-start)]"
      >
        <LoadingBlock className="h-7 w-44" />
        <div className="mt-5 flex gap-4 overflow-hidden">
          {[0, 1, 2].map((slot) => (
            <LoadingBlock key={slot} className="h-40 min-w-64 flex-1" />
          ))}
        </div>
        <LoadingBlock className="mt-10 h-6 w-36" />
        <LoadingBlock className="mt-5 h-24 w-full" />
      </div>
    </section>
  );
}

export default function AppLayout() {
  const { isAuthenticated } = useLoaderData<typeof loader>();
  const pathname = useLocation().pathname;
  const navigation = useNavigation();
  const sessionSignedIn = useSessionSignedIn();

  const effectiveAuthenticated = getEffectiveChromeAuth(
    isAuthenticated,
    sessionSignedIn,
  );
  const pendingPathname =
    isDesktopRuntime() &&
    navigation.state === "loading" &&
    navigation.location?.pathname !== pathname
      ? navigation.location?.pathname ?? null
      : null;

  return (
    <ConfirmDialogProvider>
      <DevLogBridge />
      <LayoutContent
        isAuthenticated={effectiveAuthenticated}
        pendingPathname={pendingPathname}
      >
        {pendingPathname ? (
          <DesktopRouteLoadingState pathname={pendingPathname} />
        ) : (
          <Outlet />
        )}
      </LayoutContent>
    </ConfirmDialogProvider>
  );
}
