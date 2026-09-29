import type { GeneratorInputRef } from "@clash/shared-types";
import { useAsset } from "../../lib/hooks/useAsset";
import { AssetThumbnail } from "../../features/assets/AssetThumbnail";
import { assetAvailabilityLabel } from "../../features/assets/availability";
import { safeScopedAssetName } from "../scopedAssetPickerModel";
import { FrameReferenceSlot } from "./GeneratorReferenceThumbnail";
import { IconButton } from "../ui/icon-button";

/** Input identity comes from the revision; Canvas placement is not required. */
export function NativeMediaReference({
  projectId,
  input,
  onRemove,
  compactLabel,
}: {
  compactLabel?: string;
  projectId: string;
  input: GeneratorInputRef;
  onRemove?: (input: GeneratorInputRef) => void;
}) {
  const assetId =
    "kind" in input.target && input.target.kind === "media"
      ? input.target.projectAssetId
      : undefined;
  const asset = useAsset(projectId, assetId);
  if (!assetId) return null;
  const slotLabel =
    input.slot === "startFrame"
      ? "Start frame"
      : input.slot === "endFrame"
        ? "End frame"
        : "Media";
  const fullLabel = asset ? safeScopedAssetName(asset) : slotLabel;
  const label = compactLabel ?? fullLabel;
  if (compactLabel)
    return (
      <li className="list-none">
        <FrameReferenceSlot
          filled
          label={fullLabel}
          assetReference={{ projectId, assetId }}
          onRemove={onRemove ? () => onRemove(input) : undefined}
          removeLabel={`Remove ${compactLabel} reference`}
        />
      </li>
    );
  return (
    <li
      title={fullLabel}
      className={`flex min-w-0 items-center gap-2 rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-xs ${compactLabel ? "w-fit max-w-56" : ""}`}
    >
      {asset && (
        <AssetThumbnail
          kind={asset.kind}
          src={asset.url ?? ""}
          thumbnailSrc={asset.thumbnailUrl}
          status={asset.status}
          label={label}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{label}</div>
        {asset && (!compactLabel || asset.status !== "ready") && (
          <div className="text-content-secondary">
            {assetAvailabilityLabel(asset)}
          </div>
        )}
      </div>
      {onRemove && (
        <IconButton
          className="nodrag nopan"
          label={`Remove ${label} reference`}
          icon="×"
          size="sm"
          shape="circle"
          onClick={() => onRemove(input)}
        />
      )}
    </li>
  );
}
