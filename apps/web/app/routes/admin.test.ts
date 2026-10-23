/**
 * The /admin loaders ask api-cf for the signed-in admin account before
 * loading a page (#353, #392, #394): no admin session, or only a product
 * session, redirects to the admin sign-in (/admin/login, never the product
 * /login); an account whose role lacks the page's permission gets a coded 403
 * route error (and the page's API is never called); and the server's coded
 * refusals surface as route errors. The sign-in route itself sends an
 * already signed-in admin back to a console page, and only ever to one.
 */
import type { LoaderFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminMe } from "@clash/web-ui/lib/adminClient";

import { loader as abuseLoader } from "./admin.abuse";
import { loader as auditLoader } from "./admin.audit";
import { loader as budgetsLoader } from "./admin.budgets";
import { loader as overviewLoader } from "./admin._index";
import { loader as loginLoader } from "./admin.login";
import { loader as modelsLoader } from "./admin.models";
import { loader as packagesLoader } from "./admin.packages";
import { loader as upstreamsLoader } from "./admin.upstreams";
import { loader as usageLoader } from "./admin.usage";
import { loader as usersLoader } from "./admin.users";

afterEach(() => vi.unstubAllGlobals());

const ALL_LOADERS = [overviewLoader, modelsLoader, upstreamsLoader, usersLoader, budgetsLoader, packagesLoader, usageLoader, abuseLoader, auditLoader];

/** An admin account whose role holds no console permission. */
const noPermissions: AdminMe = {
  admin: { id: "adm_none", email: "none@admin.test", name: "None", role: "platform_admin" },
  permissions: [],
  promptAccess: false,
};
const staff: AdminMe = {
  admin: { id: "adm_staff", email: "staff@admin.test", name: "Staff", role: "platform_admin" },
  permissions: [
    "tenants.list",
    "catalog.read",
    "catalog.write",
    "prices.read",
    "prices.write",
    "packages.read",
    "packages.write",
    "billing.rollover",
    "upstreams.read",
    "upstreams.write",
    "wallet.adjust",
    "subscription.limits.write",
    "admin_accounts.read",
    "admin_accounts.write",
    "usage.read_all",
    "audit.read_all",
    "abuse.read",
    "prompts.view",
    "retention.purge",
    "budgets.read",
    "team.budgets.allocate",
    "keys.read",
    "limits.write",
    "team.members.read",
    "team.members.manage",
  ],
  promptAccess: true,
};

type Responder = (path: string, method: string) => Response | undefined;

/** Stub the admin API: `/me` answers `me` (or a Response), other paths go to `respond`. */
function stubApi(me: AdminMe | Response, respond: Responder = () => undefined) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://clash.test");
      const path = url.pathname + url.search;
      paths.push(path);
      if (url.pathname === "/api/v1/admin/gateway/me") return me instanceof Response ? me.clone() : Response.json(me);
      return respond(path, init?.method ?? "GET") ?? new Response("unexpected", { status: 599 });
    }),
  );
  return paths;
}

const args = (path: string) =>
  ({ request: new Request(`http://clash.test${path}`), params: {}, context: {} }) as unknown as LoaderFunctionArgs;

const coded = (status: number, code: string, message = code) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "x-clash-error-code": code } });

/** The loader's thrown value: a redirect Response or a `data()` route error. */
async function thrown(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the loader to throw");
    },
    (caught: unknown) => caught,
  );
  if (error instanceof Response) return { status: error.status, location: error.headers.get("location") };
  const routeError = error as { data: { code: string; message: string }; init: { status: number } | null };
  return { status: routeError.init?.status, code: routeError.data?.code, message: routeError.data?.message };
}

