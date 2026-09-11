import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceMatches } from "../test-support/source-match";

function projectEditorSource() {
  return readFileSync(new URL("./ProjectEditor.tsx", import.meta.url), "utf8");
}

function chatbotCopilotSource() {
  return readFileSync(new URL("./ChatbotCopilot.tsx", import.meta.url), "utf8");
}

describe("ProjectEditor canvas performance", () => {
  it("keeps synced-node projection free of layout writes", () => {
    const source = projectEditorSource();
    const sourceFile = ts.createSourceFile("ProjectEditor.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let projection: string | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useLoroSync") {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const callback = options.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "onNodesChange");
          if (callback && ts.isPropertyAssignment(callback)) projection = callback.initializer.getText(sourceFile);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    expect(projection).toBeDefined();
    expect(sourceMatches(projection!, /loroSyncRef\.current\??\.updateNode\(/)).toBe(false);
  });

  it("keeps ReactFlow viewport virtualization enabled", () => {
    const source = projectEditorSource();

    expect(source).toMatch(/onlyRenderVisibleElements/);
  });

  it("keeps drag-only node changes from rerendering the Copilot tree", () => {
    const editorSource = projectEditorSource();
    const copilotSource = chatbotCopilotSource();
    const copilotUsage =
      editorSource.match(/<ChatbotCopilot[\s\S]*?\/>/)?.[0] ?? "";

    expect(editorSource).toContain("const copilotNodes = useMemo(");
    expect(editorSource).toContain(
      "const selectedNodesForInsertion = selectedNodesRef.current;",
    );
    expect(copilotUsage).toContain("nodes={copilotNodes}");
    // Canvas selection no longer flows into the copilot implicitly; the
    // right-click annotate flow is the single add-to-chat path.
    expect(copilotUsage).not.toContain("selectedNodes=");
    expect(copilotUsage).not.toContain("initialMessages={[]}");
    expect(copilotUsage).not.toContain("findNodeIdByName={findNodeIdByName}");
    expect(copilotUsage).not.toContain("edges={edges}");
    expect(copilotSource).toContain("export default memo(ChatbotCopilot);");
  });

  it("short-circuits multi-selection geometry while a node is dragging", () => {
    const source = projectEditorSource();

    expect(source).toContain("const [isNodeDragging, setIsNodeDragging] = useState(false)");
    expect(source).toMatch(
      /const selectionBounds = useMemo\(\(\) => \{[\s\S]*?if \(isNodeDragging \|\| isMarqueeing\) return null;/,
    );
  });

  it("does not eagerly load ELK with the editor", () => {
    const source = projectEditorSource();

    expect(source).not.toContain(
      "import { getLayoutedElements } from '@clash/web-ui/lib/utils/elkLayout';",
    );
  });

  it("warms the Timeline editor before every immediate Timeline navigation", () => {
    const source = projectEditorSource();
    for (const callbackName of [
      "openTimelineFromCanvasAction",
      "openAssetRelationTimeline",
      "createTimelineFromNavigator",
    ]) {
      const callback = source.match(new RegExp(`const ${callbackName} = useCallback\\([\\s\\S]*?\\n  \\);`))?.[0] ?? "";
      expect(callback).toContain("void preloadTimelineEditor();");
      expect(callback.indexOf("void preloadTimelineEditor();")).toBeLessThan(
        callback.indexOf('setWorkspaceSurface({ kind: "timeline"'),
      );
    }
  });

  it("normalizes canvas nodes at write boundaries instead of rescanning on render", () => {
    const source = projectEditorSource();

    expect(source).not.toContain(
      "const sanitizedNodes = useMemo(() => sanitizeNodes(nodes), [nodes]);",
    );
    expect(source).not.toContain("nodes={sanitizedNodes}");
    expect(source).toContain("nodes={nodes}");
    expect(source).toContain("setNodesInternal(processedNodes as AppNode[]);");
    expect(source).toContain("setNodesInternal(nextNodes);");
  });

  it("skips structural sanitization for position and selection-only frames", () => {
    const source = projectEditorSource();

    expect(source).toContain("nodeChangesRequireStructuralSanitize(changes)");
    expect(source).toMatch(
      /nodeChangesRequireStructuralSanitize\(changes\)[\s\S]*?sanitizeNodes\(updatedNodes\)[\s\S]*?: updatedNodes/,
    );
  });

  it("reuses unchanged node and edge objects across Loro snapshots", () => {
    const source = projectEditorSource();

    expect(source).toContain("reconcileSyncedCanvasNodes(");
    expect(source).toContain("reconcileSyncedCanvasEdges(");
  });

  it("dismisses node-owned overlays when a canvas toolbar menu opens", () => {
    const source = projectEditorSource();

    expect(sourceMatches(source, /<DropdownMenu onOpenChange=\{dismissTransientUiOnMenuOpen\}/)).toBe(true);
  });

  it("does not normalize every node z-index from a nodes-dependent effect", () => {
    const source = projectEditorSource();

    expect(source).not.toMatch(
      /useEffect\(\(\) => \{[\s\S]*?applyAutoZIndex\(nodes\)[\s\S]*?\}, \[nodes,/,
    );
    expect(source).toContain("nodeChangesRequireZIndexNormalization(changes)");
  });

  it("keeps Loro mutations outside React state updater functions", () => {
    const source = projectEditorSource();
    const sourceFile = ts.createSourceFile(
      "ProjectEditor.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const impureUpdaters: string[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "setNodes" || node.expression.text === "setEdges")
      ) {
        const updater = node.arguments[0];
        if (
          updater &&
          (ts.isArrowFunction(updater) || ts.isFunctionExpression(updater)) &&
          updater.getText(sourceFile).includes("loroSync")
        ) {
          impureUpdaters.push(updater.getText(sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    expect(impureUpdaters).toEqual([]);
  });
});
