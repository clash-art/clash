/** Overview page: 30-day usage plus platform or tenant counts (#353). */
import { formatCredits, type Overview } from "../../lib/adminClient";
import { AdminCard, AdminSection, AdminTable } from "./AdminKit";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <AdminCard>
      <div className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-stone-500">{hint}</div> : null}
    </AdminCard>
  );
}

export function AdminOverview({ overview, scopeLabel }: { overview: Overview; scopeLabel: string }) {
  return (
    <>
      <AdminSection title={`Last ${overview.windowDays} days`} description={scopeLabel}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Spend" value={formatCredits(overview.spentMicroCredits)} hint="credits settled" />
          <Stat label="Requests" value={overview.requests.toLocaleString()} />
          <Stat label="Failed" value={overview.failedRequests.toLocaleString()} hint="settled without success" />
        </div>
      </AdminSection>
      {overview.platform ? (
        <AdminSection title="Platform">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Tenants" value={overview.platform.tenants} />
            <Stat
              label="Live catalog"
              value={overview.platform.liveCatalogVersion ?? "None published"}
              hint={`${overview.platform.liveCatalogModels} models`}
            />
            <Stat label="Upstreams enabled" value={`${overview.platform.upstreamsEnabled} / ${overview.platform.upstreams}`} />
            <Stat label="Active packages" value={overview.platform.activePackages} />
            <Stat label="Platform admins" value={overview.platform.platformAdmins} />
          </div>
        </AdminSection>
      ) : null}
      {overview.tenant ? (
        <AdminSection title="Tenant">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Members" value={overview.tenant.members} />
            <Stat label="Active keys" value={overview.tenant.activeKeys} />
            <Stat label="Suspended budgets" value={overview.tenant.suspendedBudgets} />
          </div>
        </AdminSection>
      ) : null}
      <AdminSection title="Top models">
        <AdminTable
          label="Top models"
          rows={overview.topModels}
          rowKey={(row) => row.modelCode}
          empty="No settled usage in this window."
          columns={[
            { header: "Model", cell: (row) => row.modelCode || "—" },
            { header: "Requests", cell: (row) => row.requests.toLocaleString(), align: "right" },
            { header: "Spend (credits)", cell: (row) => formatCredits(row.spentMicroCredits), align: "right" },
          ]}
        />
      </AdminSection>
    </>
  );
}
