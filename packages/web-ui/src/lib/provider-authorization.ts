import {
  PROVIDER_OAUTH_ERROR_MESSAGES,
  PROVIDER_OAUTH_RETURN_PARAMS,
  isProviderOAuthErrorCode,
  type ProviderOAuthErrorCode,
} from "@clash/shared-types";

import type { ProviderOAuthInfo } from "./clientActions";

/**
 * How the settings screen sends the user to a provider to grant access.
 *
 * The screen does not know whether it runs in the desktop shell or a hosted browser; the
 * composition root binds the implementation. Desktop opens its own window and hands back the
 * callback URL; the hosted web navigates away and the server finishes the flow by redirect.
 */
export interface ProviderAuthorizationResult {
  cancelled?: boolean;
  /** Desktop scheme flows: the URL the provider called back with, for `/complete`. */
  callbackUrl?: string;
  /** Web flows: the page is navigating to the provider; nothing more happens here. */
  redirected?: boolean;
}

export interface ProviderAuthorizationPort {
  authorize(row: ProviderOAuthInfo): Promise<ProviderAuthorizationResult>;
}

export type DesktopAuthorizeProvider = (request: {
  verificationUri: string;
  callbackScheme: string;
}) => Promise<{ cancelled: boolean; callbackUrl?: string }>;

/** Desktop: the shell's own authorization window, unchanged. */
export function createDesktopProviderAuthorization(
  authorizeProvider: DesktopAuthorizeProvider,
): ProviderAuthorizationPort {
  return {
    async authorize(row) {
      if (!row.verificationUri || !row.callbackScheme) {
        throw new Error(
          "Browser OAuth response is missing its authorization URL or callback scheme.",
        );
      }
      return authorizeProvider({
        verificationUri: row.verificationUri,
        callbackScheme: row.callbackScheme,
      });
    },
  };
}

/** Hosted web: leave for the provider; its redirect lands back on the settings page. */
export function createWebProviderAuthorization(location: {
  assign(url: string): void;
}): ProviderAuthorizationPort {
  return {
    async authorize(row) {
      if (row.callbackType !== "web") {
        throw new Error(
          "Browser Provider OAuth requires the Clash desktop runtime.",
        );
      }
      if (!row.verificationUri) {
        throw new Error("Browser OAuth response is missing its authorization URL.");
      }
      location.assign(row.verificationUri);
      return { redirected: true };
    },
  };
}

const unbound: ProviderAuthorizationPort = {
  async authorize() {
    throw new Error("Provider authorization is not available in this runtime.");
  },
};

let bound: ProviderAuthorizationPort = unbound;

/**
 * Composition roots only (`apps/web`, which also serves the desktop renderer). Packages are
 * barred from choosing an implementation; they call `providerAuthorization()`.
 */
export function bindProviderAuthorization(
  port: ProviderAuthorizationPort | undefined,
): void {
  bound = port ?? unbound;
}

export function providerAuthorization(): ProviderAuthorizationPort {
  return bound;
}

/** The outcome a web flow's redirect carried back to the settings page. */
export type ProviderOAuthReturn =
  | { providerId?: string; status: "authorized" }
  | { providerId?: string; status: "error"; code: ProviderOAuthErrorCode | "UNKNOWN" };

export function readProviderOAuthReturn(
  params: URLSearchParams,
): ProviderOAuthReturn | null {
  const status = params.get(PROVIDER_OAUTH_RETURN_PARAMS.status);
  const providerParam = params.get(PROVIDER_OAUTH_RETURN_PARAMS.provider);
  const code = params.get(PROVIDER_OAUTH_RETURN_PARAMS.code);
  // `status` alone is too generic a name to claim; a return carries the provider or a code.
  if (!providerParam && !code) return null;
  const providerId = providerParam ? { providerId: providerParam } : {};
  if (status === "authorized") return { ...providerId, status };
  if (status === "error") {
    return {
      ...providerId,
      status,
      code: isProviderOAuthErrorCode(code) ? code : "UNKNOWN",
    };
  }
  return null;
}

/** A copy of `params` without the return keys, for replacing the address once handled. */
export function withoutProviderOAuthReturn(
  params: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Object.values(PROVIDER_OAUTH_RETURN_PARAMS)) next.delete(key);
  return next;
}

/** The message for a failed return, always followed by its code so support can match it. */
export function providerOAuthReturnMessage(
  result: Extract<ProviderOAuthReturn, { status: "error" }>,
): string {
  const message =
    result.code === "UNKNOWN"
      ? "The provider authorization did not finish. Start the connection again."
      : PROVIDER_OAUTH_ERROR_MESSAGES[result.code];
  return `${message} [${result.code === "UNKNOWN" ? "PROVIDER_OAUTH_UNKNOWN" : result.code}]`;
}
