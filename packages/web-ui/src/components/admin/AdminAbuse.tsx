/**
 * Abuse page (#356; guide: apps/docs/guide/gateway-admin.md#abuse): each
 * signal's top subjects (top spenders, 401 spikes, shared-key fingerprints,
 * request velocity) with its configurable threshold, the alerts thresholds
 * raised, and the suspensions of tenants and keys with manual suspend and
 * lift. Suspending takes an id and a reason only; nothing here shows or
 * needs key material. The live rate-limit counters stay below.
 */
import { useState } from "react";

import {
  adminApi,
  formatAbuseValue,
  formatCredits,
  parseAbuseThreshold,
  SUSPENSION_SUBJECTS,
  type AbuseObservation,
  type AbuseSignal,
  type AbuseSignals,
  type AbuseThreshold,
  type SuspensionSubject,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { InlineAlert } from "../ui/feedback";
import { SelectMenu } from "../ui/select";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, formatTime, StatusPill, useAdminAction } from "./AdminKit";

const SIGNAL_LABELS: Record<AbuseSignal, { title: string; description: string }> = {
  spend: { title: "Top spenders", description: "Credits settled per tenant." },
  auth_failures: { title: "401 spikes", description: "Refused credentials per tenant, or per client fingerprint when none was recognized." },
  shared_key: { title: "Shared-key fingerprints", description: "Distinct client fingerprints using one key." },
  velocity: { title: "Request velocity", description: "Authenticated requests per key." },
};

const subjectLabel = (row: { subjectKind: string; subjectId: string }) => (
  <span>
    <span className="text-xs text-stone-500">{row.subjectKind} </span>
    <code className="text-xs">{row.subjectId}</code>
  </span>
);

const describeThreshold = (signal: AbuseSignal, threshold: AbuseThreshold | null) =>
  threshold
    ? `Alert at ${formatAbuseValue(signal, threshold.alertAt)}${
        threshold.suspendAt === null ? ", never suspends" : `, suspend at ${formatAbuseValue(signal, threshold.suspendAt)}`
      } within ${threshold.windowMinutes} minutes.`
    : "No threshold: shown, never acted on.";

const thresholdText = (signal: AbuseSignal, value: number | null | undefined) =>
  value === null || value === undefined ? "" : signal === "spend" ? formatCredits(value) : String(value);

export interface AdminAbuseProps {
  abuse: AbuseSignals;
  can: { suspend: boolean; thresholds: boolean };
  onChanged: () => void;
}

