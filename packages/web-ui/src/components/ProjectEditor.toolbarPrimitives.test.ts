import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceContains, sourceMatches } from "../test-support/source-match";

const readSource = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function readCanvasToolbarSource() {
  const source = readSource("packages/web-ui/src/components/ProjectEditor.tsx");
  const start = source.indexOf('clash-canvas-toolbar-surface');
  const end = source.indexOf('id="copilot-container"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function readSelectionGroupButtonSource() {
  const source = readSource("packages/web-ui/src/components/ProjectEditor.tsx");
  const start = source.indexOf("function SelectionGroupButton");
  const end = source.indexOf("export default function ProjectEditor", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("ProjectEditor toolbar primitives", () => {
  it("uses Radix Toolbar for roving focus and single-select canvas modes", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");

    expect(sourceContains(editorSource, "import { Toolbar } from 'radix-ui'")).toBe(true);
    expect(sourceContains(editorSource, '<Toolbar.Root')).toBe(true);
    expect(sourceContains(editorSource, 'orientation="vertical"')).toBe(true);
    expect(sourceContains(editorSource, '<Toolbar.ToggleGroup')).toBe(true);
    expect(sourceContains(editorSource, 'type="single"')).toBe(true);
    expect(sourceMatches(editorSource, /<Toolbar\.ToggleItem\s+value="select"\s+asChild\s*>/)).toBe(true);
    expect(sourceMatches(editorSource, /<Toolbar\.ToggleItem\s+value="hand"\s+asChild\s*>/)).toBe(true);
    expect(sourceContains(editorSource, 'role="group"')).toBe(false);
  });

  it("uses the shared tooltip primitive for canvas toolbar icon buttons instead of browser title attributes", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");
    const toolbarSource = readCanvasToolbarSource();
    const tooltipSource = readSource("packages/gui/src/components/ui/tooltip.tsx");

    expect(sourceContains(tooltipSource, "@ariakit/react")).toBe(true);
    expect(sourceContains(tooltipSource, "TooltipProvider")).toBe(true);
    expect(sourceContains(tooltipSource, "TooltipAnchor")).toBe(true);
    expect(sourceContains(tooltipSource, "Tooltip")).toBe(true);
    expect(sourceContains(editorSource, "./ui/tooltip")).toBe(true);
    expect(sourceContains(toolbarSource, "<Tooltip label=")).toBe(true);
    expect(sourceContains(editorSource, "CanvasToolbarTooltip")).toBe(false);
    expect(sourceContains(editorSource, "TooltipProvider")).toBe(false);
    expect(sourceContains(editorSource, "TooltipAnchor")).toBe(false);
    expect(sourceContains(toolbarSource, "title=")).toBe(false);
  });

  it("places vertical canvas toolbar tooltips to the right of their controls", () => {
    const toolbarSource = readCanvasToolbarSource();

    expect(sourceMatches(toolbarSource, /<Tooltip label="Select mode \(V\)" placement="right">/)).toBe(true);
    expect(sourceMatches(toolbarSource, /<Tooltip label="Hand mode \(H\)" placement="right">/)).toBe(true);
    expect(sourceMatches(toolbarSource, /<Tooltip label="Create node" placement="right">/)).toBe(true);
    expect(sourceMatches(toolbarSource, /<Tooltip label="Auto Layout" placement="right">/)).toBe(true);
    expect(sourceMatches(toolbarSource, /<Tooltip label="Undo" placement="right">/)).toBe(true);
    expect(sourceMatches(toolbarSource, /<Tooltip label="Redo" placement="right">/)).toBe(true);
  });

  it("uses the shared tooltip primitive for project editor icon actions outside the canvas toolbar", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");

    expect(sourceContains(editorSource, '<Tooltip label="Wrap selected nodes in a new Group">')).toBe(true);
    expect(sourceContains(editorSource, '<Tooltip label="Return to projects">')).toBe(true);
    expect(sourceContains(editorSource, 'title="Wrap selected nodes in a new Group"')).toBe(false);
    expect(sourceContains(editorSource, 'title="Return to projects"')).toBe(false);
  });

  it("lets ReactFlow own the group action event boundary instead of hand-rolled mouse suppression", () => {
    const buttonSource = readSelectionGroupButtonSource();

    expect(sourceContains(buttonSource, "nodrag")).toBe(true);
    expect(sourceContains(buttonSource, "nopan")).toBe(true);
    expect(sourceContains(buttonSource, "onMouseDown={(e) => e.stopPropagation()}")).toBe(false);
  });

  it("delegates node and ActionAssetBinding deletion to the atomic Loro authority", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");

    expect(sourceContains(editorSource, "loroSync.removeNodes(deletedNodes.map((node) => node.id))")).toBe(true);
    expect(sourceContains(editorSource, "persistedDeletedNodes")).toBe(false);
    expect(sourceContains(editorSource, "removeAssetRefs")).toBe(false);
  });

  it("uses shared button primitives for project editor chrome and canvas toolbar actions", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");
    const toolbarSource = readCanvasToolbarSource();
    const selectionButtonSource = readSelectionGroupButtonSource();

    expect(sourceContains(editorSource, "./ui/button")).toBe(true);
    expect(sourceContains(editorSource, "./ui/icon-button")).toBe(true);
    expect(sourceContains(editorSource, "<Button")).toBe(true);
    expect(sourceContains(editorSource, "<IconButton")).toBe(true);
    expect(sourceContains(toolbarSource, "<motion.button")).toBe(false);
    expect(sourceContains(selectionButtonSource, "<motion.button")).toBe(false);
  });

  it("lets the shared accordion primitive own debug node log disclosure", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");
    const debugOverlayStart = editorSource.indexOf("function DebugNodeIds");
    const debugOverlayEnd = editorSource.indexOf("export default function ProjectEditor", debugOverlayStart);
    const debugOverlaySource = editorSource.slice(debugOverlayStart, debugOverlayEnd);

    expect(sourceContains(editorSource, "./ui/accordion")).toBe(true);
    expect(sourceContains(debugOverlaySource, "<Accordion")).toBe(true);
    expect(sourceContains(debugOverlaySource, 'type="single"')).toBe(true);
    expect(sourceContains(debugOverlaySource, "AccordionItem")).toBe(true);
    expect(sourceContains(debugOverlaySource, "AccordionTrigger asChild")).toBe(true);
    expect(sourceContains(debugOverlaySource, "AccordionContent")).toBe(true);
    expect(sourceContains(debugOverlaySource, "expandedNode")).toBe(false);
    expect(sourceContains(debugOverlaySource, "setExpandedNode")).toBe(false);
    expect(sourceContains(debugOverlaySource, "isExpanded &&")).toBe(false);
  });

  it("dispatches host mutation records from the live ProjectEditor runtime", () => {
    const editorSource = readSource("packages/web-ui/src/components/ProjectEditor.tsx");

    expect(sourceContains(editorSource, "@clash/web-ui/lib/hostMutationEvents")).toBe(true);
    expect(sourceContains(editorSource, "onMutation: (mutation) => dispatchHostMutationEvent(project.id, mutation)")).toBe(true);
  });
});
