import { MagnifyingGlass, UploadSimple, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetSourceScope } from "@clash/shared-types";
import { AssetThumbnail } from "../features/assets/AssetThumbnail";
import { assetAvailabilityLabel } from "../features/assets/availability";
import { SearchFilterToolbar } from "./SearchFilterToolbar";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/icon-button";
import { evidenceTimeRange, preferredAssetEvidence, useAssetEvidence } from "../features/assets/useAssetEvidence";
import type {
  ScopedAssetOption,
  ScopedAssetSection,
} from "./scopedAssetPickerModel";

export function ScopedAssetPicker({
  projectId,
  open,
  sections,
  onClose,
  onSelect,
  onUpload,
  busy = false,
  error,
}: {
  projectId?: string;
  open: boolean;
  sections: ScopedAssetSection[];
  onClose: () => void;
  onSelect: (asset: ScopedAssetOption) => void | Promise<void>;
  onUpload: (file: File) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeScopes, setActiveScopes] = useState<AssetSourceScope[]>([]);
  const evidence = useAssetEvidence({ projectId, query, enabled: open });
  const evidenceByAsset = useMemo(() => preferredAssetEvidence(evidence.matches), [evidence.matches]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveScopes([]);
  }, [open]);

  const externalSection = sections.find(
    (section) => section.scope === "external",
  );
  const assets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return sections.flatMap((section) => {
      if (!activeScopes.every((scope) => scope === section.scope)) return [];
      return section.assets.flatMap((asset) => {
        const match = asset.source.kind === "global-library" ? undefined : evidenceByAsset.get(asset.assetId);
        if (
          normalizedQuery &&
          !match &&
          !`${asset.name} ${asset.type} ${section.label}`
            .toLocaleLowerCase()
            .includes(normalizedQuery)
        )
          return [];
        return [{ asset, scopeLabel: section.label, match }];
      });
    });
  }, [activeScopes, query, sections, evidenceByAsset]);
  const showUpload = Boolean(
    externalSection?.allowLocalUpload &&
    activeScopes.every((scope) => scope === "external") &&
    (!query ||
      "upload from mac local file".includes(query.trim().toLocaleLowerCase())),
  );
  const selectableCount = assets.filter(
    ({ asset }) => !asset.disabledReason,
  ).length;
  const notReadyCount = assets.filter(
    ({ asset }) => asset.status !== "ready",
  ).length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel="Add media"
      size="auto"
      unstyled
      overlayClassName="bg-stone-950/30 backdrop-blur-[2px]"
      containerClassName="p-5 sm:p-8"
      contentClassName="h-[min(760px,88vh)] w-[min(1040px,94vw)] overflow-hidden rounded-[28px] border border-overlay-border bg-overlay-surface text-content-primary shadow-overlay"
    >
      <div data-layout="command-grid" className="flex h-full min-h-0 flex-col">
        <input
          ref={fileInputRef}
          type="file"
          aria-label="Upload media"
          accept="image/*,video/*,audio/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void onUpload(file);
          }}
        />

        <header className="shrink-0 px-6 pb-4 pt-5 sm:px-8 sm:pt-7">
          <div className="mb-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="font-display text-xl font-semibold tracking-[-0.025em] text-content-primary">
                Add media
              </h2>
              <p className="mt-0.5 text-sm text-content-secondary">
                Choose once. Clash extends the reference chain for this
                workspace.
              </p>
            </div>
            <IconButton
              label="Close"
              size="md"
              shape="circle"
              onClick={onClose}
              className="h-10 w-10 shrink-0 text-content-secondary hover:bg-warm-muted hover:text-content-primary focus-visible:ring-offset-overlay-surface"
              icon={<X className="h-[18px] w-[18px]" weight="bold" />}
            />
          </div>

          <SearchFilterToolbar
            query={query}
            onQueryChange={setQuery}
            filterGroups={[
              {
                id: "scope",
                label: "Scope",
                options: sections.map((section) => ({
                  value: section.scope,
                  label: section.label,
                })),
                selectedValues: activeScopes,
                onSelectedValuesChange: (values) =>
                  setActiveScopes(
                    values.filter((value): value is AssetSourceScope =>
                      sections.some((section) => section.scope === value),
                    ),
                  ),
              },
            ]}
            searchLabel="Search media"
            context="dialog"
          />
        </header>

        {error && (
          <p role="alert" className="px-6 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {evidence.loading && <p role="status" className="px-6 py-2 text-xs text-content-muted">Searching analysis…</p>}
        {evidence.error && <p role="alert" className="px-6 py-2 text-xs text-red-700">Analysis search: {evidence.error}</p>}
        {evidence.truncated && <p role="status" className="px-6 py-2 text-xs text-content-secondary">Search results are incomplete. Refine your search.</p>}
        <div
          role="region"
          aria-label="Media results"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5 outline-none sm:px-8 sm:py-6"
        >
          {assets.length > 0 || showUpload ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(142px,1fr))] gap-x-4 gap-y-6 sm:grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
              {assets.map(({ asset, scopeLabel, match }) => (
                <Button
                  key={`${asset.source.kind}:${asset.sourceNodeId ?? asset.assetId}`}
                  variant={null}
                  size={null}
                  shape={null}
                  aria-label={`Add ${asset.name}`}
                  disabled={busy || Boolean(asset.disabledReason)}
                  onClick={() => void onSelect(asset)}
                  title={asset.disabledReason}
                  className="group min-w-0 flex-col gap-0 whitespace-normal text-center focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-[22px] bg-warm-muted ring-1 ring-warm-border transition-[transform,box-shadow] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:ring-brand/35 group-hover:shadow-md group-active:translate-y-0 group-active:scale-[0.985] group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-overlay-surface motion-reduce:transform-none motion-reduce:transition-none">
                    <AssetThumbnail
                      kind={asset.type}
                      src={asset.src}
                      thumbnailSrc={asset.thumbnail}
                      status={asset.status}
                      label={asset.name}
                      variant="card"
                      decorative
                    />
                    <span className="absolute bottom-2 left-2 rounded-md bg-stone-950/68 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                      {scopeLabel}
                    </span>
                  </span>
                  <span className="mt-2.5 block w-full truncate px-1 text-sm font-semibold text-content-primary">
                    {asset.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-content-secondary">
                    {asset.status === "ready"
                      ? asset.type
                      : assetAvailabilityLabel(asset)}
                  </span>
                  {match && <span className="mt-1 line-clamp-2 text-xs text-content-secondary">{match.text}</span>}
                  {match && evidenceTimeRange(match) && <span className="mt-1 text-[11px] tabular-nums text-brand">{evidenceTimeRange(match)}</span>}
                </Button>
              ))}

              {showUpload ? (
                <Button
                  variant={null}
                  size={null}
                  shape={null}
                  aria-label="Upload from Mac"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                  className="group min-w-0 flex-col gap-0 whitespace-normal text-center focus-visible:outline-none disabled:cursor-wait disabled:opacity-55"
                >
                  <span className="flex aspect-square w-full items-center justify-center rounded-[22px] border border-dashed border-warm-border bg-warm-surface text-content-secondary transition-[transform,border-color,background-color,color] duration-200 ease-out group-hover:-translate-y-0.5 group-hover:border-brand/60 group-hover:bg-brand-light/35 group-hover:text-brand group-active:translate-y-0 group-active:scale-[0.985] group-focus-visible:ring-2 group-focus-visible:ring-ring group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-overlay-surface motion-reduce:transform-none motion-reduce:transition-none">
                    <UploadSimple className="h-8 w-8" weight="regular" />
                  </span>
                  <span className="mt-2.5 block text-sm font-semibold text-content-primary">
                    Upload from Mac
                  </span>
                  <span className="mt-0.5 block text-xs text-content-secondary">
                    Local file
                  </span>
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full min-h-52 items-center justify-center text-center">
              <div>
                <MagnifyingGlass
                  className="mx-auto h-8 w-8 text-content-disabled"
                  weight="regular"
                />
                <p className="mt-3 text-sm font-semibold text-content-primary">
                  {query
                    ? "No media matches this search"
                    : "Everything here is already connected"}
                </p>
                <p className="mt-1 text-sm text-content-secondary">
                  {query
                    ? "Try another name or scope."
                    : "Choose another scope or upload a new file."}
                </p>
              </div>
            </div>
          )}
        </div>

        <footer className="flex h-11 shrink-0 items-center justify-between border-t border-overlay-border bg-warm-muted px-6 text-xs text-content-secondary sm:px-8">
          <span>
            {selectableCount} selectable
            {notReadyCount > 0 ? ` · ${notReadyCount} not ready` : ""}
          </span>
          <span>Esc to close</span>
        </footer>
      </div>
    </Dialog>
  );
}
