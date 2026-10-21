/**
 * Budgets & limits page (#353): the tenant wallet, member and key budgets,
 * virtual key rate limits and (platform staff) wallet corrections and the
 * subscription's tenant rate limit. Owner allocation UI is #354; this is the
 * admin side over the same API.
 */
import { useState } from "react";

import {
  adminApi,
  formatCredits,
  parseCredits,
  type Budget,
  type GatewayKey,
  type Subscription,
  type TenantMember,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, formatTime, useAdminAction } from "./AdminKit";
import { RateLimitForm } from "./RateLimitForm";

export interface BudgetPermissions {
  budgetsWrite: boolean;
  limitsWrite: boolean;
  walletAdjust: boolean;
  subscriptionLimits: boolean;
}

export function AdminBudgets({
  tenantId,
  wallet,
  budgets,
  subscription,
  keys,
  members,
  can,
  onChanged,
}: {
  tenantId: string;
  wallet: Budget | null;
  budgets: Budget[];
  subscription: Subscription | null;
  keys: GatewayKey[];
  members: TenantMember[];
  can: BudgetPermissions;
  onChanged: () => void;
}) {
  const allocated = budgets.filter((budget) => budget.scope !== "tenant");
  return (
    <>
      <AdminSection title="Tenant wallet" description="Funded by purchases and platform corrections; every request also draws on it.">
        <AdminCard className="grid gap-3 sm:grid-cols-4">
          {wallet ? (
            <>
              <div>
                <div className="text-xs text-stone-500">Available</div>
                <div className="font-display text-2xl font-semibold tabular-nums">{formatCredits(wallet.availableMicroCredits)}</div>
              </div>
              <div className="text-sm">Limit {formatCredits(wallet.limitMicroCredits)}</div>
              <div className="text-sm">
                Spent {formatCredits(wallet.spentMicroCredits)} · held {formatCredits(wallet.reservedMicroCredits)}
              </div>
              <div>
                <StatusPill tone={wallet.status === "active" ? "ok" : "warn"}>{wallet.status}</StatusPill>
              </div>
            </>
          ) : (
            <p className="text-sm text-stone-500 sm:col-span-4">No wallet yet: it is created by the first purchase or correction.</p>
          )}
        </AdminCard>
        {can.walletAdjust ? <WalletForms tenantId={tenantId} wallet={wallet} onChanged={onChanged} /> : null}
      </AdminSection>

      <AdminSection title="Member and key budgets" description="Caps drawn alongside the wallet. A limit cannot go below spend plus open holds.">
        <AdminTable
          label="Budgets"
          rows={allocated}
          rowKey={(row) => row.id}
          empty="No member or key budgets."
          columns={[
            { header: "Scope", cell: (row) => `${row.scope}: ${row.scopeId}` },
            { header: "Status", cell: (row) => <StatusPill tone={row.status === "active" ? "ok" : "warn"}>{row.status}</StatusPill> },
            { header: "Limit", cell: (row) => formatCredits(row.limitMicroCredits), align: "right" },
            { header: "Spent", cell: (row) => formatCredits(row.spentMicroCredits), align: "right" },
            { header: "Held", cell: (row) => formatCredits(row.reservedMicroCredits), align: "right" },
          ]}
        />
        {can.budgetsWrite ? <BudgetForm tenantId={tenantId} members={members} keys={keys} budgets={allocated} onChanged={onChanged} /> : null}
      </AdminSection>

      <AdminSection title="Virtual keys" description="Per-key rate limits; empty fields clear the limit.">
        <AdminTable
          label="Virtual keys"
          rows={keys}
          rowKey={(row) => row.id}
          empty="This tenant has no virtual keys."
          columns={[
            {
              header: "Key",
              cell: (row) => (
                <div>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-stone-500">
                    {row.tokenPrefix}… · {row.userId}
                    {row.revokedAt ? " · revoked" : ""}
                  </div>
                </div>
              ),
            },
            { header: "Last used", cell: (row) => formatTime(row.lastUsedAt) },
            {
              header: "Rate limit",
              cell: (row) => (
                <RateLimitForm
                  label={`Rate limit for key ${row.name}`}
                  value={row.rateLimit}
                  disabled={!can.limitsWrite}
                  onSave={(rateLimit) => adminApi.setKeyRateLimit(tenantId, row.id, rateLimit)}
                  onDone={onChanged}
                />
              ),
            },
          ]}
        />
      </AdminSection>

      <AdminSection title="Subscription" description="The live subscription's tenant-wide rate limit (copied from its package).">
        {subscription ? (
          <AdminCard className="space-y-3">
            <div className="text-sm">
              Package <code>{subscription.packageId}</code> · {subscription.status} · period ends {formatTime(subscription.currentPeriodEnd)}
            </div>
            <RateLimitForm
              label="Tenant rate limit"
              value={subscription.rateLimit}
              disabled={!can.subscriptionLimits}
              onSave={(rateLimit) => adminApi.setSubscriptionRateLimit(tenantId, rateLimit)}
              onDone={onChanged}
            />
          </AdminCard>
        ) : (
          <p className="text-sm text-stone-500">No live subscription, so no tenant-wide rate limit applies.</p>
        )}
      </AdminSection>
    </>
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
  members: TenantMember[];
  keys: GatewayKey[];
  budgets: Budget[];
  onChanged: () => void;
}) {
  const subjects = [
    ...members.map((member) => ({ value: `user:${member.userId}`, label: `Member · ${member.name ?? member.userId}` })),
    ...keys.map((key) => ({ value: `key:${key.id}`, label: `Key · ${key.name}` })),
  ];
  const [subject, setSubject] = useState(subjects[0]?.value ?? "");
  const [limit, setLimit] = useState("");
  const [status, setStatus] = useState<"active" | "suspended">("active");
  const [reason, setReason] = useState("");
  const action = useAdminAction(onChanged);
  if (subjects.length === 0) return null;
  const existing = budgets.find((budget) => `${budget.scope}:${budget.scopeId}` === subject);
  return (
    <AdminCard>
      <form
        aria-label="Set budget"
        className="grid gap-3 sm:grid-cols-5"
        onSubmit={action.submit(async () => {
          const [scope, ...rest] = subject.split(":");
          const limitMicroCredits = limit.trim() === "" ? null : parseCredits(limit);
          if (limit.trim() !== "" && limitMicroCredits === null) throw new Error("The limit must be a number of credits.");
          await adminApi.setBudget(tenantId, scope as "user" | "key", rest.join(":"), {
            limitMicroCredits,
            status,
            ...(reason.trim() ? { reason: reason.trim() } : {}),
          });
          setLimit("");
          setReason("");
        })}
      >
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
          <span>Member or key</span>
          <SelectMenu ariaLabel="Budget subject" variant="field" size="sm" value={subject} options={subjects} onValueChange={setSubject} />
        </label>
        <AdminField
          label="Limit (credits)"
          hint={existing ? `now ${formatCredits(existing.limitMicroCredits)}; empty = unlimited` : "empty = unlimited"}
          inputMode="decimal"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
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
            onValueChange={setStatus}
          />
        </label>
        <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
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

function WalletForms({ tenantId, wallet, onChanged }: { tenantId: string; wallet: Budget | null; onChanged: () => void }) {
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [statusReason, setStatusReason] = useState("");
  const adjust = useAdminAction(onChanged);
  const status = useAdminAction(onChanged);
  const suspended = wallet?.status === "suspended";
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <AdminCard>
        <form
          aria-label="Correct wallet"
          className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
          onSubmit={adjust.submit(async () => {
            const micro = parseCredits(delta);
            if (micro === null || micro === 0) throw new Error("Enter a non-zero number of credits (negative to debit).");
            await adminApi.adjustWallet(tenantId, {
              deltaMicroCredits: micro,
              reason: reason.trim(),
              idempotencyKey: `console-${crypto.randomUUID()}`,
            });
            setDelta("");
            setReason("");
          })}
        >
          <AdminField label="Credit correction" hint="negative debits" inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} required />
          <AdminField label="Correction reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={adjust.pending}>
              Apply
            </Button>
          </div>
        </form>
        <AdminErrorAlert error={adjust.error} />
      </AdminCard>
      {wallet ? (
        <AdminCard>
          <form
            aria-label="Wallet status"
            className="grid gap-3 sm:grid-cols-[2fr_auto]"
            onSubmit={status.submit(() => adminApi.setWalletStatus(tenantId, suspended ? "active" : "suspended", statusReason.trim()))}
          >
            <AdminField label="Status reason" value={statusReason} onChange={(e) => setStatusReason(e.target.value)} required />
            <div className="flex items-end">
              <Button type="submit" size="sm" variant={suspended ? "default" : "destructive"} disabled={status.pending}>
                {suspended ? "Reactivate wallet" : "Suspend wallet"}
              </Button>
            </div>
          </form>
          <AdminErrorAlert error={status.error} />
        </AdminCard>
      ) : null}
    </div>
  );
}
