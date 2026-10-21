/** Audit log page (#353): read-only, filterable; rows are append-only on the server. */
import { useState } from "react";

import type { AuditEntry, AuditFilters } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { AdminField, AdminSection, AdminTable, formatTime } from "./AdminKit";

const snapshot = (value: unknown) => (value === null || value === undefined ? "—" : JSON.stringify(value));

export function AdminAudit({
  entries,
  filters,
  onFiltersChange,
}: {
  entries: AuditEntry[];
  filters: AuditFilters;
  onFiltersChange: (filters: AuditFilters) => void;
}) {
  const [draft, setDraft] = useState({
    actorUserId: filters.actorUserId ?? "",
    action: filters.action ?? "",
    targetType: filters.targetType ?? "",
    targetId: filters.targetId ?? "",
  });
  return (
    <>
      <AdminSection title="Filters">
        <form
          className="grid gap-3 sm:grid-cols-5"
          onSubmit={(event) => {
            event.preventDefault();
            onFiltersChange({
              ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
              ...Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim() !== "")),
            });
          }}
        >
          <AdminField label="Actor user id" value={draft.actorUserId} onChange={(e) => setDraft({ ...draft, actorUserId: e.target.value })} />
          <AdminField label="Action" hint="e.g. upstream or budget.update" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
          <AdminField label="Target type" value={draft.targetType} onChange={(e) => setDraft({ ...draft, targetType: e.target.value })} />
          <AdminField label="Target id" value={draft.targetId} onChange={(e) => setDraft({ ...draft, targetId: e.target.value })} />
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary">
              Apply
            </Button>
          </div>
        </form>
      </AdminSection>
      <AdminSection title="Audit log" description="Every admin change, with redacted before/after snapshots. Rows cannot be edited or deleted.">
        <AdminTable
          label="Audit log"
          rows={entries}
          rowKey={(row) => row.id}
          empty="No audit entries match."
          columns={[
            { header: "When", cell: (row) => formatTime(row.occurredAt) },
            { header: "Actor", cell: (row) => `${row.actorUserId}${row.actorRole ? ` (${row.actorRole})` : ""}` },
            { header: "Action", cell: (row) => <code className="text-xs">{row.action}</code> },
            { header: "Target", cell: (row) => `${row.targetType}:${row.targetId}` },
            {
              header: "Change",
              cell: (row) => (
                <div className="max-w-md space-y-1 break-all font-mono text-xs">
                  <div>before {snapshot(row.before)}</div>
                  <div>after {snapshot(row.after)}</div>
                  {row.reason ? <div className="font-sans text-stone-500">reason: {row.reason}</div> : null}
                </div>
              ),
            },
          ]}
        />
      </AdminSection>
    </>
  );
}
