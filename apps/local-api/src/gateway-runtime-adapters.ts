/**
 * Per-runtime Host adapters that point Codex / Pi / dsh-acp at the Clash
 * official gateway when the harness has no ACP `_meta.gateway` auth method
 * (#358). Spike: `docs/spikes/gateway-runtime-adapters-358.md`.
 *
 * Claude keeps the #357 ACP handoff. These adapters never open the user's
 * `~/.codex` or `~/.pi/agent`; they only write under `{dataDir}/official-gateway/`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OFFICIAL_GATEWAY_ACP_PROVIDER_NAME } from "@clash/shared-types";

/** Synthetic ACP method ids recorded on official-gateway handoffs. */
export const GATEWAY_ADAPTER_METHOD = {
  codex: "adapter:codex-config",
  pi: "adapter:pi-config",
  dsh: "adapter:dsh-env",
} as const;

export type GatewayAdapterMethodId =
  (typeof GATEWAY_ADAPTER_METHOD)[keyof typeof GATEWAY_ADAPTER_METHOD];

export type GatewayRuntimeAdapterKind = "config" | "env";

export interface GatewayRuntimeAdapter {
  harnessId: string;
  kind: GatewayRuntimeAdapterKind;
  methodId: GatewayAdapterMethodId;
}

/** The only DeepSeek model dsh may advertise or default to under official handoff. */
export const DSH_FLASH_MODEL_ID = "deepseek-flash";

const BLOCKED_DEEPSEEK = /pro|reasoner/i;

export function isBlockedDeepSeekModel(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  if (!/deepseek/i.test(id)) return false;
  if (/flash/i.test(id)) return false;
  return BLOCKED_DEEPSEEK.test(id);
}

/** Flash-only allowlist for `DSH_ACP_MODELS` / model pickers. */
export function dshFlashModelAllowlist(
  models: readonly string[] | undefined = undefined,
): string[] {
  const source =
    models && models.length > 0 ? models : [DSH_FLASH_MODEL_ID];
  const allowed = [
    ...new Set(
      source
        .map((model) => model.trim())
        .filter((model) => model.length > 0 && !isBlockedDeepSeekModel(model)),
    ),
  ];
  if (allowed.length === 0) return [DSH_FLASH_MODEL_ID];
  if (!allowed.includes(DSH_FLASH_MODEL_ID)) allowed.unshift(DSH_FLASH_MODEL_ID);
  return allowed;
}

const ADAPTERS: Record<string, GatewayRuntimeAdapter> = {
  "codex-acp": {
    harnessId: "codex-acp",
    kind: "config",
    methodId: GATEWAY_ADAPTER_METHOD.codex,
  },
  "pi-acp": {
    harnessId: "pi-acp",
    kind: "config",
    methodId: GATEWAY_ADAPTER_METHOD.pi,
  },
  "dsh-acp": {
    harnessId: "dsh-acp",
    kind: "env",
    methodId: GATEWAY_ADAPTER_METHOD.dsh,
  },
};

export function resolveGatewayRuntimeAdapter(
  harnessId: string,
): GatewayRuntimeAdapter | null {
  return ADAPTERS[harnessId] ?? null;
}

export function isGatewayAdapterMethodId(
  methodId: string | undefined,
): methodId is GatewayAdapterMethodId {
  return (
    methodId === GATEWAY_ADAPTER_METHOD.codex ||
    methodId === GATEWAY_ADAPTER_METHOD.pi ||
    methodId === GATEWAY_ADAPTER_METHOD.dsh
  );
}

export interface GatewayRuntimeApplyInput {
  harnessId: string;
  /** Gateway surface ending in `/gateway` (mint body `baseUrl`); `/v1` is appended. */
  baseUrl: string;
  apiKey: string;
  dataDir: string;
}

export interface GatewayRuntimeApplyResult {
  methodId: GatewayAdapterMethodId;
  kind: GatewayRuntimeAdapterKind;
  /** Session spawn overlay; carries the short-lived token where the adapter uses env. */
  spawnEnv: Record<string, string>;
}

