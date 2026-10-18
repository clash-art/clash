/**
 * Operator-registered OAuth Providers for the Cloudflare adapter.
 *
 * The Worker bundles no Provider declarations, and an OAuth client belongs to whoever registered
 * it with the vendor -- here, the operator of this deployment. So the declarations arrive as the
 * optional `PROVIDER_OAUTH_PROVIDERS` secret: a JSON array of `{ id, label?, flow }` whose `flow`
 * is the same `PluginAuthFlowSchema` a plugin declares.
 *
 * Parsed on first use, never at module load: api-cf startup stays free of this work, and a
 * malformed secret fails the flow that needs it with a clear message instead of the whole Worker.
 */
import { PluginAuthFlowSchema, type PluginAuthFlow } from "@clash/shared-types";

export interface HostedOAuthProvider {
  id: string;
  label?: string;
  flow: PluginAuthFlow & { tokenUrl: string; clientId: string };
}

/** The operator's configuration is unusable for this provider. Message is safe to show. */
export class ProviderOAuthConfigError extends Error {
  readonly code = "PROVIDER_OAUTH_NOT_CONFIGURED" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProviderOAuthConfigError";
  }
}

let cache: { raw: string; entries: Record<string, unknown>[] } | undefined;

function parsedEntries(raw: string): Record<string, unknown>[] {
  if (cache?.raw === raw) return cache.entries;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProviderOAuthConfigError("PROVIDER_OAUTH_PROVIDERS is not valid JSON.");
  }
  if (!Array.isArray(value)) {
    throw new ProviderOAuthConfigError("PROVIDER_OAUTH_PROVIDERS must be a JSON array.");
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ProviderOAuthConfigError(`PROVIDER_OAUTH_PROVIDERS[${index}] must be an object.`);
    }
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) {
      throw new ProviderOAuthConfigError(`PROVIDER_OAUTH_PROVIDERS[${index}] needs a string id.`);
    }
    // Two entries for one id would make which client signs the user in an accident of ordering.
    if (seen.has(id)) {
      throw new ProviderOAuthConfigError(`PROVIDER_OAUTH_PROVIDERS declares ${id} twice.`);
    }
    seen.add(id);
  }
  cache = { raw, entries: value as Record<string, unknown>[] };
  return cache.entries;
}

/**
 * The hosted declaration for `providerId`, or `null` when this deployment offers none.
 *
 * Throws `ProviderOAuthConfigError` for an entry that exists but cannot run: starting a flow the
 * vendor will reject with `invalid_client` after the user consented is worse than refusing now.
 */
export function hostedOAuthProvider(
  raw: string | undefined,
  providerId: string,
): HostedOAuthProvider | null {
  if (!raw?.trim()) return null;
  const entry = parsedEntries(raw).find((candidate) => candidate.id === providerId);
  if (!entry) return null;

  const label = entry.label;
  if (label !== undefined && (typeof label !== "string" || !label.trim())) {
    throw new ProviderOAuthConfigError(`${providerId}: label must be a non-empty string.`);
  }
  const parsed = PluginAuthFlowSchema.safeParse(entry.flow);
  if (!parsed.success) {
    // Issue paths and messages only: a received value could be the client secret.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length ? `flow.${issue.path.join(".")}` : "flow"}: ${issue.message}`)
      .join("; ");
    throw new ProviderOAuthConfigError(`${providerId}: ${issues}`);
  }
  const flow = parsed.data;
  if (!flow.tokenUrl || !flow.clientId) {
    throw new ProviderOAuthConfigError(
      `${providerId}: a hosted flow must declare tokenUrl and clientId.`,
    );
  }
  // The hosted adapter always answers on its own web redirect, so loopback and scheme declarations
  // describe the same authorization-code grant. Device code is a different grant it does not run.
  if (flow.callback.type === "poll-until") {
    throw new ProviderOAuthConfigError(
      `${providerId}: the hosted adapter completes flows by web redirect; poll-until (device code) is not supported.`,
    );
  }
  return {
    id: providerId,
    ...(typeof label === "string" ? { label: label.trim() } : {}),
    flow: { ...flow, tokenUrl: flow.tokenUrl, clientId: flow.clientId },
  };
}
