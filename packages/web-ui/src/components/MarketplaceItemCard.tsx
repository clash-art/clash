import { CaretRight, Check, Download } from "@phosphor-icons/react";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useRef, useState } from "react";
import { Link } from "react-router";
import type { RegistryItem } from "@clash/web-ui/lib/clientActions";
import {
  marketplaceInstallAction,
  marketplaceInstallPlugin,
  marketplaceInstallSkill,
} from "@clash/web-ui/lib/clientActions";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ClashArtwork, ClashPublisherArtwork } from "./ClashArtwork";
import { marketplacePluginPath } from "./marketplaceRouting";
import { marketplaceItemTone } from "./marketplaceItemTone";
import { Card } from "./ui/card";
import { cn } from "./ai-elements/utils";
import {
  marketplaceSkillReference,
  useMarketplaceSkillReferenceDraggable,
  type AddMarketplaceSkillReference,
} from "./MarketplaceSkillReferenceDnd";

type MarketplacePublisherArtwork =
  | { kind: "asset"; assetName: "plugins"; label: string }
  | { kind: "image"; src: string; label: string };

function marketplacePublisherArtwork(
  item: RegistryItem,
): MarketplacePublisherArtwork | null {
  const identity = [
    item.id,
    item.name,
    item.author,
    item.model?.provider,
    ...(item.tags ?? []),
  ]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  if (
    item.author?.trim().toLowerCase() === "clash" ||
    item.id.toLowerCase().includes("codex-imagegen")
  ) {
    return {
      kind: "asset",
      assetName: "plugins",
      label: "Clash plugin",
    };
  }

  if (
    item.author?.trim().toLowerCase() === "openai" ||
    item.id.toLowerCase().startsWith("clash.openai.")
  ) {
    return {
      kind: "image",
      src: "/brand/providers/openai.svg",
      label: "OpenAI",
    };
  }

  if (
    identity.includes("volcengine") ||
    identity.includes("seedance") ||
    identity.includes("bytedance")
  ) {
    return {
      kind: "image",
      src: "/brand/providers/volcengine.svg",
      label: "Volcengine",
    };
  }

  return null;
}

export function MarketplaceItemArtwork({
  item,
  context = "catalog",
}: {
  item: RegistryItem;
  context?: "catalog" | "preview";
}) {
  if (item.cover) {
    return (
      <img
        data-slot="marketplace-cover"
        src={item.cover.src}
        alt={item.cover.alt ?? ""}
        className={`aspect-[3/2] shrink-0 rounded-lg border border-border object-cover ${
          context === "preview" ? "w-14" : "w-24"
        }`}
      />
    );
  }

  if (item.artwork) {
    return (
      <ClashPublisherArtwork
        src={item.artwork.src}
        label={item.artwork.alt ?? item.name}
        tone={marketplaceItemTone(item)}
      />
    );
  }

  const publisherArtwork = marketplacePublisherArtwork(item);
  const tone = marketplaceItemTone(item);

  if (publisherArtwork?.kind === "asset") {
    return (
      <ClashPublisherArtwork
        assetName={publisherArtwork.assetName}
        label={publisherArtwork.label}
        tone={tone}
      />
    );
  }

  if (publisherArtwork?.kind === "image") {
    return (
      <ClashPublisherArtwork
        src={publisherArtwork.src}
        label={publisherArtwork.label}
        tone={tone}
      />
    );
  }

  return (
    <ClashArtwork
      kind={item.type === "action" ? "action" : "skill"}
      tone={tone}
    />
  );
}

function declarationLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value || typeof value !== "object") return "Unknown declaration";

  const declaration = value as Record<string, unknown>;
  const summary = [
    declaration.kind,
    declaration.name,
    declaration.id,
    declaration.type,
    declaration.pathPattern,
  ].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return summary.length > 0 ? summary.join(" · ") : JSON.stringify(value);
}

