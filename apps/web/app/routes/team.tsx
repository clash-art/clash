/**
 * /team: team settings (#354). The loader finds the caller's teams and the
 * one `?team=` selects (else their first team); an owner gets the management
 * view (members, invites, wallet and purchases, budgets, limits, usage,
 * audit), a member only their own role, budget, keys and usage, and nothing
 * of the owner view is ever requested for them.
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { TeamSettings, type TeamView } from "@clash/web-ui/components/team/TeamSettings";
import { teamApi, teamCan, type Team } from "@clash/web-ui/lib/teamClient";

import { rethrowTeamLoaderError, TeamRouteErrorBoundary } from "../lib/teamRoute";

export interface TeamLoaderData {
  teams: Team[];
  team: Team | null;
  view: TeamView | null;
}

async function loadView(team: Team): Promise<TeamView> {
  const id = team.tenantId;
  if (!teamCan(team).manage) return { kind: "member", data: await teamApi.me(id) };
  const [tenant, members, invites, budgets, keys, offers, usage, audit] = await Promise.all([
    teamApi.tenant(id),
    teamApi.members(id),
    teamApi.invites(id),
    teamApi.budgets(id),
    teamApi.keys(id),
    teamApi.offers(id),
    teamApi.usage(id),
    teamApi.audit(id),
  ]);
  return {
    kind: "owner",
    data: {
      tenant: tenant.tenant,
      members: members.members,
      invites: invites.invites,
      budgets: budgets.budgets,
      wallet: budgets.wallet,
      subscription: budgets.subscription,
      events: budgets.events,
      keys: keys.keys,
      packages: offers.packages,
      packs: offers.packs,
      usage: usage.usage,
      usageCursor: usage.nextCursor ?? null,
      audit: audit.entries,
    },
  };
}

export async function loader({ request }: LoaderFunctionArgs): Promise<TeamLoaderData> {
  const url = new URL(request.url);
  try {
    const { teams } = await teamApi.teams();
    const requested = url.searchParams.get("team");
    const team =
      teams.find((entry) => entry.tenantId === requested) ?? teams.find((entry) => entry.kind === "team") ?? teams[0] ?? null;
    return { teams, team, view: team ? await loadView(team) : null };
  } catch (error) {
    rethrowTeamLoaderError(error, url);
  }
}

export default function TeamRoute() {
  const data = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const { revalidate } = useRevalidator();
  return (
    <main className="h-full min-h-[100dvh] w-full overflow-y-auto bg-warm-page text-slate-950 dark:text-slate-50">
      <TeamSettings
        teams={data.teams}
        team={data.team}
        view={data.view}
        onSelect={(tenantId) => setSearchParams({ team: tenantId })}
        onChanged={() => void revalidate()}
      />
    </main>
  );
}

export const ErrorBoundary = TeamRouteErrorBoundary;
