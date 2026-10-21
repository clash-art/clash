/**
 * Upstream accounts page (#353). Secrets are write-only: the form sends a
 * Worker secret name or an API key once, the key field is cleared after
 * every submit, and the server only ever answers the credential kind, field
 * names and key version.
 */
import { useState } from "react";

import { adminApi, type UpstreamAccount, type UpstreamCredential } from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, formatTime, useAdminAction } from "./AdminKit";
import { RateLimitForm } from "./RateLimitForm";

type CredentialKind = "sealed" | "secret_ref";

function CredentialFields({
  kind,
  onKindChange,
  secret,
  onSecretChange,
  baseUrl,
  onBaseUrlChange,
}: {
  kind: CredentialKind;
  onKindChange: (kind: CredentialKind) => void;
  secret: string;
  onSecretChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
}) {
  return (
    <>
      <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
        <span>Credential</span>
        <SelectMenu
          ariaLabel="Credential kind"
          variant="field"
          size="sm"
          value={kind}
          options={[
            { value: "sealed", label: "API key (sealed on save)" },
            { value: "secret_ref", label: "Worker secret name" },
          ]}
          onValueChange={onKindChange}
        />
      </label>
      {kind === "sealed" ? (
        <>
          <AdminField
            label="API key"
            type="password"
            autoComplete="off"
            hint="Write-only: never shown again."
            value={secret}
            onChange={(e) => onSecretChange(e.target.value)}
            required
          />
          <AdminField label="Base URL (optional)" type="url" value={baseUrl} onChange={(e) => onBaseUrlChange(e.target.value)} />
        </>
      ) : (
        <AdminField
          label="Secret name"
          hint="A GATEWAY_UPSTREAM_* Worker secret."
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
          required
        />
      )}
    </>
  );
}

function credentialOf(kind: CredentialKind, secret: string, baseUrl: string): UpstreamCredential {
  return kind === "secret_ref"
    ? { secretRef: secret.trim() }
    : { apiKey: secret.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) };
}

