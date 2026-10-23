/**
 * Loader errors and the error page shared by the team settings routes (#354;
 * guide: apps/docs/guide/gateway-teams.md). These are product pages on the
 * product session: without one, the caller signs in at the product /login and
 * comes back. api-cf authorizes every call; a coded refusal becomes a coded
 * route error, never a blank page.
 */
import { data, isRouteErrorResponse, Link, redirect, useRouteError } from "react-router";
import { TeamApiError } from "@clash/web-ui/lib/teamClient";

export interface TeamRouteErrorData {
  code: string;
  message: string;
}

/** The product sign-in, returning to `path` afterwards. */
export const teamLoginPath = (path: string) => `/login?returnTo=${encodeURIComponent(path)}`;

/** Turn a team API failure inside a loader into a sign-in redirect or a coded route error. */
export function rethrowTeamLoaderError(error: unknown, url: URL): never {
  if (error instanceof TeamApiError) {
    if (error.status === 401) throw redirect(teamLoginPath(url.pathname + url.search));
    if (error.status === 404 && error.code === "HTTP_404")
      throw data<TeamRouteErrorData>(
        { code: "TEAM_SETTINGS_UNAVAILABLE", message: "This deployment does not serve team settings." },
        { status: 404 },
      );
    throw data<TeamRouteErrorData>({ code: error.code, message: error.message }, { status: error.status });
  }
  throw error;
}

export function TeamRouteErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const body = isRouteErrorResponse(error) ? (error.data as Partial<TeamRouteErrorData> | undefined) : undefined;
  const code = body?.code ?? (error instanceof TeamApiError ? error.code : "TEAM_ROUTE_ERROR");
  const message = body?.message ?? (error instanceof Error ? error.message : "Team settings could not load.");
  return (
    <main className="flex min-h-screen items-center justify-center bg-warm-page px-6 text-slate-950 dark:text-slate-50">
      <section role="alert" className="w-full max-w-lg space-y-3 rounded-2xl border border-warm-border bg-warm-surface/80 p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-red-600">Team settings · {status}</p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          {status === 403 ? "You do not have access to this team" : "Team settings are unavailable"}
        </h1>
        <p className="font-mono text-sm">{code}</p>
        <p className="text-sm text-stone-600 dark:text-stone-300">{message}</p>
        <div className="flex gap-4 text-sm">
          <Link className="text-red-600 hover:underline" to="/team">
            Team settings
          </Link>
          <Link className="text-red-600 hover:underline" to="/">
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