export function AdminAbuse({ abuse, can, onChanged }: AdminAbuseProps) {
  const [subject, setSubject] = useState<{ kind: SuspensionSubject; id: string }>({ kind: "tenant", id: "" });
  const [reason, setReason] = useState("");
  const [liftReason, setLiftReason] = useState("");
  const action = useAdminAction(onChanged);
  const suspendable = (row: AbuseObservation) => row.subjectKind !== "client";

  return (
    <>
      <AdminErrorAlert error={action.error} />
      {can.suspend ? (
        <AdminSection
          title="Suspend a tenant or key"
          description="A suspended tenant or key is refused with GATEWAY_SUSPENDED (403) before anything is reserved or sent upstream."
        >
          <AdminCard>
            <form
              aria-label="Suspend"
              className="grid gap-3 sm:grid-cols-[auto_1fr_1fr_auto]"
              onSubmit={action.submit(async () => {
                await adminApi.suspend({ subjectKind: subject.kind, subjectId: subject.id.trim(), reason: reason.trim() });
                setSubject({ kind: subject.kind, id: "" });
                setReason("");
              })}
            >
              <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
                <span>Subject</span>
                <SelectMenu
                  ariaLabel="Subject kind"
                  variant="field"
                  size="sm"
                  value={subject.kind}
                  options={SUSPENSION_SUBJECTS.map((kind) => ({ value: kind, label: kind }))}
                  onValueChange={(kind) => setSubject({ ...subject, kind: kind as SuspensionSubject })}
                />
              </label>
              <AdminField label="Tenant or key id" value={subject.id} onChange={(e) => setSubject({ ...subject, id: e.target.value })} required />
              <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
              <div className="flex items-end">
                <Button type="submit" size="sm" variant="destructive" disabled={action.pending || !subject.id.trim() || !reason.trim()}>
                  Suspend
                </Button>
              </div>
            </form>
          </AdminCard>
        </AdminSection>
      ) : null}

      {abuse.signals.map((entry) => (
        <AdminSection
          key={entry.signal}
          title={SIGNAL_LABELS[entry.signal].title}
          description={`${SIGNAL_LABELS[entry.signal].description} Last ${entry.windowMinutes} minutes. ${describeThreshold(entry.signal, entry.threshold)}`}
        >
          <AdminTable
            label={SIGNAL_LABELS[entry.signal].title}
            rows={entry.top}
            rowKey={(row) => `${row.subjectKind}:${row.subjectId}`}
            empty="Nothing measured in this window."
            columns={[
              { header: "Subject", cell: subjectLabel },
              { header: "Tenant", cell: (row) => (row.tenantId ? <code className="text-xs">{row.tenantId}</code> : "—") },
              { header: "Value", cell: (row) => formatAbuseValue(entry.signal, row.value), align: "right" },
              {
                header: "",
                cell: (row) =>
                  can.suspend && suspendable(row) ? (
                    <Button size="sm" variant="default" onClick={() => setSubject({ kind: row.subjectKind as SuspensionSubject, id: row.subjectId })}>
                      Select to suspend
                    </Button>
                  ) : null,
              },
            ]}
          />
          {can.thresholds ? (
            <ThresholdForm
              signal={entry.signal}
              threshold={entry.threshold}
              pending={action.pending}
              onSave={(threshold) => action.run(() => adminApi.setAbuseThreshold(entry.signal, threshold))}
              onError={action.setError}
            />
          ) : null}
        </AdminSection>
      ))}

      <AdminSection
        title="Suspensions"
        description="Active first. Automatic suspensions name the signal that crossed its threshold."
        actions={
          can.suspend ? <AdminField label="Lift reason" value={liftReason} onChange={(e) => setLiftReason(e.target.value)} /> : null
        }
      >
        <AdminTable
          label="Suspensions"
          rows={abuse.suspensions}
          rowKey={(row) => row.id}
          empty="Nothing has been suspended."
          columns={[
            { header: "Subject", cell: subjectLabel },
            { header: "Tenant", cell: (row) => <code className="text-xs">{row.tenantId}</code> },
            { header: "Source", cell: (row) => (row.source === "auto" ? `auto · ${row.signal}` : "manual") },
            { header: "Reason", cell: (row) => row.reason },
            { header: "By", cell: (row) => `${row.actorKind} ${row.actorId}` },
            { header: "Since", cell: (row) => formatTime(row.createdAt) },
            {
              header: "Status",
              cell: (row) =>
                row.liftedAt ? (
                  <StatusPill tone="muted">{`Lifted ${formatTime(row.liftedAt)}`}</StatusPill>
                ) : (
                  <StatusPill tone="warn">Active</StatusPill>
                ),
            },
            {
              header: "",
              cell: (row) =>
                can.suspend && !row.liftedAt ? (
                  <Button
                    size="sm"
                    variant="default"
                    disabled={action.pending || !liftReason.trim()}
                    onClick={() =>
                      void action.run(async () => {
                        await adminApi.liftSuspension(row.id, liftReason.trim());
                        setLiftReason("");
                      })
                    }
                  >
                    Lift
                  </Button>
                ) : null,
            },
          ]}
        />
      </AdminSection>

      <AdminSection title="Alerts" description="One per signal, subject and threshold window; each is also logged as gateway.abuse_alert.">
        <AdminTable
          label="Alerts"
          rows={abuse.alerts}
          rowKey={(row) => row.id}
          empty="No threshold has been crossed."
          columns={[
            { header: "Raised", cell: (row) => formatTime(row.createdAt) },
            { header: "Signal", cell: (row) => SIGNAL_LABELS[row.signal].title },
            { header: "Subject", cell: subjectLabel },
            {
              header: "Value",
              cell: (row) => `${formatAbuseValue(row.signal, row.value)} ≥ ${formatAbuseValue(row.signal, row.threshold)}`,
              align: "right",
            },
            { header: "Window", cell: (row) => `${row.windowMinutes} min` },
            { header: "Action", cell: (row) => (row.action === "suspend" ? (row.suspensionId ? "suspended" : "already suspended") : "alert") },
          ]}
        />
      </AdminSection>

      <InlineAlert tone="info" title="Denied requests" message={abuse.events.reason} />
      <AdminSection title="Busiest rate-limit counters" description={`Requests and tokens counted in the last ${abuse.windowMinutes} minutes.`}>
        <AdminTable
          label="Rate-limit counters"
          rows={abuse.rateWindows}
          rowKey={(row) => row.subject}
          empty="No counted traffic in this window."
          columns={[
            { header: "Subject", cell: (row) => <code className="text-xs">{row.subject}</code> },
            { header: "Requests", cell: (row) => row.requests.toLocaleString(), align: "right" },
            { header: "Tokens", cell: (row) => row.tokens.toLocaleString(), align: "right" },
            { header: "Last window", cell: (row) => formatTime(row.lastWindowAt) },
          ]}
        />
      </AdminSection>
      <AdminSection title="Open concurrency leases">
        <AdminTable
          label="Concurrency leases"
          rows={abuse.inflight}
          rowKey={(row) => row.subject}
          empty="No requests in flight under a concurrency limit."
          columns={[
            { header: "Subject", cell: (row) => <code className="text-xs">{row.subject}</code> },
            { header: "Leases", cell: (row) => row.leases, align: "right" },
          ]}
        />
      </AdminSection>
    </>
  );
}

