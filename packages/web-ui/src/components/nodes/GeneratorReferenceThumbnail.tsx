import type { ReactNode } from "react";
import { Image as ImageIcon } from "@phosphor-icons/react";
import { useAsset } from "../../lib/hooks/useAsset";
import { ProjectedImage } from "../ProjectedMedia";
import { Tooltip } from "../ui/tooltip";
import { IconButton } from "../ui/icon-button";

export function FrameReferenceSlot({
  assetReference,
  badge,
  emptyControl,
  filled,
  label,
  onRemove,
  removeLabel,
  thumb,
  timeControl,
  timeLabel,
}: {
  assetReference?: { projectId: string; assetId: string };
  badge?: ReactNode;
  emptyControl?: ReactNode;
  filled: boolean;
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
  thumb?: string;
  timeControl?: ReactNode;
  timeLabel?: string;
}) {
  const asset = useAsset(
    assetReference?.projectId ?? "",
    assetReference?.assetId,
  );
  const resolvedThumb =
    thumb ??
    (assetReference
      ? (asset?.thumbnailUrl ??
        (asset?.kind === "image" ? asset.url : undefined))
      : undefined);
  return (
    <Tooltip label={label}>
      <div className="group/thumb relative w-10 flex-shrink-0">
        {filled ? (
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-warm-border bg-warm-muted shadow-sm">
            {resolvedThumb ? (
              <ProjectedImage
                src={resolvedThumb}
                alt={label}
                className="h-full w-full object-cover"
              />
            ) : (
              <ImageIcon size={15} className="text-content-secondary" />
            )}
          </div>
        ) : (
          emptyControl
        )}
        <span className="sr-only">{label}</span>
        {badge != null && (
          <span className="clash-node-ref-index pointer-events-none absolute -left-1 -top-1 min-w-[14px] rounded px-1 text-center text-[9px] font-bold leading-[14px]">
            {badge}
          </span>
        )}
        {timeControl ??
          (timeLabel && (
            <div className="mt-1 text-center text-[9px] tabular-nums leading-none text-content-secondary">
              {timeLabel}
            </div>
          ))}
        {onRemove && removeLabel && (
          <IconButton
            label={removeLabel}
            icon="×"
            size="sm"
            shape="circle"
            onClick={onRemove}
            className={`nodrag nopan clash-node-ref-remove absolute -right-1 -top-1 hidden h-5 min-h-5 w-5 min-w-5 text-[11px] leading-none group-hover/thumb:flex`}
          />
        )}
      </div>
    </Tooltip>
  );
}
