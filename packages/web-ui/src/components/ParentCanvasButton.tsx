import type { ProjectCanvas } from "@clash/shared-types";
import { CanvasIcon } from "./ProjectSurfaceIcon";
import { IconButton } from "./ui/icon-button";
import { Tooltip } from "./ui/tooltip";

/** Navigation to a workspace's owner; this does not close or delete its content. */
export function ParentCanvasButton({
  canvas,
  onOpenCanvas,
}: {
  canvas: Pick<ProjectCanvas, "id" | "name">;
  onOpenCanvas: (canvasId: string) => void;
}) {
  const label = `Open parent Canvas ${canvas.name}`;
  return (
    <Tooltip label={label}>
      <IconButton
        label={label}
        icon={<CanvasIcon className="h-4 w-4" weight="regular" />}
        size="sm"
        shape="rounded"
        onClick={() => onOpenCanvas(canvas.id)}
        className="h-8 min-h-8 w-8 min-w-8 rounded-md text-content-muted hover:bg-warm-hover hover:text-content-primary"
      />
    </Tooltip>
  );
}
