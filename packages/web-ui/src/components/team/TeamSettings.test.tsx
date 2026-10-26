// @vitest-environment jsdom
/**
 * Team settings (#354): the owner's controls call the product team API with
 * the right shapes (roles, removal, invites, budgets with enforcement and
 * overrides, rate limits, purchases), coded refusals show inline, and a
 * member sees only their own data with no owner control rendered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Team, TeamSelf } from "../../lib/teamClient";
import { chooseOption, gatewayError, stubAdminFetch, stubDownloads } from "../../test-support/admin";
import { TeamInviteAccept } from "./TeamInviteAccept";
import { TeamSettings, type TeamOwnerData } from "./TeamSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

const ownerTeam: Team = { tenantId: "team:a", name: "Studio", kind: "team", role: "owner", members: 2 };
const memberTeam: Team = { ...ownerTeam, role: "member" };

const owner: TeamOwnerData = {
  tenant: { id: "team:a", name: "Studio", kind: "team", ownerUserId: "u-olga", rateLimit: null },
  members: [
    { userId: "u-olga", role: "owner", name: "Olga", email: "olga@team.test", joinedAt: null, rateLimit: null },
    { userId: "u-ann", role: "member", name: "Ann", email: "ann@team.test", joinedAt: null, rateLimit: { requestsPerMinute: 10 } },
  ],
  invites: [
    { id: "gwi_1", tenantId: "team:a", email: "bob@team.test", role: "member", status: "pending", invitedByUserId: "u-olga", expiresAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-23T00:00:00.000Z" },
  ],
  budgets: [
    {
      id: "gwb_u_ann",
      scope: "user",
      scopeId: "u-ann",
      status: "active",
      limitMicroCredits: 5_000_000,
      spentMicroCredits: 1_250_000,
      reservedMicroCredits: 250_000,
      availableMicroCredits: 3_500_000,
      enforcement: "soft",
      alertThresholdPct: 80,
    },
  ],
  wallet: { budgetId: "gwb_t", status: "active", limitMicroCredits: 20_000_000, spentMicroCredits: 4_000_000, reservedMicroCredits: 0, availableMicroCredits: 16_000_000 },
  subscription: null,
  events: [
    {
      id: "e1",
      budgetId: "gwb_u_ann",
      scope: "user",
      scopeId: "u-ann",
      kind: "alert_threshold",
      enforcement: "soft",
      requestId: "gwr_1",
      limitMicroCredits: 5_000_000,
      spentMicroCredits: 4_000_000,
      reservedMicroCredits: 0,
      thresholdPct: 80,
      occurredAt: "2026-10-23T00:00:00.000Z",
    },
  ],
  keys: [{ id: "gwk_1", userId: "u-ann", name: "ci", tokenPrefix: "sk_gw_ab", budgetId: null, rateLimit: null, revokedAt: null, lastUsedAt: null }],
  packages: [{ id: "pkg_1", name: "Pro", billingPeriod: "month", priceMinor: 2000, priceCurrency: "USD", periodMicroCredits: 50_000_000 }],
  packs: [{ id: "pack_1", name: "Boost", priceMinor: 500, priceCurrency: "USD", microCredits: 5_000_000 }],
  usage: [
    { requestId: "gwr_1", userId: "u-ann", keyId: null, modelCode: "gpt-5.4", status: "settled", costMicroCredits: 1_250_000, notCharged: false, inputTokens: 10, outputTokens: 20, usageSource: "reported", errorCode: null, occurredAt: "2026-10-23T00:00:00.000Z" },
    { requestId: "gwr_2", userId: "u-ann", keyId: null, modelCode: "image-gen", status: "upstream_failed", costMicroCredits: 0, notCharged: true, inputTokens: 0, outputTokens: 0, usageSource: "reported", errorCode: "GATEWAY_UPSTREAM_ERROR", occurredAt: "2026-10-22T00:00:00.000Z" },
  ],
  usageCursor: "older-1",
  audit: [
    { id: "a1", actorKind: "user", actorId: "u-olga", actorRole: "owner", action: "budget.override", targetType: "budget", targetId: "user:u-ann", reason: "freeze", occurredAt: "2026-10-23T00:00:00.000Z" },
  ],
};

const self: TeamSelf = {
  tenant: { id: "team:a", name: "Studio", kind: "team" },
  member: owner.members[1]!,
  budgets: owner.budgets,
  keys: owner.keys,
  usage: owner.usage,
  events: owner.events,
};

const renderOwner = () =>
  render(<TeamSettings teams={[ownerTeam]} team={ownerTeam} view={{ kind: "owner", data: owner }} onSelect={() => undefined} onChanged={() => undefined} />);

describe("TeamSettings (owner)", () => {
  it("shows the wallet, budgets with used and left, notifications, usage and audit", () => {
    renderOwner();
    expect(screen.getByText("16")).toBeInTheDocument();
    const budgets = screen.getByRole("table", { name: "Budgets" });
    const ann = within(budgets).getByText("Member · Ann").closest("tr")!;
    for (const text of ["soft", "5", "1.25", "3.5", "80%"]) expect(within(ann).getByText(text)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Budget notifications" })).getByText("Alert: 80% reached")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Usage" })).getByText("gpt-5.4")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Audit log" })).getByText("budget.override")).toBeInTheDocument();
  });

  it("marks a failed media generation not charged, loads older usage, and exports the team's CSV", async () => {
    const saved = stubDownloads();
    const calls = stubAdminFetch((call) =>
      call.path.includes("/usage/export")
        ? new Response("occurred_at,request_id\r\n", { headers: { "content-type": "text/csv", "content-disposition": 'attachment; filename="gateway-usage-team_a.csv"' } })
        : Response.json({ usage: [{ ...owner.usage[0]!, requestId: "gwr_0", modelCode: "older-model" }], nextCursor: null }),
    );
    renderOwner();
    const failed = within(screen.getByRole("table", { name: "Usage" })).getByText("image-gen").closest("tr")!;
    expect(within(failed).getByText("not charged")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    expect(await within(screen.getByRole("table", { name: "Usage" })).findByText("older-model")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
    fireEvent.click(within(screen.getByRole("region", { name: "Usage" })).getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toEqual(["gateway-usage-team_a.csv"]));
    expect(calls.map((call) => call.path)).toEqual([
      "/api/v1/gateway/tenants/team%3Aa/usage?cursor=older-1",
      "/api/v1/gateway/tenants/team%3Aa/usage/export",
    ]);
  });

  it("shows a refused export's code instead of saving a file", async () => {
    const saved = stubDownloads();
    stubAdminFetch(() => gatewayError(413, "GATEWAY_EXPORT_TOO_LARGE", "Narrow the filters."));
    renderOwner();
    fireEvent.click(within(screen.getByRole("region", { name: "Usage" })).getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("GATEWAY_EXPORT_TOO_LARGE")).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it("changes a role and removes a member, and shows a coded refusal inline", async () => {
    const calls = stubAdminFetch((call) =>
      call.method === "DELETE" ? gatewayError(409, "GATEWAY_LAST_OWNER", "A tenant must keep at least one owner.") : Response.json({ member: {} }),
    );
    renderOwner();
    chooseOption("Role of Ann", "Owner");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/v1/gateway/tenants/team%3Aa/members/u-ann/role", body: { role: "owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove Olga" }));
    expect(await screen.findByText("GATEWAY_LAST_OWNER")).toBeInTheDocument();
    expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/gateway/tenants/team%3Aa/members/u-olga" });
  });

  it("invites by email and shows the link once; revokes a pending invite", async () => {
    const calls = stubAdminFetch((call) =>
      call.method === "POST"
        ? Response.json({ invite: {}, token: "gwi_x.y", acceptPath: "/team/invite?token=gwi_x.y" }, { status: 201 })
        : Response.json({ revoked: true }),
    );
    renderOwner();
    const form = screen.getByRole("form", { name: "Invite member" });
    type(form, "Email", "new@team.test");
    chooseOption("Invite role", "Owner", form);
    fireEvent.submit(form);
    expect(await screen.findByLabelText("Invite link (shown once)")).toHaveValue(`${window.location.origin}/team/invite?token=gwi_x.y`);
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/gateway/tenants/team%3Aa/invites", body: { email: "new@team.test", role: "owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Revoke invite for bob@team.test" }));
    await waitFor(() => expect(calls[1]).toMatchObject({ method: "DELETE", path: "/api/v1/gateway/tenants/team%3Aa/invites/gwi_1" }));
  });

  it("allocates a budget with its enforcement and threshold, and requires a reason for an override", async () => {
    const calls = stubAdminFetch(() => Response.json({ budget: {} }));
    renderOwner();
    const form = screen.getByRole("form", { name: "Allocate budget" });
    chooseOption("Budget for", "Key · ci", form);
    type(form, "Limit (credits)", "2.5");
    chooseOption("Enforcement", "Alert: allow and notify", form);
    type(form, "Alert at (% of limit)", "90");
    fireEvent.click(within(form).getByRole("checkbox", { name: "Override usage check" }));
    fireEvent.submit(form);
    expect(await within(form.parentElement!).findByText("An override needs a reason.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    type(form, "Reason", "cap the CI key");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/api/v1/gateway/tenants/team%3Aa/budgets/key/gwk_1",
      body: { limitMicroCredits: 2_500_000, status: "active", enforcement: "alert", alertThresholdPct: 90, override: true, reason: "cap the CI key" },
    });
  });

  it("starts each budget subject from its own settings, so a save never carries another's over", async () => {
    const calls = stubAdminFetch(() => Response.json({ budget: {} }));
    renderOwner();
    const form = screen.getByRole("form", { name: "Allocate budget" });
    chooseOption("Budget for", "Member · Ann", form);
    expect(within(form).getByLabelText("Alert at (% of limit)")).toHaveValue("80");
    type(form, "Limit (credits)", "6");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ enforcement: "soft", alertThresholdPct: 80, status: "active" });
    chooseOption("Budget for", "Key · ci", form);
    type(form, "Limit (credits)", "1");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ path: "/api/v1/gateway/tenants/team%3Aa/budgets/key/gwk_1", body: { enforcement: "hard", alertThresholdPct: null } });
  });

  it("sets member, team and key rate limits, media jobs included", async () => {
    const calls = stubAdminFetch(() => Response.json({}));
    renderOwner();
    const member = screen.getByRole("form", { name: "Rate limit for Ann" });
    expect(within(member).getByLabelText("Requests/min")).toHaveValue("10");
    type(member, "Media jobs", "2");
    fireEvent.submit(member);
    const team = screen.getByRole("form", { name: "Team rate limit" });
    type(team, "Tokens/min", "200000");
    fireEvent.submit(team);
    const key = screen.getByRole("form", { name: "Rate limit for key ci" });
    type(key, "Concurrent", "4");
    fireEvent.submit(key);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "PUT", path: "/api/v1/gateway/tenants/team%3Aa/members/u-ann/rate-limit", body: { rateLimit: { requestsPerMinute: 10, mediaJobs: 2 } } },
        { method: "PUT", path: "/api/v1/gateway/tenants/team%3Aa/rate-limit", body: { rateLimit: { tokensPerMinute: 200000 } } },
        { method: "PUT", path: "/api/v1/gateway/tenants/team%3Aa/keys/gwk_1/rate-limit", body: { rateLimit: { concurrency: 4 } } },
      ]),
    );
  });

  it("buys packages and top-ups for the team wallet with a fresh idempotency key each time", async () => {
    const calls = stubAdminFetch(() => Response.json({}, { status: 201 }));
    renderOwner();
    fireEvent.click(screen.getByRole("button", { name: "Buy Boost" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Subscribe to Pro" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/gateway/tenants/team%3Aa/topups", body: { packId: "pack_1" } });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/api/v1/gateway/tenants/team%3Aa/subscription", body: { packageId: "pkg_1" } });
    const keys = calls.map((call) => (call.body as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("creates a team and selects it", async () => {
    const onSelect = vi.fn();
    const calls = stubAdminFetch(() => Response.json({ team: { ...ownerTeam, tenantId: "team:new" } }, { status: 201 }));
    render(<TeamSettings teams={[]} team={null} view={null} onSelect={onSelect} onChanged={() => undefined} />);
    const form = screen.getByRole("form", { name: "Create team" });
    type(form, "New team name", "Night shift");
    fireEvent.submit(form);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("team:new"));
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/gateway/teams", body: { name: "Night shift" } });
  });
});

describe("TeamSettings (member)", () => {
  it("shows only the member's own budget, keys and usage, with no owner control", () => {
    stubAdminFetch(() => Response.json({}));
    render(<TeamSettings teams={[memberTeam]} team={memberTeam} view={{ kind: "member", data: self }} onSelect={() => undefined} onChanged={() => undefined} />);
    expect(screen.getByText("You are a member of this team.")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Your budgets" })).getByText("Member · You")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Usage" })).getByText("gpt-5.4")).toBeInTheDocument();
    expect(screen.getByText("Your rate limit: 10 rpm")).toBeInTheDocument();
    for (const name of ["Invite member", "Allocate budget", "Team rate limit", "Rate limit for key ci", "Rate limit for Ann"])
      expect(screen.queryByRole("form", { name })).toBeNull();
    for (const name of ["Members", "Budgets", "Audit log", "Packages"]) expect(screen.queryByRole("table", { name })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove|Buy|Subscribe|Load older/ })).toBeNull();
  });

  it("exports only the member's own usage", async () => {
    const saved = stubDownloads();
    const calls = stubAdminFetch(() => new Response("occurred_at\r\n", { headers: { "content-type": "text/csv" } }));
    render(<TeamSettings teams={[memberTeam]} team={memberTeam} view={{ kind: "member", data: self }} onSelect={() => undefined} onChanged={() => undefined} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Your usage" })).getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saved).toEqual(["gateway-usage.csv"]));
    expect(calls.map((call) => call.path)).toEqual(["/api/v1/gateway/tenants/team%3Aa/me/usage/export"]);
  });
});

describe("TeamInviteAccept", () => {
  const invite = { id: "gwi_1", tenantId: "team:a", email: "ann@team.test", role: "member", status: "pending", invitedByUserId: "u-olga", expiresAt: "2026-11-01T00:00:00.000Z", createdAt: "2026-10-23T00:00:00.000Z" };

  it("joins the team with the link's token", async () => {
    const onAccepted = vi.fn();
    const calls = stubAdminFetch(() => Response.json({ team: memberTeam }));
    render(<TeamInviteAccept token="gwi_x.y" invite={invite} team={{ tenantId: "team:a", name: "Studio" }} error={null} onAccepted={onAccepted} />);
    expect(screen.getByText("Studio")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(memberTeam));
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/gateway/invites/accept", body: { token: "gwi_x.y" } });
  });

  it("shows the server's refusal when the account is not the invited one", async () => {
    stubAdminFetch(() => gatewayError(403, "GATEWAY_INVITE_EMAIL_MISMATCH", "The invite was sent to a different email address."));
    render(<TeamInviteAccept token="gwi_x.y" invite={invite} team={{ tenantId: "team:a", name: "Studio" }} error={null} onAccepted={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Join Studio" }));
    expect(await screen.findByText("GATEWAY_INVITE_EMAIL_MISMATCH")).toBeInTheDocument();
  });
});
