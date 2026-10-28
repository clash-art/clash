/**
 * Runtime bridge from apps/web's console plugin registry into shared UI.
 *
 * apps/web calls `configureConsolePlugins(consolePlugins)` at module load
 * (router.tsx). OSS ships an empty registry → no billing nav / 402 top-up.
 * Hosted overlays the registry before build so billing appears.
 *
 * web-ui must not import apps/web; this module is the only seam.
 */

export interface ConsolePluginNavItem {
  to: string;
  label: string;
  /** Optional icon component name hint for tests; UI may ignore. */
  end?: boolean;
}

export interface ConsolePluginNavGroup {
  label: string;
  items: ConsolePluginNavItem[];
}

export interface ConsolePluginDescriptor {
  id: string;
  navGroups?: ConsolePluginNavGroup[];
}

let plugins: ConsolePluginDescriptor[] = [];

/** Called once from apps/web with the (possibly overlaid) registry. */
export function configureConsolePlugins(
  next: readonly ConsolePluginDescriptor[],
): void {
  plugins = next.map((plugin) => ({
    id: plugin.id,
    navGroups: plugin.navGroups?.map((group) => ({
      label: group.label,
      items: group.items.map((item) => ({
        to: item.to,
        label: item.label,
        end: item.end,
      })),
    })),
  }));
}

/** Test helper: reset to the OSS empty default. */
export function resetConsolePlugins(): void {
  plugins = [];
}

export function listConsolePlugins(): readonly ConsolePluginDescriptor[] {
  return plugins;
}

export function hasConsolePlugin(id: string): boolean {
  return plugins.some((plugin) => plugin.id === id);
}

/** True when the hosted billing plugin is registered. */
export function isBillingPluginEnabled(): boolean {
  return hasConsolePlugin("billing");
}

/** Flattened nav items from every plugin (Account → Billing, etc.). */
export function consolePluginNavItems(): ConsolePluginNavItem[] {
  return plugins.flatMap((plugin) =>
    (plugin.navGroups ?? []).flatMap((group) => group.items),
  );
}
