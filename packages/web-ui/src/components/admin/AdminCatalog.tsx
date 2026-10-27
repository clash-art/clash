/**
 * Models & prices page (#353). The catalog routes as whole published
 * versions: clone the live version (or seed the AIGC/media-first launch
 * draft, #351) into a draft, edit or remove models, then publish. Prices follow the #352 draft/publish price book. Published
 * versions are read-only here and on the server.
 */
import { useState } from "react";

import {
  adminApi,
  describeRateLimit,
  formatCredits,
  parseCredits,
  parseRateLimit,
  type CatalogModel,
  type CatalogSeedResult,
  type CatalogVersion,
  type CatalogVersionSummary,
  type PriceVersion,
} from "../../lib/adminClient";
import { Button } from "../ui/button";
import { SelectMenu } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { AdminCard, AdminErrorAlert, AdminField, AdminSection, AdminTable, StatusPill, formatTime, useAdminAction } from "./AdminKit";

const PRICE_UNITS = [
  "input_token",
  "output_token",
  "cached_input_token",
  "cache_write_token",
  "image",
  "video_second",
  "audio_second",
  "character",
  "request",
] as const;

export function AdminCatalog({
  versions,
  selected,
  canWrite,
  onSelect,
  onChanged,
}: {
  versions: CatalogVersionSummary[];
  selected: CatalogVersion | null;
  canWrite: boolean;
  onSelect: (version: string) => void;
  onChanged: () => void;
}) {
  const publish = useAdminAction(onChanged);
  const remove = useAdminAction(onChanged);
  const [editing, setEditing] = useState<CatalogModel | "new" | null>(null);
  const draft = selected?.status === "draft";
  return (
    <>
      <AdminSection title="Catalog versions" description="The newest published version is live; a published version never changes.">
        <AdminTable
          label="Catalog versions"
          rows={versions}
          rowKey={(row) => row.version}
          empty="No catalog versions yet."
          columns={[
            {
              header: "Version",
              cell: (row) => (
                <Button size="sm" variant={row.version === selected?.version ? "primary" : "default"} onClick={() => onSelect(row.version)}>
                  {row.version}
                </Button>
              ),
            },
            {
              header: "Status",
              cell: (row) => (
                <StatusPill tone={row.live ? "ok" : row.status === "draft" ? "warn" : "muted"}>
                  {row.live ? "live" : row.status}
                </StatusPill>
              ),
            },
            { header: "Models", cell: (row) => row.models, align: "right" },
            { header: "Published", cell: (row) => formatTime(row.publishedAt) },
          ]}
        />
        {canWrite ? <CloneForm versions={versions} onCreated={(version) => { onSelect(version); onChanged(); }} /> : null}
        {canWrite ? <SeedForm onCreated={(version) => { onSelect(version); onChanged(); }} /> : null}
      </AdminSection>

      {selected ? (
        <AdminSection
          title={`Version ${selected.version}`}
          description={draft ? "Draft: edit models, then publish to make it live." : "Published: read-only."}
          actions={
            canWrite && draft ? (
              <>
                <Button size="sm" onClick={() => setEditing("new")}>
                  Add model
                </Button>
                <Button size="sm" variant="primary" disabled={publish.pending} onClick={() => void publish.run(() => adminApi.publishCatalog(selected.version))}>
                  Publish version
                </Button>
              </>
            ) : null
          }
        >
          <AdminErrorAlert error={publish.error ?? remove.error} />
          <AdminTable
            label={`Models in ${selected.version}`}
            rows={selected.models}
            rowKey={(row) => row.modelCode}
            empty="No models in this version."
            columns={[
              { header: "Model", cell: (row) => <div><div className="font-medium">{row.displayName ?? row.modelCode}</div><code className="text-xs">{row.modelCode}</code></div> },
              { header: "Kind", cell: (row) => row.kind },
              { header: "Enabled", cell: (row) => <StatusPill tone={row.enabled ? "ok" : "muted"}>{row.enabled ? "yes" : "no"}</StatusPill> },
              { header: "Max output", cell: (row) => row.maxOutputTokens ?? "—", align: "right" },
              { header: "Rate limit", cell: (row) => describeRateLimit(row.rateLimit) },
              {
                header: "",
                cell: (row) =>
                  canWrite && draft ? (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setEditing(row)}>
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={remove.pending}
                        onClick={() => void remove.run(() => adminApi.removeCatalogModel(selected.version, row.modelCode))}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : null,
              },
            ]}
          />
          {canWrite && draft && editing ? (
            <ModelForm
              key={editing === "new" ? "new" : editing.modelCode}
              version={selected.version}
              model={editing === "new" ? null : editing}
              onDone={() => {
                setEditing(null);
                onChanged();
              }}
            />
          ) : null}
        </AdminSection>
      ) : null}
    </>
  );
}

