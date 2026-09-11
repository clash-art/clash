import { isMcpProjectApp } from "../../lib/mcpProject";
import { ChatCenteredDots } from "@phosphor-icons/react";
import type { AgentAnnotationTarget } from "@clash/shared-types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "../ui/context-menu";

export function AgentAnnotationContextMenu({
  target,
  onAnnotate,
  children,
}: {
  target: AgentAnnotationTarget | null;
  onAnnotate: (target: AgentAnnotationTarget) => void;
  children: React.ReactNode;
}) {
  if (isMcpProjectApp()) return <>{children}</>;
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>
          {target?.objectLabel ?? "Agent context"}
        </ContextMenuLabel>
        <ContextMenuItem
          disabled={!target}
          onSelect={() => {
            if (target) onAnnotate(target);
          }}
        >
          <ChatCenteredDots className="h-4 w-4 shrink-0 text-stone-500 dark:text-stone-400" weight="duotone" />
          <span className="min-w-0 flex-1 truncate font-medium">
            Annotate for agent
          </span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