describe("admin loader guard", () => {
  it("redirects a caller without an admin session to the admin sign-in, returning to the page", async () => {
    const paths = stubApi(coded(401, "GATEWAY_AUTH_REQUIRED"));
    for (const loader of ALL_LOADERS)
      expect(await thrown(loader(args("/admin/usage?kind=settle")))).toEqual({
        status: 302,
        location: `/admin/login?returnTo=${encodeURIComponent("/admin/usage?kind=settle")}`,
      });
    expect(paths.every((path) => path === "/api/v1/admin/gateway/me")).toBe(true);
  });

  it("sends a product session or token (refused by the server as the wrong identity) to the admin sign-in, never the product /login", async () => {
    const paths = stubApi(coded(403, "GATEWAY_ADMIN_SESSION_REQUIRED"));
    for (const loader of ALL_LOADERS)
      expect(await thrown(loader(args("/admin/x?tenant=team%3Aa")))).toEqual({
        status: 302,
        location: `/admin/login?returnTo=${encodeURIComponent("/admin/x?tenant=team%3Aa")}`,
      });
    expect(paths.every((path) => path === "/api/v1/admin/gateway/me")).toBe(true);
  });

  it("refuses an admin account whose role lacks the page's permission with a coded 403, without calling the page's API", async () => {
    const paths = stubApi(noPermissions);
    for (const loader of ALL_LOADERS)
      expect(await thrown(loader(args("/admin/x?tenant=team%3Aa")))).toMatchObject({ status: 403, code: "GATEWAY_FORBIDDEN" });
    expect(paths.every((path) => path === "/api/v1/admin/gateway/me")).toBe(true);
  });

  it("reports a deployment without the admin API as unavailable", async () => {
    stubApi(new Response("Not Found", { status: 404 }));
    expect(await thrown(overviewLoader(args("/admin")))).toMatchObject({ status: 404, code: "ADMIN_CONSOLE_UNAVAILABLE" });
  });

  it("surfaces the server's coded refusal of the page's own call", async () => {
    stubApi(staff, () => coded(403, "GATEWAY_FORBIDDEN", "permission upstreams.read"));
    expect(await thrown(upstreamsLoader(args("/admin/upstreams")))).toEqual({
      status: 403,
      code: "GATEWAY_FORBIDDEN",
      message: "permission upstreams.read",
    });
  });
});