export function MarketplacePluginDeclarations({
  item,
}: {
  item: RegistryItem;
}) {
  const metadata = [
    [
      "Type",
      item.type === "action"
        ? "Action"
        : item.type === "plugin"
          ? "Plugin"
          : "Skill",
    ],
    ["Plugin ID", item.id],
    ["Publisher", item.author],
    ["Version", item.version ?? item.sourceVersion],
    ["Source", item.source],
    [
      "Collection",
      item.curation?.collection === "official-picks"
        ? `${item.curation.curator} Official Picks`
        : undefined,
    ],
    ["Runtime", item.runtime],
    ["Execution contract", item.executionContract],
    ["Output type", item.outputType],
    [
      "Model",
      item.model
        ? [item.model.provider, item.model.name ?? item.model.id]
            .filter(Boolean)
            .join(" · ")
        : undefined,
    ],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  const declarations: Array<{ label: string; values: readonly unknown[] }> = [];
  if (item.tags) declarations.push({ label: "Tags", values: item.tags });
  if (item.promptModalities) {
    declarations.push({
      label: "Prompt inputs",
      values: item.promptModalities,
    });
  }
  if (item.inputs) declarations.push({ label: "Inputs", values: item.inputs });
  if (item.outputs) {
    declarations.push({ label: "Outputs", values: item.outputs });
  }
  if (item.requiredSystemCapabilities) {
    declarations.push({
      label: "Required system capabilities",
      values: item.requiredSystemCapabilities,
    });
  }

  return (
    <div data-slot="marketplace-plugin-declarations" className="space-y-5">
      <dl className="grid grid-cols-1 gap-3 rounded-xl border border-border bg-muted/35 p-4 sm:grid-cols-2">
        {metadata.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-[11px] font-medium uppercase tracking-wide text-content-muted">
              {label}
            </dt>
            <dd className="mt-1 break-words text-sm text-content-primary">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      {item.attribution ? (
        <section
          aria-label="Source attribution"
          className="space-y-2 text-sm text-content-secondary"
        >
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            <a
              href={item.attribution.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4"
            >
              Original skill
            </a>
            {item.attribution.licenseUrl ? (
              <a
                href={item.attribution.licenseUrl}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {item.attribution.license ?? "License"}
              </a>
            ) : item.attribution.license ? (
              <span>{item.attribution.license}</span>
            ) : null}
          </div>
          {item.attribution.repositoryStars !== undefined ? (
            <p>
              {item.attribution.repositoryStars.toLocaleString()} repository
              stars
              {item.attribution.checkedAt
                ? ` · checked ${item.attribution.checkedAt}`
                : ""}
            </p>
          ) : null}
          {item.attribution.notes ? <p>{item.attribution.notes}</p> : null}
        </section>
      ) : null}

      {declarations.length > 0 ? (
        <div className="space-y-4">
          {declarations.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="text-xs font-semibold text-content-primary">
                {group.label}
              </h3>
              {group.values.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {group.values.map((value, index) => (
                    <li
                      key={`${group.label}-${index}`}
                      className="max-w-full rounded-md bg-muted px-2 py-1 text-xs text-content-secondary"
                    >
                      {declarationLabel(value)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-content-muted">None declared</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <p className="text-sm text-content-muted">
          This plugin does not declare additional inputs, outputs, or system
          capabilities.
        </p>
      )}
    </div>
  );
}

export function MarketplaceItemCard({
  item,
  initiallyInstalled,
  canManage = true,
  canAddReference = false,
  onAddReference,
  isReferenceAdded = false,
}: {
  item: RegistryItem;
  initiallyInstalled: boolean;
  canManage?: boolean;
  canAddReference?: boolean;
  onAddReference?: AddMarketplaceSkillReference;
  isReferenceAdded?: boolean;
}) {
  const [installedLocally, setInstalledLocally] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [errorContext, setErrorContext] = useState<"install" | "reference">(
    "install",
  );
  const [addingReference, setAddingReference] = useState(false);
  const installed = initiallyInstalled || installedLocally;
  const isAction = item.type === "action";
  const isPlugin = item.type === "plugin";
  const isSkill = item.type === "skill";
  const installedRef = useRef(installed);
  const installRequestRef = useRef<Promise<boolean> | null>(null);
  const referenceRequestRef = useRef<Promise<void> | null>(null);
  installedRef.current = installed;

  const errorMessage = (error: unknown) =>
    error instanceof Error && error.message.trim()
      ? error.message
      : "Unknown Marketplace error";

  const ensureInstalled = useCallback(
    (context: "install" | "reference") => {
      if (installedRef.current) return Promise.resolve(true);
      if (installRequestRef.current) return installRequestRef.current;

      setInstalling(true);
      setInstallError(null);
      setErrorContext(context);
      const request = (async () => {
        try {
          if (isAction) {
            await marketplaceInstallAction(item);
          } else if (isPlugin) {
            await marketplaceInstallPlugin(item);
          } else {
            await marketplaceInstallSkill(item);
          }
          installedRef.current = true;
          setInstalledLocally(true);
          return true;
        } catch (error) {
          console.error("Marketplace install failed:", error);
          setInstallError(errorMessage(error));
          return false;
        } finally {
          setInstalling(false);
          installRequestRef.current = null;
        }
      })();
      installRequestRef.current = request;
      return request;
    },
    [isAction, isPlugin, item],
  );

  const install = async () => {
    if (!canManage || installed || installing) return;
    await ensureInstalled("install");
  };

  const addReference = useCallback(() => {
    const reference = marketplaceSkillReference(item);
    if (!reference || !canAddReference || !onAddReference || isReferenceAdded) {
      return Promise.resolve();
    }
    if (referenceRequestRef.current) return referenceRequestRef.current;

    setAddingReference(true);
    setInstallError(null);
    setErrorContext("reference");
    const request = (async () => {
      try {
        if (!(await ensureInstalled("reference"))) return;
        await onAddReference(reference);
      } catch (error) {
        console.error("Marketplace Composer reference failed:", error);
        setInstallError(errorMessage(error));
      } finally {
        setAddingReference(false);
        referenceRequestRef.current = null;
      }
    })();
    referenceRequestRef.current = request;
    return request;
  }, [
    canAddReference,
    ensureInstalled,
    isReferenceAdded,
    item,
    onAddReference,
  ]);

  const referenceEnabled =
    isSkill && canAddReference && Boolean(onAddReference);
  const draggable = useMarketplaceSkillReferenceDraggable({
    item,
    enabled: referenceEnabled && !isReferenceAdded,
    requestAdd: addReference,
  });

  return (
    <Card asChild interaction="surface">
      <li
        ref={draggable.setNodeRef}
        data-slot="marketplace-item"
        data-layout="model-card"
        data-dragging={draggable.isDragging ? "true" : "false"}
        style={{ transform: CSS.Translate.toString(draggable.transform) }}
        {...(referenceEnabled ? draggable.attributes : {})}
        {...(referenceEnabled ? draggable.listeners : {})}
        className={cn(
          "group/marketplace-card relative flex min-h-[148px] min-w-0 flex-col",
          draggable.isDragging && "opacity-60",
        )}
      >
        <Link
          to={marketplacePluginPath(item)}
          aria-label={`View ${item.name} details`}
          className="flex min-w-0 flex-1 items-start gap-3.5 rounded-[var(--surface-card-radius)] p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {item.cover ? (
            <MarketplaceItemArtwork item={item} />
          ) : (
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white p-1 shadow-[0_4px_14px_rgba(31,26,23,0.08)] dark:border-white/10">
              <MarketplaceItemArtwork item={item} />
            </span>
          )}
          <span className="min-w-0 flex-1 pt-0.5">
            <span className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="truncate text-[15px] font-semibold leading-5 text-content-primary">
                    {item.name}
                  </h3>
                  {item.author ? (
                    <span className="text-xs text-content-muted">
                      @{item.author}
                    </span>
                  ) : null}
                  {item.version ? (
                    <span className="font-mono text-xs text-content-muted">
                      v{item.version}
                    </span>
                  ) : null}
                </span>
              </span>
              <CaretRight
                className="mt-0.5 h-4 w-4 shrink-0 text-content-muted "
                aria-hidden="true"
              />
            </span>

            {item.description ? (
              <span className="mt-3 block line-clamp-2 min-h-8 text-xs leading-4 text-content-secondary">
                {item.description}
              </span>
            ) : null}

            {item.tags && item.tags.length > 0 ? (
              <span className="mt-3 flex min-w-0 flex-wrap gap-1.5">
                {item.tags.slice(0, 2).map((tag) => (
                  <Badge
                    key={tag}
                    data-tag=""
                    variant="secondary"
                    className="rounded-md px-2"
                  >
                    {tag}
                  </Badge>
                ))}
              </span>
            ) : null}
          </span>
        </Link>

        <div className="flex min-h-8 min-w-0 flex-wrap items-center justify-end gap-2 px-4 pb-4">
          {canManage || referenceEnabled ? (
            <>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                {installed ? (
                  <Badge variant="secondary" tone="sage">
                    <Check
                      className="h-3 w-3"
                      weight="bold"
                      aria-hidden="true"
                    />
                    Installed
                  </Badge>
                ) : null}
                {isReferenceAdded ? (
                  <Badge variant="secondary" tone="blue">
                    Added to Composer
                  </Badge>
                ) : null}
                {installError ? (
                  <Badge
                    role={errorContext === "reference" ? "alert" : "status"}
                    aria-live="polite"
                    variant="secondary"
                    tone="coral"
                    className="max-w-full whitespace-normal text-left"
                  >
                    {errorContext === "install" ? "Install failed: " : null}
                    {installError}
                  </Badge>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {canManage && !installed ? (
                  <Button
                    onClick={() => void install()}
                    disabled={installing || addingReference}
                    leftIcon={
                      installing && errorContext === "install" ? undefined : (
                        <Download
                          className="h-3.5 w-3.5"
                          weight="bold"
                          aria-hidden="true"
                        />
                      )
                    }
                    size="sm"
                    shape="rounded"
                    className="h-8 rounded-lg px-3 text-xs"
                  >
                    {installing && errorContext === "install"
                      ? "Installing…"
                      : installError && errorContext === "install"
                        ? "Retry"
                        : "Install"}
                  </Button>
                ) : null}

                {referenceEnabled && !isReferenceAdded ? (
                  <Button
                    onClick={() => void addReference()}
                    disabled={addingReference || installing}
                    size="sm"
                    shape="rounded"
                    className="h-8 rounded-lg px-3 text-xs"
                  >
                    {addingReference ? "Adding…" : "Add to Composer"}
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <Badge variant="secondary" tone="blue" className="w-fit">
              Available in workspace
            </Badge>
          )}
        </div>
      </li>
    </Card>
  );
}
