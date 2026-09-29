import { memo, useCallback } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { Shapes } from "@phosphor-icons/react";

import { usePluginView } from "../PluginViewContext";
import { Button } from "../ui/button";

function PluginViewNode({ id, data }: NodeProps<Node<Record<string, unknown>>>) {
  const { openView } = usePluginView();
  const label = typeof data.label === "string" && data.label.trim()
    ? data.label
    : "Untitled View";
  const handleOpen = useCallback(() => openView(id), [id, openView]);
  return (
    <div className="group relative w-[320px]" data-plugin-view-node={id} onDoubleClick={handleOpen}>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="!h-3 !w-3 !border-2 !border-warm-surface !bg-stone-400"
      />
      <div className="overflow-hidden rounded-matrix bg-warm-surface shadow-md ring-1 ring-warm-border transition-shadow hover:shadow-lg">
        <div className="flex min-h-32 items-center gap-4 bg-warm-muted px-5 py-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-warm-border bg-warm-surface text-brand shadow-sm">
            <Shapes className="h-6 w-6" weight="duotone" />
          </div>
          <div className="min-w-0">
            <div className="font-display text-[10px] font-bold uppercase tracking-wide text-content-muted">Plugin View</div>
            <div className="mt-1 truncate font-display text-sm font-semibold text-content-primary">{label}</div>
            <div className="mt-1 text-xs text-content-secondary">Structured draft workspace</div>
          </div>
        </div>
        <div className="flex h-12 items-center justify-end border-t border-warm-border px-3">
          <Button size="sm" onClick={handleOpen} className="clash-node-primary min-h-0 rounded-xl px-3 py-1.5 text-xs font-bold">
            Open View
          </Button>
        </div>
      </div>
    </div>
  );
}

export default memo(PluginViewNode);
