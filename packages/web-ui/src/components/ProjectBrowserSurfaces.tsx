import { memo, useCallback, type ComponentProps } from "react";
import type {
  AgentAnnotationDraft,
  AgentAnnotationTarget,
} from "@clash/shared-types";
import type { BrowserAgentContext } from "../lib/copilotWorkspaceContext";
import { BrowserSurface } from "./BrowserSurface";
import type { ProjectBrowserTab } from "./ProjectWorkspaceNavigator";

type BrowserSurfaceProps = ComponentProps<typeof BrowserSurface>;

type RetainedBrowserSurfaceProps = Omit<BrowserSurfaceProps, "onTabChange"> & {
  onTabChange: (
    browserId: string,
    patch: Parameters<BrowserSurfaceProps["onTabChange"]>[0],
  ) => void;
};

// Keep each webview and its React state alive, without re-rendering/rebinding
// all pages when the surrounding workspace changes or another tab is selected.
const RetainedBrowserSurface = memo(function RetainedBrowserSurface({
  onTabChange,
  ...props
}: RetainedBrowserSurfaceProps) {
  const browserId = props.tab.id;
  const handleTabChange = useCallback(
    (patch: Parameters<BrowserSurfaceProps["onTabChange"]>[0]) =>
      onTabChange(browserId, patch),
    [browserId, onTabChange],
  );
  return <BrowserSurface {...props} onTabChange={handleTabChange} />;
});

export function ProjectBrowserSurfaces({
  projectId,
  tabs,
  activeBrowserId,
  headerEndInset = 0,
  annotations,
  activeAnnotationId,
  onTabChange,
  onCreateAnnotation,
  onSelectAnnotation,
  onAgentContextChange,
}: {
  projectId: string;
  tabs: readonly ProjectBrowserTab[];
  activeBrowserId: string | null;
  headerEndInset?: number;
  annotations: readonly AgentAnnotationDraft[];
  activeAnnotationId: string | null;
  onTabChange: (
    browserId: string,
    patch: Partial<Pick<ProjectBrowserTab, "title" | "url">>,
  ) => void;
  onCreateAnnotation: (target: AgentAnnotationTarget) => string;
  onSelectAnnotation: (annotationId: string) => void;
  onAgentContextChange?: (
    browserId: string,
    context: BrowserAgentContext,
  ) => void;
}) {
  return tabs.map((tab) => {
    const active = tab.id === activeBrowserId;
    return (
      <div
        key={tab.id}
        data-project-browser-slot={tab.id}
        data-active={active ? "true" : "false"}
        aria-hidden={active ? undefined : true}
        className={`absolute inset-0 z-10 ${
          active ? "visible" : "invisible pointer-events-none"
        }`}
      >
        <RetainedBrowserSurface
          projectId={projectId}
          tab={tab}
          headerEndInset={headerEndInset}
          annotations={annotations}
          activeAnnotationId={activeAnnotationId}
          onTabChange={onTabChange}
          onCreateAnnotation={onCreateAnnotation}
          onSelectAnnotation={onSelectAnnotation}
          onAgentContextChange={onAgentContextChange}
        />
      </div>
    );
  });
}
