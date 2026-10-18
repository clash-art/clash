import { PROVIDER_OAUTH_ERROR_MESSAGES } from "@clash/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindProviderAuthorization,
  createDesktopProviderAuthorization,
  createWebProviderAuthorization,
  providerAuthorization,
  providerOAuthReturnMessage,
  readProviderOAuthReturn,
  withoutProviderOAuthReturn,
} from "./provider-authorization";
import type { ProviderOAuthInfo } from "./clientActions";

const schemeRow: ProviderOAuthInfo = {
  providerId: "hilo-hub",
  status: "pending",
  flow: "browser",
  callbackType: "scheme",
  callbackScheme: "minimax-hub",
  verificationUri: "https://hub.minimax.io/login",
  hasAccessToken: false,
};

const webRow: ProviderOAuthInfo = {
  providerId: "acme",
  status: "pending",
  flow: "browser",
  callbackType: "web",
  verificationUri: "https://auth.acme.test/authorize?state=s",
  hasAccessToken: false,
};

afterEach(() => bindProviderAuthorization(undefined));

describe("ProviderAuthorizationPort", () => {
  it("fails explicitly when no composition root bound an implementation", async () => {
    await expect(providerAuthorization().authorize(webRow)).rejects.toThrow(
      /not available in this runtime/,
    );
  });

  it("returns whichever implementation the composition root bound", async () => {
    const assign = vi.fn();
    const port = createWebProviderAuthorization({ assign });
    bindProviderAuthorization(port);
    expect(providerAuthorization()).toBe(port);
  });

  describe("desktop", () => {
    it("passes the authorization URL and callback scheme to the shell and returns its answer", async () => {
      const authorizeProvider = vi.fn(async () => ({
        cancelled: false,
        callbackUrl: "minimax-hub://auth-callback?accessToken=t",
      }));
      const result = await createDesktopProviderAuthorization(authorizeProvider).authorize(schemeRow);
      expect(authorizeProvider).toHaveBeenCalledWith({
        verificationUri: "https://hub.minimax.io/login",
        callbackScheme: "minimax-hub",
      });
      expect(result).toEqual({ cancelled: false, callbackUrl: "minimax-hub://auth-callback?accessToken=t" });
    });

    it("refuses a row without a callback scheme instead of opening a window that cannot return", async () => {
      const authorizeProvider = vi.fn();
      await expect(
        createDesktopProviderAuthorization(authorizeProvider).authorize({ ...schemeRow, callbackScheme: undefined }),
      ).rejects.toThrow(/callback scheme/);
      expect(authorizeProvider).not.toHaveBeenCalled();
    });
  });

  describe("web", () => {
    it("navigates to the provider for a web callback and reports a redirect", async () => {
      const assign = vi.fn();
      const result = await createWebProviderAuthorization({ assign }).authorize(webRow);
      expect(assign).toHaveBeenCalledWith("https://auth.acme.test/authorize?state=s");
      expect(result).toEqual({ redirected: true });
    });

    it("refuses a flow whose callback needs the desktop shell", async () => {
      const assign = vi.fn();
      await expect(createWebProviderAuthorization({ assign }).authorize(schemeRow)).rejects.toThrow(
        /requires the Clash desktop runtime/,
      );
      expect(assign).not.toHaveBeenCalled();
    });

    it("refuses a web row without an authorization URL", async () => {
      const assign = vi.fn();
      await expect(
        createWebProviderAuthorization({ assign }).authorize({ ...webRow, verificationUri: undefined }),
      ).rejects.toThrow(/authorization URL/);
      expect(assign).not.toHaveBeenCalled();
    });
  });
});

describe("settings return", () => {
  it("reads a successful return", () => {
    expect(readProviderOAuthReturn(new URLSearchParams("section=providers&providerOAuth=acme&status=authorized")))
      .toEqual({ providerId: "acme", status: "authorized" });
  });

  it("reads an error return with its code and shows that code's message", () => {
    const result = readProviderOAuthReturn(
      new URLSearchParams("providerOAuth=acme&status=error&code=PROVIDER_OAUTH_STATE_EXPIRED"),
    );
    expect(result).toEqual({ providerId: "acme", status: "error", code: "PROVIDER_OAUTH_STATE_EXPIRED" });
    expect(providerOAuthReturnMessage(result as Extract<typeof result, { status: "error" }>))
      .toBe(PROVIDER_OAUTH_ERROR_MESSAGES.PROVIDER_OAUTH_STATE_EXPIRED);
  });

  it("reads an error return that names no provider, such as a lost session", () => {
    expect(readProviderOAuthReturn(new URLSearchParams("status=error&code=PROVIDER_OAUTH_UNAUTHENTICATED")))
      .toEqual({ status: "error", code: "PROVIDER_OAUTH_UNAUTHENTICATED" });
  });

  it("still reports an error whose code it does not know", () => {
    const result = readProviderOAuthReturn(new URLSearchParams("providerOAuth=acme&status=error&code=NOPE"));
    expect(result).toEqual({ providerId: "acme", status: "error", code: "UNKNOWN" });
    expect(providerOAuthReturnMessage(result as Extract<typeof result, { status: "error" }>))
      .toMatch(/did not finish/);
  });

  it("ignores an address that is not a provider return", () => {
    expect(readProviderOAuthReturn(new URLSearchParams("section=providers"))).toBeNull();
    expect(readProviderOAuthReturn(new URLSearchParams("status=authorized"))).toBeNull();
  });

  it("drops only the return keys", () => {
    const next = withoutProviderOAuthReturn(
      new URLSearchParams("section=providers&project=p1&providerOAuth=acme&status=error&code=PROVIDER_OAUTH_DENIED"),
    );
    expect(next.toString()).toBe("section=providers&project=p1");
  });
});
