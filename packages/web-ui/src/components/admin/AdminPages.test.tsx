// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AbuseSignals, Budget, CatalogVersion, GatewayKey, TenantMember } from "../../lib/adminClient";
import { chooseOption, gatewayError, stubAdminFetch } from "../../test-support/admin";
import { AdminAbuse } from "./AdminAbuse";
import { AdminAudit } from "./AdminAudit";
import { AdminBudgets, type BudgetPermissions } from "./AdminBudgets";
import { AdminCatalog, AdminPrices } from "./AdminCatalog";
import { AdminPackages } from "./AdminPackages";
import { AdminUsage } from "./AdminUsage";
import { AdminMembers, AdminPlatformAdmins } from "./AdminUsers";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (form: HTMLElement, label: string, value: string) =>
  fireEvent.change(within(form).getByLabelText(label), { target: { value } });

describe("AdminBudgets", () => {
  const wallet: Budget = {
    id: "b-wallet",
    scope: "tenant",
    scopeId: "team:a",
    status: "active",
    limitMicroCredits: 10_000_000,
    spentMicroCredits: 2_000_000,
    reservedMicroCredits: 500_000,
    availableMicroCredits: 7_500_000,
  };
  const members: TenantMember[] = [{ userId: "u-ann", role: "member", name: "Ann", email: null, joinedAt: null }];
  const keys: GatewayKey[] = [
    { id: "gwk_1", userId: "u-ann", name: "ci", tokenPrefix: "sk_gw_ab", budgetId: null, rateLimit: null, revokedAt: null, lastUsedAt: null },
  ];
  const renderBudgets = (can: BudgetPermissions) =>
    render(
      <AdminBudgets tenantId="team:a" wallet={wallet} budgets={[wallet]} subscription={null} keys={keys} members={members} can={can} onChanged={() => undefined} />,
    );
  const none: BudgetPermissions = { budgetsWrite: false, limitsWrite: false, walletAdjust: false, subscriptionLimits: false };

  it("is read-only for a role without write permissions", () => {
    renderBudgets(none);
    expect(screen.getByText("7.5")).toBeInTheDocument();
    for (const name of ["Set budget", "Correct wallet", "Wallet status", "Rate limit for key ci"])
      expect(screen.queryByRole("form", { name })).toBeNull();
  });

  it("sets a member budget in micro-credits, and only platform staff see wallet corrections", async () => {
    const calls = stubAdminFetch(() => Response.json({ budget: {} }));
    renderBudgets({ ...none, budgetsWrite: true, limitsWrite: true });
    expect(screen.queryByRole("form", { name: "Correct wallet" })).toBeNull();
    expect(screen.getByRole("form", { name: "Rate limit for key ci" })).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Set budget" });
    type(form, "Limit (credits)", "2.25");
    chooseOption("Budget status", "Suspended", form);
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/api/v1/admin/gateway/tenants/team%3Aa/budgets/user/u-ann",
      body: { limitMicroCredits: 2_250_000, status: "suspended" },
    });
  });

  it("shows a refused budget's code inline", async () => {
    stubAdminFetch(() => gatewayError(409, "GATEWAY_BUDGET_BELOW_USAGE", "The budget limit cannot go below what is already spent and reserved."));
    renderBudgets({ ...none, budgetsWrite: true });
    const form = screen.getByRole("form", { name: "Set budget" });
    type(form, "Limit (credits)", "0");
    fireEvent.submit(form);
    expect(await screen.findByText("GATEWAY_BUDGET_BELOW_USAGE")).toBeInTheDocument();
  });

  it("posts a wallet correction with a reason and a fresh idempotency key", async () => {
    const calls = stubAdminFetch(() => Response.json({ replayed: false }, { status: 201 }));
    renderBudgets({ ...none, walletAdjust: true });
    const form = screen.getByRole("form", { name: "Correct wallet" });
    type(form, "Credit correction", "-1");
    type(form, "Correction reason", "refund duplicate charge");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/admin/gateway/tenants/team%3Aa/wallet/adjust",
      body: { deltaMicroCredits: -1_000_000, reason: "refund duplicate charge", idempotencyKey: expect.stringMatching(/^console-/) },
    });
  });
});

