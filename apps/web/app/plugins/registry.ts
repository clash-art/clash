// Console plugin registry — extension point for hosted-only UI.
//
// Self-host (OSS-only) installs see this file's default empty array and
// render zero extra routes / nav items. Hosted deployments overlay-replace
// this file at build time (clash-hosted's apply-console-overlay step) with
// one that imports + registers plugins from `console-plugins/*`.
//
// Today's hosted plugins:
//   - Billing (Polar checkout / wallet / offers / ledger)
//
// The plugin shape mirrors openma's apps/console/src/plugins/registry.ts so
// the same overlay pattern works. Types are duplicated here instead of
// imported from the layout so plugin code never has to peek at the rest of
// the app. Drift is caught by tsc at the consumer call sites (router.tsx +
// consolePlugins configure).
//
// Routes: mounted under AppLayout so plugin pages share chrome. Path is
// relative (no leading slash), matching createBrowserRouter children.

import type { ReactNode, ComponentType } from "react";

export interface PluginNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}

export interface PluginNavGroup {
  label: string;
  items: PluginNavItem[];
}

export interface PluginRoute {
  /** Path under AppLayout. Relative, no leading slash. */
  path: string;
  /** React element to render for this route. */
  element: ReactNode;
}

export interface ConsolePlugin {
  /** Stable id — used for feature detection (e.g. billing chrome, 402 top-up). */
  id: string;
  /** Routes this plugin contributes. Mounted under AppLayout. */
  routes?: PluginRoute[];
  /** Nav groups surfaced to account chrome (UserControls) via configureConsolePlugins. */
  navGroups?: PluginNavGroup[];
}

/** OSS default: empty. Hosted overlay replaces this array with [billingPlugin]. */
export const consolePlugins: ConsolePlugin[] = [];
