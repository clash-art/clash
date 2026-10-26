/**
 * Users & teams page (#353, #392, #394): the tenant list, the selected
 * tenant's members and roles (read-only: team owners manage members in team
 * settings, #354), and the admin accounts (a separate identity, never product
 * users) with their role: platform_admin, or support_agent (#356). The
 * server keeps one enabled platform_admin.
 */
import { useState } from "react";
import { Link } from "react-router";

import {
  ADMIN_ACCOUNT_ROLES,
  adminApi,
  type AdminAccount,
  type AdminAccountRole,
  type TenantMember,
  type TenantSummary,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
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

export function AdminAccounts({
  accounts,
  currentAdminId,
  canWrite,
  onChanged,
}: {
  accounts: AdminAccount[];
  /** The signed-in account, which cannot disable itself from here. */
  currentAdminId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AdminAccountRole>("platform_admin");
  const [reason, setReason] = useState("");
  const action = useAdminAction(onChanged);
  return (
    <AdminSection
      title="Admin accounts"
      description="Console sign-ins, separate from product users. A support agent reads and suspends by id, without key, credential or prompt access. Disabling one signs it out everywhere; the last enabled platform admin cannot be disabled."
    >
      <AdminErrorAlert error={action.error} />
      <AdminTable
        label="Admin accounts"
        rows={accounts}
        rowKey={(row) => row.id}
        empty="No admin accounts."
        columns={[
          { header: "Account", cell: (row) => `${row.name} · ${row.email}` },
          { header: "Role", cell: (row) => row.role },
          { header: "Since", cell: (row) => formatTime(row.createdAt) },
          { header: "Status", cell: (row) => (row.disabledAt ? `Disabled ${formatTime(row.disabledAt)}` : "Enabled") },
          {
            header: "",
            cell: (row) =>
              canWrite && !row.disabledAt && row.id !== currentAdminId ? (
                <Button size="sm" variant="destructive" disabled={action.pending} onClick={() => void action.run(() => adminApi.disableAdminAccount(row.id))}>
                  Disable
                </Button>
              ) : null,
          },
        ]}
      />
      {canWrite ? (
        <AdminCard>
          <form
            aria-label="Create admin account"
            className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto_1fr_auto]"
            onSubmit={action.submit(async () => {
              await adminApi.createAdminAccount({
                email: email.trim(),
                name: name.trim(),
                password,
                role,
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              });
              setEmail("");
              setName("");
              setPassword("");
              setRole("platform_admin");
              setReason("");
            })}
          >
            <AdminField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <AdminField label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <AdminField
              label="Password"
              type="password"
              autoComplete="new-password"
              hint="12 to 128 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
              <span>Role</span>
              <SelectMenu
                ariaLabel="Role"
                variant="field"
                size="sm"
                value={role}
                options={ADMIN_ACCOUNT_ROLES.map((value) => ({ value, label: value === "platform_admin" ? "Platform admin" : "Support agent" }))}
                onValueChange={(value) => setRole(value as AdminAccountRole)}
              />
            </label>
            <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex items-end">
              <Button type="submit" size="sm" variant="primary" disabled={action.pending || !email.trim() || !name.trim() || !password}>
                Create
              </Button>
            </div>
          </form>
        </AdminCard>
      ) : null}
    </AdminSection>
  );
}
