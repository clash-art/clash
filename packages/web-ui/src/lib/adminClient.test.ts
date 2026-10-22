import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PAGES,
  AdminApiError,
  adminApi,
  adminAuthApi,
  adminCan,
  adminLoginPath,
  adminPage,
  canOpenAdminPage,
  isAdminReturnPath,
  parseCredits,
  parseRateLimit,
  resolveAdminTenant,
  type AdminMe,
} from "./adminClient";
import { runtimeFetch, setApiUnauthorizedListener } from "./runtimeConfig";

afterEach(() => vi.unstubAllGlobals());

const admin = { id: "adm_1", email: "ops@admin.test", name: "Ops", role: "platform_admin" };

/** An admin account whose role holds no console permission. */
const noneMe: AdminMe = { admin, permissions: [], promptAccess: false };

const platformMe: AdminMe = {
  admin,
  // /me lists every tenant permission for platform_admin too (it holds them on every tenant).
  permissions: ["tenants.list", "catalog.read", "usage.read_all", "audit.read_all", "budgets.read", "team.budgets.allocate"],
  promptAccess: false,
};

describe("adminRequest", () => {
  it("raises the server's coded gateway error, from the header first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "GATEWAY_FORBIDDEN", message: "Not allowed." } }), {
          status: 403,
          headers: { "x-clash-error-code": "GATEWAY_FORBIDDEN" },
        }),
      ),
    );
    const failure = await adminApi.upstreams().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminApiError);
    expect(failure).toMatchObject({ status: 403, code: "GATEWAY_FORBIDDEN", message: "Not allowed." });
  });

  it("falls back to an HTTP code when the response is not a gateway error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 404, statusText: "Not Found" })));
    await expect(adminApi.me()).rejects.toMatchObject({ status: 404, code: "HTTP_404" });
  });

  it("sends JSON bodies with credentials and encodes path segments", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ key: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await adminApi.setKeyRateLimit("team:a", "gwk/1", { concurrency: 2 });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/v1/admin/gateway/tenants/team%3Aa/keys/gwk%2F1/rate-limit");
    expect(init).toMatchObject({ method: "PUT", credentials: "include", body: JSON.stringify({ rateLimit: { concurrency: 2 } }) });
  });
});

describe("admin sign-in (#394)", () => {
  it("signs in and out through the admin auth endpoints, never the product ones", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await adminAuthApi.signIn("ops@admin.test", "a-long-password-1");
    await adminAuthApi.signOut();
    expect(fetchMock.mock.calls.map(([url, init]) => [new URL(String(url), "http://clash.test").pathname, init?.method, init?.credentials])).toEqual([
      ["/api/admin-auth/sign-in/email", "POST", "include"],
      ["/api/admin-auth/sign-out", "POST", "include"],
    ]);
  });

  it("raises Better Auth's code, or the HTTP status when there is none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" }, { status: 401 })));
    await expect(adminAuthApi.signIn("a@admin.test", "x")).rejects.toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Too many requests." }, { status: 429 })));
    await expect(adminAuthApi.signIn("a@admin.test", "x")).rejects.toMatchObject({ status: 429, code: "HTTP_429" });
  });

  it("never signs the product session out on an admin 401", async () => {
    const productSignedOut = vi.fn();
    setApiUnauthorizedListener(productSignedOut);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "GATEWAY_AUTH_REQUIRED" } }, { status: 401 })));
      await expect(adminApi.me()).rejects.toMatchObject({ status: 401 });
      await expect(adminAuthApi.signIn("a@admin.test", "x")).rejects.toMatchObject({ status: 401 });
      expect(productSignedOut).not.toHaveBeenCalled();
      // A product API 401 still does (#160).
      await runtimeFetch("/api/v1/me");
      expect(productSignedOut).toHaveBeenCalledTimes(1);
    } finally {
      setApiUnauthorizedListener(undefined);
    }
  });

  it("returns only to console pages after sign-in", () => {
    expect(adminLoginPath("/admin/usage?kind=settle")).toBe(`/admin/login?returnTo=${encodeURIComponent("/admin/usage?kind=settle")}`);
    for (const path of ["https://evil.example/admin", "//evil.example", "/settings", "/admin/login", "/administrator"]) {
      expect(isAdminReturnPath(path), path).toBe(false);
      expect(adminLoginPath(path), path).toBe("/admin/login");
    }
    for (const path of ["/admin", "/admin/usage", "/admin?tenant=team%3Aa"]) expect(isAdminReturnPath(path), path).toBe(true);
  });
});

describe("console permissions (UI affordance only)", () => {
  it("offers only what the admin account's permissions hold", () => {
    expect(adminCan(platformMe, "team.budgets.allocate")).toBe(true);
    expect(adminCan(platformMe, "upstreams.write")).toBe(false);
    expect(adminCan(noneMe, "team.budgets.allocate")).toBe(false);
  });

  it("opens a page through its permission only; an account without permissions opens none", () => {
    const openable = (me: AdminMe) => ADMIN_PAGES.filter((page) => canOpenAdminPage(me, page)).map((page) => page.key);
    expect(openable(noneMe)).toEqual([]);
    expect(openable(platformMe)).toEqual(["overview", "models", "users", "budgets", "usage", "audit"]);
  });

  it("narrows tenant-scoped pages to the requested tenant, and only those", () => {
    const audit = adminPage("audit");
    expect(resolveAdminTenant(audit, null)).toBeUndefined();
    expect(resolveAdminTenant(audit, "team:z")).toBe("team:z");
    expect(resolveAdminTenant(adminPage("models"), "team:z")).toBeUndefined();
  });
});

describe("form parsing", () => {
  it("parses credits into integer micro-credits", () => {
    expect(parseCredits("1.5")).toBe(1_500_000);
    expect(parseCredits("-2")).toBe(-2_000_000);
    expect(parseCredits("0.0000001")).toBeNull();
    expect(parseCredits("ten")).toBeNull();
  });

  it("parses rate limits, clearing them when every field is empty", () => {
    expect(parseRateLimit({ requestsPerMinute: "60", tokensPerMinute: "", concurrency: " 2 " })).toEqual({
      requestsPerMinute: 60,
      concurrency: 2,
    });
    expect(parseRateLimit({ requestsPerMinute: "", tokensPerMinute: "", concurrency: "" })).toBeNull();
    expect(() => parseRateLimit({ requestsPerMinute: "0", tokensPerMinute: "", concurrency: "" })).toThrow(/positive whole number/);
    expect(() => parseRateLimit({ requestsPerMinute: "1.5", tokensPerMinute: "", concurrency: "" })).toThrow(/positive whole number/);
  });
});
