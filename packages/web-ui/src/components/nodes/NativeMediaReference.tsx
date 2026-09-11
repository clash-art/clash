import type { GeneratorInputRef } from "@clash/shared-types";
import { useAsset } from "../../lib/hooks/useAsset";
import { AssetThumbnail } from "../../features/assets/AssetThumbnail";
import { assetAvailabilityLabel } from "../../features/assets/availability";
import { safeScopedAssetName } from "../scopedAssetPickerModel";
import { IconButton } from "../ui/icon-button";

/** Input identity comes from the revision; Canvas placement is not required. */
export function NativeMediaReference({ projectId, input, onRemove }: {
  projectId: string;
  input: GeneratorInputRef;
  onRemove?: (input: GeneratorInputRef) => void;
}) {
  const assetId = "kind" in input.target && input.target.kind === "media" ? input.target.projectAssetId : undefined;
  const asset = useAsset(projectId, assetId);
  if (!assetId) return null;
  const slotLabel = input.slot === "startFrame" ? "Start frame" : input.slot === "endFrame" ? "End frame" : "Media";
  const label = asset ? safeScopedAssetName(asset) : slotLabel;
  return <li className="flex min-w-0 items-center gap-2 rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-xs">
    {asset && <AssetThumbnail kind={asset.kind} src={asset.url ?? ""} thumbnailSrc={asset.thumbnailUrl} status={asset.status} label={label} />}
    <div className="min-w-0 flex-1">
      <div className="truncate font-medium">{label}</div>
      {asset && <div className="text-content-secondary">{assetAvailabilityLabel(asset)}</div>}
    </div>
    {onRemove && <IconButton className="nodrag nopan" label={`Remove ${label} reference`} icon="×" size="sm" shape="circle" onClick={() => onRemove(input)} />}
  </li>;
}
