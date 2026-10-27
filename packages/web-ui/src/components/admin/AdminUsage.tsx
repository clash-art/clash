/**
 * Usage explorer (#353, #355; guide: apps/docs/guide/gateway-usage.md): the
 * ledger filtered by tenant (the console's `?tenant=`), user, key, model,
 * kind, status and UTC days through the URL, paged newest first, with
 * per-model totals and the same filter as a CSV export. Failed and partial
 * media/AIGC requests settle at zero and are marked "not charged". Entries are
 * metadata only; the audited viewer of a retained prompt and response (30
 * days) appears only when the deployment enables it for platform staff.
 */
import { useState } from "react";

import { adminApi, formatCredits, type UsageFilters, type UsageResult } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import {
  AdminErrorAlert,
  AdminField,
  AdminSection,
  AdminTable,
  StatusPill,
  formatTime,
  saveDownload,
  useAdminAction,
  utcDayOf,
  utcDayStart,
} from "./AdminKit";
import { AdminPromptViewer } from "./AdminPromptViewer";

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
    status: filters.status ?? "",
    fromDay: utcDayOf(filters.from),
    beforeDay: utcDayOf(filters.to),
  });
  const [viewing, setViewing] = useState<string | null>(null);
  const exporting = useAdminAction();
  const { fromDay, beforeDay, ...fields } = draft;
  return (
    <>
      <AdminSection title="Filters">
        <form
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            // A new filter starts from the newest page.
            onFiltersChange({
              ...(filters.tenantId ? { tenantId: filters.tenantId } : {}),
              ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value.trim() !== "")),
              ...(utcDayStart(fromDay) ? { from: utcDayStart(fromDay) } : {}),
              ...(utcDayStart(beforeDay) ? { to: utcDayStart(beforeDay) } : {}),
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
          <AdminField
            label="Status"
            hint="settled, partial, upstream_failed, …"
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          />
          <AdminField label="From (UTC day)" type="date" value={fromDay} onChange={(e) => setDraft({ ...draft, fromDay: e.target.value })} />
          <AdminField
            label="Before (UTC day)"
            type="date"
            value={beforeDay}
            onChange={(e) => setDraft({ ...draft, beforeDay: e.target.value })}
          />
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary">
              Apply
            </Button>
          </div>
        </form>
      </AdminSection>
      <AdminSection title="By model" description="Settled requests matching the filters. Not charged: failed or partial media requests, settled at zero.">
        <AdminTable
          label="Usage by model"
          rows={usage.byModel}
          rowKey={(row) => row.modelCode}
          empty="No settled usage matches."
          columns={[
            { header: "Model", cell: (row) => row.modelCode || "—" },
            { header: "Requests", cell: (row) => row.requests.toLocaleString(), align: "right" },
            { header: "Not charged", cell: (row) => row.notCharged.toLocaleString(), align: "right" },
            { header: "Input tokens", cell: (row) => row.inputTokens.toLocaleString(), align: "right" },
            { header: "Output tokens", cell: (row) => row.outputTokens.toLocaleString(), align: "right" },
            { header: "Credits", cell: (row) => formatCredits(row.amountMicroCredits), align: "right" },
          ]}
        />
      </AdminSection>
      <AdminSection
        title="Ledger entries"
        description="Newest first. Metadata only; the upstream is kept 30 days, the ledger 13 months."
        actions={
          <Button
            size="sm"
            disabled={exporting.pending}
            onClick={() => void exporting.run(async () => saveDownload(await adminApi.usageExport(filters)))}
          >
            Export CSV
          </Button>
        }
      >
        <AdminErrorAlert error={exporting.error} />
        <AdminTable
          label="Ledger entries"
          rows={usage.entries}
          rowKey={(row) => row.id}
          empty="No ledger entries match."
          columns={[
            { header: "When", cell: (row) => formatTime(row.occurredAt) },
            {
              header: "Kind",
              cell: (row) => (
                <span className="flex flex-wrap items-center gap-1">
                  {`${row.kind} · ${row.status}`}
                  {row.notCharged ? <StatusPill tone="muted">not charged</StatusPill> : null}
                </span>
              ),
            },
            { header: "Model", cell: (row) => row.modelCode ?? "—" },
            { header: "Tenant", cell: (row) => row.tenantId || "platform" },
            { header: "User / key", cell: (row) => [row.userId, row.keyId].filter(Boolean).join(" / ") || "—" },
            { header: "Tokens in/out", cell: (row) => `${row.inputTokens} / ${row.outputTokens}`, align: "right" },
            { header: "Credits", cell: (row) => formatCredits(row.amountMicroCredits), align: "right" },
            {
              header: "Request",
              cell: (row) => (
                <span className="flex items-center gap-2">
                  <code className="text-xs">{row.requestId}</code>
                  {/* A settle row is one gateway request; its bodies are what the viewer shows. */}
                  {promptAccess && row.kind === "settle" && row.tenantId ? (
                    <Button size="sm" aria-label={`View prompt for ${row.requestId}`} onClick={() => setViewing(row.requestId)}>
                      View
                    </Button>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
        {filters.cursor || usage.nextCursor ? (
          <div className="flex gap-2">
            {filters.cursor ? (
              <Button size="sm" onClick={() => onFiltersChange({ ...filters, cursor: undefined })}>
                Newest
              </Button>
            ) : null}
            {usage.nextCursor ? (
              <Button size="sm" onClick={() => onFiltersChange({ ...filters, cursor: usage.nextCursor! })}>
                Older entries
              </Button>
            ) : null}
          </div>
        ) : null}
      </AdminSection>
      {promptAccess ? (
        <>
          <PromptLookup onOpen={setViewing} />
          <AdminPromptViewer requestId={viewing} onClose={() => setViewing(null)} />
        </>
      ) : null}
    </>
  );
}

function PromptLookup({ onOpen }: { onOpen: (requestId: string) => void }) {
  const [requestId, setRequestId] = useState("");
  return (
    <AdminSection
      title="Staff prompt access"
      description="Platform admins only. Prompts and responses are kept 30 days; every view is audited with its reason."
    >
      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (requestId.trim()) onOpen(requestId.trim());
        }}
      >
        <AdminField label="Gateway request id" value={requestId} onChange={(e) => setRequestId(e.target.value)} required />
        <div className="flex items-end">
          <Button type="submit" size="sm" disabled={!requestId.trim()}>
            Open
          </Button>
        </div>
      </form>
    </AdminSection>
  );
}
