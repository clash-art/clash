/**
 * Team settings (#354): the product page where a team owner runs the team
 * (members and roles, invites, the team wallet's packages and top-ups,
 * member and key budgets with hard/soft/alert enforcement, rate limits) and
 * a member sees only their own role, budget, keys and usage. Every control
 * calls the product API (lib/teamClient.ts); the server authorizes each call
 * and refusals are shown with their code. Owner controls are not rendered
 * for a member.
 */
import { useState } from "react";
import { Link } from "react-router";

import {
  BUDGET_ENFORCEMENTS,
  describeRateLimit,
  formatCredits,
  parseCredits,
  type BudgetEnforcement,
  type GatewayKey,
  type Subscription,
} from "../../lib/adminClient";
import { isBillingPluginEnabled } from "../../lib/consolePlugins";
import {
  formatPrice,
  teamApi,
  teamCan,
  type BudgetEvent,
  type Team,
  type TeamAuditEntry,
  type TeamBudget,
  type TeamInvite,
  type TeamMember,
  type TeamPackage,
  type TeamRole,
  type TeamSelf,
  type TeamTenant,
  type TeamTopupPack,
  type TeamUsage,
  type TeamWallet,
} from "../../lib/teamClient";
import {
  AdminCard,
  AdminErrorAlert,
  AdminField,
  AdminSection,
  AdminTable,
  StatusPill,
  formatTime,
  saveDownload,
  useAdminAction,
} from "../admin/AdminKit";
import { RateLimitForm } from "../admin/RateLimitForm";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { SelectMenu } from "../ui/select";

/** Everything the owner view shows, loaded by the route. */
export interface TeamOwnerData {
  tenant: TeamTenant;
  members: TeamMember[];
  invites: TeamInvite[];
  budgets: TeamBudget[];
  wallet: TeamWallet | null;
  subscription: Subscription | null;
  events: BudgetEvent[];
  keys: GatewayKey[];
  packages: TeamPackage[];
  packs: TeamTopupPack[];
  usage: TeamUsage[];
  /** The page after `usage`; null or absent on the last page. */
  usageCursor?: string | null;
  audit: TeamAuditEntry[];
}

export type TeamView = { kind: "owner"; data: TeamOwnerData } | { kind: "member"; data: TeamSelf };

const ROLE_OPTIONS: Array<{ value: TeamRole; label: string }> = [
  { value: "member", label: "Member" },
  { value: "owner", label: "Owner" },
];

const ENFORCEMENT_LABELS: Record<BudgetEnforcement, string> = {
  hard: "Hard: refuse over the limit",
  soft: "Soft: allow and flag",
  alert: "Alert: allow and notify",
};

const idempotencyKey = () => `team-${crypto.randomUUID()}`;
const label = "flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300";

export function TeamSettings({
  teams,
  team,
  view,
  onSelect,
  onChanged,
}: {
  teams: Team[];
  team: Team | null;
  view: TeamView | null;
  onSelect: (tenantId: string) => void;
  onChanged: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Team settings</h1>
          <p className="text-sm text-stone-500">Members, credits and limits for the Clash official model gateway.</p>
        </div>
        {teams.length ? (
          <label className={label}>
            <span>Team</span>
            <SelectMenu
              ariaLabel="Team"
              variant="field"
              size="sm"
              value={team?.tenantId ?? ""}
              options={teams.map((entry) => ({ value: entry.tenantId, label: `${entry.name} · ${entry.role}` }))}
              onValueChange={onSelect}
            />
          </label>
        ) : null}
      </header>
      <CreateTeamForm onCreated={(created) => onSelect(created.tenantId)} />
      {/* Keyed by team: forms never carry one team's selections into another's. */}
      {team && view?.kind === "owner" ? <TeamOwnerSettings key={team.tenantId} team={team} data={view.data} onChanged={onChanged} /> : null}
      {team && view?.kind === "member" ? <TeamSelfView key={team.tenantId} data={view.data} /> : null}
      {!team ? <p className="text-sm text-stone-500">You are not in a team yet. Create one, or open an invite link from a team owner.</p> : null}
    </div>
  );
}

