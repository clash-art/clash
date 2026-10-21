/**
 * Users & teams page (#353, #392): the tenant list, the selected tenant's
 * members and roles (read-only: team owners manage members in team
 * settings, #354), and platform admin grants. The server keeps one platform
 * admin.
 */
import { useState } from "react";
import { Link } from "react-router";

import { adminApi, type PlatformAdmin, type TenantMember, type TenantSummary } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, formatTime, useAdminAction } from "./AdminKit";

export function AdminTenantList({ tenants, basePath }: { tenants: TenantSummary[]; basePath: string }) {
  return (
    <AdminSection title="Tenants" description="Open a tenant to see its members, budgets and limits.">
      <AdminTable
        label="Tenants"
        rows={tenants}
        rowKey={(row) => row.id}
        empty="No tenants yet."
        columns={[
          {
            header: "Tenant",
            cell: (row) => (
              <Link className="font-medium text-red-600 hover:underline" to={`${basePath}?tenant=${encodeURIComponent(row.id)}`}>
                {row.name}
              </Link>
            ),
          },
          { header: "Id", cell: (row) => <code className="text-xs">{row.id}</code> },
          { header: "Kind", cell: (row) => row.kind },
          { header: "Members", cell: (row) => row.members, align: "right" },
          { header: "Created", cell: (row) => formatTime(row.createdAt) },
        ]}
      />
    </AdminSection>
  );
}

export function AdminMembers({ members }: { members: TenantMember[] }) {
  return (
    <AdminSection title="Members" description="Team roles are owner or member; the team's owners manage them.">
      <AdminTable
        label="Members"
        rows={members}
        rowKey={(row) => row.userId}
        empty="This tenant has no members."
        columns={[
          {
            header: "User",
            cell: (row) => (
              <div>
                <div className="font-medium">{row.name ?? row.userId}</div>
                <div className="text-xs text-stone-500">{row.email ?? row.userId}</div>
              </div>
            ),
          },
          { header: "Role", cell: (row) => row.role },
          { header: "Joined", cell: (row) => formatTime(row.joinedAt) },
        ]}
      />
    </AdminSection>
  );
}

export function AdminPlatformAdmins({
  admins,
  canWrite,
  onChanged,
}: {
  admins: PlatformAdmin[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const action = useAdminAction(onChanged);
  return (
    <AdminSection title="Platform admins" description="Staff grants, separate from tenant roles. The last platform admin cannot be revoked.">
      <AdminErrorAlert error={action.error} />
      <AdminTable
        label="Platform admins"
        rows={admins}
        rowKey={(row) => row.userId}
        empty="No platform admins."
        columns={[
          { header: "User", cell: (row) => `${row.name ?? row.userId}${row.email ? ` · ${row.email}` : ""}` },
          { header: "Granted by", cell: (row) => row.grantedByUserId ?? "bootstrap" },
          { header: "Since", cell: (row) => formatTime(row.grantedAt) },
          {
            header: "",
            cell: (row) =>
              canWrite ? (
                <Button size="sm" variant="destructive" disabled={action.pending} onClick={() => void action.run(() => adminApi.revokePlatformAdmin(row.userId))}>
                  Revoke
                </Button>
              ) : null,
          },
        ]}
      />
      {canWrite ? (
        <AdminCard>
          <form
            aria-label="Grant platform admin"
            className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
            onSubmit={action.submit(async () => {
              await adminApi.grantPlatformAdmin(userId.trim(), reason.trim() || undefined);
              setUserId("");
              setReason("");
            })}
          >
            <AdminField label="User id" value={userId} onChange={(e) => setUserId(e.target.value)} required />
            <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex items-end">
              <Button type="submit" size="sm" variant="primary" disabled={action.pending || !userId.trim()}>
                Grant
              </Button>
            </div>
          </form>
        </AdminCard>
      ) : null}
    </AdminSection>
  );
}
