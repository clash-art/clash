import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { sourceContains, sourceMatches } from "../test-support/source-match";
const source = readFileSync(
  new URL("./ProjectEditor.tsx", import.meta.url),
  "utf8",
);
const globalsSource = readFileSync(
  new URL("../../../../apps/web/app/globals.css", import.meta.url),
  "utf8",
);

describe("ProjectEditor workspace model", () => {
  it("projects one Project Loro replica into a selected concrete Canvas", () => {
    expect(
      sourceMatches(source, /useState\(['"]main['"]\)/),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceMatches(source, /useLoroSync\(\{[\s\S]*canvasId: activeCanvasId/),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<ProjectWorkspaceNavigator"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<EditableProjectAssetSurface"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<ProjectTimelineEditorSurface"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<ProjectDirectorStageSurface"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<StandaloneTimelineSurface"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, 'id="project-workspace-shell"'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "grid-cols-[var(--clash-app-sidebar-expanded-width,16rem)_minmax(0,1fr)]",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(sourceContains(source, "header={"), "mechanism missing").toBe(true);
    expect(
      sourceContains(source, "footer={<UserControls compact />}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "sidebarExpanded={!isProjectNavigatorCollapsed}"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, 'id="project-top-actions"'),
      "must not reappear",
    ).toBe(false);
    expect(sourceContains(source, "topActionsRight"), "must not reappear").toBe(
      false,
    );
    expect(
      sourceContains(source, "clash-project-sidebar-header"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "className={`absolute bottom-0 left-52"),
      "must not reappear",
    ).toBe(false);
  });

  it("places sidebar-created plugin surfaces on the implicit Main Canvas", () => {
    expect(
      sourceMatches(
        source,
        /const createPluginViewFromNavigator[\s\S]{0,1600}createPluginView\(\{[\s\S]{0,500}canvasId:\s*DEFAULT_CANVAS_ID/,
      ),
      "Plugin View direct-add must target Main",
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /const createTimelineFromNavigator[\s\S]{0,1600}createTimelineOnCanvas\(\{[\s\S]{0,300}canvasId:\s*DEFAULT_CANVAS_ID/,
      ),
      "Timeline direct-add must target Main",
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /const createDirectorStageFromNavigator[\s\S]{0,1600}createDirectorStageOnCanvas\(\{[\s\S]{0,300}canvasId:\s*DEFAULT_CANVAS_ID/,
      ),
      "Director Stage direct-add must target Main",
    ).toBe(true);
  });

  it("persists the project navigator through the shared workspace shell", () => {
    expect(source).toMatch(
      /localStorage\.getItem\(["']project-navigator-collapsed["']\)/,
    );
    expect(source).toMatch(
      /localStorage\.setItem\(\s*["']project-navigator-collapsed["']/,
    );
    expect(source).toMatch(
      /data-project-navigator-collapsed=\{\s*isProjectNavigatorCollapsed\s*\}/,
    );
    expect(
      sourceContains(
        source,
        "data-[project-navigator-collapsed=true]:grid-cols-[0_minmax(0,1fr)]",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "--clash-app-sidebar-collapsed-width"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceMatches(source, /collapsed=\{\s*isProjectNavigatorCollapsed\s*\}/),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /onCollapsedChange=\{\s*setIsProjectNavigatorCollapsed\s*\}/,
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'widthStorageKey="project-navigator-width"'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /header=\{[\s\S]{0,2200}<DesktopSidebarCollapseButton/,
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "clash-project-sidebar-toggle-button"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "PROJECT_NAVIGATOR_VISIBILITY_EVENT"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "setIsProjectNavigatorCollapsed(detail.collapsed)",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "data-project-workspace-toolbar"),
      "mechanism missing",
    ).toBe(true);
  });

  it("publishes the real project name to the retained desktop tab", () => {
    expect(sourceContains(source, "DESKTOP_TAB_TITLE_EVENT")).toBe(true);
    expect(
      sourceMatches(
        source,
        /title:\s*projectName\s*\|\|\s*project\.name\s*\|\|\s*["']Untitled["']/,
      ),
    ).toBe(true);
    expect(
      sourceMatches(
        source,
        /window\.dispatchEvent\(\s*new CustomEvent\(DESKTOP_TAB_TITLE_EVENT,\s*\{\s*detail\s*\}\)/,
      ),
    ).toBe(true);
  });

  it("hosts the full project navigator body inside the shared auto-hide sidebar", () => {
    expect(
      sourceMatches(
        source,
        /import DesktopAutoHideSidebar,\s*\{[\s\S]*?DesktopSidebarCollapseButton[\s\S]*?\}\s*from "\.\/DesktopAutoHideSidebar"/,
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<DesktopAutoHideSidebar"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'label="Project navigator"'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        'expandedWidth="var(--clash-app-sidebar-expanded-width)"',
      ),
      "mechanism missing",
    ).toBe(true);
    // The shared component owns the aside, the edge preview, and the scrim.
    expect(
      sourceMatches(
        source,
        /<DesktopAutoHideSidebar[\s\S]{0,400}<ProjectWorkspaceNavigator/,
      ),
      "mechanism missing",
    ).toBe(true);
    // The navigator renders one full body; it has no collapsed variant.
    expect(
      sourceMatches(
        source,
        /<ProjectWorkspaceNavigator[^>]*\bcollapsed=/,
      ),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceMatches(
        source,
        /\{!isProjectNavigatorCollapsed \?[\s\S]{0,40}<form/,
      ),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceMatches(source, /clash-auto-hide-sidebar-host/),
      "mechanism missing",
    ).toBe(true);
  });

  it("keeps the auto-hide sidebar host elevated during collapsed preview", () => {
    expect(
      sourceMatches(
        globalsSource,
        /\.clash-auto-hide-sidebar-host:has\(> aside\[data-state="preview"\]\)\s*\{[\s\S]*?z-index:\s*40;[\s\S]*?overflow:\s*visible;/,
      ),
      "mechanism missing",
    ).toBe(true);
  });

  it("does not reconstruct Canvas ownership from the Project asset list", () => {
    expect(
      sourceContains(source, "buildFallbackCanvasFromAssets"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "recoveredFromAssetRef"),
      "must not reappear",
    ).toBe(false);
  });

  it("creates Timeline Actions through Timeline ownership primitives", () => {
    expect(source).toMatch(
      /type === ["']video-editor["'][\s\S]*createTimelineOnCanvas\(/,
    );
  });

  it("creates Director Stage Actions through independent Stage ownership primitives", () => {
    expect(source).toMatch(
      /type === ["']director-stage["'][\s\S]*createDirectorStageOnCanvas\(/,
    );
    expect(
      sourceContains(source, "onDoubleClick={openCreateMenuFromPane}"),
      `mechanism missing`,
    ).toBe(true);
    expect(
      sourceContains(source, 'classList.contains("react-flow__pane")'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "directorStages={loroSync.directorStages}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "onOpenDirectorStage={openDirectorStageFromCanvasAction}",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onCaptureShot={captureDirectorStageShot}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onUploadModel={uploadDirectorModel}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "DIRECTOR_BUILTIN_MODEL_ASSET_URLS"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "!DIRECTOR_BUILTIN_MODEL_ASSET_URLS[object.model.assetId]",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onGeneratePanorama={generateDirectorPanorama}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "normalizeDirectorPanorama(file"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'panoramaProjection: "equirectangular"'),
      "mechanism missing",
    ).toBe(true);
    // The panorama is 2:1 equirectangular, which is what this test's own title
    // states and what the generator sends. `21:9` was never in the product and
    // is a cinematic crop, not an equirectangular projection.
    expect(
      sourceContains(source, 'aspect_ratio: "2:1"'),
      "mechanism missing",
    ).toBe(true);
    expect(sourceContains(source, 'kind: "model"'), "mechanism missing").toBe(
      true,
    );
  });

  it("inspects uploaded Director models and persists discovered animation metadata", () => {
    expect(
      sourceContains(source, "inspectDirectorModelFile"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "animation: animationMetadata"),
      "mechanism missing",
    ).toBe(true);
  });

  it("routes Director text-to-3D through the local runtime and stage callback", () => {
    expect(
      sourceContains(source, "onGenerateModel={generateDirectorModel}"),
      `mechanism missing`,
    ).toBe(true);
    expect(
      sourceContains(
        source,
        'runtimeApiUrl("/api/v1/director-model-generations")',
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "body: JSON.stringify({ actionRunId, projectId: project.id, ...input })",
      ),
      "mechanism missing",
    ).toBe(true);
  });

  it("sizes Director Stage shot nodes to the captured aspect ratio", () => {
    const captureCallback =
      source.match(
        /const captureDirectorStageShot = useCallback\([\s\S]*?\n {2}\);/,
      )?.[0] ?? "";

    expect(
      sourceContains(source, "calculateDimensionsFromAspectRatio"),
      "mechanism missing",
    ).toBe(true);
    expect(source).toMatch(
      /const shotNodeSize = calculateDimensionsFromAspectRatio\(\s*input\.aspectRatio,?\s*\)/,
    );
    expect(
      sourceContains(source, "width: shotNodeSize.width"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "height: shotNodeSize.height"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "aspectRatio: input.aspectRatio"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "sourceDirectorStageTimeSeconds: input.timeSeconds",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(captureCallback, 'op: "shot.register"'),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(captureCallback, "applyDirectorStageState"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(captureCallback, "sourceDirectorStageRevisionId"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(captureCallback, "publishDirectorStageOutputFile"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(captureCallback, "importProjectAssetFile"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(captureCallback, "addNodeToCanvas"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(captureCallback, "addEdge"),
      "mechanism missing",
    ).toBe(true);
  });

  it("publishes Director video exports as independent referenced output nodes", () => {
    const exportCallback =
      source.match(
        /const exportDirectorStageVideo = useCallback\([\s\S]*?\n {2}\);/,
      )?.[0] ?? "";

    expect(exportCallback).toContain("publishDirectorStageOutputFile");
    expect(exportCallback).not.toContain("importProjectAssetFile");
    expect(exportCallback).toContain('type: "video"');
    expect(exportCallback).toContain("assetId");
    expect(exportCallback).toContain("addNodeToCanvas");
    expect(exportCallback).toContain("addEdge");
    expect(exportCallback).toContain("updateEdge");
    expect(exportCallback).not.toContain("outputPatch");
    expect(exportCallback).not.toContain(
      "loroSync.updateNode(owner.actionNodeId",
    );
    expect(exportCallback).not.toContain("outputVideoAssetId");
    expect(exportCallback).not.toContain("outputVideoSrc");
    expect(exportCallback).not.toContain("outputVideoPreviewUrl");
    expect(exportCallback).toContain("createDirectorReferencePacket");
    expect(exportCallback).toContain("directorReferencePacket");
    expect(exportCallback).toContain("directorShotReferencePackets");
    expect(exportCallback).toContain('input.mode === "selected-shots"');
    expect(exportCallback).toContain("sourceDirectorStageShotId");
    expect(exportCallback).toContain("autoRun: true");
    expect(exportCallback).toContain("render.referenceFrames");
    expect(exportCallback).toContain("referenceStills");
    expect(exportCallback).not.toContain('op: "shot.register"');
    expect(exportCallback).not.toContain("loroSync.applyDirectorStageState");
    expect(exportCallback).toContain("loroSync.updateNode");
    expect(exportCallback).not.toContain("createTimeline");
    expect(exportCallback).not.toContain("attachTimeline");
    expect(exportCallback).not.toContain("requestTimelineRender");
    expect(exportCallback).not.toContain("applyTimelineState");
  });

  it("opens a Timeline as an editor document instead of an information surface", () => {
    expect(
      sourceContains(source, "timelines={loroSync.timelines}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "applyTimelineState"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onOpenTimeline={openTimelineFromCanvasAction}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onOpenCanvas={selectCanvasFromNavigator}"),
      `mechanism missing`,
    ).toBe(true);
    expect(
      sourceContains(source, "onExit={exitTimelineEditor}"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(
        source,
        "standaloneTimelines={loroSync.standaloneTimelines}",
      ),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "selectTimelineMediaInputs({"),
      "mechanism missing",
    ).toBe(true);
    const timelineSurface =
      source.match(/<ProjectTimelineEditorSurface[\s\S]*?\/>/)?.[0] ?? "";
    expect(timelineSurface).toContain("mediaInputs={timelineMediaInputs}");
    expect(timelineSurface).toContain("key={selectedTimeline.id}");
    expect(timelineSurface).not.toContain("assets={projectAssets}");
    expect(timelineSurface).toContain("onRequestAsset={() =>");
  });

  it("attributes Timeline exports to the signed-in user with a local owner fallback", () => {
    expect(
      sourceContains(source, "betterAuthClient.useSession()"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "session.data?.user?.id || project.ownerId"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "actorUserId: timelineExportActorUserId"),
      "mechanism missing",
    ).toBe(true);
  });

  it("uses one scope-aware picker for Canvas and Timeline media acquisition", () => {
    expect(
      sourceContains(source, "<ScopedAssetPicker"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "buildScopedAssetSections({"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "planAssetScopeCascade({ source: option.source, target })",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        'setAssetPickerTarget({ kind: "canvas", canvasId: activeCanvasId, position })',
      ),
      "mechanism missing",
    ).toBe(true);
  });

  it("keeps collapsed editors full-width and reserves padding for the rounded floating Copilot", () => {
    expect(source).toMatch(
      /const shouldReserveCopilotSpace\s*=\s*workspaceSurface\.kind !== "canvas" && !isSidebarCollapsed/,
    );
    expect(source).toMatch(
      /const copilotWorkspaceRight\s*=\s*shouldReserveCopilotSpace[\s\S]*?sidebarWidth \+ COPILOT_PANEL_GUTTER_PX \* 2[\s\S]*?: 0/,
    );
    expect(
      sourceContains(
        source,
        'collapsedLauncherPlacement={workspaceSurface.kind === "canvas" ? "canvas" : "header"}',
      ),
      `mechanism missing`,
    ).toBe(true);
    expect(
      sourceContains(source, "headerEndInset={copilotHeaderInset}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "COPILOT_COLLAPSED_RAIL_WIDTH_PX"),
      "must not reappear",
    ).toBe(false);
    expect(source).toMatch(
      /data-copilot-layout=\{\s*shouldReserveCopilotSpace\s*\?\s*"reserved-floating"\s*:\s*"overlay"\s*\}/,
    );
    expect(source).toMatch(
      /id="project-workspace-shell"[\s\S]*?style=\{\{[\s\S]*?right: copilotWorkspaceRight/,
    );
    expect(
      sourceContains(source, "data-copilot-resizing={isCopilotResizing}"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(
        source,
        "onResizeStateChange={handleCopilotResizeStateChange}",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onWidthPreview={handleCopilotWidthPreview}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onWidthChange={handleCopilotWidthChange}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        "shell.style.right = `${nextWidth + COPILOT_PANEL_GUTTER_PX * 2}px`",
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(
        source,
        'shell.dataset.copilotResizing = resizing ? "true" : "false"',
      ),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "[data-copilot-width-constraint]"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "measureMinContentWidth"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "copilotWorkspaceMinWidthRef"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "STRUCTURED_WORKSPACE_MIN_WIDTH"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, "rightInset={copilotWorkspaceInset}"),
      "must not reappear",
    ).toBe(false);
    expect(
      sourceContains(source, 'layoutMode="floating"'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'layoutMode="docked"'),
      "must not reappear",
    ).toBe(false);
    expect(source.match(/<ChatbotCopilot/g)).toHaveLength(1);

    const copilotKey =
      source.match(/<ChatbotCopilot[\s\S]*?key=\{([^}]+)\}/)?.[1] ?? "";
    expect(copilotKey).not.toContain("workspaceSurface");
  });

  it("delegates the Home composer prompt to the Project composer without creating a cloud session", () => {
    expect(
      sourceContains(source, "initialPrompt={chatInitialPrompt}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "handleCreateSession(initialPrompt)"),
      "must not reappear",
    ).toBe(false);
  });

  it("warms the Timeline editor bundle after project data becomes available", () => {
    expect(
      sourceContains(source, "preloadTimelineEditor"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "requestIdleCallback"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "cancelIdleCallback"),
      "mechanism missing",
    ).toBe(true);
  });

  it("selects one project asset at a time and accepts sidebar asset drops on Canvas", () => {
    expect(
      sourceContains(source, "onSelectAsset={(assetId) =>"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'workspaceSurface.kind === "asset"'),
      "mechanism missing",
    ).toBe(true);
    expect(source).toMatch(
      /onDragEnterCapture=\{\s*handleCanvasAssetDragEnter\s*\}/,
    );
    expect(source).toMatch(
      /onDragOverCapture=\{\s*handleCanvasAssetDragOver\s*\}/,
    );
    expect(source).toMatch(
      /onDragLeaveCapture=\{\s*handleCanvasAssetDragLeave\s*\}/,
    );
    expect(
      sourceMatches(source, /onDropCapture=\{\s*handleCanvasAssetDrop\s*\}/),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'data-testid="canvas-asset-drop-target"'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onDragEndCapture={clearCanvasAssetDropTarget}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "<ProjectAssetsSurface"),
      "must not reappear",
    ).toBe(false);
  });

  it("feeds asset Preview a project-wide relation graph and real workspace navigation", () => {
    expect(
      sourceContains(source, "readAssetRelationGraph("),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'loroSync.doc.getMap("nodes").entries()'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, 'loroSync.doc.getMap("edges").entries()'),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "relationNodes={assetRelationGraph.nodes}"),
      `mechanism missing`,
    ).toBe(true);
    expect(
      sourceContains(source, "relationEdges={assetRelationGraph.edges}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onOpenCanvas={openAssetRelationCanvas}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onOpenTimeline={openAssetRelationTimeline}"),
      "mechanism missing",
    ).toBe(true);
    expect(
      sourceContains(source, "onOpenAsset={openRelatedAsset}"),
      "mechanism missing",
    ).toBe(true);
  });

  it("does not clear the live projection when returning to the already-active Canvas", () => {
    // The guard moved out of `selectCanvas` into the `activateCanvasData` callback it
    // delegates to, so a slice anchored on `selectCanvas` no longer contains it. Scope
    // to the function that owns the behaviour, and bound the slice by the next callback
    // so the assertion cannot drift into unrelated code.
    const start = source.indexOf("const activateCanvasData = useCallback");
    const end = source.indexOf("const selectCanvas = useCallback", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const activateSource = source.slice(start, end);

    // Re-selecting the current Canvas must not blank the live graph.
    expect(
      sourceMatches(
        activateSource,
        /if \(activeCanvasIdRef\.current !== canvasId\) \{ setNodes\(\[\]\); setEdges\(\[\]\); setActiveCanvasId\(canvasId\); \}/,
      ),
      "mechanism missing",
    ).toBe(true);
    // And `selectCanvas` must go through it rather than clearing state itself.
    const selectStart = end;
    const selectEnd = source.indexOf("useCallback", selectStart + 40);
    const selectSource = source.slice(selectStart, selectEnd);
    expect(
      sourceContains(selectSource, "activateCanvasData(canvasId)"),
      "mechanism missing",
    ).toBe(true);
    expect(sourceContains(selectSource, "setNodes([])")).toBe(false);
  });
});
