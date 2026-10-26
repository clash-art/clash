/**
 * The managed "Clash official" provider row (#351): the official gateway's
 * live published catalog, read-only beside the user's own accounts. The host
 * decides what it lists: nothing renders while no catalog is published or
 * when the host serves no official gateway (a local Host without one).
 */
import { useEffect, useState } from "react";
import type { OfficialModelProvider } from "@clash/shared-types";

import { readOfficialModelProvider } from "@clash/web-ui/lib/clientActions";
import { SettingsPanel } from "./SettingsPrimitives";
import { InlineAlert } from "./ui/feedback";

const MODEL_KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  text: "Text",
};

export function OfficialProviderRow() {
  const [row, setRow] = useState<OfficialModelProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readOfficialModelProvider().then(
      (official) => {
        if (!cancelled) setRow(official);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <InlineAlert tone="error" title="Could not load Clash official models" message={error} />;
  if (!row) return null;
  if (row.status === "unavailable")
    return <InlineAlert tone="error" title={`${row.label} is unavailable right now`} message={<code>{row.code}</code>} />;

  // The server lists AIGC/media first; group in that order.
  const groups = new Map<string, typeof row.models>();
  for (const model of row.models) groups.set(model.kind, [...(groups.get(model.kind) ?? []), model]);
  return (
    <SettingsPanel as="section" aria-label={row.label} className="space-y-3 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{row.label}</h3>
          <p className="text-xs text-muted-foreground">
            Managed by Clash. Catalog <code>{row.catalogVersion}</code>
            {row.publishedAt ? `, published ${new Date(row.publishedAt).toLocaleDateString()}` : ""}.
          </p>
        </div>
        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
          {row.models.length} models
        </span>
      </header>
      {row.models.length === 0 ? (
        <p className="text-xs text-muted-foreground">No official model is being served right now.</p>
      ) : (
        <dl className="space-y-2 text-xs">
          {[...groups].map(([kind, models]) => (
            <div key={kind}>
              <dt className="font-medium">{MODEL_KIND_LABELS[kind] ?? kind}</dt>
              <dd className="text-muted-foreground">{models.map((model) => model.name || model.id).join(", ")}</dd>
            </div>
          ))}
        </dl>
      )}
    </SettingsPanel>
  );
}