function gatewayV1Base(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function officialGatewayRoot(dataDir: string): string {
  return join(dataDir, "official-gateway");
}

export function codexAdapterHome(dataDir: string): string {
  return join(officialGatewayRoot(dataDir), "codex-home");
}

export function piAdapterAgentDir(dataDir: string): string {
  return join(officialGatewayRoot(dataDir), "pi-agent");
}

/** Codex `config.toml` body: provider only — secret stays in `OPENAI_API_KEY`. */
export function buildCodexGatewayConfigToml(baseUrlV1: string): string {
  return [
    `# Clash official gateway adapter (#358).`,
    `# Owned by the Host under CODEX_HOME; do not copy into ~/.codex.`,
    `model_provider = "clash"`,
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    `[model_providers.clash]`,
    `name = "Clash official"`,
    `base_url = ${JSON.stringify(baseUrlV1)}`,
    `env_key = "OPENAI_API_KEY"`,
    `wire_api = "chat"`,
    "supports_websockets = false",
    "",
  ].join("\n");
}

/** Pi `models.json` provider patch — same shape as pi-acp `gatewayAuthenticate`. */
export function buildPiGatewayModelsJson(input: {
  baseUrlV1: string;
  apiKey: string;
  providerId?: string;
  providerName?: string;
}): string {
  const providerId = input.providerId ?? OFFICIAL_GATEWAY_ACP_PROVIDER_NAME;
  const doc = {
    providers: {
      [providerId]: {
        name: input.providerName ?? "Clash official",
        baseUrl: input.baseUrlV1,
        api: "openai-completions",
        apiKey: input.apiKey,
      },
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function applyCodex(
  input: GatewayRuntimeApplyInput,
): Promise<GatewayRuntimeApplyResult> {
  const home = codexAdapterHome(input.dataDir);
  await mkdir(home, { recursive: true });
  const baseUrlV1 = gatewayV1Base(input.baseUrl);
  await writeFile(
    join(home, "config.toml"),
    buildCodexGatewayConfigToml(baseUrlV1),
    "utf8",
  );
  return {
    methodId: GATEWAY_ADAPTER_METHOD.codex,
    kind: "config",
    spawnEnv: {
      CODEX_HOME: home,
      OPENAI_API_KEY: input.apiKey,
    },
  };
}

async function applyPi(
  input: GatewayRuntimeApplyInput,
): Promise<GatewayRuntimeApplyResult> {
  const agentDir = piAdapterAgentDir(input.dataDir);
  await mkdir(agentDir, { recursive: true });
  const baseUrlV1 = gatewayV1Base(input.baseUrl);
  await writeFile(
    join(agentDir, "models.json"),
    buildPiGatewayModelsJson({
      baseUrlV1,
      apiKey: input.apiKey,
      providerId: OFFICIAL_GATEWAY_ACP_PROVIDER_NAME,
      providerName: "Clash official",
    }),
    "utf8",
  );
  return {
    methodId: GATEWAY_ADAPTER_METHOD.pi,
    kind: "config",
    spawnEnv: {
      PI_CODING_AGENT_DIR: agentDir,
    },
  };
}

function applyDsh(
  input: GatewayRuntimeApplyInput,
): GatewayRuntimeApplyResult {
  const baseUrlV1 = gatewayV1Base(input.baseUrl);
  const models = dshFlashModelAllowlist().join(",");
  return {
    methodId: GATEWAY_ADAPTER_METHOD.dsh,
    kind: "env",
    spawnEnv: {
      DEEPSEEK_API_KEY: input.apiKey,
      DEEPSEEK_BASE_URL: baseUrlV1,
      DSH_ACP_MODELS: models,
      DSH_MODEL: DSH_FLASH_MODEL_ID,
    },
  };
}

export async function applyGatewayRuntimeAdapter(
  input: GatewayRuntimeApplyInput,
): Promise<GatewayRuntimeApplyResult> {
  const adapter = resolveGatewayRuntimeAdapter(input.harnessId);
  if (!adapter)
    throw new Error(
      `No gateway runtime adapter for harness: ${input.harnessId}`,
    );
  switch (adapter.harnessId) {
    case "codex-acp":
      return applyCodex(input);
    case "pi-acp":
      return applyPi(input);
    case "dsh-acp":
      return applyDsh(input);
    default:
      throw new Error(
        `No gateway runtime adapter for harness: ${input.harnessId}`,
      );
  }
}

/** Remove Pi fallback apiKey material from the Clash-owned models.json. */
export async function scrubPiAdapterCredentials(
  dataDir: string,
): Promise<void> {
  const path = join(piAdapterAgentDir(dataDir), "models.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return;
  const providers = (doc as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers))
    return;
  let changed = false;
  const nextProviders: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(
    providers as Record<string, unknown>,
  )) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      nextProviders[id] = value;
      continue;
    }
    const entry = { ...(value as Record<string, unknown>) };
    if ("apiKey" in entry) {
      delete entry.apiKey;
      changed = true;
    }
    const headers = entry.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      const kept: Record<string, unknown> = {};
      for (const [name, headerValue] of Object.entries(
        headers as Record<string, unknown>,
      )) {
        const lower = name.toLowerCase();
        if (lower === "authorization" || lower === "x-api-key") {
          changed = true;
          continue;
        }
        kept[name] = headerValue;
      }
      if (Object.keys(kept).length === 0) delete entry.headers;
      else entry.headers = kept;
    }
    nextProviders[id] = entry;
  }
  if (!changed) return;
  await writeFile(
    path,
    `${JSON.stringify({ ...(doc as object), providers: nextProviders }, null, 2)}\n`,
    "utf8",
  );
}
