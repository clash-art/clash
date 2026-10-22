/**
 * Admin console sign-in (#394): the admin account session, separate from the
 * product login at /login. A visitor who already holds an admin session goes
 * straight back to the console page they came from.
 */
import type { LoaderFunctionArgs } from "react-router";
import { redirect, useNavigate, useSearchParams } from "react-router";
import { AdminLogin } from "@clash/web-ui/components/admin/AdminLogin";
import { AdminApiError, adminApi, isAdminReturnPath } from "@clash/web-ui/lib/adminClient";

import { AdminRouteErrorBoundary, isAdminSignInRequired, rethrowAdminLoaderError } from "../lib/adminRoute";

/** The console page to open after sign-in: a same-origin /admin path, else the overview. */
export function adminReturnTo(search: URLSearchParams): string {
  const requested = search.get("returnTo");
  return requested && isAdminReturnPath(requested) ? requested : "/admin";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  try {
    await adminApi.me();
  } catch (error) {
    if (error instanceof AdminApiError && isAdminSignInRequired(error)) return null;
    rethrowAdminLoaderError(error, url);
  }
  throw redirect(adminReturnTo(url.searchParams));
}

export default function AdminLoginRoute() {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  return <AdminLogin onSignedIn={() => void navigate(adminReturnTo(search), { replace: true })} />;
}

export const ErrorBoundary = AdminRouteErrorBoundary;
