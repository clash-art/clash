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

/** A team owner or member: no platform grant, so no console access. */
const teamMe: AdminMe = { userId: "u-owner", platformRoles: [], platformPermissions: [], promptAccess: false };

const platformMe: AdminMe = {
  userId: "u-staff",
  platformRoles: ["platform_admin"],
  // /me lists every tenant permission for platform_admin too (it holds them on every tenant).
  platformPermissions: ["tenants.list", "catalog.read", "usage.read_all", "audit.read_all", "budgets.read", "team.budgets.allocate"],
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
  it("offers only what the caller's platform grants hold", () => {
    expect(adminCan(platformMe, "team.budgets.allocate")).toBe(true);
    expect(adminCan(platformMe, "upstreams.write")).toBe(false);
    expect(adminCan(teamMe, "team.budgets.allocate")).toBe(false);
  });

  it("opens a page through its platform permission only; a team role opens none", () => {
    const openable = (me: AdminMe) => ADMIN_PAGES.filter((page) => canOpenAdminPage(me, page)).map((page) => page.key);
    expect(openable(teamMe)).toEqual([]);
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
