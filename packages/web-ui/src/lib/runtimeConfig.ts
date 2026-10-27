import {
  apiUrl,
  resolveRuntimeConfig,
  webSocketUrl,
  type TimelineRenderExecutor,
  type RuntimeCapabilities,
  type RuntimeMode,
  type ResolvedRuntimeEndpointConfig,
  type RuntimeEndpointConfig,
} from "@clash/shared-runtime";

/**
 * The runtime view UI code may read: endpoints and declared capabilities.
 * The deployment mode is deliberately absent. UI asks for a capability
 * (`getRuntimeCapabilities()`), never which backend it runs on; the server
 * adapters behind the shared contracts own every difference.
 */
export type UiRuntimeConfig = Omit<ResolvedRuntimeEndpointConfig, "mode">;

declare global {
  var __CLASH_RUNTIME_CONFIG__: RuntimeEndpointConfig | undefined;
}

interface LocationLike {
  protocol: string;
  host: string;
}

interface DesktopRuntimeBridge {
  isDesktop?: boolean;
  refreshRuntime?: () => Promise<RuntimeEndpointConfig>;
}

let runtimeOverride: RuntimeEndpointConfig | undefined;
let runtimeRefresh: Promise<UiRuntimeConfig> | undefined;

function browserLocation(): LocationLike | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location;
}

function wsBaseFromLocation(location: LocationLike | undefined): string {
  if (!location) return "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

function resolvedRuntimeConfig(): ResolvedRuntimeEndpointConfig {
  return resolveRuntimeConfig(
    runtimeOverride ?? globalThis.__CLASH_RUNTIME_CONFIG__ ?? {},
  );
}

export function getRuntimeConfig(): UiRuntimeConfig {
  const { mode: _mode, ...config } = resolvedRuntimeConfig();
  return config;
}

/**
 * Composition roots only (`apps/web`, `apps/desktop`): the one place that may
 * know the deployment. Packages under `packages/` are barred from calling it
 * by `.eslintrc.boundaries.json` (`pnpm run lint:boundaries`).
 */
export function readRuntimeModeAtCompositionRoot(): RuntimeMode {
  return resolvedRuntimeConfig().mode;
}

export function setRuntimeConfigOverride(
  config: RuntimeEndpointConfig | undefined,
): void {
  runtimeOverride = config;
}

function desktopRuntimeBridge(): DesktopRuntimeBridge | undefined {
  return (
    globalThis as typeof globalThis & {
      __CLASH_DESKTOP__?: DesktopRuntimeBridge;
    }
  ).__CLASH_DESKTOP__;
}

export function isDesktopRuntime(): boolean {
  const desktopBridge = desktopRuntimeBridge();
  return (
    desktopBridge?.isDesktop === true ||
    resolvedRuntimeConfig().mode === "desktop"
  );
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  return resolvedRuntimeConfig().capabilities;
}

let timelineRenderExecutor: TimelineRenderExecutor | undefined;

/**
 * Composition roots only (`apps/web`): bind the deployment's Timeline render
 * adapter behind the Timeline client's `render`. Unbound, the Host renders.
 * Packages are barred from calling it by `.eslintrc.boundaries.json`.
 */
export function bindTimelineRenderExecutor(
  executor: TimelineRenderExecutor | undefined,
): void {
  timelineRenderExecutor = executor;
}

export function boundTimelineRenderExecutor():
  | TimelineRenderExecutor
  | undefined {
  return timelineRenderExecutor;
}


export type TimelineExportNodesResolver = () => Record<string, unknown> | undefined;

let timelineExportNodesResolver: TimelineExportNodesResolver | undefined;

/**
 * Editor surfaces publish the latest Canvas/runtime node map so browser
 * Timeline export can hydrate live HTML MG sources (#448). Composition roots
 * and Canvas preview may call this; packages must not invent a second store.
 */
export function bindTimelineExportNodesResolver(
  resolver: TimelineExportNodesResolver | undefined,
): void {
  timelineExportNodesResolver = resolver;
}

export function resolveTimelineExportNodes(): Record<string, unknown> | undefined {
  try {
    return timelineExportNodesResolver?.() ?? undefined;
  } catch {
    return undefined;
  }
}


export function runtimeApiUrl(path: string): string {
  return apiUrl(path, resolvedRuntimeConfig());
}

export async function refreshRuntimeConfig(): Promise<UiRuntimeConfig> {
  if (runtimeRefresh) return runtimeRefresh;
  const refresh = desktopRuntimeBridge()?.refreshRuntime;
  if (!refresh) return getRuntimeConfig();

  runtimeRefresh = refresh()
    .then((config) => {
      setRuntimeConfigOverride(config);
      return getRuntimeConfig();
    })
    .finally(() => {
      runtimeRefresh = undefined;
    });
  return runtimeRefresh;
}

let unauthorizedListener: (() => void) | undefined;

/**
 * Issue #160: an API 401 means the browser session is gone. The session store
 * registers here so runtimeFetch callers sign the app out without a refetch.
 * The admin console's own identity (#394: /api/admin-auth, /api/v1/admin) is
 * separate, so its 401s never sign the product session out.
 */
export function setApiUnauthorizedListener(
  listener: (() => void) | undefined,
): void {
  unauthorizedListener = listener;
}

function noticeUnauthorized(path: string, response: Response): Response {
  if (
    response.status === 401 &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/better-auth/") &&
    !path.startsWith("/api/admin-auth/") &&
    !path.startsWith("/api/v1/admin/") &&
    getRuntimeCapabilities().auth.mode === "better-auth"
  ) {
    unauthorizedListener?.();
  }
  return response;
}

export async function runtimeFetch(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    return noticeUnauthorized(path, await fetchImpl(runtimeApiUrl(path), init));
  } catch (error) {
    if (!isDesktopRuntime() || !desktopRuntimeBridge()?.refreshRuntime) {
      throw error;
    }
    await refreshRuntimeConfig();
    return noticeUnauthorized(path, await fetchImpl(runtimeApiUrl(path), init));
  }
}

export function runtimeSyncWebSocketUrl(
  projectId: string,
  location: LocationLike | undefined = browserLocation(),
): string {
  return runtimeWebSocketUrl(
    `/sync/${encodeURIComponent(projectId)}`,
    location,
  );
}

export function runtimeWebSocketUrl(
  path: string,
  location: LocationLike | undefined = browserLocation(),
): string {
  const cfg = resolvedRuntimeConfig();
  if (cfg.wsBaseUrl) return webSocketUrl(path, cfg);
  return webSocketUrl(path, {
    ...cfg,
    wsBaseUrl: wsBaseFromLocation(location),
  });
}