describe("AdminUsage", () => {
  const usage = { entries: [], byModel: [] };
  const entry = (requestId: string, kind: string) => ({
    requestId,
    kind,
    status: "settled",
    tenantId: "team:a",
    userId: "u-ann",
    keyId: "gwk_1",
    amountMicroCredits: 1500,
    modelCode: "gpt-x",
    inputTokens: 4,
    outputTokens: 2,
    priceVersion: "p1",
    errorCode: null,
    occurredAt: "2026-10-20T10:00:00.000Z",
  });
  const ledger = { entries: [entry("gwr_1", "settle"), entry("gwr_1", "hold")], byModel: [] };
  // The stored bytes, deliberately not pretty-printed: the viewer must show them unchanged.
  const stored = {
    request: '{"model":"gpt-x","messages":[{"role":"user","content":"why is the sky blue?"}]}',
    response: '{"choices":[{"message":{"role":"assistant","content":"Rayleigh scattering."}}],"model":"gpt-x"}',
  };
  const retained = {
    requestId: "gwr_1",
    tenantId: "team:a",
    userId: "u-ann",
    keyId: "gwk_1",
    responseStatus: 200,
    storedAt: "2026-10-20T10:00:00.000Z",
    expiresAt: "2026-11-19T10:00:00.000Z",
    request: { contentType: "application/json", bytes: stored.request.length, sha256: "a".repeat(64), body: stored.request },
    response: { contentType: "application/json", bytes: stored.response.length, sha256: "b".repeat(64), body: stored.response },
  };

  it("offers staff prompt access only when the deployment enables it for the caller", () => {
    const { rerender } = render(<AdminUsage usage={ledger} filters={{}} onFiltersChange={() => undefined} promptAccess={false} />);
    expect(screen.queryByRole("region", { name: "Staff prompt access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "View prompt for gwr_1" })).toBeNull();
    rerender(<AdminUsage usage={ledger} filters={{}} onFiltersChange={() => undefined} promptAccess />);
    expect(screen.getByRole("region", { name: "Staff prompt access" })).toBeInTheDocument();
    // One viewer per request: on its settle row, not on the hold.
    expect(screen.getAllByRole("button", { name: "View prompt for gwr_1" })).toHaveLength(1);
  });

  it("opens a row's prompt and response with a reason and shows the stored bytes unchanged", async () => {
    const calls = stubAdminFetch(() => Response.json({ prompt: retained }));
    render(<AdminUsage usage={ledger} filters={{}} onFiltersChange={() => undefined} promptAccess />);
    fireEvent.click(screen.getByRole("button", { name: "View prompt for gwr_1" }));
    const dialog = await screen.findByRole("dialog", { name: "Prompt and response" });
    const submit = within(dialog).getByRole("button", { name: "View prompt and response" });
    expect(submit).toBeDisabled();
    const form = within(dialog).getByRole("form", { name: "Prompt access" });
    type(form, "Reason", "incident 42");
    fireEvent.submit(form);
    const request = await within(dialog).findByRole("region", { name: "Request" });
    expect(calls).toEqual([{ method: "POST", path: "/api/v1/admin/gateway/prompts/gwr_1/access", body: { reason: "incident 42" } }]);
    expect(request.querySelector("pre")!.textContent).toBe(stored.request);
    expect(within(dialog).getByRole("region", { name: "Response" }).querySelector("pre")!.textContent).toBe(stored.response);
    expect(within(dialog).getByText("b".repeat(64))).toBeInTheDocument();
  });

  it("shows an expired or unretained request's coded error in the viewer", async () => {
    const calls = stubAdminFetch(() =>
      gatewayError(410, "GATEWAY_PROMPT_EXPIRED", "The retained request and response bodies are past their retention and can no longer be viewed."),
    );
    render(<AdminUsage usage={usage} filters={{}} onFiltersChange={() => undefined} promptAccess />);
    const lookup = screen.getByRole("region", { name: "Staff prompt access" }).querySelector("form")!;
    type(lookup, "Gateway request id", "gwr_old");
    fireEvent.submit(lookup);
    const dialog = await screen.findByRole("dialog", { name: "Prompt and response" });
    type(within(dialog).getByRole("form", { name: "Prompt access" }), "Reason", "audit request");
    fireEvent.submit(within(dialog).getByRole("form", { name: "Prompt access" }));
    expect(await within(dialog).findByText("GATEWAY_PROMPT_EXPIRED")).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Request" })).toBeNull();
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/admin/gateway/prompts/gwr_old/access", body: { reason: "audit request" } });
  });

  it("applies filters, keeping the tenant scope", () => {
    const onFiltersChange = vi.fn();
    render(<AdminUsage usage={usage} filters={{ tenantId: "team:a" }} onFiltersChange={onFiltersChange} promptAccess={false} />);
    const form = screen.getByRole("region", { name: "Filters" }).querySelector("form")!;
    type(form, "Model", "gpt-x");
    chooseOption("Ledger kind", "settle");
    fireEvent.submit(form);
    expect(onFiltersChange).toHaveBeenCalledWith({ tenantId: "team:a", modelCode: "gpt-x", kind: "settle" });
  });
});

describe("AdminCatalog and AdminPrices", () => {
  const published: CatalogVersion = {
    version: "c1",
    status: "published",
    models: [{ modelCode: "m1", kind: "chat", displayName: "Model one", enabled: true, maxOutputTokens: null, rateLimit: null, publishedAt: null, card: { id: "m1" } }],
  };

  it("keeps a published version read-only", () => {
    render(
      <AdminCatalog
        versions={[{ version: "c1", status: "published", live: true, models: 1, publishedAt: null, createdAt: "2026-10-01T00:00:00Z" }]}
        selected={published}
        canWrite
        onSelect={() => undefined}
        onChanged={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Publish version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByRole("form", { name: "New draft version" })).toBeInTheDocument();
  });

  it("edits a draft model and refuses a card that is not JSON before calling the server", async () => {
    const calls = stubAdminFetch(() => Response.json({ model: {} }));
    const onChanged = vi.fn();
    render(
      <AdminCatalog
        versions={[{ version: "c2", status: "draft", live: false, models: 1, publishedAt: null, createdAt: "2026-10-01T00:00:00Z" }]}
        selected={{ ...published, version: "c2", status: "draft" }}
        canWrite
        onSelect={() => undefined}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const form = screen.getByRole("form", { name: "Edit m1" });
    type(form, "Model card JSON", "{ not json");
    fireEvent.submit(form);
    expect(await screen.findByText("The model card is not valid JSON.")).toBeInTheDocument();
    expect(calls).toHaveLength(0);

    type(form, "Model card JSON", JSON.stringify({ id: "m1" }));
    type(form, "Requests/min per user", "30");
    fireEvent.submit(form);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/api/v1/admin/gateway/catalog/versions/c2/models/m1",
      body: { card: { id: "m1" }, enabled: true, displayName: "Model one", maxOutputTokens: null, rateLimit: { requestsPerMinute: 30 } },
    });
  });

  it("hides price writes without prices.write and publishes drafts with it", async () => {
    const versions = [{ version: "p1", status: "draft" as const, effectiveFrom: "2026-11-01T00:00:00Z", effectiveTo: null, publishedAt: null, rates: [] }];
    const { rerender } = render(<AdminPrices versions={versions} canWrite={false} onChanged={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("form", { name: "Price draft" })).toBeNull();
    const calls = stubAdminFetch(() => gatewayError(409, "GATEWAY_PRICE_WINDOW_INVALID", "The price window is invalid."));
    rerender(<AdminPrices versions={versions} canWrite onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("GATEWAY_PRICE_WINDOW_INVALID")).toBeInTheDocument();
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/admin/gateway/prices/versions/p1/publish" });
  });
});

describe("AdminPackages", () => {
  it("creates a package with its tenant rate limit, in minor units and micro-credits", async () => {
    const calls = stubAdminFetch(() => Response.json({ package: {} }, { status: 201 }));
    render(<AdminPackages packages={[]} packs={[]} canWrite canRollover={false} onChanged={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Close ended periods" })).toBeNull();
    const form = screen.getByRole("form", { name: "New package" });
    type(form, "Package name", "Pro");
    type(form, "Price (minor units)", "4900");
    type(form, "Currency", "usd");
    type(form, "Credits per period", "100");
    type(form, "Tenant concurrency", "4");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/admin/gateway/packages",
      body: { name: "Pro", billingPeriod: "month", priceMinor: 4900, priceCurrency: "USD", periodMicroCredits: 100_000_000, rateLimit: { concurrency: 4 } },
    });
  });

  it("has no write controls without packages.write", () => {
    render(
      <AdminPackages
        packages={[{ id: "pkg1", name: "Pro", status: "active", billingPeriod: "month", priceMinor: 4900, priceCurrency: "USD", periodMicroCredits: 1, rateLimit: null }]}
        packs={[]}
        canWrite={false}
        canRollover={false}
        onChanged={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.queryByRole("form", { name: "New package" })).toBeNull();
    expect(screen.queryByRole("form", { name: "New top-up pack" })).toBeNull();
  });
});

describe("AdminMembers and AdminPlatformAdmins", () => {
  const members: TenantMember[] = [
    { userId: "u-own", role: "owner", name: "Olga", email: "o@example.test", joinedAt: null },
    { userId: "u-max", role: "member", name: "Max", email: null, joinedAt: null },
  ];

  it("shows a team's members and roles read-only: team owners manage them in team settings", () => {
    const calls = stubAdminFetch(() => Response.json({}));
    render(<AdminMembers members={members} />);
    expect(screen.getByText("owner")).toBeInTheDocument();
    expect(screen.getByText("member")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("grants platform admin by user id, labelling the bootstrap grant", async () => {
    const calls = stubAdminFetch(() => Response.json({ granted: true }, { status: 201 }));
    render(
      <AdminPlatformAdmins
        admins={[{ userId: "u-first", name: null, email: null, grantedByUserId: null, grantedAt: "2026-10-01T00:00:00Z" }]}
        canWrite
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByText("bootstrap")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Grant platform admin" });
    type(form, "User id", "u-next");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/admin/gateway/platform-admins", body: { userId: "u-next" } });
  });
});

describe("AdminAbuse and AdminAudit", () => {
  it("states that denied-request events are not yet available instead of showing an empty list", () => {
    const abuse: AbuseSignals = {
      windowMinutes: 60,
      rateWindows: [{ subject: "key:gwk_1", requests: 12, tokens: 3400, lastWindowAt: "2026-10-01T00:00:00Z" }],
      inflight: [],
      events: { available: false, reason: "Denied requests are not recorded yet." },
    };
    render(<AdminAbuse abuse={abuse} />);
    expect(screen.getByText("Denied-request events are not yet available")).toBeInTheDocument();
    expect(screen.getByText("Denied requests are not recorded yet.")).toBeInTheDocument();
    expect(screen.getByText("key:gwk_1")).toBeInTheDocument();
  });

  it("renders audit snapshots read-only and filters through the URL callback", () => {
    const onFiltersChange = vi.fn();
    render(
      <MemoryRouter>
        <AdminAudit
          entries={[
            {
              id: "gwa_1",
              tenantId: "",
              actorUserId: "u-staff",
              actorRole: "platform_admin",
              action: "upstream.rotate",
              targetType: "upstream_account",
              targetId: "gwu_1",
              before: { credential: { keyVersion: "v1" } },
              after: { credential: { keyVersion: "v2" } },
              reason: "scheduled",
              occurredAt: "2026-10-01T00:00:00Z",
            },
          ]}
          filters={{}}
          onFiltersChange={onFiltersChange}
        />
      </MemoryRouter>,
    );
    const log = screen.getByRole("table", { name: "Audit log" });
    expect(within(log).getByText("upstream.rotate")).toBeInTheDocument();
    expect(within(log).getByText("reason: scheduled")).toBeInTheDocument();
    expect(within(log).queryByRole("button")).toBeNull();
    const form = screen.getByRole("region", { name: "Filters" }).querySelector("form")!;
    type(form, "Action", "upstream");
    fireEvent.submit(form);
    expect(onFiltersChange).toHaveBeenCalledWith({ action: "upstream" });
  });
});
