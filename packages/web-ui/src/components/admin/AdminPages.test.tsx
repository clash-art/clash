// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AbuseSignals, AdminAccount, Budget, CatalogVersion, GatewayKey, TenantMember } from "../../lib/adminClient";
import { chooseOption, gatewayError, stubAdminFetch } from "../../test-support/admin";
import { AdminAbuse } from "./AdminAbuse";
import { AdminAudit } from "./AdminAudit";
import { AdminBudgets, type BudgetPermissions } from "./AdminBudgets";
import { AdminCatalog, AdminPrices } from "./AdminCatalog";
import { AdminPackages } from "./AdminPackages";
import { AdminUsage } from "./AdminUsage";
import { AdminAccounts, AdminMembers } from "./AdminUsers";

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
  const none: BudgetPermissions = { walletAdjust: false, subscriptionLimits: false };

  it("is read-only for a role without write permissions", () => {
    renderBudgets(none);
    expect(screen.getByText("7.5")).toBeInTheDocument();
    for (const name of ["Correct wallet", "Wallet status"]) expect(screen.queryByRole("form", { name })).toBeNull();
  });

  it("only views team budgets and key limits, even for platform staff: owners set them in team settings", () => {
    const ann: Budget = { ...wallet, id: "b-ann", scope: "user", scopeId: "u-ann", enforcement: "soft", limitMicroCredits: 1_000_000 };
    render(
      <AdminBudgets
        tenantId="team:a"
        wallet={wallet}
        budgets={[wallet, ann]}
        subscription={null}
        keys={[{ ...keys[0]!, rateLimit: { requestsPerMinute: 30 } }]}
        members={members}
        can={{ walletAdjust: true, subscriptionLimits: true }}
        onChanged={() => undefined}
      />,
    );
    const table = screen.getByRole("table", { name: "Budgets" });
    expect(within(table).getByText("user: Ann")).toBeInTheDocument();
    expect(within(table).getByText("soft")).toBeInTheDocument();
    expect(screen.getByText("30 rpm")).toBeInTheDocument();
    for (const name of ["Set budget", "Rate limit for key ci"]) expect(screen.queryByRole("form", { name })).toBeNull();
    expect(screen.getByRole("form", { name: "Correct wallet" })).toBeInTheDocument();
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

describe("AdminMembers and AdminAccounts", () => {
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

  const accounts: AdminAccount[] = [
    { id: "adm_me", email: "me@admin.test", name: "Me", role: "platform_admin", disabledAt: null, createdAt: "2026-10-01T00:00:00Z" },
    { id: "adm_ops", email: "ops@admin.test", name: "Ops", role: "platform_admin", disabledAt: null, createdAt: "2026-10-02T00:00:00Z" },
    { id: "adm_old", email: "old@admin.test", name: "Old", role: "platform_admin", disabledAt: "2026-10-03T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" },
  ];

  it("creates an admin account by email, name and password, and disables another enabled one", async () => {
    const onChanged = vi.fn();
    const calls = stubAdminFetch(() => Response.json({ account: accounts[1], accounts }, { status: 201 }));
    render(<AdminAccounts accounts={accounts} currentAdminId="adm_me" canWrite onChanged={onChanged} />);
    const table = screen.getByRole("table", { name: "Admin accounts" });
    // Only another enabled account can be disabled from here: not yourself, not a disabled one.
    expect(within(table).getAllByRole("button", { name: "Disable" })).toHaveLength(1);
    fireEvent.click(within(table).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ method: "POST", path: "/api/v1/admin/gateway/admin-accounts/adm_ops/disable", body: {} });

    const form = screen.getByRole("form", { name: "Create admin account" });
    type(form, "Email", "new@admin.test");
    type(form, "Name", "New");
    type(form, "Password", "a-long-password-1");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({
      method: "POST",
      path: "/api/v1/admin/gateway/admin-accounts",
      body: { email: "new@admin.test", name: "New", password: "a-long-password-1", role: "platform_admin" },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
    // The password field is cleared after the account is created.
    expect((within(form).getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("creates a support agent account with the role chosen (#356)", async () => {
    const calls = stubAdminFetch(() => Response.json({ account: accounts[1], accounts }, { status: 201 }));
    render(<AdminAccounts accounts={accounts} currentAdminId="adm_me" canWrite onChanged={() => undefined} />);
    const form = screen.getByRole("form", { name: "Create admin account" });
    type(form, "Email", "triage@admin.test");
    type(form, "Name", "Triage");
    type(form, "Password", "a-long-password-2");
    chooseOption("Role", "Support agent", form);
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toMatchObject({ email: "triage@admin.test", role: "support_agent" });
  });

  it("shows the coded refusal inline, such as the last enabled account", async () => {
    stubAdminFetch(() => gatewayError(409, "GATEWAY_LAST_ADMIN_ACCOUNT", "The last enabled admin account cannot be disabled."));
    render(<AdminAccounts accounts={accounts} currentAdminId="adm_me" canWrite onChanged={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(await screen.findByText("GATEWAY_LAST_ADMIN_ACCOUNT")).toBeInTheDocument();
  });

  it("is read-only without admin_accounts.write", () => {
    stubAdminFetch();
    render(<AdminAccounts accounts={accounts} currentAdminId="adm_me" canWrite={false} onChanged={() => undefined} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form", { name: "Create admin account" })).toBeNull();
  });
});

describe("AdminAbuse", () => {
  const abuse: AbuseSignals = {
    windowMinutes: 5,
    rateWindows: [{ subject: "key:gwk_1", requests: 12, tokens: 3400, lastWindowAt: "2026-10-01T00:00:00Z" }],
    inflight: [],
    events: { available: false, reason: "Rate-limited answers are not recorded." },
    signals: [
      {
        signal: "spend",
        windowMinutes: 60,
        threshold: null,
        top: [{ signal: "spend", subjectKind: "tenant", subjectId: "team:a", tenantId: "team:a", value: 2_500_000 }],
      },
      {
        signal: "auth_failures",
        windowMinutes: 60,
        threshold: null,
        top: [{ signal: "auth_failures", subjectKind: "client", subjectId: "0123abcd0123abcd", tenantId: null, value: 40 }],
      },
      { signal: "shared_key", windowMinutes: 60, threshold: null, top: [] },
      {
        signal: "velocity",
        windowMinutes: 5,
        threshold: { windowMinutes: 5, alertAt: 100, suspendAt: 300 },
        top: [{ signal: "velocity", subjectKind: "key", subjectId: "gwk_hot", tenantId: "team:a", value: 320 }],
      },
    ],
    alerts: [
      {
        id: "gwab_1",
        signal: "velocity",
        subjectKind: "key",
        subjectId: "gwk_hot",
        tenantId: "team:a",
        value: 320,
        threshold: 300,
        windowMinutes: 5,
        windowStart: "2026-10-01T00:00:00Z",
        action: "suspend",
        suspensionId: "gws_auto",
        createdAt: "2026-10-01T00:01:00Z",
      },
    ],
    suspensions: [
      {
        id: "gws_auto",
        subjectKind: "key",
        subjectId: "gwk_hot",
        tenantId: "team:a",
        source: "auto",
        signal: "velocity",
        reason: "velocity 320 >= 300 in 5 min",
        actorKind: "system",
        actorId: "threshold:velocity",
        createdAt: "2026-10-01T00:01:00Z",
        liftedAt: null,
        liftedBy: null,
        liftReason: null,
      },
    ],
  };
  const all = { suspend: true, thresholds: true };

  it("shows every signal's top subjects, its threshold, the alerts and suspensions, read-only without permissions", () => {
    stubAdminFetch();
    render(<AdminAbuse abuse={abuse} can={{ suspend: false, thresholds: false }} onChanged={() => undefined} />);
    for (const title of ["Top spenders", "401 spikes", "Shared-key fingerprints", "Request velocity", "Suspensions", "Alerts"])
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Top spenders" })).getByText("2.5 credits")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "401 spikes" })).getByText("0123abcd0123abcd")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Request velocity" })).toHaveTextContent("suspend at 300 within 5 minutes");
    expect(screen.getByRole("region", { name: "Top spenders" })).toHaveTextContent("No threshold: shown, never acted on.");
    expect(within(screen.getByRole("table", { name: "Suspensions" })).getByText("auto · velocity")).toBeInTheDocument();
    expect(screen.getByText("Rate-limited answers are not recorded.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form")).toBeNull();
  });

  it("suspends a measured key by id with a reason; a client fingerprint cannot be selected", async () => {
    const onChanged = vi.fn();
    const calls = stubAdminFetch(() => Response.json({ suspension: abuse.suspensions[0] }, { status: 201 }));
    render(<AdminAbuse abuse={abuse} can={all} onChanged={onChanged} />);
    expect(within(screen.getByRole("table", { name: "401 spikes" })).queryByRole("button")).toBeNull();
    fireEvent.click(within(screen.getByRole("table", { name: "Request velocity" })).getByRole("button", { name: "Select to suspend" }));
    const form = screen.getByRole("form", { name: "Suspend" });
    expect((within(form).getByLabelText("Tenant or key id") as HTMLInputElement).value).toBe("gwk_hot");
    type(form, "Reason", "scraping");
    fireEvent.submit(form);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/admin/gateway/abuse/suspensions",
      body: { subjectKind: "key", subjectId: "gwk_hot", reason: "scraping" },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("lifts an active suspension only with a reason, and shows the server's coded refusal", async () => {
    const calls = stubAdminFetch(() => gatewayError(404, "GATEWAY_SUSPENSION_NOT_FOUND", "No active suspension with this id exists."));
    render(<AdminAbuse abuse={abuse} can={all} onChanged={() => undefined} />);
    const lift = within(screen.getByRole("table", { name: "Suspensions" })).getByRole("button", { name: "Lift" });
    expect(lift).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Lift reason"), { target: { value: "false positive" } });
    fireEvent.click(lift);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/api/v1/admin/gateway/abuse/suspensions/gws_auto/lift",
      body: { reason: "false positive" },
    });
    expect(await screen.findByText("GATEWAY_SUSPENSION_NOT_FOUND")).toBeInTheDocument();
  });

  it("configures a threshold, spend in credits, an empty suspend-at as alert only, and clears one", async () => {
    const calls = stubAdminFetch(() => Response.json({ threshold: null, changed: true }));
    render(<AdminAbuse abuse={abuse} can={all} onChanged={() => undefined} />);
    const spend = screen.getByRole("form", { name: "Top spenders threshold" });
    type(spend, "Window (minutes)", "60");
    type(spend, "Alert at (credits)", "1.5");
    fireEvent.submit(spend);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/api/v1/admin/gateway/abuse/thresholds/spend",
      body: { threshold: { windowMinutes: 60, alertAt: 1_500_000, suspendAt: null } },
    });

    const velocity = screen.getByRole("form", { name: "Request velocity threshold" });
    expect((within(velocity).getByLabelText("Suspend at") as HTMLInputElement).value).toBe("300");
    type(velocity, "Alert at", "zero");
    fireEvent.submit(velocity);
    expect(await screen.findByText("Alert at must be a positive whole number.")).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    fireEvent.click(within(velocity).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ method: "PUT", path: "/api/v1/admin/gateway/abuse/thresholds/velocity", body: { threshold: null } });
  });
});

describe("AdminAudit", () => {

  it("renders audit snapshots read-only and filters through the URL callback", () => {
    const onFiltersChange = vi.fn();
    render(
      <MemoryRouter>
        <AdminAudit
          entries={[
            {
              id: "gwa_1",
              tenantId: "",
              actorKind: "admin",
              actorId: "adm_staff",
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
    // The actor is the admin account: its kind and id.
    expect(within(log).getByText("admin adm_staff (platform_admin)")).toBeInTheDocument();
    expect(within(log).getByText("reason: scheduled")).toBeInTheDocument();
    expect(within(log).queryByRole("button")).toBeNull();
    const form = screen.getByRole("region", { name: "Filters" }).querySelector("form")!;
    type(form, "Action", "upstream");
    type(form, "Actor id", "adm_staff");
    fireEvent.submit(form);
    expect(onFiltersChange).toHaveBeenCalledWith({ action: "upstream", actorId: "adm_staff" });
  });
});
