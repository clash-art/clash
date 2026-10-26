/** Packages page (#353): subscription packages and top-up packs (#352 API), plus period rollover. */
import { useState } from "react";

import {
  adminApi,
  describeRateLimit,
  formatCredits,
  parseCredits,
  parseRateLimit,
  type AdminPackage,
  type AdminTopupPack,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, useAdminAction } from "./AdminKit";

/** Integer minor units of an ISO 4217 currency, shown with that currency's own decimals. */
function money(minor: number, currency: string): string {
  try {
    const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
    return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
  } catch {
    return `${minor} ${currency} (minor units)`;
  }
}

export function AdminPackages({
  packages,
  packs,
  canWrite,
  canRollover,
  onChanged,
}: {
  packages: AdminPackage[];
  packs: AdminTopupPack[];
  canWrite: boolean;
  canRollover: boolean;
  onChanged: () => void;
}) {
  const archive = useAdminAction(onChanged);
  const rollover = useAdminAction(onChanged);
  const [rolloverResult, setRolloverResult] = useState<string | null>(null);
  return (
    <>
      <AdminSection
        title="Subscription packages"
        description="Credits granted into the tenant wallet each period. Archived packages keep renewing for live subscribers."
        actions={
          canRollover ? (
            <Button
              size="sm"
              disabled={rollover.pending}
              onClick={() =>
                void rollover.run(async () => {
                  const result = await adminApi.rollover();
                  setRolloverResult(`${result.subscriptions.length} subscriptions processed, ${result.failed} failed.`);
                })
              }
            >
              Close ended periods
            </Button>
          ) : null
        }
      >
        {rolloverResult ? <p className="text-sm text-stone-500">{rolloverResult}</p> : null}
        <AdminErrorAlert error={rollover.error ?? archive.error} />
        <AdminTable
          label="Subscription packages"
          rows={packages}
          rowKey={(row) => row.id}
          empty="No packages yet."
          columns={[
            { header: "Name", cell: (row) => row.name },
            { header: "Status", cell: (row) => <StatusPill tone={row.status === "active" ? "ok" : "muted"}>{row.status}</StatusPill> },
            { header: "Price", cell: (row) => `${money(row.priceMinor, row.priceCurrency)} / ${row.billingPeriod}` },
            { header: "Credits / period", cell: (row) => formatCredits(row.periodMicroCredits), align: "right" },
            { header: "Tenant limit", cell: (row) => describeRateLimit(row.rateLimit) },
            {
              header: "Provider price id",
              cell: (row) => (
                <ExternalPriceIdCell
                  label={`Provider price id for ${row.name}`}
                  value={row.externalPriceId ?? null}
                  canWrite={canWrite}
                  save={(value) => adminApi.setPackageExternalPriceId(row.id, value)}
                  onChanged={onChanged}
                />
              ),
            },
            {
              header: "",
              cell: (row) =>
                canWrite && row.status === "active" ? (
                  <Button size="sm" variant="destructive" disabled={archive.pending} onClick={() => void archive.run(() => adminApi.archivePackage(row.id))}>
                    Archive
                  </Button>
                ) : null,
            },
          ]}
        />
        {canWrite ? <PackageForm onChanged={onChanged} /> : null}
      </AdminSection>
      <AdminSection title="Top-up packs" description="One-off credits added to the tenant wallet; they do not expire.">
        <AdminTable
          label="Top-up packs"
          rows={packs}
          rowKey={(row) => row.id}
          empty="No top-up packs yet."
          columns={[
            { header: "Name", cell: (row) => row.name },
            { header: "Status", cell: (row) => <StatusPill tone={row.status === "active" ? "ok" : "muted"}>{row.status}</StatusPill> },
            { header: "Price", cell: (row) => money(row.priceMinor, row.priceCurrency) },
            { header: "Credits", cell: (row) => formatCredits(row.microCredits), align: "right" },
            {
              header: "Provider price id",
              cell: (row) => (
                <ExternalPriceIdCell
                  label={`Provider price id for ${row.name}`}
                  value={row.externalPriceId ?? null}
                  canWrite={canWrite}
                  save={(value) => adminApi.setTopupPackExternalPriceId(row.id, value)}
                  onChanged={onChanged}
                />
              ),
            },
            {
              header: "",
              cell: (row) =>
                canWrite && row.status === "active" ? (
                  <Button size="sm" variant="destructive" disabled={archive.pending} onClick={() => void archive.run(() => adminApi.archiveTopupPack(row.id))}>
                    Archive
                  </Button>
                ) : null,
            },
          ]}
        />
        {canWrite ? <TopupPackForm onChanged={onChanged} /> : null}
      </AdminSection>
    </>
  );
}