function CloneForm({ versions, onCreated }: { versions: CatalogVersionSummary[]; onCreated: (version: string) => void }) {
  const live = versions.find((row) => row.live)?.version ?? versions[0]?.version ?? "";
  const [from, setFrom] = useState(live);
  const [version, setVersion] = useState("");
  const action = useAdminAction();
  if (versions.length === 0) return null;
  return (
    <AdminCard>
      <form
        aria-label="New draft version"
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"
        onSubmit={action.submit(async () => {
          await adminApi.cloneCatalog(version.trim(), from);
          onCreated(version.trim());
        })}
      >
        <AdminField label="New draft version" hint="letters, digits, . _ -" value={version} onChange={(e) => setVersion(e.target.value)} required />
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
          <span>Copy models from</span>
          <SelectMenu
            ariaLabel="Copy models from"
            variant="field"
            size="sm"
            value={from}
            options={versions.map((row) => ({ value: row.version, label: `${row.version}${row.live ? " (live)" : ""}` }))}
            onValueChange={setFrom}
          />
        </label>
        <div className="flex items-end">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending || !version.trim()}>
            Create draft
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

const EXCLUSION_LABELS: Record<CatalogSeedResult["excluded"][number]["reason"], string> = {
  "no-official-account": "no enabled official account serves them",
  "text-not-configured": "chat-only, not listed",
  "deepseek-not-flash": "DeepSeek Pro/Reasoner (Flash only)",
};

/**
 * A launch draft (#351) from the deployment's model cards: every AIGC/media
 * model an enabled official account serves, then the chat-only models listed
 * here. It is a draft like any other: review, edit, then publish.
 */
function SeedForm({ onCreated }: { onCreated: (version: string) => void }) {
  const [version, setVersion] = useState("");
  const [textModels, setTextModels] = useState("");
  const [result, setResult] = useState<CatalogSeedResult | null>(null);
  const action = useAdminAction();
  const excluded = result
    ? Object.entries(
        result.excluded.reduce<Record<string, number>>((counts, entry) => {
          counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
          return counts;
        }, {}),
      )
    : [];
  return (
    <AdminCard>
      <form
        aria-label="Seed launch draft"
        className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]"
        onSubmit={action.submit(async () => {
          const codes = textModels.split(/[\s,]+/).filter(Boolean);
          const seeded = await adminApi.seedCatalog(version.trim(), codes);
          setResult(seeded);
          onCreated(seeded.version.version);
        })}
      >
        <AdminField label="Launch draft version" hint="AIGC/media models first" value={version} onChange={(e) => setVersion(e.target.value)} required />
        <AdminField
          label="Chat-only models to include"
          hint="model codes, comma-separated; none by default"
          value={textModels}
          onChange={(e) => setTextModels(e.target.value)}
        />
        <div className="flex items-end">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending || !version.trim()}>
            Seed draft
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
      {result ? (
        <div role="status" className="mt-3 space-y-1 text-xs text-stone-600 dark:text-stone-300">
          <p>
            Seeded {result.version.models.length} models into {result.version.version}.
          </p>
          {excluded.map(([reason, count]) => (
            <p key={reason}>
              Left out {count}: {EXCLUSION_LABELS[reason as keyof typeof EXCLUSION_LABELS]}.
            </p>
          ))}
          {result.unknownTextModelCodes.length > 0 ? <p>Unknown model codes: {result.unknownTextModelCodes.join(", ")}.</p> : null}
        </div>
      ) : null}
    </AdminCard>
  );
}

