/**
 * /team/invite?token=…: accept a team invite (#354). The loader looks the
 * link up on the product session (signing in first, then returning here);
 * an expired, revoked or malformed link is shown with its code. Joining
 * opens the team's settings.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { TeamInviteAccept } from "@clash/web-ui/components/team/TeamInviteAccept";
import { TeamApiError, teamApi, type TeamInvite } from "@clash/web-ui/lib/teamClient";

import { rethrowTeamLoaderError, TeamRouteErrorBoundary } from "../lib/teamRoute";

export interface TeamInviteLoaderData {
  token: string;
  invite: TeamInvite | null;
  team: { tenantId: string; name: string } | null;
  error: TeamApiError | null;
}

export async function loader({ request }: LoaderFunctionArgs): Promise<TeamInviteLoaderData> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  if (!token)
    return { token, invite: null, team: null, error: new TeamApiError(400, "GATEWAY_INVITE_NOT_FOUND", "This invite link has no token.") };
  try {
    const { invite, team } = await teamApi.lookupInvite(token);
    return { token, invite, team, error: null };
  } catch (error) {
    // The link's own refusals (expired, revoked, malformed) are shown on the page; no session signs in first.
    if (error instanceof TeamApiError && error.status !== 401 && error.code.startsWith("GATEWAY_"))
      return { token, invite: null, team: null, error };
    rethrowTeamLoaderError(error, url);
  }
}

export default function TeamInviteRoute() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  return (
    <main className="h-full min-h-[100dvh] w-full overflow-y-auto bg-warm-page text-slate-950 dark:text-slate-50">
      <TeamInviteAccept
        token={data.token}
        invite={data.invite}
        team={data.team}
        error={data.error}
        onAccepted={(team) => navigate(`/team?team=${encodeURIComponent(team.tenantId)}`, { replace: true })}
      />
    </main>
  );
}

export const ErrorBoundary = TeamRouteErrorBoundary;
