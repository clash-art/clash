/**
 * Loader guard and page frame shared by the `/admin` routes (#353; guide:
 * apps/docs/guide/gateway-admin.md).
 *
 * Every admin loader asks api-cf who the caller is (`/api/v1/admin/gateway/me`,
 * D1 roles) before it loads the page's data: no session is a redirect to
 * /login, a caller who cannot open the page is a 403 route error, and a
 * deployment without the gateway admin API (local Host, self-host without it)
 * is a 404 route error. api-cf still authorizes every call the page makes;
 * this guard only decides what is rendered.
 */
import type { ReactNode } from "react";
import { data, isRouteErrorResponse, Link, redirect, useRevalidator, useRouteError, useSearchParams } from "react-router";
import { AdminShell } from "@clash/web-ui/components/admin/AdminShell";
import {
  AdminApiError,
  adminApi,
  adminPage,
  canOpenAdminPage,
  resolveAdminTenant,
  type AdminMe,
  type AdminPage,
  type AdminPageKey,
} from "@clash/web-ui/lib/adminClient";

export interface AdminPageContext {
  me: AdminMe;
  page: AdminPage;
  /** The tenant a tenant-scoped page shows; undefined for the platform-wide view. */
  tenantId: string | undefined;
  url: URL;
}

/** The coded body of an admin route error. */
export interface AdminRouteErrorData {
  code: string;
  message: string;
}

function routeError(status: number, code: string, message: string): never {
  throw data<AdminRouteErrorData>({ code, message }, { status });
}

/** Turn an admin API failure inside a loader into a redirect or a coded route error. */
export function rethrowAdminLoaderError(error: unknown, url: URL): never {
  if (error instanceof AdminApiError) {
    if (error.status === 401) throw redirect(`/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
    if (error.status === 404 && error.code === "HTTP_404")
      routeError(404, "ADMIN_CONSOLE_UNAVAILABLE", "This deployment does not serve the gateway admin console.");
    routeError(error.status, error.code, error.message);
  }
  throw error;
}

/**
 * Resolve the caller and the page: redirects to /login without a session,
 * throws a 403 route error when the caller holds none of the page's
 * permissions.
 */
export async function loadAdminPage(request: Request, key: AdminPageKey): Promise<AdminPageContext> {
  const url = new URL(request.url);
  let me: AdminMe;
  try {
    me = await adminApi.me();
  } catch (error) {
    rethrowAdminLoaderError(error, url);
  }
  const page = adminPage(key);
  if (!canOpenAdminPage(me, page))
    routeError(403, "GATEWAY_FORBIDDEN", `Your roles do not include access to ${page.label}.`);
  return { me, page, tenantId: resolveAdminTenant(me, page, url.searchParams.get("tenant")), url };
}

/** Run the page's data calls; their failures become the same redirect or coded route error. */
export async function loadAdminData<T>(context: AdminPageContext, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    rethrowAdminLoaderError(error, context.url);
  }
}

/** The console frame: navigation, the tenant switcher wired to `?tenant=`, and revalidation after changes. */
export function AdminRouteFrame({
  context,
  children,
}: {
  context: Pick<AdminPageContext, "me" | "page" | "tenantId">;
  children: ReactNode;
}) {
  const [, setSearchParams] = useSearchParams();
  return (
    <AdminShell
      me={context.me}
      tenantId={context.tenantId}
      tenantScoped={context.page.tenant !== undefined}
      // A new tenant starts from unfiltered views.
      onTenantChange={(tenantId) => setSearchParams(tenantId ? { tenant: tenantId } : {})}
    >
      {children}
    </AdminShell>
  );
}

/** Reload the page's loader data after a successful admin action. */
export function useAdminRefresh(): () => void {
  const { revalidate } = useRevalidator();
  return () => void revalidate();
}

/** Shown when an admin loader refuses: the coded reason, never a blank page. */
export function AdminRouteErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const body = isRouteErrorResponse(error) ? (error.data as Partial<AdminRouteErrorData> | undefined) : undefined;
  const code = body?.code ?? (error instanceof AdminApiError ? error.code : "ADMIN_ROUTE_ERROR");
  const message =
    body?.message ?? (error instanceof Error ? error.message : "The admin console could not load this page.");
  return (
    <main className="flex min-h-screen items-center justify-center bg-warm-page px-6 text-slate-950 dark:text-slate-50">
      <section role="alert" className="w-full max-w-lg space-y-3 rounded-2xl border border-warm-border bg-warm-surface/80 p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-600">Gateway admin · {status}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {status === 403 ? "You do not have access to this page" : "This admin page is unavailable"}
        </h1>
        <p className="font-mono text-sm">{code}</p>
        <p className="text-sm text-stone-600 dark:text-stone-300">{message}</p>
        <div className="flex gap-4 text-sm">
          <Link className="text-red-600 hover:underline" to="/admin">
            Admin overview
          </Link>
          <Link className="text-red-600 hover:underline" to="/">
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