function ThresholdForm({
  signal,
  threshold,
  pending,
  onSave,
  onError,
}: {
  signal: AbuseSignal;
  threshold: AbuseThreshold | null;
  pending: boolean;
  onSave: (threshold: AbuseThreshold | null) => Promise<boolean>;
  onError: (error: unknown) => void;
}) {
  const [fields, setFields] = useState({
    windowMinutes: threshold ? String(threshold.windowMinutes) : "",
    alertAt: thresholdText(signal, threshold?.alertAt),
    suspendAt: thresholdText(signal, threshold?.suspendAt),
  });
  const unit = signal === "spend" ? " (credits)" : "";
  const label = SIGNAL_LABELS[signal].title;
  return (
    <form
      aria-label={`${label} threshold`}
      className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        let parsed: AbuseThreshold;
        try {
          parsed = parseAbuseThreshold(signal, fields);
        } catch (error) {
          onError(error);
          return;
        }
        void onSave(parsed);
      }}
    >
      <AdminField
        label="Window (minutes)"
        inputMode="numeric"
        value={fields.windowMinutes}
        onChange={(e) => setFields({ ...fields, windowMinutes: e.target.value })}
        required
      />
      <AdminField label={`Alert at${unit}`} value={fields.alertAt} onChange={(e) => setFields({ ...fields, alertAt: e.target.value })} required />
      <AdminField
        label={`Suspend at${unit}`}
        hint="Empty: alert only"
        value={fields.suspendAt}
        onChange={(e) => setFields({ ...fields, suspendAt: e.target.value })}
      />
      <div className="flex items-end">
        <Button type="submit" size="sm" variant="primary" disabled={pending}>
          Save threshold
        </Button>
      </div>
      <div className="flex items-end">
        {threshold ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={pending}
            onClick={() =>
              void onSave(null).then((saved) => {
                if (saved) setFields({ windowMinutes: "", alertAt: "", suspendAt: "" });
              })
            }
          >
            Clear
          </Button>
        ) : null}
      </div>
    </form>
  );
}
