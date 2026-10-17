export type RuntimeMode = "hosted" | "local" | "desktop";

export interface RuntimeCapabilities {
  assets: {
    storage: "cloud" | "local";
    signing: "signed" | "unsigned";
    /** Where `import-file` lands: the local Host, the cloud adapter, or nowhere. */
    upload: "local" | "cloud" | "disabled";
  };
  workflows: {
    runner: "cloudflare" | "local-node" | "disabled";
    mediaPostprocess: "cloud" | "local-node" | "disabled";
  };
  loro: {
    persistence: "remote" | "local" | "hybrid";
    sync: "durable-object" | "local-websocket";
  };
  auth: {
    mode: "better-auth" | "local-user";
  };
  /**
   * Project Host capabilities whose availability differs between server
   * adapters. UI code reads these instead of branching on the runtime mode;
   * every adapter answers an unavailable one with 501, never 404.
   */
  host: {
    /** Timeline export through a render executor (`request_timeline_render`). */
    timelineRender: "available" | "unavailable";
    /** Text node revision history (`/projects/:id/text-revisions`). */
    textRevisions: "available" | "unavailable";
    /** Voice input backed by the local Host audio runtime. */
    localAudio: "available" | "unavailable";
  };
}

export type RuntimeCapabilityOverrides = {
  [K in keyof RuntimeCapabilities]?: Partial<RuntimeCapabilities[K]>;
};

export interface RuntimeEndpointConfig {
  /**
   * Runtime deployment mode. Hosted means same-origin Cloudflare backend;
   * local means a standalone local Node backend; desktop means Electron-hosted
   * local backend plus bundled/web-served UI.
   */
  mode?: RuntimeMode;
  /** HTTP origin for the backend. Empty means same-origin relative URLs. */
  apiBaseUrl?: string;
  /** WebSocket origin. When omitted, it is derived from apiBaseUrl. */
  wsBaseUrl?: string;
  /** Optional capability overrides for hybrid runtime configurations. */
  capabilities?: RuntimeCapabilityOverrides;
}

export interface ResolvedRuntimeEndpointConfig {
  mode: RuntimeMode;
  apiBaseUrl: string;
  wsBaseUrl: string;
  capabilities: RuntimeCapabilities;
}

export const desktopChromeMetrics = {
  tabStripHeight: 40,
  nativeWindowButtonFrameSize: 20,
  trafficLightInsetX: 12,
  trafficLightOpticalOffsetY: 2,
  toolbarLeftInset: 92,
} as const;

export const desktopTrafficLightPosition = {
  x: desktopChromeMetrics.trafficLightInsetX,
  y:
    Math.round(
      (desktopChromeMetrics.tabStripHeight -
        desktopChromeMetrics.nativeWindowButtonFrameSize) /
        2,
    ) + desktopChromeMetrics.trafficLightOpticalOffsetY,
} as const;

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function withLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isAbsoluteResource(value: string): boolean {
  return /^(https?:|wss?:|blob:|data:|file:)/.test(value);
}

function deriveWsBaseUrl(apiBaseUrl: string): string {
  if (!apiBaseUrl) return "";
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

export function defaultRuntimeCapabilities(
  mode: RuntimeMode,
): RuntimeCapabilities {
  if (mode === "hosted") {
    return {
      assets: { storage: "cloud", signing: "signed", upload: "cloud" },
      workflows: { runner: "cloudflare", mediaPostprocess: "cloud" },
      loro: { persistence: "remote", sync: "durable-object" },
      auth: { mode: "better-auth" },
      host: {
        timelineRender: "unavailable",
        textRevisions: "unavailable",
        localAudio: "unavailable",
      },
    };
  }

  return {
    assets: { storage: "local", signing: "unsigned", upload: "local" },
    workflows: { runner: "local-node", mediaPostprocess: "disabled" },
    loro: { persistence: "local", sync: "local-websocket" },
    auth: { mode: "local-user" },
    host: {
      timelineRender: "available",
      textRevisions: "available",
      localAudio: "available",
    },
  };
}

function mergeRuntimeCapabilities(
  base: RuntimeCapabilities,
  overrides: RuntimeCapabilityOverrides | undefined,
): RuntimeCapabilities {
  if (!overrides) return base;
  return {
    assets: { ...base.assets, ...overrides.assets },
    workflows: { ...base.workflows, ...overrides.workflows },
    loro: { ...base.loro, ...overrides.loro },
    auth: { ...base.auth, ...overrides.auth },
    host: { ...base.host, ...overrides.host },
  };
}

export function resolveRuntimeConfig(
  input: RuntimeEndpointConfig = {},
): ResolvedRuntimeEndpointConfig {
  const mode = input.mode ?? "hosted";
  const apiBaseUrl = input.apiBaseUrl
    ? trimTrailingSlash(input.apiBaseUrl)
    : "";
  const wsBaseUrl = input.wsBaseUrl
    ? trimTrailingSlash(input.wsBaseUrl)
    : deriveWsBaseUrl(apiBaseUrl);
  const capabilities = mergeRuntimeCapabilities(
    defaultRuntimeCapabilities(mode),
    input.capabilities,
  );
  return { mode, apiBaseUrl, wsBaseUrl, capabilities };
}

export function apiUrl(
  path: string,
  config: ResolvedRuntimeEndpointConfig | RuntimeEndpointConfig = {},
): string {
  if (isAbsoluteResource(path)) return path;
  const cfg =
    "apiBaseUrl" in config && "wsBaseUrl" in config
      ? (config as ResolvedRuntimeEndpointConfig)
      : resolveRuntimeConfig(config);
  const normalizedPath = withLeadingSlash(path);
  return cfg.apiBaseUrl ? `${cfg.apiBaseUrl}${normalizedPath}` : normalizedPath;
}

export function syncWebSocketUrl(
  projectId: string,
  config: ResolvedRuntimeEndpointConfig | RuntimeEndpointConfig = {},
): string {
  return webSocketUrl(`/sync/${encodeURIComponent(projectId)}`, config);
}

export function webSocketUrl(
  path: string,
  config: ResolvedRuntimeEndpointConfig | RuntimeEndpointConfig = {},
): string {
  const cfg =
    "apiBaseUrl" in config && "wsBaseUrl" in config
      ? (config as ResolvedRuntimeEndpointConfig)
      : resolveRuntimeConfig(config);
  if (isAbsoluteResource(path)) return path;
  const normalizedPath = withLeadingSlash(path);
  return cfg.wsBaseUrl ? `${cfg.wsBaseUrl}${normalizedPath}` : normalizedPath;
}
