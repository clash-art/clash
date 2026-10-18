/**
 * Stable outcomes of a Provider OAuth flow that an adapter cannot finish.
 *
 * The server stores the code on the authorization row and puts it on the settings redirect; the
 * settings screen shows the message for it. A code -- not a sentence -- crosses the boundary, so
 * the UI never parses server prose and never shows a vendor's raw reply.
 */
export const PROVIDER_OAUTH_ERROR_MESSAGES = {
  PROVIDER_OAUTH_NOT_CONFIGURED:
    "This provider's sign-in is not configured correctly on this server. Ask the operator to check its OAuth client.",
  PROVIDER_OAUTH_UNSUPPORTED:
    "This server offers no OAuth sign-in for that provider.",
  PROVIDER_OAUTH_UNAUTHENTICATED:
    "Your Clash session ended before the provider sent you back. Sign in and connect the provider again.",
  PROVIDER_OAUTH_STATE_INVALID:
    "This sign-in response did not match an authorization started from your account, or it was already used. Start the connection again.",
  PROVIDER_OAUTH_STATE_EXPIRED:
    "The authorization took longer than 10 minutes and expired. Start the connection again.",
  PROVIDER_OAUTH_DENIED:
    "Access was not granted at the provider. Start the connection again and approve access.",
  PROVIDER_OAUTH_VENDOR_ERROR:
    "The provider could not complete the authorization. Start the connection again.",
  PROVIDER_OAUTH_EXCHANGE_FAILED:
    "The provider did not issue a token for this authorization. Start the connection again.",
  PROVIDER_OAUTH_WEB_CALLBACK:
    "This authorization finishes when the provider redirects back to Clash; there is nothing to complete by hand.",
  PROVIDER_OAUTH_REQUIRES_DESKTOP:
    "This sign-in needs the Clash desktop app on your computer.",
} as const;

export type ProviderOAuthErrorCode = keyof typeof PROVIDER_OAUTH_ERROR_MESSAGES;

export function isProviderOAuthErrorCode(value: unknown): value is ProviderOAuthErrorCode {
  return typeof value === "string" && Object.hasOwn(PROVIDER_OAUTH_ERROR_MESSAGES, value);
}

/** Where a web redirect flow lands the browser when it finishes, successfully or not. */
export const PROVIDER_OAUTH_RETURN_PARAMS = {
  provider: "providerOAuth",
  status: "status",
  code: "code",
} as const;

export type ProviderOAuthReturnStatus = "authorized" | "error";
