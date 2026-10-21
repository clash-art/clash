/**
 * Usage page (#353): the ledger with filters applied through the URL, per-model
 * totals, and — only when the deployment enables it for platform staff — the
 * audited prompt-access request (decision 10). The gateway keeps no bodies, so
 * that request answers its coded "not retained" state.
 */
import { useState } from "react";

import { adminApi, formatCredits, type UsageFilters, type UsageResult } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { InlineAlert } from "../ui/feedback";
import { SelectMenu } from "../ui/select";
import { AdminErrorAlert, AdminField, AdminSection, AdminTable, formatTime, useAdminAction } from "./AdminKit";

const ALL_KINDS = "all";
const LEDGER_KINDS = ["settle", "refund", "adjust", "grant", "topup", "expire", "hold", "release"] as const;

export function AdminUsage({
  usage,
  filters,
  onFiltersChange,
  promptAccess,
}: {
  usage: UsageResult;
  filters: UsageFilters;
  onFiltersChange: (filters: UsageFilters) => void;
  promptAccess: boolean;
}) {
  const [draft, setDraft] = useState({
    userId: filters.userId ?? "",
    keyId: filters.keyId ?? "",
    modelCode: filters.modelCode ?? "",
    kind: filters.kind ?? "",
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
          <AdminField label="User id" value={draft.userId} onChange={(e) => setDraft({ ...draft, userId: e.target.value })} />
          <AdminField label="Key id" value={draft.keyId} onChange={(e) => setDraft({ ...draft, keyId: e.target.value })} />
          <AdminField label="Model" value={draft.modelCode} onChange={(e) => setDraft({ ...draft, modelCode: e.target.value })} />
          <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
            <span>Ledger kind</span>
            <SelectMenu
              ariaLabel="Ledger kind"
              variant="field"
              size="sm"
              value={draft.kind || ALL_KINDS}
              options={[ALL_KINDS, ...LEDGER_KINDS].map((kind) => ({
                value: kind,
                label: kind === ALL_KINDS ? "All but holds/releases" : kind,
              }))}
              onValueChange={(kind) => setDraft({ ...draft, kind: kind === ALL_KINDS ? "" : kind })}
            />
          </label>
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary">
              Apply
            </Button>
          </div>
        </form>
      </AdminSection>
      <AdminSection title="By model" description="Settled requests matching the filters.">
        <AdminTable
          label="Usage by model"
          rows={usage.byModel}
          rowKey={(row) => row.modelCode}
          empty="No settled usage matches."
          columns={[
            { header: "Model", cell: (row) => row.modelCode || "—" },
            { header: "Requests", cell: (row) => row.requests.toLocaleString(), align: "right" },
            { header: "Input tokens", cell: (row) => row.inputTokens.toLocaleString(), align: "right" },
            { header: "Output tokens", cell: (row) => row.outputTokens.toLocaleString(), align: "right" },
            { header: "Credits", cell: (row) => formatCredits(row.amountMicroCredits), align: "right" },
          ]}
        />
      </AdminSection>
      <AdminSection title="Ledger entries" description="Newest first. Request and response bodies are never stored.">
        <AdminTable
          label="Ledger entries"
          rows={usage.entries}
          rowKey={(row) => `${row.requestId}:${row.kind}:${row.occurredAt}`}
          empty="No ledger entries match."
          columns={[
            { header: "When", cell: (row) => formatTime(row.occurredAt) },
            { header: "Kind", cell: (row) => `${row.kind} · ${row.status}` },
            { header: "Model", cell: (row) => row.modelCode ?? "—" },
            { header: "User / key", cell: (row) => [row.userId, row.keyId].filter(Boolean).join(" / ") || "—" },
            { header: "Tokens in/out", cell: (row) => `${row.inputTokens} / ${row.outputTokens}`, align: "right" },
            { header: "Credits", cell: (row) => formatCredits(row.amountMicroCredits), align: "right" },
            { header: "Request", cell: (row) => <code className="text-xs">{row.requestId}</code> },
          ]}
        />
      </AdminSection>
      {promptAccess ? <PromptAccess /> : null}
    </>
  );
}

function PromptAccess() {
  const [requestId, setRequestId] = useState("");
  const [reason, setReason] = useState("");
  const action = useAdminAction();
  return (
    <AdminSection
      title="Staff prompt access"
      description="Break-glass, platform admins only. Every request is audited with its reason."
    >
      <form
        className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
        onSubmit={action.submit(() => adminApi.promptAccess(requestId.trim(), reason.trim()))}
      >
        <AdminField label="Gateway request id" value={requestId} onChange={(e) => setRequestId(e.target.value)} required />
        <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={action.pending || !requestId.trim() || !reason.trim()}>
            Request access
          </Button>
        </div>
      </form>
      {action.error ? <AdminErrorAlert error={action.error} /> : null}
      <InlineAlert
        tone="info"
        title="No prompts are retained"
        message="The gateway stores no request or response bodies, so an allowed request is audited and reports GATEWAY_PROMPT_NOT_RETAINED."
      />
    </AdminSection>
  );
}
