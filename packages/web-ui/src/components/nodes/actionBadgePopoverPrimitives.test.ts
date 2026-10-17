import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sourceContains } from "../../test-support/source-match";

const readNodeSource = (file: string) =>
    readFileSync(join(process.cwd(), "packages/web-ui/src/components/nodes", file), "utf8");

describe("ActionBadge popover primitives", () => {
    it("uses ReactFlow positioning for the action panel and shared popovers for nested pickers", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("NodeToolbar");
        // The action panel mounts only while open (#163/#164); whitespace-insensitive.
        expect(sourceContains(source, "{showPanel ? (<NodeToolbar")).toBe(true);
        expect(source).toContain('useCanvasTransientUiOwner("action-panel", id)');
        expect(source).toContain("../ui/popover");
        expect(source).toContain("PopoverContent");
        expect(source).toContain("PopoverTrigger asChild");
        expect(source).not.toContain('role="button"');
        expect(source).not.toContain("event.key === 'Enter' || event.key === ' '");
        expect(source).not.toContain("createPortal");
        expect(source).not.toContain("document.addEventListener('mousedown'");
        expect(source).not.toContain("document.removeEventListener('mousedown'");
        expect(source).not.toContain("document.addEventListener('pointerdown'");
        expect(source).not.toContain("document.addEventListener('keydown', onEsc");
    });

    it("computes reference picker candidates for both legacy and slot-target pickers", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("showRefPicker || refPickerTarget !== null");
    });

    it("uses the shared node modal shell for the expanded prompt editor", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("./NodeModalDialog");
        expect(source).not.toContain("fixed inset-0 z-[9999] flex items-center justify-center p-8");
    });

    it("uses the shared combobox primitive for the inline asset mention picker", () => {
        const source = readNodeSource("ActionBadge.tsx");
        const comboboxPath = join(process.cwd(), "packages/web-ui/src/components/ui/combobox.tsx");
        const comboboxSource = existsSync(comboboxPath) ? readFileSync(comboboxPath, "utf8") : "";
        const guiComboboxPath = join(process.cwd(), "packages/gui/src/components/ui/combobox.tsx");
        const guiComboboxSource = existsSync(guiComboboxPath) ? readFileSync(guiComboboxPath, "utf8") : "";

        expect(existsSync(comboboxPath)).toBe(true);
        expect(comboboxSource).toContain("@clash/gui/components/ui/combobox");
        expect(guiComboboxSource).toContain("@ariakit/react");
        expect(source).toContain("../ui/combobox");
        expect(source).toContain("ComboboxProvider");
        expect(source).toContain("ComboboxList");
        expect(source).toContain("ComboboxItem");
        expect(source).not.toContain("@ariakit/react");
        expect(source).toContain("handleMentionComboboxKeyDown");
        expect(source).not.toContain("e.key === 'ArrowDown'");
        expect(source).not.toContain("e.key === 'ArrowUp'");
        expect(source).not.toContain("e.key === 'Escape'");
        expect(source).not.toContain("onKeyDown={isCheckpointLocked ? undefined : (e) =>");
        expect(source).not.toContain("mentionIndex");
        expect(source).not.toContain("setMentionIndex");
        expect(source).not.toContain("activeIndex");
        expect(source).not.toContain("onMouseEnter={() => onHover(idx)}");
        expect(source).not.toContain("selectValueOnClick={false}");
        expect(source).not.toContain("onClick={() => {\n                                onPick(node);");
        expect(source).not.toContain("@ mention dropdown with thumbnails");
        expect(source).not.toContain("absolute left-4 right-4 bottom-full mb-1 bg-warm-surface border border-warm-border rounded-xl shadow-lg z-50 max-h-48 overflow-y-auto");
    });

    it("uses the shared select primitive for the batch count picker", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("BATCH_COUNT_OPTIONS");
        expect(source).toContain('ariaLabel="Batch count"');
        expect(source).not.toContain("const [batchCountMenuOpen, setBatchCountMenuOpen]");
        expect(source).not.toContain("open={batchCountMenuOpen}");
        expect(source).not.toContain("setBatchCountMenuOpen");
        expect(source).not.toContain("countPopoverOpen");
        expect(source).not.toContain("[1, 2, 3, 4].map");
    });

    it("lets the shared select primitive own model picker disclosure state", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).not.toContain("const [showModelDropdown, setShowModelDropdown]");
        expect(source).not.toContain("open={showModelDropdown}");
        expect(source).not.toContain("setShowModelDropdown");
    });

    it("uses shared select primitives for expanded select and boolean parameter choices", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("PARAM_BOOLEAN_OPTIONS");
        expect(source).toContain("paramOptionsToSelectOptions");
        expect(source).not.toContain("p.options?.map((opt)");
        expect(source).not.toContain("[{ l: 'On', v: true }, { l: 'Off', v: false }].map");
    });

    it("does not keep an unused inline boolean parameter fallback", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).not.toContain("renderParamControl");
        expect(source).not.toContain("../ui/switch");
        expect(source).not.toContain("<Switch");
        expect(source).not.toContain('type="checkbox"');
    });

    it("routes the real music lyrics field through the shared Textarea", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("../ui/textarea");
        expect(source).toContain("<Textarea");
        expect(source).not.toContain("<textarea");
    });

    it("uses the shared slider primitive for model slider parameters", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("../ui/slider");
        expect(source).toContain("<Slider");
        expect(source).toContain("<SliderTrack");
        expect(source).toContain("<SliderRange");
        expect(source).toContain("<SliderThumb");
        expect(source).not.toContain('type="range"');
    });

    it("lets the shared accordion primitive own expanded parameter rows", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("../ui/accordion");
        expect(source).toContain("<Accordion");
        expect(source).toContain('type="single"');
        expect(source).toContain("collapsible");
        expect(source).toContain("AccordionItem");
        expect(source).toContain("AccordionTrigger asChild");
        expect(source).toContain("AccordionContent");
        expect(source).not.toContain("../ui/collapsible");
        expect(source).not.toContain("const [expandedParam, setExpandedParam]");
        expect(source).not.toContain("setExpandedParam");
        expect(source).not.toContain("setExpandedParam(isExpanded ? null : p.id)");
        expect(source).not.toContain("{isExpanded && (");
    });

    it("uses shared tooltip primitives for action control buttons instead of browser title attributes", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("../ui/tooltip");
        expect(source).toContain("<Tooltip label={modelPickerLabel}>");
        expect(source).toContain('<Tooltip label="Duplicate this panel and open the copy">');
        expect(source).toContain("<Tooltip label={checkpointRunLabel}>");
        expect(source).toContain("<Tooltip label={panelRunLabel}>");
        expect(source).not.toContain("title={customActionOffline ? RUNTIME_OFFLINE_TOOLTIP : undefined}");
        expect(source).not.toContain('title="Duplicate this panel and open the copy"');
        expect(source).not.toContain("title={customActionOffline ? RUNTIME_OFFLINE_TOOLTIP : 'Run again with current parameters'}");
        expect(source).not.toContain("TooltipProvider");
        expect(source).not.toContain("TooltipAnchor");
    });

    it("uses shared tooltip primitives for reference picker labels and keeps mention HTML title-free", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("<Tooltip label={label}>");
        expect(source).toContain("<RefPickerOptionButton");
        expect(source).not.toContain("onClick={() => onPick(n.id)}");
        expect(source).not.toContain('title="${label}"');
        expect(source).not.toContain("title={label}");
    });

    it("uses ReactFlow interaction boundary classes for node form controls instead of mouse suppression", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("NODE_INTERACTION_BOUNDARY_CLASS");
        expect(source).toContain("nodrag nopan");
        expect(source).not.toContain("onMouseDown={(e) => e.stopPropagation()}");
        expect(source).not.toContain("onPointerDown={e => e.stopPropagation()}");
    });

    it("uses shared button primitives for action badge controls", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("../ui/button");
        expect(source).toContain("../ui/icon-button");
        expect(source).toContain("<Button");
        expect(source).toContain("<IconButton");
        expect(source).not.toContain("<button");
        expect(source).not.toContain("<motion.button");
    });

    it("keeps contentEditable focus sync behind a tested helper", () => {
        const source = readNodeSource("ActionBadge.tsx");

        expect(source).toContain("replaceContentEditableHtmlPreservingFocus");
        expect(source).not.toContain("document.activeElement");
    });
});