function ModelForm({ version, model, onDone }: { version: string; model: CatalogModel | null; onDone: () => void }) {
  const [form, setForm] = useState({
    modelCode: model?.modelCode ?? "",
    displayName: model?.displayName ?? "",
    enabled: model?.enabled ?? true,
    maxOutputTokens: model?.maxOutputTokens?.toString() ?? "",
    rpm: model?.rateLimit?.requestsPerMinute?.toString() ?? "",
    tpm: model?.rateLimit?.tokensPerMinute?.toString() ?? "",
    concurrency: model?.rateLimit?.concurrency?.toString() ?? "",
    card: model ? JSON.stringify(model.card, null, 2) : "",
  });
  const action = useAdminAction(onDone);
  return (
    <AdminCard>
      <form
        aria-label={model ? `Edit ${model.modelCode}` : "Add model"}
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={action.submit(async () => {
          let card: unknown;
          try {
            card = JSON.parse(form.card);
          } catch {
            throw new Error("The model card is not valid JSON.");
          }
          await adminApi.putCatalogModel(version, form.modelCode.trim(), {
            card,
            enabled: form.enabled,
            displayName: form.displayName.trim() || null,
            maxOutputTokens: form.maxOutputTokens.trim() ? Number(form.maxOutputTokens) : null,
            rateLimit: parseRateLimit({ requestsPerMinute: form.rpm, tokensPerMinute: form.tpm, concurrency: form.concurrency }),
          });
        })}
      >
        <AdminField label="Model code" value={form.modelCode} disabled={model !== null} onChange={(e) => setForm({ ...form, modelCode: e.target.value })} required />
        <AdminField label="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        <AdminField label="Max output tokens" inputMode="numeric" value={form.maxOutputTokens} onChange={(e) => setForm({ ...form, maxOutputTokens: e.target.value })} />
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
          <span>Routing</span>
          <SelectMenu
            ariaLabel="Model enabled"
            variant="field"
            size="sm"
            value={form.enabled ? "enabled" : "disabled"}
            options={[
              { value: "enabled", label: "Enabled" },
              { value: "disabled", label: "Disabled" },
            ]}
            onValueChange={(value) => setForm({ ...form, enabled: value === "enabled" })}
          />
        </label>
        <AdminField label="Requests/min per user" inputMode="numeric" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} />
        <AdminField label="Tokens/min per user" inputMode="numeric" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} />
        <AdminField label="Concurrent per user" inputMode="numeric" value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: e.target.value })} />
        <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 sm:col-span-4 dark:text-stone-300">
          <span>Model card (JSON; its id must equal the model code)</span>
          <Textarea aria-label="Model card JSON" rows={10} className="font-mono text-xs" value={form.card} onChange={(e) => setForm({ ...form, card: e.target.value })} required />
        </label>
        <div className="sm:col-span-4">
          <Button type="submit" size="sm" variant="primary" disabled={action.pending}>
            Save model
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}

