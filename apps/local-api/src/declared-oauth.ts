import type { PluginAuthDeclaration, PluginAuthFlow } from "@clash/shared-types";

/**
 * The browser flow a Provider declares, if it declares one.
 *
 * This replaces `pluginBrowserOAuth`, which returned `null` unconditionally once the auth-type
 * registry was deleted -- a function wired to nothing, so the start endpoint answered 404 for every
 * plugin Provider regardless of what it declared.
 *
 * What replaces the registry is not a shorter list of vendors. It is reading the flow the Provider
 * already states, and letting the host supply everything that repeats: the loopback port and the
 * timeout live in `auth-flow.ts`; PKCE, `state` and the token exchange in
 * `@clash/shared-runtime/provider-oauth-flow`. What comes from here is the address to open and the
 * vendor's own parameters.
 */

export interface DeclaredAuthProvider {
  id: string;
  name: string;
  auth?: PluginAuthDeclaration;
}

export function declaredBrowserFlow(
  providers: readonly DeclaredAuthProvider[],
  providerId: string,
  /**
   * Which way in. Optional only because the start route does not carry it yet: it names a Provider
   * and nothing else, so when it is omitted this falls back to the single method that declares a
   * flow -- and refuses to guess when there is more than one.
   */
  methodId?: string,
): PluginAuthFlow | undefined {
  // Exact match. `google` and `google-cloud` are two Providers, and starting the wrong one's flow
  // would send the user to authorize an account they did not ask for.
  const provider = providers.find((candidate) => candidate.id === providerId);
  // And the method, because a flow belongs to a method rather than to a Provider. hrhrng.hub
  // declares three ways in and only one of them opens a browser; answering with a sibling's flow
  // would put a browser window in front of a user who chose to paste a token.
  const methods = provider?.auth?.methods ?? [];
  if (methodId) return methods.find((candidate) => candidate.id === methodId)?.flow;

  const withFlow = methods.filter((candidate) => candidate.flow);
  // Two flows and no way to say which is a question, not a default. Picking the first would open
  // whichever the plugin happened to list first.
  return withFlow.length === 1 ? withFlow[0]!.flow : undefined;
}

/** The button that starts it, so the caller can name what the user pressed. */
export function declaredFlowButtonKey(
  providers: readonly DeclaredAuthProvider[],
  providerId: string,
  methodId: string,
): string | undefined {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const method = provider?.auth?.methods.find((candidate) => candidate.id === methodId);
  if (!method?.flow) return undefined;
  const button = (method.form ?? []).find((item) => item.kind === "button");
  return button && "key" in button ? button.key : undefined;
}
