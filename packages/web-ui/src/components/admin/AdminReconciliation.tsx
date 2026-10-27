/**
 * Reconciliation page (#355; guide: apps/docs/guide/gateway-usage.md): the
 * nightly diff of the ledger against what the upstream reported for a UTC
 * day (an invoice export or AI Gateway logs). Lists runs and imported
 * reports, opens a run's per-group differences, and — with
 * `reconciliation.write` — imports a day's report and reconciles a day now.
 * Differences are platform `adjust` ledger entries valued at the price book;
 * they never charge or credit a tenant.
 */
import { useState } from "react";

import {
  RECONCILE_SOURCES,
  adminApi,
  formatCredits,
  type ReconcileRun,
  type ReconcileSource,
  type ReconcileUsage,
  type UpstreamReport,
  type UpstreamReportGroup,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, formatTime, useAdminAction } from "./AdminKit";

const AUTO_SOURCE = "auto";
const SOURCE_LABELS: Record<ReconcileSource, string> = { invoice: "Invoice", ai_gateway: "AI Gateway logs" };
const STATUS_TONE: Record<ReconcileRun["status"], "ok" | "muted" | "warn"> = {
  matched: "ok",
  adjusted: "muted",
  incomplete: "warn",
  source_missing: "warn",
};
const label = "flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300";

/** Signed micro-credits as credits with an explicit sign. */
function signedCredits(micro: number): string {
  return `${micro > 0 ? "+" : ""}${formatCredits(micro)}`;
}

const usageSummary = (usage: ReconcileUsage) =>
  `${usage.requests} req · ${usage.inputTokens} in · ${usage.outputTokens} out`;

/**
 * The report groups an operator pasted: a JSON array of
 * `{ upstreamId, accountId, modelCode, requests?, inputTokens?, ... }`.
 * Throws before any call when it is not one; the server validates the rest.
 */
export function parseReportGroups(text: string): UpstreamReportGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Report groups must be a JSON array.");
  }
  if (!Array.isArray(parsed)) throw new Error("Report groups must be a JSON array.");
  for (const [index, group] of parsed.entries())
    if (
      !group ||
      typeof group !== "object" ||
      typeof (group as UpstreamReportGroup).upstreamId !== "string" ||
      typeof (group as UpstreamReportGroup).accountId !== "string" ||
      typeof (group as UpstreamReportGroup).modelCode !== "string"
    )
      throw new Error(`Group ${index + 1} needs upstreamId, accountId and modelCode.`);
  return parsed as UpstreamReportGroup[];
}

