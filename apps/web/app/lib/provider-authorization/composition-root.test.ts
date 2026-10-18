// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bindProviderAuthorization,
  providerAuthorization,
} from "@clash/web-ui/lib/provider-authorization";
import { installProviderAuthorizationCompositionRoot } from "./composition-root";

afterEach(() => {
  delete globalThis.__CLASH_DESKTOP__;
  bindProviderAuthorization(undefined);
  vi.restoreAllMocks();
});

describe("provider authorization composition root", () => {
  it("binds the desktop shell's authorization window when the bridge offers one", async () => {
    const authorizeProvider = vi.fn(async () => ({
      cancelled: false,
      callbackUrl: "acme://cb?accessToken=t",
    }));
    globalThis.__CLASH_DESKTOP__ = { isDesktop: true, newWindow: vi.fn(), authorizeProvider };
    installProviderAuthorizationCompositionRoot();

    const result = await providerAuthorization().authorize({
      providerId: "acme",
      status: "pending",
      flow: "browser",
      callbackType: "scheme",
      callbackScheme: "acme",
      verificationUri: "https://auth.acme.test/login",
      hasAccessToken: false,
    });
    expect(authorizeProvider).toHaveBeenCalledWith({
      verificationUri: "https://auth.acme.test/login",
      callbackScheme: "acme",
    });
    expect(result.callbackUrl).toBe("acme://cb?accessToken=t");
  });

  it("binds the web redirect in a plain browser", async () => {
    installProviderAuthorizationCompositionRoot();
    // jsdom cannot navigate; a scheme row proves the web adapter is bound without leaving the page.
    await expect(
      providerAuthorization().authorize({
        providerId: "acme",
        status: "pending",
        flow: "browser",
        callbackType: "scheme",
        callbackScheme: "acme",
        verificationUri: "https://auth.acme.test/login",
        hasAccessToken: false,
      }),
    ).rejects.toThrow(/requires the Clash desktop runtime/);
  });
});
