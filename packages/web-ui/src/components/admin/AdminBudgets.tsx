/**
 * Budgets & limits page (#353): the tenant wallet, member and key budgets and
 * virtual key rate limits, read-only, plus the platform levers (wallet
 * corrections and status, the subscription's tenant rate limit). Team owners
 * allocate member and key budgets and set key, member and tenant limits in
 * team settings (#354, TeamSettings); the console only views them.
 */
import { useState } from "react";

import {
  adminApi,
  describeRateLimit,
  formatCredits,
  parseCredits,
  type Budget,
  type GatewayKey,
  type Subscription,
  type TenantMember,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, formatTime, useAdminAction } from "./AdminKit";
import { RateLimitForm } from "./RateLimitForm";

export interface BudgetPermissions {
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
  const subjectName = (budget: Budget) =>
    budget.scope === "user"
      ? (members.find((member) => member.userId === budget.scopeId)?.name ?? budget.scopeId)
      : (keys.find((key) => key.id === budget.scopeId)?.name ?? budget.scopeId);
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

      <AdminSection title="Member and key budgets" description="Allocated by the team owner in team settings; drawn alongside the wallet.">
        <AdminTable
          label="Budgets"
          rows={allocated}
          rowKey={(row) => row.id}
          empty="No member or key budgets."
          columns={[
            { header: "Scope", cell: (row) => `${row.scope}: ${subjectName(row)}` },
            { header: "Status", cell: (row) => <StatusPill tone={row.status === "active" ? "ok" : "warn"}>{row.status}</StatusPill> },
            { header: "Enforcement", cell: (row) => row.enforcement ?? "hard" },
            { header: "Limit", cell: (row) => formatCredits(row.limitMicroCredits), align: "right" },
            { header: "Spent", cell: (row) => formatCredits(row.spentMicroCredits), align: "right" },
            { header: "Held", cell: (row) => formatCredits(row.reservedMicroCredits), align: "right" },
          ]}
        />
      </AdminSection>

      <AdminSection title="Virtual keys" description="Per-key rate limits, set by the team owner.">
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
            { header: "Rate limit", cell: (row) => describeRateLimit(row.rateLimit) },
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
