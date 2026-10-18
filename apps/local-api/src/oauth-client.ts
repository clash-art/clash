import type { PluginAuthFlow } from "@clash/shared-types";

import { exchangeAuthorizationCode } from "@clash/shared-runtime/provider-oauth-flow";

/**
 * The OAuth client belongs to the host, and the plugin never sees it.
 *
 * A client id is the *application's* identity with a vendor. Google issued Clash's, not a plugin's.
 * A plugin holding the client secret could mint its own authorization requests against Clash's
 * registration, and every token it obtained would look to the vendor like Clash asking.
 *
 * So the host runs the whole exchange and writes only the resulting token into the plugin's store.
 * What a plugin can read is a credential for the account; what it cannot read is the credential that
 * identifies Clash.
 */

export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

export type OAuthClientRegistry = Record<string, OAuthClient>;

export function hostOAuthClient(
  registry: OAuthClientRegistry,
  providerId: string,
): OAuthClient {
  const client = registry[providerId];
  // Better than starting a flow the vendor will reject with `invalid_client` after the user has
  // already picked an account and granted consent.
  if (!client?.clientId) {
    throw new Error(
      `This installation has no OAuth client for ${providerId}. `
      + `Register one with the vendor and configure it before signing in.`,
    );
  }
  return client;
}

export interface CompleteDeclaredFlowInput {
  flow: PluginAuthFlow;
  client: OAuthClient;
  code: string;
  verifier: string;
  redirectUri: string;
  /** Writes into the plugin's own store, bound to this account by the host. */
  put: (key: string, value: string, options?: { secret?: boolean }) => Promise<void>;
  fetch?: typeof globalThis.fetch;
}

export async function completeDeclaredFlow(input: CompleteDeclaredFlowInput): Promise<void> {
  if (!input.flow.tokenUrl) {
    // An authorization code is worth nothing stored. Writing one would leave the account looking
    // configured while every request failed.
    throw new Error("This flow declares no tokenUrl, so its code cannot be exchanged.");
  }

  const token = await exchangeAuthorizationCode({
    tokenUrl: input.flow.tokenUrl,
    clientId: input.client.clientId,
    ...(input.client.clientSecret ? { clientSecret: input.client.clientSecret } : {}),
    code: input.code,
    verifier: input.verifier,
    redirectUri: input.redirectUri,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });

  await input.put("accessToken", token.accessToken, { secret: true });
  if (token.refreshToken) {
    await input.put("refreshToken", token.refreshToken, { secret: true });
  }
  if (token.expiresAt !== undefined) {
    // Absolute and ISO, because the renewal scheduler reads this long after the response that
    // carried `expires_in` is gone.
    await input.put("expiresAt", new Date(token.expiresAt).toISOString());
  }
}
