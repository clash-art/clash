import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_PATH,
  HOSTED_WEB_TRUSTED_ORIGINS,
  originFromAuthBaseUrl,
  resolveAuthErrorURL,
  resolveLegacyWebRedirect,
  resolveTrustedOrigins,
} from "./auth-origins";

describe("resolveTrustedOrigins", () => {
  it("includes art and video hosts plus BETTER_AUTH_URL origin", () => {
    const origins = resolveTrustedOrigins({
      baseURL: "https://clash.art",
      includeLocalDev: false,
    });
    expect(origins).toEqual(
      expect.arrayContaining([
        ...HOSTED_WEB_TRUSTED_ORIGINS,
        "https://clash.art",
      ]),
    );
    expect(origins).not.toEqual(
      expect.arrayContaining(["http://localhost:3000"]),
    );
  });

  it("adds localhost when baseURL is local", () => {
    const origins = resolveTrustedOrigins({
      baseURL: "http://localhost:3001",
    });
    expect(origins).toEqual(
      expect.arrayContaining([
        "http://localhost:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3000",
      ]),
    );
  });
});

describe("resolveAuthErrorURL", () => {
  it("points at Clash /login under the auth base origin", () => {
    expect(resolveAuthErrorURL("https://clash.art")).toBe(
      `https://clash.art${AUTH_ERROR_PATH}`,
    );
    expect(resolveAuthErrorURL(undefined)).toBe(AUTH_ERROR_PATH);
  });
});

describe("resolveLegacyWebRedirect", () => {
  it("301s legacy video hosts to BETTER_AUTH_URL origin", () => {
    const target = resolveLegacyWebRedirect(
      new URL("https://clash.video/login?returnTo=%2Fbilling"),
      {
        LEGACY_WEB_REDIRECT_HOSTS: "clash.video,www.clash.video",
        BETTER_AUTH_URL: "https://clash.art",
      },
    );
    expect(target).toBe("https://clash.art/login?returnTo=%2Fbilling");
  });

  it("preserves OAuth callback path and query on legacy host", () => {
    const target = resolveLegacyWebRedirect(
      new URL(
        "https://www.clash.video/api/better-auth/callback/google?code=x&state=y",
      ),
      {
        LEGACY_WEB_REDIRECT_HOSTS: "clash.video,www.clash.video",
        BETTER_AUTH_URL: "https://clash.art",
      },
    );
    expect(target).toBe(
      "https://clash.art/api/better-auth/callback/google?code=x&state=y",
    );
  });

  it("no-ops when unset or already canonical", () => {
    expect(
      resolveLegacyWebRedirect(new URL("https://clash.video/"), {
        BETTER_AUTH_URL: "https://clash.art",
      }),
    ).toBeNull();
    expect(
      resolveLegacyWebRedirect(new URL("https://clash.art/billing"), {
        LEGACY_WEB_REDIRECT_HOSTS: "clash.video",
        BETTER_AUTH_URL: "https://clash.art",
      }),
    ).toBeNull();
  });
});

describe("originFromAuthBaseUrl", () => {
  it("parses absolute http(s) only", () => {
    expect(originFromAuthBaseUrl("https://clash.art/api/better-auth")).toBe(
      "https://clash.art",
    );
    expect(originFromAuthBaseUrl("not-a-url")).toBeUndefined();
  });
});