describe("admin page scope", () => {
  it("narrows a tenant-scoped page to the tenant asked for", async () => {
    const paths = stubApi(staff, (path) =>
      path.startsWith("/api/v1/admin/gateway/overview")
        ? Response.json({ overview: { windowDays: 30, requests: 0, spentMicroCredits: 0, failedRequests: 0, topModels: [] } })
        : Response.json({ entries: [] }),
    );
    const overview = await overviewLoader(args("/admin?tenant=team%3Aa"));
    expect(overview).toMatchObject({ tenantId: "team:a", scopeLabel: "Tenant team:a" });
    const audit = await auditLoader(args("/admin/audit?tenant=team%3Ab&action=key"));
    expect(audit.filters).toEqual({ action: "key", tenantId: "team:b" });
    expect(paths).toEqual(
      expect.arrayContaining(["/api/v1/admin/gateway/overview?tenantId=team%3Aa", "/api/v1/admin/gateway/audit?action=key&tenantId=team%3Ab"]),
    );
  });

  it("gives platform staff the platform-wide view, and any tenant they ask for", async () => {
    const paths = stubApi(staff, (path) => {
      if (path.startsWith("/api/v1/admin/gateway/tenants?") || path === "/api/v1/admin/gateway/tenants") return Response.json({ tenants: [] });
      if (path.endsWith("/budgets")) return Response.json({ budgets: [], wallet: null, subscription: null });
      if (path.endsWith("/keys")) return Response.json({ keys: [] });
      if (path.endsWith("/members")) return Response.json({ members: [] });
      return undefined;
    });
    const platformView = await budgetsLoader(args("/admin/budgets"));
    expect(platformView).toMatchObject({ tenantId: undefined, tenants: [], tenant: null });
    const tenantView = await budgetsLoader(args("/admin/budgets?tenant=team%3Az"));
    expect(tenantView.tenant).toMatchObject({
      id: "team:z",
      can: { budgetsWrite: true, limitsWrite: true, walletAdjust: true, subscriptionLimits: true },
    });
    expect(paths).toContain("/api/v1/admin/gateway/tenants/team%3Az/budgets");
  });

  it("shows a tenant's members read-only, with no role-change call", async () => {
    const members = [{ userId: "u1", role: "owner", name: null, email: null, joinedAt: null }];
    const paths = stubApi(staff, (path) => {
      if (path === "/api/v1/admin/gateway/tenants") return Response.json({ tenants: [] });
      if (path === "/api/v1/admin/gateway/admin-accounts") return Response.json({ accounts: [] });
      if (path.endsWith("/members")) return Response.json({ members });
      return undefined;
    });
    const data = await usersLoader(args("/admin/users?tenant=team%3Az"));
    expect(data).toMatchObject({ tenantId: "team:z", members });
    expect(data).not.toHaveProperty("canWriteRoles");
    expect(paths).toContain("/api/v1/admin/gateway/tenants/team%3Az/members");
    expect(paths.some((path) => path.endsWith("/role"))).toBe(false);
  });

  it("loads the platform pages for staff with their write affordances", async () => {
    stubApi(staff, (path) => {
      if (path === "/api/v1/admin/gateway/catalog") return Response.json({ versions: [{ version: "c1", status: "published", live: true, models: 0, publishedAt: null, createdAt: "" }] });
      if (path === "/api/v1/admin/gateway/catalog/versions/c1") return Response.json({ version: { version: "c1", status: "published", models: [] } });
      if (path === "/api/v1/admin/gateway/prices") return Response.json({ versions: [] });
      if (path === "/api/v1/admin/gateway/tenants") return Response.json({ tenants: [] });
      if (path === "/api/v1/admin/gateway/admin-accounts") return Response.json({ accounts: [] });
      if (path.startsWith("/api/v1/admin/gateway/usage")) return Response.json({ entries: [], byModel: [] });
      return undefined;
    });
    expect(await modelsLoader(args("/admin/models"))).toMatchObject({ selected: { version: "c1" }, prices: [], canWriteCatalog: true, canWritePrices: true });
    expect(await usersLoader(args("/admin/users"))).toMatchObject({ tenantId: undefined, members: null, tenants: [], accounts: [], canWriteAdminAccounts: true });
    expect((await usageLoader(args("/admin/usage"))).me.promptAccess).toBe(true);
  });
});

describe("admin sign-in route", () => {
  it("shows the sign-in form without an admin session, or with only a product session", async () => {
    for (const refusal of [coded(401, "GATEWAY_AUTH_REQUIRED"), coded(403, "GATEWAY_ADMIN_SESSION_REQUIRED")]) {
      stubApi(refusal);
      expect(await loginLoader(args("/admin/login?returnTo=%2Fadmin%2Fusage"))).toBeNull();
    }
  });

  it("sends a signed-in admin back to the console page asked for, and only to a console page", async () => {
    stubApi(staff);
    expect(await thrown(loginLoader(args(`/admin/login?returnTo=${encodeURIComponent("/admin/usage?kind=settle")}`)))).toEqual({
      status: 302,
      location: "/admin/usage?kind=settle",
    });
    for (const returnTo of ["https://evil.example/admin", "//evil.example/admin", "/settings", "/admin/login", "/administrator"])
      expect(await thrown(loginLoader(args(`/admin/login?returnTo=${encodeURIComponent(returnTo)}`))), returnTo).toEqual({
        status: 302,
        location: "/admin",
      });
  });

  it("reports a deployment without the admin API as unavailable", async () => {
    stubApi(new Response("Not Found", { status: 404 }));
    expect(await thrown(loginLoader(args("/admin/login")))).toMatchObject({ status: 404, code: "ADMIN_CONSOLE_UNAVAILABLE" });
  });
});