/**
 * The payment provider's price id (#419): configuration that maps a provider
 * checkout to this package or pack. Empty clears it.
 */
function ExternalPriceIdCell({
  label,
  value,
  canWrite,
  save,
  onChanged,
}: {
  label: string;
  value: string | null;
  canWrite: boolean;
  save: (value: string | null) => Promise<unknown>;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  const action = useAdminAction(onChanged);
  if (!canWrite) return <span className="font-mono text-xs">{value ?? "—"}</span>;
  return (
    <form className="flex items-center gap-1" aria-label={label} onSubmit={action.submit(() => save(draft.trim() || null))}>
      <input
        aria-label={label}
        className="w-36 rounded border border-stone-300 bg-transparent px-1.5 py-0.5 font-mono text-xs dark:border-stone-700"
        value={draft}
        placeholder="unset"
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button type="submit" size="sm" disabled={action.pending || draft.trim() === (value ?? "")}>
        Save
      </Button>
      <AdminErrorAlert error={action.error} />
    </form>
  );
}

function PackageForm({ onChanged }: { onChanged: () => void }) {
  const [form, setForm] = useState({ name: "", period: "month" as "month" | "year", price: "", currency: "USD", credits: "", rpm: "", tpm: "", concurrency: "", externalPriceId: "" });
  const action = useAdminAction(onChanged);
  return (
    <AdminCard>
      <form
        aria-label="New package"
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={action.submit(async () => {
          const credits = parseCredits(form.credits);
          if (credits === null) throw new Error("Credits per period must be a number.");
          const rateLimit = parseRateLimit({ requestsPerMinute: form.rpm, tokensPerMinute: form.tpm, concurrency: form.concurrency });
          await adminApi.createPackage({
            name: form.name,
            billingPeriod: form.period,
            priceMinor: Number(form.price),
            priceCurrency: form.currency.trim().toUpperCase(),
            periodMicroCredits: credits,
            ...(rateLimit ? { rateLimit } : {}),
            ...(form.externalPriceId.trim() ? { externalPriceId: form.externalPriceId.trim() } : {}),
          });
        })}
      >
        <AdminField label="Package name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
          <span>Billing period</span>
          <SelectMenu
            ariaLabel="Billing period"
            variant="field"
            size="sm"
            value={form.period}
            options={[
              { value: "month", label: "Monthly" },
              { value: "year", label: "Yearly" },
            ]}
            onValueChange={(period) => setForm({ ...form, period })}
          />
        </label>
        <AdminField label="Price (minor units)" hint="e.g. 4900 = 49.00 USD" inputMode="numeric" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
        <AdminField label="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} required />
        <AdminField label="Credits per period" inputMode="decimal" value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} required />
        <AdminField label="Tenant requests/min" inputMode="numeric" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} />
        <AdminField label="Tenant tokens/min" inputMode="numeric" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} />
        <AdminField label="Tenant concurrency" inputMode="numeric" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} />
        <AdminField label="Provider price id" hint="optional; set by the payments plugin's provider" value={form.externalPriceId} onChange={(e) => setForm({ ...form, externalPriceId: e.target.value })} />
        <div className="sm:col-span-4">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
            Create package
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

function TopupPackForm({ onChanged }: { onChanged: () => void }) {
  const [form, setForm] = useState({ name: "", price: "", currency: "USD", credits: "", externalPriceId: "" });
  const action = useAdminAction(onChanged);
  return (
    <AdminCard>
      <form
        aria-label="New top-up pack"
        className="grid gap-3 sm:grid-cols-6"
        onSubmit={action.submit(async () => {
          const credits = parseCredits(form.credits);
          if (credits === null) throw new Error("Credits must be a number.");
          await adminApi.createTopupPack({
            name: form.name,
            priceMinor: Number(form.price),
            priceCurrency: form.currency.trim().toUpperCase(),
            microCredits: credits,
            ...(form.externalPriceId.trim() ? { externalPriceId: form.externalPriceId.trim() } : {}),
          });
        })}
      >
        <AdminField label="Pack name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        <AdminField label="Price (minor units)" inputMode="numeric" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
        <AdminField label="Currency" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} required />
        <AdminField label="Credits" inputMode="decimal" value={form.credits} onChange={(e) => setForm({ ...form, credits: e.target.value })} required />
        <AdminField label="Provider price id" value={form.externalPriceId} onChange={(e) => setForm({ ...form, externalPriceId: e.target.value })} />
        <div className="flex items-end">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
            Create pack
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}
