import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PAGES,
  AdminApiError,
  adminApi,
  adminCan,
  adminPage,
  canOpenAdminPage,
  parseCredits,
  parseRateLimit,
  resolveAdminTenant,
  type AdminMe,
} from "./adminClient";

afterEach(() => vi.unstubAllGlobals());

const viewerMe: AdminMe = {
  userId: "u-viewer",
  platformRoles: [],
  platformPermissions: [],
  tenants: [
    { tenantId: "team:a", name: "A", kind: "team", role: "viewer", permissions: ["tenant.read", "usage.read", "budgets.read", "members.read"] },
    { tenantId: "team:b", name: "B", kind: "team", role: "support", permissions: ["tenant.read", "usage.read", "budgets.read", "keys.read", "members.read", "audit.read"] },
  ],
  promptAccess: false,
};

const platformMe: AdminMe = {
  userId: "u-staff",
  platformRoles: ["platform_admin"],
  // /me lists every tenant permission for platform_admin too (it holds them on every tenant).
  platformPermissions: ["tenants.list", "catalog.read", "usage.read_all", "audit.read_all", "audit.read", "budgets.read", "budgets.write"],
  tenants: [],
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

describe("console permissions (UI affordance only)", () => {
  it("scopes tenant permissions to the tenant that grants them", () => {
    expect(adminCan(viewerMe, "audit.read", "team:b")).toBe(true);
    expect(adminCan(viewerMe, "audit.read", "team:a")).toBe(false);
    expect(adminCan(viewerMe, "audit.read")).toBe(false);
    expect(adminCan(platformMe, "budgets.write", "team:anything")).toBe(true);
  });

  it("opens a page through a tenant permission in some tenant, or its platform permission", () => {
    const openable = (me: AdminMe) => ADMIN_PAGES.filter((page) => canOpenAdminPage(me, page)).map((page) => page.key);
    expect(openable(viewerMe)).toEqual(["overview", "users", "budgets", "usage", "audit"]);
    expect(openable(platformMe)).toEqual(["overview", "models", "users", "budgets", "usage", "audit"]);
  });

  it("shows a requested tenant only when the caller may see it there", () => {
    const audit = adminPage("audit");
    expect(resolveAdminTenant(viewerMe, audit, "team:b")).toBe("team:b");
    // team:a grants no audit.read, so the page falls back to the first tenant that does.
    expect(resolveAdminTenant(viewerMe, audit, "team:a")).toBe("team:b");
    expect(resolveAdminTenant(platformMe, audit, null)).toBeUndefined();
    expect(resolveAdminTenant(platformMe, audit, "team:z")).toBe("team:z");
    expect(resolveAdminTenant(platformMe, adminPage("models"), "team:z")).toBeUndefined();
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