export function AdminUpstreams({
  upstreams,
  canWrite,
  onChanged,
}: {
  upstreams: UpstreamAccount[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const toggle = useAdminAction(onChanged);
  const [rotating, setRotating] = useState<string | null>(null);
  return (
    <>
      <AdminSection title="Official upstream accounts" description="Server-owned keys the gateway routes official traffic through.">
        <AdminErrorAlert error={toggle.error} />
        <AdminTable
          label="Upstream accounts"
          rows={upstreams}
          rowKey={(row) => row.id}
          empty="No upstream accounts yet."
          columns={[
            {
              header: "Account",
              cell: (row) => (
                <div>
                  <div className="font-medium">{row.label ?? row.id}</div>
                  <div className="text-xs text-stone-500">
                    {row.providerId}
                    {row.upstreamId ? ` / ${row.upstreamId}` : ""}
                    {row.region ? ` · ${row.region}` : ""}
                  </div>
                </div>
              ),
            },
            { header: "Status", cell: (row) => <StatusPill tone={row.enabled ? "ok" : "muted"}>{row.enabled ? "enabled" : "disabled"}</StatusPill> },
            {
              header: "Credential",
              cell: (row) => (
                <div className="text-xs">
                  {row.credential.kind === "secret_ref" ? `secret ${row.credential.secretRef}` : `sealed ${row.credential.fields.join(", ")}`}
                  <div className="text-stone-500">
                    {row.credential.keyVersion} · rotated {formatTime(row.credential.rotatedAt)}
                  </div>
                </div>
              ),
            },
            { header: "Priority / weight", cell: (row) => `${row.priority ?? "—"} / ${row.weight ?? "—"}` },
            {
              header: "Rate limit",
              cell: (row) => (
                <RateLimitForm
                  label={`Rate limit for ${row.label ?? row.id}`}
                  value={row.rateLimit}
                  disabled={!canWrite}
                  onSave={(rateLimit) => adminApi.updateUpstream(row.id, { rateLimit })}
                  onDone={onChanged}
                />
              ),
            },
            {
              header: "",
              cell: (row) =>
                canWrite ? (
                  <div className="flex flex-col gap-2">
                    <Button
                      size="sm"
                      variant={row.enabled ? "destructive" : "default"}
                      disabled={toggle.pending}
                      onClick={() => void toggle.run(() => adminApi.updateUpstream(row.id, { enabled: !row.enabled }))}
                    >
                      {row.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" onClick={() => setRotating(rotating === row.id ? null : row.id)}>
                      Rotate key
                    </Button>
                  </div>
                ) : null,
            },
          ]}
        />
        {rotating ? (
          <RotateForm
            account={upstreams.find((row) => row.id === rotating)!}
            onDone={() => {
              setRotating(null);
              onChanged();
            }}
          />
        ) : null}
      </AdminSection>
      {canWrite ? <CreateForm onChanged={onChanged} /> : null}
    </>
  );
}

function RotateForm({ account, onDone }: { account: UpstreamAccount; onDone: () => void }) {
  const [kind, setKind] = useState<CredentialKind>(account.credential.kind);
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [reason, setReason] = useState("");
  const action = useAdminAction(onDone);
  return (
    <AdminCard>
      <form
        aria-label={`Rotate ${account.label ?? account.id}`}
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={action.submit(async () => {
          try {
            await adminApi.rotateUpstream(account.id, credentialOf(kind, secret, baseUrl), reason.trim() || undefined);
          } finally {
            setSecret("");
          }
        })}
      >
        <CredentialFields kind={kind} onKindChange={setKind} secret={secret} onSecretChange={setSecret} baseUrl={baseUrl} onBaseUrlChange={setBaseUrl} />
        <AdminField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <div className="sm:col-span-4">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
            Rotate to {account.credential.keyVersion.replace(/\d+$/, (n) => String(Number(n) + 1))}
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

function CreateForm({ onChanged }: { onChanged: () => void }) {
  const [form, setForm] = useState({ providerId: "official", upstreamId: "", apiShape: "", region: "", label: "", priority: "", weight: "" });
  const [kind, setKind] = useState<CredentialKind>("sealed");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const action = useAdminAction(onChanged);
  const optionalInt = (text: string) => (text.trim() ? Number(text) : null);
  return (
    <AdminSection title="Add an upstream account">
      <AdminCard>
        <form
          aria-label="New upstream account"
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={action.submit(async () => {
            try {
              await adminApi.createUpstream({
                providerId: form.providerId.trim(),
                ...(form.upstreamId.trim() ? { upstreamId: form.upstreamId.trim() } : {}),
                ...(form.apiShape.trim() ? { apiShape: form.apiShape.trim() } : {}),
                ...(form.region.trim() ? { region: form.region.trim() } : {}),
                ...(form.label.trim() ? { label: form.label.trim() } : {}),
                priority: optionalInt(form.priority),
                weight: optionalInt(form.weight),
                credential: credentialOf(kind, secret, baseUrl),
              });
            } finally {
              setSecret("");
            }
          })}
        >
          <AdminField label="Provider id" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })} required />
          <AdminField label="Upstream id" hint="e.g. openai" value={form.upstreamId} onChange={(e) => setForm({ ...form, upstreamId: e.target.value })} />
          <AdminField label="API shape" hint="e.g. openai-compatible" value={form.apiShape} onChange={(e) => setForm({ ...form, apiShape: e.target.value })} />
          <AdminField label="Region" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} />
          <AdminField label="Label" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <AdminField label="Priority" inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          <AdminField label="Weight" inputMode="numeric" value={form.weight} onChange={(e) => setForm({ ...form, weight: e.target.value })} />
          <CredentialFields kind={kind} onKindChange={setKind} secret={secret} onSecretChange={setSecret} baseUrl={baseUrl} onBaseUrlChange={setBaseUrl} />
          <div className="sm:col-span-4">
            <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
              Create account
            </Button>
          </div>
        </form>
        <AdminErrorAlert error={action.error} />
      </AdminCard>
    </AdminSection>
  );
}
