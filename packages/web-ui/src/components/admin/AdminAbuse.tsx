/**
 * Abuse page (#353 scaffold): the live rate-limit counters that exist today.
 * Denied requests are not recorded yet, and the page says so instead of
 * showing an empty event list as if nothing happened.
 */
import type { AbuseSignals } from "../../lib/adminClient";
import { InlineAlert } from "../ui/feedback";
import { AdminSection, AdminTable, formatTime } from "./AdminKit";

export function AdminAbuse({ abuse }: { abuse: AbuseSignals }) {
  return (
    <>
      <InlineAlert tone="warning" title="Denied-request events are not yet available" message={abuse.events.reason} />
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