export function AdminPrices({
  versions,
  canWrite,
  onChanged,
}: {
  versions: PriceVersion[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const publish = useAdminAction(onChanged);
  return (
    <AdminSection title="Price book" description="Credits per unit. Drafts are never charged; a published version never changes.">
      <AdminErrorAlert error={publish.error} />
      <AdminTable
        label="Price versions"
        rows={versions}
        rowKey={(row) => row.version}
        empty="No price versions yet."
        columns={[
          { header: "Version", cell: (row) => <code className="text-xs">{row.version}</code> },
          { header: "Status", cell: (row) => <StatusPill tone={row.status === "published" ? "ok" : "warn"}>{row.status}</StatusPill> },
          { header: "Effective", cell: (row) => `${formatTime(row.effectiveFrom)} → ${row.effectiveTo ? formatTime(row.effectiveTo) : "open"}` },
          {
            header: "Rates",
            cell: (row) => (
              <ul className="space-y-0.5 text-xs">
                {row.rates.map((rate) => (
                  <li key={`${rate.modelCode}:${rate.upstreamId}:${rate.unit}`}>
                    {rate.modelCode}
                    {rate.upstreamId ? `@${rate.upstreamId}` : ""} · {rate.unit}: {formatCredits(rate.amountMicroCredits)} / {rate.per.toLocaleString()}
                  </li>
                ))}
              </ul>
            ),
          },
          {
            header: "",
            cell: (row) =>
              canWrite && row.status === "draft" ? (
                <Button size="sm" variant="primary" disabled={publish.pending} onClick={() => void publish.run(() => adminApi.publishPrices(row.version))}>
                  Publish
                </Button>
              ) : null,
          },
        ]}
      />
      {canWrite ? <PriceDraftForm onChanged={onChanged} /> : null}
    </AdminSection>
  );
}

interface RateRow {
  modelCode: string;
  upstreamId: string;
  unit: (typeof PRICE_UNITS)[number];
  credits: string;
  per: string;
}

const emptyRate = (): RateRow => ({ modelCode: "", upstreamId: "", unit: "input_token", credits: "", per: "1000000" });

function PriceDraftForm({ onChanged }: { onChanged: () => void }) {
  const [version, setVersion] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [rates, setRates] = useState<RateRow[]>([emptyRate()]);
  const action = useAdminAction(onChanged);
  const update = (index: number, patch: Partial<RateRow>) =>
    setRates((current) => current.map((rate, i) => (i === index ? { ...rate, ...patch } : rate)));
  return (
    <AdminCard>
      <form
        aria-label="Price draft"
        className="space-y-3"
        onSubmit={action.submit(async () => {
          const from = effectiveFrom ? new Date(effectiveFrom) : new Date();
          if (Number.isNaN(from.getTime())) throw new Error("The effective date is invalid.");
          await adminApi.putPriceDraft(version.trim(), {
            effectiveFrom: from.toISOString(),
            rates: rates.map((rate) => {
              const amount = parseCredits(rate.credits);
              if (amount === null) throw new Error(`The price for ${rate.modelCode || "a rate"} must be a number of credits.`);
              return {
                modelCode: rate.modelCode.trim(),
                ...(rate.upstreamId.trim() ? { upstreamId: rate.upstreamId.trim() } : {}),
                unit: rate.unit,
                amountMicroCredits: amount,
                per: Number(rate.per),
              };
            }),
          });
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <AdminField label="Draft version" hint="Saving an existing draft replaces it." value={version} onChange={(e) => setVersion(e.target.value)} required />
          <AdminField label="Effective from" hint="Never before publishing; empty = now." type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </div>
        {rates.map((rate, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1.5fr_1fr_1fr_auto]">
            <AdminField label={`Model ${index + 1}`} value={rate.modelCode} onChange={(e) => update(index, { modelCode: e.target.value })} required />
            <AdminField label="Upstream" hint="empty = all" value={rate.upstreamId} onChange={(e) => update(index, { upstreamId: e.target.value })} />
            <label className="flex flex-col gap-1 text-xs font-medium text-stone-600 dark:text-stone-300">
              <span>Unit</span>
              <SelectMenu
                ariaLabel={`Unit ${index + 1}`}
                variant="field"
                size="sm"
                value={rate.unit}
                options={PRICE_UNITS.map((unit) => ({ value: unit, label: unit }))}
                onValueChange={(unit) => update(index, { unit })}
              />
            </label>
            <AdminField label="Credits" inputMode="decimal" value={rate.credits} onChange={(e) => update(index, { credits: e.target.value })} required />
            <AdminField label="Per units" inputMode="numeric" value={rate.per} onChange={(e) => update(index, { per: e.target.value })} required />
            <div className="flex items-end">
              <Button size="sm" variant="destructive" disabled={rates.length === 1} onClick={() => setRates((current) => current.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setRates((current) => [...current, emptyRate()])}>
            Add rate
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={action.pending || !version.trim()}>
            Save draft
          </Button>
        </div>
      </form>
      <AdminErrorAlert error={action.error} />
    </AdminCard>
  );
}
