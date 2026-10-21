/**
 * The /admin loaders ask api-cf for the caller's roles before loading a page
 * (#353): no session redirects to /login, a caller without the page's
 * permission gets a coded 403 route error (and the page's API is never
 * called), and the server's coded refusals surface as route errors.
 */
import type { LoaderFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminMe } from "@clash/web-ui/lib/adminClient";

import { loader as abuseLoader } from "./admin.abuse";
import { loader as auditLoader } from "./admin.audit";
import { loader as budgetsLoader } from "./admin.budgets";
import { loader as overviewLoader } from "./admin._index";
import { loader as modelsLoader } from "./admin.models";
import { loader as packagesLoader } from "./admin.packages";
import { loader as upstreamsLoader } from "./admin.upstreams";
import { loader as usageLoader } from "./admin.usage";
import { loader as usersLoader } from "./admin.users";

afterEach(() => vi.unstubAllGlobals());

const VIEWER_PERMISSIONS = ["tenant.read", "usage.read", "budgets.read", "members.read"];
const OWNER_PERMISSIONS = [
  "tenant.read",
  "usage.read",
  "budgets.read",
  "budgets.write",
  "keys.read",
  "limits.write",
  "members.read",
  "roles.write",
  "audit.read",
  "billing.read",
  "billing.purchase",
];

const viewer: AdminMe = {
  userId: "u-viewer",
  platformRoles: [],
  platformPermissions: [],
  tenants: [{ tenantId: "team:a", name: "A", kind: "team", role: "viewer", permissions: VIEWER_PERMISSIONS }],
  promptAccess: false,
};
const owner: AdminMe = {
  ...viewer,
  userId: "u-owner",
  tenants: [
    { tenantId: "team:a", name: "A", kind: "team", role: "viewer", permissions: VIEWER_PERMISSIONS },
    { tenantId: "team:b", name: "B", kind: "team", role: "owner", permissions: OWNER_PERMISSIONS },
  ],
};
const staff: AdminMe = {
  userId: "u-staff",
  platformRoles: ["platform_admin"],
  platformPermissions: [
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
    "platform_roles.read",
    "platform_roles.write",
    "usage.read_all",
    "audit.read_all",
    "abuse.read",
    "prompts.view",
    ...OWNER_PERMISSIONS,
  ],
  tenants: [],
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
  it("redirects a caller without a session to /login, returning to the page", async () => {
    stubApi(coded(401, "GATEWAY_AUTH_REQUIRED"));
    expect(await thrown(usageLoader(args("/admin/usage?kind=settle")))).toEqual({
      status: 302,
      location: `/login?returnTo=${encodeURIComponent("/admin/usage?kind=settle")}`,
    });
  });

  it("refuses with a coded 403, without calling the page's API, when no role opens the page", async () => {
    const paths = stubApi(viewer);
    for (const loader of [modelsLoader, upstreamsLoader, packagesLoader, abuseLoader, auditLoader])
      expect(await thrown(loader(args("/admin/x")))).toMatchObject({ status: 403, code: "GATEWAY_FORBIDDEN" });
    expect(paths.every((path) => path === "/api/v1/admin/gateway/me")).toBe(true);
  });

  it("refuses a signed-in user with no console role at all", async () => {
    stubApi({ ...viewer, tenants: [] });
    expect(await thrown(overviewLoader(args("/admin")))).toMatchObject({ status: 403, code: "GATEWAY_FORBIDDEN" });
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
  it("scopes a tenant role's overview to its own tenant", async () => {
    const paths = stubApi(viewer, () => Response.json({ overview: { windowDays: 30, requests: 0, spentMicroCredits: 0, failedRequests: 0, topModels: [] } }));
    const data = await overviewLoader(args("/admin"));
    expect(data.tenantId).toBe("team:a");
    expect(paths).toContain("/api/v1/admin/gateway/overview?tenantId=team%3Aa");
  });

  it("never requests a tenant the caller holds no role in; it falls back to one that grants the page", async () => {
    const paths = stubApi(owner, () => Response.json({ entries: [] }));
    // team:a grants this caller no audit.read, and team:z nothing at all.
    for (const tenant of ["team:a", "team:z"]) {
      const data = await auditLoader(args(`/admin/audit?tenant=${encodeURIComponent(tenant)}&action=key`));
      expect(data.tenantId).toBe("team:b");
      expect(data.filters).toEqual({ action: "key", tenantId: "team:b" });
    }
    expect(paths.filter((path) => path.startsWith("/api/v1/admin/gateway/audit"))).toEqual([
      "/api/v1/admin/gateway/audit?action=key&tenantId=team%3Ab",
      "/api/v1/admin/gateway/audit?action=key&tenantId=team%3Ab",
    ]);
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

  it("derives write affordances from the caller's role in the shown tenant", async () => {
    stubApi(owner, (path) => {
      if (path.endsWith("/budgets")) return Response.json({ budgets: [], wallet: null, subscription: null });
      if (path.endsWith("/keys")) return Response.json({ keys: [] });
      if (path.endsWith("/members")) return Response.json({ members: [] });
      return undefined;
    });
    const asViewer = await budgetsLoader(args("/admin/budgets?tenant=team%3Aa"));
    expect(asViewer.tenant?.can).toEqual({ budgetsWrite: false, limitsWrite: false, walletAdjust: false, subscriptionLimits: false });
    const asOwner = await budgetsLoader(args("/admin/budgets?tenant=team%3Ab"));
    expect(asOwner.tenant?.can).toEqual({ budgetsWrite: true, limitsWrite: true, walletAdjust: false, subscriptionLimits: false });
  });

  it("loads the platform pages for staff with their write affordances", async () => {
    stubApi(staff, (path) => {
      if (path === "/api/v1/admin/gateway/catalog") return Response.json({ versions: [{ version: "c1", status: "published", live: true, models: 0, publishedAt: null, createdAt: "" }] });
      if (path === "/api/v1/admin/gateway/catalog/versions/c1") return Response.json({ version: { version: "c1", status: "published", models: [] } });
      if (path === "/api/v1/admin/gateway/prices") return Response.json({ versions: [] });
      if (path === "/api/v1/admin/gateway/tenants") return Response.json({ tenants: [] });
      if (path === "/api/v1/admin/gateway/platform-admins") return Response.json({ admins: [] });
      if (path.startsWith("/api/v1/admin/gateway/usage")) return Response.json({ entries: [], byModel: [] });
      return undefined;
    });
    expect(await modelsLoader(args("/admin/models"))).toMatchObject({ selected: { version: "c1" }, prices: [], canWriteCatalog: true, canWritePrices: true });
    expect(await usersLoader(args("/admin/users"))).toMatchObject({ tenantId: undefined, members: null, tenants: [], admins: [], canWritePlatformRoles: true });
    expect((await usageLoader(args("/admin/usage"))).me.promptAccess).toBe(true);
  });
});
