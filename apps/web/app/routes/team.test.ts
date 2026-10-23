/**
 * The team settings loaders (#354): a caller without a product session signs
 * in at /login and returns; an owner's view loads the management endpoints,
 * a member's only their own `/me` (no owner endpoint is ever requested);
 * `?team=` selects the team; coded refusals become coded route errors. The
 * invite route shows a link's own refusal on the page and signs in first
 * only when there is no session.
 */
import type { LoaderFunctionArgs } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loader as inviteLoader } from "./team.invite";
import { loader as teamLoader } from "./team";

afterEach(() => vi.unstubAllGlobals());

type Responder = (path: string, method: string) => Response | undefined;

function stubApi(respond: Responder) {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://clash.test");
      const path = url.pathname + url.search;
      paths.push(path);
      return respond(path, init?.method ?? "GET") ?? new Response("unexpected", { status: 599 });
    }),
  );
  return paths;
}

const args = (path: string) =>
  ({ request: new Request(`http://clash.test${path}`), params: {}, context: {} }) as unknown as LoaderFunctionArgs;

const coded = (status: number, code: string, message = code) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "x-clash-error-code": code } });

async function thrown(promise: Promise<unknown>) {
  const error = await promise.then(
    () => {
      throw new Error("expected the loader to throw");
    },
    (caught: unknown) => caught,
  );
  if (error instanceof Response) return { status: error.status, location: error.headers.get("location") };
  const routeError = error as { data: { code: string }; init: { status: number } | null };
  return { status: routeError.init?.status, code: routeError.data?.code };
}

const teams = [
  { tenantId: "personal:u", name: "Personal workspace", kind: "personal", role: "owner", members: 1 },
  { tenantId: "team:own", name: "Studio", kind: "team", role: "owner", members: 3 },
  { tenantId: "team:join", name: "Agency", kind: "team", role: "member", members: 5 },
];

const ownerResponses: Responder = (path) => {
  if (path === "/api/v1/gateway/teams") return Response.json({ teams });
  const base = "/api/v1/gateway/tenants/team%3Aown";
  const bodies: Record<string, unknown> = {
    [base]: { tenant: { id: "team:own", name: "Studio", kind: "team", ownerUserId: "u", rateLimit: null } },
    [`${base}/members`]: { members: [] },
    [`${base}/invites`]: { invites: [] },
    [`${base}/budgets`]: { budgets: [], wallet: null, subscription: null, events: [] },
    [`${base}/keys`]: { keys: [] },
    [`${base}/billing/offers`]: { packages: [], packs: [] },
    [`${base}/usage`]: { usage: [] },
    [`${base}/audit`]: { entries: [] },
  };
  return path in bodies ? Response.json(bodies[path]) : undefined;
};

describe("team settings loader", () => {
  it("sends a caller without a product session to /login and back", async () => {
    stubApi(() => coded(401, "GATEWAY_AUTH_REQUIRED"));
    expect(await thrown(teamLoader(args("/team?team=team%3Aown")))).toEqual({
      status: 302,
      location: `/login?returnTo=${encodeURIComponent("/team?team=team%3Aown")}`,
    });
  });

  it("opens the caller's first team by default and loads the owner's management view", async () => {
    const paths = stubApi(ownerResponses);
    const data = await teamLoader(args("/team"));
    expect(data.team?.tenantId).toBe("team:own");
    expect(data.view?.kind).toBe("owner");
    expect(paths).toEqual(expect.arrayContaining(["/api/v1/gateway/tenants/team%3Aown/members", "/api/v1/gateway/tenants/team%3Aown/budgets"]));
    expect(paths.some((path) => path.endsWith("/me"))).toBe(false);
  });

  it("loads only a member's own view, never an owner endpoint", async () => {
    const paths = stubApi((path) => {
      if (path === "/api/v1/gateway/teams") return Response.json({ teams });
      if (path === "/api/v1/gateway/tenants/team%3Ajoin/me")
        return Response.json({ tenant: { id: "team:join", name: "Agency", kind: "team" }, member: {}, budgets: [], keys: [], usage: [], events: [] });
      return undefined;
    });
    const data = await teamLoader(args("/team?team=team%3Ajoin"));
    expect(data.view?.kind).toBe("member");
    expect(paths).toEqual(["/api/v1/gateway/teams", "/api/v1/gateway/tenants/team%3Ajoin/me"]);
  });

  it("shows the empty state without a team, and coded refusals as route errors", async () => {
    stubApi((path) => (path === "/api/v1/gateway/teams" ? Response.json({ teams: [] }) : undefined));
    expect(await teamLoader(args("/team"))).toEqual({ teams: [], team: null, view: null });
    stubApi((path) => (path === "/api/v1/gateway/teams" ? Response.json({ teams }) : coded(403, "GATEWAY_FORBIDDEN")));
    expect(await thrown(teamLoader(args("/team")))).toEqual({ status: 403, code: "GATEWAY_FORBIDDEN" });
    stubApi(() => new Response("not found", { status: 404 }));
    expect(await thrown(teamLoader(args("/team")))).toEqual({ status: 404, code: "TEAM_SETTINGS_UNAVAILABLE" });
  });
});

describe("team invite loader", () => {
  it("looks the link up, and signs in first without a session", async () => {
    const paths = stubApi((path, method) =>
      path === "/api/v1/gateway/invites/lookup" && method === "POST"
        ? Response.json({ invite: { id: "gwi_1", role: "member" }, team: { tenantId: "team:own", name: "Studio" } })
        : undefined,
    );
    const data = await inviteLoader(args("/team/invite?token=gwi_x.y"));
    expect(data).toMatchObject({ token: "gwi_x.y", team: { name: "Studio" }, error: null });
    expect(paths).toEqual(["/api/v1/gateway/invites/lookup"]);
    stubApi(() => coded(401, "GATEWAY_AUTH_REQUIRED"));
    expect(await thrown(inviteLoader(args("/team/invite?token=gwi_x.y")))).toEqual({
      status: 302,
      location: `/login?returnTo=${encodeURIComponent("/team/invite?token=gwi_x.y")}`,
    });
  });

  it("shows an expired or missing link's code on the page", async () => {
    stubApi(() => coded(410, "GATEWAY_INVITE_EXPIRED"));
    expect((await inviteLoader(args("/team/invite?token=gwi_x.y"))).error).toMatchObject({ status: 410, code: "GATEWAY_INVITE_EXPIRED" });
    const paths = stubApi(() => undefined);
    expect((await inviteLoader(args("/team/invite"))).error).toMatchObject({ code: "GATEWAY_INVITE_NOT_FOUND" });
    expect(paths).toEqual([]);
  });
});
