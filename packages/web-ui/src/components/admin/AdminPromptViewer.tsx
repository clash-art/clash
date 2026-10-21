/**
 * Staff prompt viewer (#353): asks for a reason, then shows one gateway
 * request's retained prompt and response exactly as stored. Every open is an
 * audited server call (`prompt.view`); expired, unretained and refused
 * requests show the server's coded error.
 */
import { useState } from "react";

import { adminApi, type RetainedBody, type RetainedPrompt } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { AdminErrorAlert, AdminField, formatTime, useAdminAction } from "./AdminKit";

export function AdminPromptViewer({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  return (
    <Dialog
      open={requestId !== null}
      onClose={onClose}
      title="Prompt and response"
      description="Platform admins only. Every view is audited with your reason."
      size="lg"
    >
      {/* Keyed by request: another row starts with a fresh reason and no body. */}
      {requestId !== null ? <PromptAccess key={requestId} requestId={requestId} /> : null}
    </Dialog>
  );
}

function PromptAccess({ requestId }: { requestId: string }) {
  const [reason, setReason] = useState("");
  const [prompt, setPrompt] = useState<RetainedPrompt | null>(null);
  const action = useAdminAction();
  if (prompt) return <RetainedPromptView prompt={prompt} />;
  return (
    <form
      aria-label="Prompt access"
      className="space-y-3"
      onSubmit={action.submit(async () => setPrompt((await adminApi.promptAccess(requestId, reason.trim())).prompt))}
    >
      <p className="text-sm">
        Request <code className="text-xs">{requestId}</code>
      </p>
      <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      {action.error ? <AdminErrorAlert error={action.error} /> : null}
      <Button type="submit" size="sm" variant="primary" disabled={action.pending || !reason.trim()}>
        View prompt and response
      </Button>
    </form>
  );
}

function RetainedPromptView({ prompt }: { prompt: RetainedPrompt }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-stone-500">Request</dt>
        <dd>
          <code>{prompt.requestId}</code>
        </dd>
        <dt className="text-stone-500">Tenant / user / key</dt>
        <dd>{[prompt.tenantId, prompt.userId, prompt.keyId].filter(Boolean).join(" / ")}</dd>
        <dt className="text-stone-500">Answer status</dt>
        <dd>{prompt.responseStatus}</dd>
        <dt className="text-stone-500">Stored / expires</dt>
        <dd>
          {formatTime(prompt.storedAt)} / {formatTime(prompt.expiresAt)}
        </dd>
      </dl>
      <StoredBody title="Request" part={prompt.request} />
      <StoredBody title="Response" part={prompt.response} />
    </div>
  );
}

function StoredBody({ title, part }: { title: string; part: RetainedBody }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="text-xs text-stone-500">
        {part.bytes.toLocaleString()} bytes · {part.contentType} · sha256 <code>{part.sha256}</code>
      </p>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-warm-border bg-warm-page/60 p-3 text-xs">
        {part.body}
      </pre>
    </section>
  );
}