export function AdminReconciliation({
  runs,
  reports,
  canWrite,
  onChanged,
}: {
  runs: ReconcileRun[];
  reports: UpstreamReport[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [opened, setOpened] = useState<ReconcileRun | null>(null);
  const open = useAdminAction();
  return (
    <>
      {canWrite ? (
        <ReconcileDayForm
          onDone={(run) => {
            setOpened(run);
            onChanged();
          }}
        />
      ) : null}
      <AdminSection title="Runs" description="Nightly at 01:15 UTC for yesterday, and for any earlier day whose report changed since its last run.">
        <AdminErrorAlert error={open.error} />
        <AdminTable
          label="Reconciliation runs"
          rows={runs}
          rowKey={(row) => row.id}
          empty="No reconciliation has run yet."
          columns={[
            { header: "Day", cell: (row) => row.day },
            { header: "Source", cell: (row) => (row.source ? SOURCE_LABELS[row.source as ReconcileSource] ?? row.source : "—") },
            {
              header: "Status",
              cell: (row) => (
                <span className="flex flex-col gap-0.5">
                  <StatusPill tone={STATUS_TONE[row.status]}>{row.status.replace("_", " ")}</StatusPill>
                  {row.errorCode ? <code className="text-xs">{row.errorCode}</code> : null}
                </span>
              ),
            },
            { header: "Groups", cell: (row) => row.groups, align: "right" },
            { header: "Adjustments", cell: (row) => row.adjustments, align: "right" },
            { header: "Adjusted", cell: (row) => signedCredits(row.adjustedMicroCredits), align: "right" },
            { header: "By", cell: (row) => (row.actorKind === "system" ? "nightly" : row.actorId) },
            { header: "Started", cell: (row) => formatTime(row.startedAt) },
            {
              header: "Details",
              cell: (row) => (
                <Button
                  size="sm"
                  aria-label={`Open run ${row.id}`}
                  disabled={open.pending}
                  onClick={() => void open.run(async () => setOpened((await adminApi.reconcileRun(row.id)).run))}
                >
                  Open
                </Button>
              ),
            },
          ]}
        />
      </AdminSection>
      {opened ? <RunDetail run={opened} /> : null}
      {canWrite ? <ImportReportForm onDone={onChanged} /> : null}
      <AdminSection title="Upstream reports" description="Daily totals per upstream account and model. Counts only; kept 13 months.">
        <AdminTable
          label="Upstream reports"
          rows={reports}
          rowKey={(row) => `${row.day}:${row.source}`}
          empty="No upstream report has been imported."
          columns={[
            { header: "Day", cell: (row) => row.day },
            { header: "Source", cell: (row) => SOURCE_LABELS[row.source] ?? row.source },
            { header: "Groups", cell: (row) => row.groups, align: "right" },
            { header: "Imported", cell: (row) => formatTime(row.importedAt) },
            { header: "By", cell: (row) => row.importedBy },
          ]}
        />
      </AdminSection>
    </>
  );
}

function RunDetail({ run }: { run: ReconcileRun }) {
  return (
    <AdminSection title={`Run ${run.day}`} description={`${run.id} · ${run.status.replace("_", " ")}`}>
      <AdminTable
        label="Run differences"
        rows={run.diffs ?? []}
        rowKey={(row) => `${row.upstreamId}:${row.accountId}:${row.modelCode}`}
        empty={run.status === "source_missing" ? "No upstream report was imported for this day." : "No usage on either side."}
        columns={[
          { header: "Model", cell: (row) => row.modelCode },
          { header: "Upstream / account", cell: (row) => `${row.upstreamId} / ${row.accountId}` },
          { header: "Ledger", cell: (row) => usageSummary(row.ledger) },
          { header: "Upstream", cell: (row) => usageSummary(row.upstream) },
          {
            header: "Difference",
            cell: (row) =>
              row.deltaMicroCredits === null ? <code className="text-xs">{row.errorCode ?? "unpriced"}</code> : signedCredits(row.deltaMicroCredits),
            align: "right",
          },
          { header: "Posted now", cell: (row) => signedCredits(row.adjustMicroCredits), align: "right" },
        ]}
      />
    </AdminSection>
  );
}

function SourceSelect({ value, onChange, allowAuto }: { value: string; onChange: (value: string) => void; allowAuto?: boolean }) {
  return (
    <label className={label}>
      <span>Source</span>
      <SelectMenu
        ariaLabel="Source"
        variant="field"
        size="sm"
        value={value}
        options={[
          ...(allowAuto ? [{ value: AUTO_SOURCE, label: "Invoice, else AI Gateway logs" }] : []),
          ...RECONCILE_SOURCES.map((source) => ({ value: source, label: SOURCE_LABELS[source] })),
        ]}
        onValueChange={onChange}
      />
    </label>
  );
}

function ReconcileDayForm({ onDone }: { onDone: (run: ReconcileRun) => void }) {
  const [day, setDay] = useState("");
  const [source, setSource] = useState(AUTO_SOURCE);
  const [result, setResult] = useState<string | null>(null);
  const action = useAdminAction();
  return (
    <AdminSection title="Reconcile a day" description="An ended UTC day within the last 30 days. Re-running a day posts only what changed.">
      <AdminCard>
        <form
          aria-label="Reconcile a day"
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={action.submit(async () => {
            const { run, posted } = await adminApi.reconcileDay(day, source === AUTO_SOURCE ? undefined : (source as ReconcileSource));
            setResult(`${run.day}: ${run.status.replace("_", " ")}, ${posted} adjustment${posted === 1 ? "" : "s"} posted.`);
            onDone(run);
          })}
        >
          <AdminField label="Day (UTC)" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
          <SourceSelect value={source} onChange={setSource} allowAuto />
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="primary" disabled={action.pending || !day}>
              Reconcile
            </Button>
          </div>
        </form>
        <AdminErrorAlert error={action.error} />
        {result ? <p className="mt-2 text-sm">{result}</p> : null}
      </AdminCard>
    </AdminSection>
  );
}

function ImportReportForm({ onDone }: { onDone: () => void }) {
  const [day, setDay] = useState("");
  const [source, setSource] = useState<string>("invoice");
  const [groups, setGroups] = useState("[]");
  const [reason, setReason] = useState("");
  const action = useAdminAction(onDone);
  return (
    <AdminSection title="Import an upstream report" description="Replaces that day's report from the same source. Every group names an upstream account and its upstream.">
      <AdminCard>
        <form
          aria-label="Import upstream report"
          className="grid gap-3"
          onSubmit={action.submit(async () => {
            const parsed = parseReportGroups(groups);
            await adminApi.importReconcileReport(day, source as ReconcileSource, {
              groups: parsed,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
          })}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <AdminField label="Report day (UTC)" type="date" value={day} onChange={(e) => setDay(e.target.value)} required />
            <SourceSelect value={source} onChange={setSource} />
            <AdminField label="Import reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Textarea
            aria-label="Report groups JSON"
            rows={6}
            className="font-mono text-xs"
            value={groups}
            onChange={(e) => setGroups(e.target.value)}
            required
          />
          <div>
            <Button type="submit" size="sm" disabled={action.pending || !day}>
              Import report
            </Button>
          </div>
        </form>
        <AdminErrorAlert error={action.error} />
      </AdminCard>
    </AdminSection>
  );
}