function CreateTeamForm({ onCreated }: { onCreated: (team: Team) => void }) {
  const [name, setName] = useState("");
  const action = useAdminAction();
  return (
    <AdminCard>
      <form
        aria-label="Create team"
        className="flex flex-wrap items-end gap-3"
        onSubmit={action.submit(async () => {
          const { team } = await teamApi.createTeam(name.trim());
          setName("");
          onCreated(team);
        })}
      >
        <AdminField label="New team name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" size="sm" disabled={action.pending || !name.trim()}>
          Create team
        </Button>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

// ─── Owner ────────────────────────────────────────────────────────────────

export function TeamOwnerSettings({ team, data, onChanged }: { team: Team; data: TeamOwnerData; onChanged: () => void }) {
  const tenantId = team.tenantId;
  const isTeam = data.tenant.kind === "team";
  const nameOf = (userId: string) => {
    const member = data.members.find((entry) => entry.userId === userId);
    return member?.name ?? member?.email ?? userId;
  };
  const subjectName = (scope: string, scopeId: string) =>
    scope === "user" ? nameOf(scopeId) : (data.keys.find((key) => key.id === scopeId)?.name ?? scopeId);
  return (
    <>
      <AdminSection title="Members" description="Owners manage the team; members use the gateway and see their own usage. A team keeps at least one owner.">
        <AdminTable
          label="Members"
          rows={data.members}
          rowKey={(row) => row.userId}
          empty="No members."
          columns={[
            {
              header: "Member",
              cell: (row) => (
                <div>
                  <div className="font-medium">{row.name ?? row.userId}</div>
                  <div className="text-xs text-stone-500">{row.email ?? row.userId}</div>
                </div>
              ),
            },
            { header: "Role", cell: (row) => <MemberRole tenantId={tenantId} member={row} onChanged={onChanged} /> },
            {
              header: "Rate limit",
              cell: (row) => (
                <RateLimitForm
                  label={`Rate limit for ${row.name ?? row.userId}`}
                  value={row.rateLimit}
                  onSave={(rateLimit) => teamApi.setMemberRateLimit(tenantId, row.userId, rateLimit)}
                  onDone={onChanged}
                />
              ),
            },
            ...(isTeam ? [{ header: "", cell: (row: TeamMember) => <RemoveMember tenantId={tenantId} member={row} onChanged={onChanged} /> }] : []),
          ]}
        />
      </AdminSection>

      {isTeam ? <TeamInvites tenantId={tenantId} invites={data.invites} onChanged={onChanged} /> : null}

      <TeamWalletSection
        tenantId={tenantId}
        wallet={data.wallet}
        subscription={data.subscription}
        packages={data.packages}
        packs={data.packs}
        onChanged={onChanged}
      />

      <AdminSection
        title="Member and key budgets"
        description="Caps you allocate from the team wallet. Hard refuses over the limit, soft allows and flags, alert allows and notifies at the threshold."
      >
        <BudgetTable label="Budgets" budgets={data.budgets.filter((budget) => budget.scope !== "tenant")} subjectName={subjectName} />
        <BudgetForm tenantId={tenantId} members={data.members} keys={data.keys} budgets={data.budgets} onChanged={onChanged} />
      </AdminSection>

      <AdminSection title="Budget notifications" description="Requests allowed past a soft limit, and alert thresholds crossed.">
        <BudgetEventTable events={data.events} subjectName={subjectName} />
      </AdminSection>

      <AdminSection title="Rate limits" description="Requests and tokens per minute, requests and media jobs in flight. Empty fields clear a limit.">
        <AdminCard className="space-y-2">
          <div className="text-sm font-medium">Whole team</div>
          <RateLimitForm
            label="Team rate limit"
            value={data.tenant.rateLimit}
            onSave={(rateLimit) => teamApi.setTenantRateLimit(tenantId, rateLimit)}
            onDone={onChanged}
          />
          {data.subscription?.rateLimit ? (
            <p className="text-xs text-stone-500">Your package also limits the team to {describeRateLimit(data.subscription.rateLimit)}; the tighter limit applies.</p>
          ) : null}
        </AdminCard>
        <AdminTable
          label="Virtual keys"
          rows={data.keys}
          rowKey={(row) => row.id}
          empty="The team has no virtual keys."
          columns={[
            {
              header: "Key",
              cell: (row) => (
                <div>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-stone-500">
                    {row.tokenPrefix}… · {nameOf(row.userId)}
                    {row.revokedAt ? " · revoked" : ""}
                  </div>
                </div>
              ),
            },
            {
              header: "Rate limit",
              cell: (row) => (
                <RateLimitForm
                  label={`Rate limit for key ${row.name}`}
                  value={row.rateLimit}
                  onSave={(rateLimit) => teamApi.setKeyRateLimit(tenantId, row.id, rateLimit)}
                  onDone={onChanged}
                />
              ),
            },
          ]}
        />
      </AdminSection>

      <TeamUsageSection tenantId={tenantId} usage={data.usage} nextCursor={data.usageCursor ?? null} nameOf={nameOf} />

      <AdminSection title="Audit log" description="Every change to this team, with who made it.">
        <AdminTable
          label="Audit log"
          rows={data.audit}
          rowKey={(row) => row.id}
          empty="No changes yet."
          columns={[
            { header: "When", cell: (row) => formatTime(row.occurredAt) },
            { header: "Who", cell: (row) => `${nameOf(row.actorId)}${row.actorRole ? ` (${row.actorRole})` : ""}` },
            { header: "Action", cell: (row) => row.action },
            { header: "Target", cell: (row) => row.targetId },
            { header: "Reason", cell: (row) => row.reason ?? "—" },
          ]}
        />
      </AdminSection>
    </>
  );
}

function MemberRole({ tenantId, member, onChanged }: { tenantId: string; member: TeamMember; onChanged: () => void }) {
  const action = useAdminAction(onChanged);
  return (
    <div className="space-y-1">
      <SelectMenu
        ariaLabel={`Role of ${member.name ?? member.userId}`}
        variant="field"
        size="sm"
        value={member.role}
        options={ROLE_OPTIONS}
        disabled={action.pending}
        onValueChange={(role) => void action.run(() => teamApi.setRole(tenantId, member.userId, role as TeamRole))}
      />
      <AdminErrorAlert error={action.error} />
    </div>
  );
}

function RemoveMember({ tenantId, member, onChanged }: { tenantId: string; member: TeamMember; onChanged: () => void }) {
  const action = useAdminAction(onChanged);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="destructive"
        disabled={action.pending}
        aria-label={`Remove ${member.name ?? member.userId}`}
        onClick={() => void action.run(() => teamApi.removeMember(tenantId, member.userId))}
      >
        Remove
      </Button>
      <AdminErrorAlert error={action.error} />
    </div>
  );
}

function TeamInvites({ tenantId, invites, onChanged }: { tenantId: string; invites: TeamInvite[]; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const action = useAdminAction(onChanged);
  const revoke = useAdminAction(onChanged);
  return (
    <AdminSection title="Invites" description="An invite link works once, for the invited email, for 7 days.">
      <AdminCard className="space-y-3">
        <form
          aria-label="Invite member"
          className="grid gap-3 sm:grid-cols-[2fr_1fr_auto]"
          onSubmit={action.submit(async () => {
            const created = await teamApi.invite(tenantId, email.trim(), role);
            setLink(new URL(created.acceptPath, window.location.origin).toString());
            setEmail("");
          })}
        >
          <AdminField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label className={label}>
            <span>Role</span>
            <SelectMenu ariaLabel="Invite role" variant="field" size="sm" value={role} options={ROLE_OPTIONS} onValueChange={(value) => setRole(value as TeamRole)} />
          </label>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
              Invite
            </Button>
          </div>
        </form>
        {link ? <AdminField label="Invite link (shown once)" value={link} readOnly onFocus={(e) => e.currentTarget.select()} /> : null}
        <AdminErrorAlert error={action.error} />
      </AdminCard>
      <AdminTable
        label="Pending invites"
        rows={invites}
        rowKey={(row) => row.id}
        empty="No pending invites."
        columns={[
          { header: "Email", cell: (row) => row.email },
          { header: "Role", cell: (row) => row.role },
          { header: "Expires", cell: (row) => formatTime(row.expiresAt) },
          {
            header: "",
            cell: (row) => (
              <Button type="button" size="sm" aria-label={`Revoke invite for ${row.email}`} disabled={revoke.pending} onClick={() => void revoke.run(() => teamApi.revokeInvite(tenantId, row.id))}>
                Revoke
              </Button>
            ),
          },
        ]}
      />
      <AdminErrorAlert error={revoke.error} />
    </AdminSection>
  );
}

function TeamWalletSection({
  tenantId,
  wallet,
  subscription,
  packages,
  packs,
  onChanged,
}: {
  tenantId: string;
  wallet: TeamWallet | null;
  subscription: Subscription | null;
  packages: TeamPackage[];
  packs: TeamTopupPack[];
  onChanged: () => void;
}) {
  const action = useAdminAction(onChanged);
  const live = subscription && (subscription.status === "active" || subscription.status === "trialing");
  return (
    <AdminSection title="Team wallet" description="Packages and top-ups fund the whole team; every member's requests draw on it.">
      {isBillingPluginEnabled() ? (
        <p className="text-sm text-stone-600">
          Purchases go through the hosted billing page (payment provider checkout).{" "}
          <Link to="/billing" className="font-medium underline underline-offset-2">
            Open billing
          </Link>
        </p>
      ) : null}
      <AdminCard className="grid gap-3 sm:grid-cols-4">
        {wallet ? (
          <>
            <div>
              <div className="text-xs text-stone-500">Available</div>
              <div className="font-display text-2xl font-semibold tabular-nums">{formatCredits(wallet.availableMicroCredits)}</div>
            </div>
            <div className="text-sm">Credits {formatCredits(wallet.limitMicroCredits)}</div>
            <div className="text-sm">Used {formatCredits(wallet.spentMicroCredits)}</div>
            <div>
              <StatusPill tone={wallet.status === "active" ? "ok" : "warn"}>{wallet.status}</StatusPill>
            </div>
          </>
        ) : (
          <p className="text-sm text-stone-500 sm:col-span-4">No credits yet: buy a package or a top-up to fund the team.</p>
        )}
      </AdminCard>
      {subscription ? (
        <AdminCard className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            Package <code>{packages.find((entry) => entry.id === subscription.packageId)?.name ?? subscription.packageId}</code> · {subscription.status} · renews{" "}
            {formatTime(subscription.currentPeriodEnd)}
          </div>
          {live ? (
            <Button type="button" size="sm" disabled={action.pending} onClick={() => void action.run(() => teamApi.cancelSubscription(tenantId))}>
              Cancel at period end
            </Button>
          ) : null}
        </AdminCard>
      ) : null}
      <AdminTable
        label="Packages"
        rows={packages}
        rowKey={(row) => row.id}
        empty="No packages are offered."
        columns={[
          { header: "Package", cell: (row) => row.name },
          { header: "Credits per period", cell: (row) => `${formatCredits(row.periodMicroCredits)} / ${row.billingPeriod}`, align: "right" },
          { header: "Price", cell: (row) => formatPrice(row.priceMinor, row.priceCurrency), align: "right" },
          {
            header: "",
            cell: (row) =>
              isBillingPluginEnabled() ? (
                <Link
                  to="/billing"
                  aria-label={`Subscribe to ${row.name} on Billing`}
                  className="inline-flex h-8 items-center rounded-md border border-warm-border bg-warm-surface px-3 text-xs font-medium hover:bg-warm-hover"
                >
                  Billing
                </Link>
              ) : (
                <Button type="button" size="sm" aria-label={`Subscribe to ${row.name}`} disabled={action.pending || Boolean(live)} onClick={() => void action.run(() => teamApi.subscribe(tenantId, row.id, idempotencyKey()))}>
                  Subscribe
                </Button>
              ),
          },
        ]}
      />
      <AdminTable
        label="Top-up packs"
        rows={packs}
        rowKey={(row) => row.id}
        empty="No top-up packs are offered."
        columns={[
          { header: "Pack", cell: (row) => row.name },
          { header: "Credits", cell: (row) => formatCredits(row.microCredits), align: "right" },
          { header: "Price", cell: (row) => formatPrice(row.priceMinor, row.priceCurrency), align: "right" },
          {
            header: "",
            cell: (row) =>
              isBillingPluginEnabled() ? (
                <Link
                  to="/billing"
                  aria-label={`Buy ${row.name} on Billing`}
                  className="inline-flex h-8 items-center rounded-md border border-warm-border bg-warm-surface px-3 text-xs font-medium hover:bg-warm-hover"
                >
                  Billing
                </Link>
              ) : (
                <Button type="button" size="sm" aria-label={`Buy ${row.name}`} disabled={action.pending} onClick={() => void action.run(() => teamApi.topup(tenantId, row.id, idempotencyKey()))}>
                  Buy
                </Button>
              ),
          },
        ]}
      />
      <AdminErrorAlert error={action.error} />
    </AdminSection>
  );
}

function BudgetTable({ label, budgets, subjectName }: { label: string; budgets: TeamBudget[]; subjectName: (scope: string, scopeId: string) => string }) {
  return (
    <AdminTable
      label={label}
      rows={budgets}
      rowKey={(row) => row.id}
      empty="No budgets allocated."
      columns={[
        { header: "For", cell: (row) => `${row.scope === "user" ? "Member" : "Key"} · ${subjectName(row.scope, row.scopeId)}` },
        { header: "Enforcement", cell: (row) => row.enforcement },
        { header: "Status", cell: (row) => <StatusPill tone={row.status === "active" ? "ok" : "warn"}>{row.status}</StatusPill> },
        { header: "Limit", cell: (row) => formatCredits(row.limitMicroCredits), align: "right" },
        { header: "Used", cell: (row) => formatCredits(row.spentMicroCredits), align: "right" },
        { header: "Left", cell: (row) => formatCredits(row.availableMicroCredits), align: "right" },
        { header: "Alert at", cell: (row) => (row.alertThresholdPct ?? (row.enforcement === "alert" ? 100 : null)) === null ? "—" : `${row.alertThresholdPct ?? 100}%` },
      ]}
    />
  );
}

function BudgetForm({
  tenantId,
  members,
  keys,
  budgets,
  onChanged,
}: {
  tenantId: string;
  members: TeamMember[];
  keys: GatewayKey[];
  budgets: TeamBudget[];
  onChanged: () => void;
}) {
  const subjects = [
    ...members.map((member) => ({ value: `user:${member.userId}`, label: `Member · ${member.name ?? member.email ?? member.userId}` })),
    ...keys.filter((key) => !key.revokedAt).map((key) => ({ value: `key:${key.id}`, label: `Key · ${key.name}` })),
  ];
  const budgetOf = (value: string) => budgets.find((budget) => `${budget.scope}:${budget.scopeId}` === value);
  const [subject, setSubject] = useState(subjects[0]?.value ?? "");
  const existing = budgetOf(subject);
  const [limit, setLimit] = useState("");
  const [enforcement, setEnforcement] = useState<BudgetEnforcement>(existing?.enforcement ?? "hard");
  const [threshold, setThreshold] = useState(existing?.alertThresholdPct?.toString() ?? "");
  const [status, setStatus] = useState<"active" | "suspended">(existing?.status === "suspended" ? "suspended" : "active");
  // Each subject starts from its own budget, so saving never carries another's settings over.
  const selectSubject = (value: string) => {
    const next = budgetOf(value);
    setSubject(value);
    setEnforcement(next?.enforcement ?? "hard");
    setThreshold(next?.alertThresholdPct?.toString() ?? "");
    setStatus(next?.status === "suspended" ? "suspended" : "active");
  };
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const action = useAdminAction(onChanged);
  if (subjects.length === 0) return null;
  return (
    <AdminCard>
      <form
        aria-label="Allocate budget"
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={action.submit(async () => {
          const [scope, ...rest] = subject.split(":");
          const limitMicroCredits = limit.trim() === "" ? null : parseCredits(limit);
          if (limit.trim() !== "" && (limitMicroCredits === null || limitMicroCredits < 0)) throw new Error("The limit must be a number of credits.");
          const pct = threshold.trim() === "" ? null : Number(threshold.trim());
          if (pct !== null && !(Number.isInteger(pct) && pct >= 1 && pct <= 100)) throw new Error("The alert threshold is a whole percent from 1 to 100.");
          if (override && !reason.trim()) throw new Error("An override needs a reason.");
          await teamApi.setBudget(tenantId, scope as "user" | "key", rest.join(":"), {
            limitMicroCredits,
            status,
            enforcement,
            alertThresholdPct: pct,
            ...(override ? { override: true as const } : {}),
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          });
          setLimit("");
          setReason("");
          setOverride(false);
        })}
      >
        <label className={label}>
          <span>Member or key</span>
          <SelectMenu ariaLabel="Budget for" variant="field" size="sm" value={subject} options={subjects} onValueChange={selectSubject} />
        </label>
        <AdminField
          label="Limit (credits)"
          hint={existing ? `now ${formatCredits(existing.limitMicroCredits)}; empty = unlimited` : "empty = unlimited (the wallet still caps it)"}
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <label className={label}>
          <span>Enforcement</span>
          <SelectMenu
            ariaLabel="Enforcement"
            variant="field"
            size="sm"
            value={enforcement}
            options={BUDGET_ENFORCEMENTS.map((value) => ({ value, label: ENFORCEMENT_LABELS[value] }))}
            onValueChange={(value) => setEnforcement(value as BudgetEnforcement)}
          />
        </label>
        <AdminField label="Alert at (% of limit)" hint="empty = no alert (alert budgets: 100%)" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        <label className={label}>
          <span>Status</span>
          <SelectMenu
            ariaLabel="Budget status"
            variant="field"
            size="sm"
            value={status}
            options={[
              { value: "active", label: "Active" },
              { value: "suspended", label: "Suspended" },
            ]}
            onValueChange={(value) => setStatus(value as "active" | "suspended")}
          />
        </label>
        <AdminField label="Reason" hint="required for an override; kept in the audit log" value={reason} onChange={(e) => setReason(e.target.value)} />
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox aria-label="Override usage check" checked={override} onCheckedChange={(checked) => setOverride(checked === true)} />
          <span>Override: allow a limit below what is already used and reserved</span>
        </label>
        <div className="flex items-end">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
            Save budget
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

function BudgetEventTable({ events, subjectName }: { events: BudgetEvent[]; subjectName: (scope: string, scopeId: string) => string }) {
  return (
    <AdminTable
      label="Budget notifications"
      rows={events}
      rowKey={(row) => row.id}
      empty="No budget notifications."
      columns={[
        { header: "When", cell: (row) => formatTime(row.occurredAt) },
        { header: "For", cell: (row) => subjectName(row.scope, row.scopeId) },
        {
          header: "What",
          cell: (row) => (
            <StatusPill tone="warn">{row.kind === "soft_exceeded" ? "Allowed past soft limit" : `Alert: ${row.thresholdPct ?? 100}% reached`}</StatusPill>
          ),
        },
        { header: "Used", cell: (row) => formatCredits(row.spentMicroCredits + row.reservedMicroCredits), align: "right" },
        { header: "Limit", cell: (row) => formatCredits(row.limitMicroCredits), align: "right" },
      ]}
    />
  );
}

/** The owner's usage: every member's requests, older pages on demand, and the CSV export. */
function TeamUsageSection({
  tenantId,
  usage,
  nextCursor,
  nameOf,
}: {
  tenantId: string;
  usage: TeamUsage[];
  nextCursor: string | null;
  nameOf: (userId: string) => string;
}) {
  const [older, setOlder] = useState<{ rows: TeamUsage[]; cursor: string | null }>({ rows: [], cursor: nextCursor });
  const more = useAdminAction();
  const exporting = useAdminAction();
  return (
    <AdminSection
      title="Usage"
      description="Every member's requests, newest first. Failed media generations are shown at zero, not charged."
      actions={
        <Button
          size="sm"
          disabled={exporting.pending}
          onClick={() => void exporting.run(async () => saveDownload(await teamApi.usageExport(tenantId)))}
        >
          Export CSV
        </Button>
      }
    >
      <AdminErrorAlert error={exporting.error ?? more.error} />
      <UsageTable usage={[...usage, ...older.rows]} nameOf={nameOf} />
      {older.cursor ? (
        <Button
          size="sm"
          disabled={more.pending}
          onClick={() =>
            void more.run(async () => {
              const page = await teamApi.usage(tenantId, { cursor: older.cursor! });
              setOlder({ rows: [...older.rows, ...page.usage], cursor: page.nextCursor });
            })
          }
        >
          Load older
        </Button>
      ) : null}
    </AdminSection>
  );
}

function UsageTable({ usage, nameOf }: { usage: TeamUsage[]; nameOf?: (userId: string) => string }) {
  return (
    <AdminTable
      label="Usage"
      rows={usage}
      rowKey={(row) => row.requestId}
      empty="No requests yet."
      columns={[
        { header: "When", cell: (row) => formatTime(row.occurredAt) },
        ...(nameOf ? [{ header: "Member", cell: (row: TeamUsage) => nameOf(row.userId) }] : []),
        { header: "Model", cell: (row) => row.modelCode },
        {
          header: "Status",
          cell: (row) => (
            <span className="flex flex-wrap items-center gap-1">
              {row.status}
              {row.notCharged ? <StatusPill tone="muted">not charged</StatusPill> : null}
            </span>
          ),
        },
        { header: "Tokens in / out", cell: (row) => `${row.inputTokens} / ${row.outputTokens}`, align: "right" },
        { header: "Credits", cell: (row) => formatCredits(row.costMicroCredits), align: "right" },
      ]}
    />
  );
}

// ─── Member ───────────────────────────────────────────────────────────────

/** A member's own role, budget, keys and usage: never another member's. */
export function TeamSelfView({ data }: { data: TeamSelf }) {
  const subjectName = (scope: string, scopeId: string) =>
    scope === "user" ? "You" : (data.keys.find((key) => key.id === scopeId)?.name ?? scopeId);
  const exporting = useAdminAction();
  return (
    <>
      <AdminSection title={data.tenant.name} description={`You are a ${data.member.role} of this team.`}>
        {data.member.rateLimit ? <p className="text-sm">Your rate limit: {describeRateLimit(data.member.rateLimit)}</p> : null}
      </AdminSection>
      <AdminSection title="Your budget" description="Allocated by the team owner from the team wallet.">
        <BudgetTable label="Your budgets" budgets={data.budgets} subjectName={subjectName} />
      </AdminSection>
      <AdminSection title="Your keys">
        <AdminTable
          label="Your keys"
          rows={data.keys}
          rowKey={(row) => row.id}
          empty="You have no virtual keys in this team."
          columns={[
            { header: "Key", cell: (row) => `${row.name} (${row.tokenPrefix}…)${row.revokedAt ? " · revoked" : ""}` },
            { header: "Rate limit", cell: (row) => describeRateLimit(row.rateLimit) },
          ]}
        />
      </AdminSection>
      <AdminSection title="Your budget notifications">
        <BudgetEventTable events={data.events} subjectName={subjectName} />
      </AdminSection>
      <AdminSection
        title="Your usage"
        actions={
          <Button
            size="sm"
            disabled={exporting.pending}
            onClick={() => void exporting.run(async () => saveDownload(await teamApi.myUsageExport(data.tenant.id)))}
          >
            Export CSV
          </Button>
        }
      >
        <AdminErrorAlert error={exporting.error} />
        <UsageTable usage={data.usage} />
      </AdminSection>
    </>
  );
}

export { teamCan };
