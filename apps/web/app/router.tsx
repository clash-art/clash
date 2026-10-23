import { createBrowserRouter } from "react-router";
import AppLayout from "./layouts/AppLayout";
import { loader as appLayoutLoader } from "./layouts/appLayoutLoader";
import { ErrorBoundary, HydrateFallback } from "./root";
import { clearRouteModuleRecovery } from "./lib/routeModuleRecovery";

// Object Route Module shim: route files export the page component as
// `default` and (optionally) a `loader`. createBrowserRouter's `lazy`
// expects { Component, loader, ... }; only set fields the module
// actually exports (passing { ErrorBoundary: undefined } makes react-
// router try to render <undefined /> → React #130).
function lazyRoute(importer: () => Promise<any>) {
  return async () => {
    const m = await importer();
    if (import.meta.env.DEV) clearRouteModuleRecovery(window.sessionStorage);
    const out: Record<string, unknown> = { Component: m.default };
    if (m.loader) out.loader = m.loader;
    if (m.ErrorBoundary) out.ErrorBoundary = m.ErrorBoundary;
    if (m.HydrateFallback) out.HydrateFallback = m.HydrateFallback;
    return out;
  };
}

const devOnlyRoutes = import.meta.env.DEV
  ? [
      {
        path: "__canvas-perf",
        lazy: lazyRoute(() => import("./routes/__canvas-perf")),
      },
    ]
  : [];

export const router = createBrowserRouter([
  {
    Component: AppLayout,
    loader: appLayoutLoader,
    HydrateFallback,
    ErrorBoundary,
    children: [
      { index: true, lazy: lazyRoute(() => import("./routes/home")) },
      { path: "landing", lazy: lazyRoute(() => import("./routes/landing")) },
      { path: "docs", lazy: lazyRoute(() => import("./routes/docs")) },
      { path: "download", lazy: lazyRoute(() => import("./routes/download")) },
      { path: "login", lazy: lazyRoute(() => import("./routes/login")) },
      { path: "projects", lazy: lazyRoute(() => import("./routes/projects")) },
      { path: "assets", lazy: lazyRoute(() => import("./routes/assets")) },
      { path: "settings", lazy: lazyRoute(() => import("./routes/settings")) },
      {
        path: "projects/:id",
        lazy: lazyRoute(() => import("./routes/project.$id")),
      },
      { path: "billing", lazy: lazyRoute(() => import("./routes/billing")) },
      // Team settings (#354): the team owner manages members, budgets and limits.
      { path: "team", lazy: lazyRoute(() => import("./routes/team")) },
      { path: "team/invite", lazy: lazyRoute(() => import("./routes/team.invite")) },
      // Gateway admin console (#353): every page's loader asks api-cf for the
      // signed-in admin account (#394), whose own sign-in is /admin/login.
      { path: "admin/login", lazy: lazyRoute(() => import("./routes/admin.login")) },
      { path: "admin", lazy: lazyRoute(() => import("./routes/admin._index")) },
      { path: "admin/models", lazy: lazyRoute(() => import("./routes/admin.models")) },
      { path: "admin/upstreams", lazy: lazyRoute(() => import("./routes/admin.upstreams")) },
      { path: "admin/users", lazy: lazyRoute(() => import("./routes/admin.users")) },
      { path: "admin/budgets", lazy: lazyRoute(() => import("./routes/admin.budgets")) },
      { path: "admin/packages", lazy: lazyRoute(() => import("./routes/admin.packages")) },
      { path: "admin/usage", lazy: lazyRoute(() => import("./routes/admin.usage")) },
      { path: "admin/abuse", lazy: lazyRoute(() => import("./routes/admin.abuse")) },
      { path: "admin/audit", lazy: lazyRoute(() => import("./routes/admin.audit")) },
      {
        path: "marketplace/manage",
        lazy: lazyRoute(() => import("./routes/marketplace.manage")),
      },
      {
        path: "marketplace/:pluginType/:pluginId",
        lazy: lazyRoute(
          () => import("./routes/marketplace.$pluginType.$pluginId"),
        ),
      },
      {
        path: "marketplace",
        lazy: lazyRoute(() => import("./routes/marketplace")),
      },
      {
        path: "editor-standalone",
        lazy: lazyRoute(() => import("./routes/editor-standalone")),
      },
      { path: "auth/cli", lazy: lazyRoute(() => import("./routes/auth.cli")) },
      {
        path: "__codex-copilot-preview",
        lazy: lazyRoute(() => import("./routes/__codex-copilot-preview")),
      },
      ...devOnlyRoutes,
      { path: "terms", lazy: lazyRoute(() => import("./routes/terms")) },
      { path: "privacy", lazy: lazyRoute(() => import("./routes/privacy")) },
    ],
  },
]);
