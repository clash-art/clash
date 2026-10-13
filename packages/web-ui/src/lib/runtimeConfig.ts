import {
  apiUrl,
  resolveRuntimeConfig,
  webSocketUrl,
  type RuntimeCapabilities,
  type ResolvedRuntimeEndpointConfig,
  type RuntimeEndpointConfig,
} from "@clash/shared-runtime";

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
let runtimeRefresh: Promise<ResolvedRuntimeEndpointConfig> | undefined;

function browserLocation(): LocationLike | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location;
}

function wsBaseFromLocation(location: LocationLike | undefined): string {
  if (!location) return "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}`;
}

export function getRuntimeConfig(): ResolvedRuntimeEndpointConfig {
  return resolveRuntimeConfig(
    runtimeOverride ?? globalThis.__CLASH_RUNTIME_CONFIG__ ?? {},
  );
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
    desktopBridge?.isDesktop === true || getRuntimeConfig().mode === "desktop"
  );
}

/**
 * Whether this surface is backed by a local Project Host. Hosted Web has no
 * Host behind its origin, so Host-only contracts (Asset projections, plugin
 * catalogs, Host commands, local audio) answer 404 there and must not be
 * probed or polled.
 */
export function hasLocalHostRuntime(): boolean {
  return getRuntimeConfig().mode !== "hosted";
}

export function getRuntimeCapabilities(): RuntimeCapabilities {
  return getRuntimeConfig().capabilities;
}

export function runtimeApiUrl(path: string): string {
  return apiUrl(path, getRuntimeConfig());
}

export async function refreshRuntimeConfig(): Promise<ResolvedRuntimeEndpointConfig> {
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

export async function runtimeFetch(
  path: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  try {
    return await fetchImpl(runtimeApiUrl(path), init);
  } catch (error) {
    if (!isDesktopRuntime() || !desktopRuntimeBridge()?.refreshRuntime) {
      throw error;
    }
    await refreshRuntimeConfig();
    return fetchImpl(runtimeApiUrl(path), init);
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
  const cfg = getRuntimeConfig();
  if (cfg.wsBaseUrl) return webSocketUrl(path, cfg);
  return webSocketUrl(path, {
    ...cfg,
    wsBaseUrl: wsBaseFromLocation(location),
  });
}
