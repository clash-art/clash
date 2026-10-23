/** Edit one rate limit (`rate_limit_json`): empty fields clear it; the server validates again. */
import { useState } from "react";

import { describeRateLimit, parseRateLimit, type RateLimit } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { AdminErrorAlert, AdminField, useAdminAction } from "./AdminKit";

export function RateLimitForm({
  label,
  value,
  onSave,
  onDone,
  disabled = false,
}: {
  label: string;
  value: RateLimit | null;
  onSave: (limit: RateLimit | null) => Promise<unknown>;
  onDone?: () => void;
  disabled?: boolean;
}) {
  const [fields, setFields] = useState({
    requestsPerMinute: value?.requestsPerMinute?.toString() ?? "",
    tokensPerMinute: value?.tokensPerMinute?.toString() ?? "",
    concurrency: value?.concurrency?.toString() ?? "",
    mediaJobs: value?.mediaJobs?.toString() ?? "",
  });
  const action = useAdminAction(onDone);
  if (disabled) return <span className="text-sm">{describeRateLimit(value)}</span>;
  return (
    <form
      aria-label={label}
      className="space-y-2"
      onSubmit={action.submit(async () => onSave(parseRateLimit(fields)))}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <AdminField label="Requests/min" inputMode="numeric" value={fields.requestsPerMinute} onChange={(e) => setFields({ ...fields, requestsPerMinute: e.target.value })} />
        <AdminField label="Tokens/min" inputMode="numeric" value={fields.tokensPerMinute} onChange={(e) => setFields({ ...fields, tokensPerMinute: e.target.value })} />
        <AdminField label="Concurrent" inputMode="numeric" value={fields.concurrency} onChange={(e) => setFields({ ...fields, concurrency: e.target.value })} />
        <AdminField label="Media jobs" inputMode="numeric" value={fields.mediaJobs} onChange={(e) => setFields({ ...fields, mediaJobs: e.target.value })} />
      </div>
      <Button type="submit" size="sm" disabled={action.pending}>
        Save limit
      </Button>
      <AdminErrorAlert error={action.error} />
    </form>
  );
}
