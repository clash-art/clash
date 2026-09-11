import { CanvasTransientUiProvider, createCanvasTransientUiStore } from "@clash/web-ui/components/CanvasTransientUiContext";
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
  useEdges,
  useNodes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ImageNode from "@clash/web-ui/components/nodes/ImageNode";
import TextNode from "@clash/web-ui/components/nodes/TextNode";
import PromptActionNode from "@clash/web-ui/components/nodes/ActionBadge";
import GroupNode from "@clash/web-ui/components/nodes/GroupNode";
import { LayoutActionsProvider } from "@clash/web-ui/components/LayoutActionsContext";
import { MediaViewerProvider } from "@clash/web-ui/components/MediaViewerContext";
import { PresenceAwarenessProvider } from "@clash/web-ui/components/PresenceAwarenessContext";
import { ProjectProvider } from "@clash/web-ui/components/ProjectContext";
import { sanitizeNodesForReactFlow } from "@clash/web-ui/lib/canvasNodeOrder";
import {
  computeBuildPlan,
  computeBuildPlanFromGraph,
} from "@clash/web-ui/components/nodes/buildPlan";

type AppNode = Node<Record<string, any>>;

interface PerfConfig {
  groups: number;
  images: number;
  texts: number;
  actions: number;
}

interface RenderCounters {
  image: number;
  text: number;
  action: number;
  group: number;
}

interface SortStats {
  medianMs: number;
  avgMs: number;
  checksum: number;
}

interface BuildPlanPerfStats {
  graphNodes: number;
  graphEdges: number;
  targetCount: number;
  legacyMedianMs: number;
  legacyAvgMs: number;
  lookupMedianMs: number;
  lookupAvgMs: number;
  speedup: number;
  reductionPct: number;
  checksum: {
    legacy: number;
    lookup: number;
  };
}

declare global {
  interface Window {
    __canvasPerf?: Record<string, unknown>;
  }
}

function numberParam(params: URLSearchParams, key: keyof PerfConfig, fallback: number): number {
  const value = Number(params.get(key));
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(5000, Math.floor(value)));
}

function readConfig(): PerfConfig {
  const params = new URLSearchParams(window.location.search);
  return {
    groups: numberParam(params, "groups", 80),
    images: numberParam(params, "images", 900),
    texts: numberParam(params, "texts", 420),
    actions: numberParam(params, "actions", 260),
  };
}

function readLegacyMediaSubscription(): boolean {
  return new URLSearchParams(window.location.search).get("legacyMedia") === "1";
}

function readLegacyActionEdgesSubscription(): boolean {
  return new URLSearchParams(window.location.search).get("legacyActionEdges") === "1";
}

function readOnlyRenderVisibleElements(): boolean {
  return new URLSearchParams(window.location.search).get("onlyVisible") === "1";
}

function readFitView(): boolean {
  return new URLSearchParams(window.location.search).get("fit") !== "0";
}

function svgDataUri(index: number): string {
  const hue = (index * 37) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
    <defs>
      <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="hsl(${hue} 72% 58%)"/>
        <stop offset="1" stop-color="hsl(${(hue + 70) % 360} 78% 44%)"/>
      </linearGradient>
    </defs>
    <rect width="320" height="180" rx="18" fill="url(#g)"/>
    <circle cx="${40 + (index % 7) * 38}" cy="${36 + (index % 5) * 24}" r="${18 + (index % 4) * 5}" fill="rgba(255,255,255,.32)"/>
    <path d="M 24 146 C 88 86, 134 180, 206 112 S 284 84, 310 136" fill="none" stroke="rgba(255,255,255,.62)" stroke-width="10" stroke-linecap="round"/>
    <text x="24" y="42" font-family="Inter, Arial" font-size="20" font-weight="700" fill="white">Asset ${index}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function legacySortNodesParentFirst(nodes: readonly AppNode[]): AppNode[] {
  const idSet = new Set(nodes.map((node) => node.id));
  const result: AppNode[] = [];
  const visited = new Set<string>();

  const visit = (node: AppNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.parentId && idSet.has(node.parentId)) {
      const parent = nodes.find((candidate) => candidate.id === node.parentId);
      if (parent) visit(parent);
    }
    result.push(node);
  };

  for (const node of nodes) visit(node);
  return result;
}

function measureSort(fn: () => AppNode[], rounds = 9): SortStats {
  const times: number[] = [];
  let checksum = 0;

  for (let i = 0; i < rounds + 2; i += 1) {
    const start = performance.now();
    const result = fn();
    const elapsed = performance.now() - start;
    checksum += result.length + result[0]?.id.length;
    if (i >= 2) times.push(elapsed);
  }

  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    avgMs: times.reduce((sum, value) => sum + value, 0) / times.length,
    checksum,
  };
}

function measureWork(fn: () => number, rounds = 7): SortStats {
  const times: number[] = [];
  let checksum = 0;

  for (let i = 0; i < rounds + 2; i += 1) {
    const start = performance.now();
    checksum += fn();
    const elapsed = performance.now() - start;
    if (i >= 2) times.push(elapsed);
  }

  times.sort((a, b) => a - b);
  return {
    medianMs: times[Math.floor(times.length / 2)],
    avgMs: times.reduce((sum, value) => sum + value, 0) / times.length,
    checksum,
  };
}

function measureBuildPlanPerf(baseNodes: AppNode[], baseEdges: Edge[], draftCount: number): BuildPlanPerfStats {
  const actionNodes = baseNodes.filter((node) => node.type === "action-badge");
  const targetCount = Math.min(draftCount, actionNodes.length);
  const draftNodes: AppNode[] = [];
  const draftEdges: Edge[] = [];

  for (let i = 0; i < targetCount; i += 1) {
    const action = actionNodes[i];
    const draftId = `draft-${i}`;
    draftNodes.push({
      id: draftId,
      type: "image",
      parentId: action.parentId,
      position: {
        x: action.position.x + 260,
        y: action.position.y,
      },
      width: 240,
      height: 150,
      data: {
        label: `Draft material ${i}`,
        status: "draft",
      },
    });
    draftEdges.push({
      id: `${action.id}-${draftId}`,
      source: action.id,
      target: draftId,
      type: "default",
    });
  }

  const nodes = [...baseNodes, ...draftNodes];
  const edges = [...baseEdges, ...draftEdges];
  const targets = draftNodes.map((node) => node.id);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Edge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target);
    if (list) list.push(edge);
    else incoming.set(edge.target, [edge]);
  }

  const legacy = measureWork(() => {
    let checksum = 0;
    for (const target of targets) {
      const plan = computeBuildPlan(target, nodes, edges);
      checksum += plan.entries.length + plan.blockers.length + plan.warnings.length + (plan.cycle ? 1 : 0);
    }
    return checksum;
  });

  const lookup = measureWork(() => {
    let checksum = 0;
    for (const target of targets) {
      const plan = computeBuildPlanFromGraph(
        target,
        (nodeId) => nodeById.get(nodeId),
        (nodeId) => incoming.get(nodeId) ?? [],
      );
      checksum += plan.entries.length + plan.blockers.length + plan.warnings.length + (plan.cycle ? 1 : 0);
    }
    return checksum;
  });

  return {
    graphNodes: nodes.length,
    graphEdges: edges.length,
    targetCount,
    legacyMedianMs: legacy.medianMs,
    legacyAvgMs: legacy.avgMs,
    lookupMedianMs: lookup.medianMs,
    lookupAvgMs: lookup.avgMs,
    speedup: legacy.medianMs / Math.max(lookup.medianMs, 0.001),
    reductionPct: ((legacy.medianMs - lookup.medianMs) / Math.max(legacy.medianMs, 0.001)) * 100,
    checksum: {
      legacy: legacy.checksum,
      lookup: lookup.checksum,
    },
  };
}

function cloneCounters(counters: RenderCounters): RenderCounters {
  return {
    image: counters.image,
    text: counters.text,
    action: counters.action,
    group: counters.group,
  };
}

function diffCounters(after: RenderCounters, before: RenderCounters): RenderCounters {
  return {
    image: after.image - before.image,
    text: after.text - before.text,
    action: after.action - before.action,
    group: after.group - before.group,
  };
}

function createMeasuredNodeTypes(
  countersRef: React.MutableRefObject<RenderCounters>,
  legacyMediaSubscription: boolean,
  legacyActionEdgesSubscription: boolean,
): NodeTypes {
  const MeasuredImageNode = (props: NodeProps<AppNode>) => {
    countersRef.current.image += 1;
    return <ImageNode {...props} />;
  };

  const LegacyMeasuredImageNode = (props: NodeProps<AppNode>) => {
    countersRef.current.image += 1;
    const nodes = useNodes();
    nodes.find((node) => node.id === props.id);
    return <ImageNode {...props} />;
  };

  const MeasuredTextNode = (props: NodeProps<AppNode>) => {
    countersRef.current.text += 1;
    return <TextNode {...props} />;
  };

  const MeasuredActionNode = (props: NodeProps<AppNode>) => {
    countersRef.current.action += 1;
    return <PromptActionNode {...props} />;
  };

  const LegacyMeasuredActionNode = (props: NodeProps<AppNode>) => {
    countersRef.current.action += 1;
    const edges = useEdges();
    edges.find((edge) => edge.target === props.id || edge.source === props.id);
    return <PromptActionNode {...props} />;
  };

  const MeasuredGroupNode = (props: NodeProps<AppNode>) => {
    countersRef.current.group += 1;
    return <GroupNode {...props} />;
  };

  return {
    image: (legacyMediaSubscription ? LegacyMeasuredImageNode : MeasuredImageNode) as ComponentType<NodeProps>,
    text: MeasuredTextNode as ComponentType<NodeProps>,
    context: MeasuredTextNode as ComponentType<NodeProps>,
    "action-badge": (legacyActionEdgesSubscription ? LegacyMeasuredActionNode : MeasuredActionNode) as ComponentType<NodeProps>,
    group: MeasuredGroupNode as ComponentType<NodeProps>,
  };
}

function makeGroup(index: number, groupCount: number, childrenPerGroup: number): AppNode {
  const columns = Math.max(1, Math.ceil(Math.sqrt(groupCount)));
  const rows = Math.max(1, Math.ceil(childrenPerGroup / 4));
  return {
    id: `group-${index}`,
    type: "group",
    position: {
      x: (index % columns) * 1360,
      y: Math.floor(index / columns) * 1820,
    },
    width: 1180,
    height: Math.max(620, rows * 230 + 130),
    style: { width: 1180, height: Math.max(620, rows * 230 + 130) },
    data: { label: `Material Set ${index + 1}` },
  };
}

function childPosition(slot: number) {
  return {
    x: 36 + (slot % 4) * 282,
    y: 72 + Math.floor(slot / 4) * 226,
  };
}

function makeMaterialCanvas(config: PerfConfig): { rawNodes: AppNode[]; edges: Edge[] } {
  const totalChildren = config.images + config.texts + config.actions;
  const groupCount = Math.max(1, config.groups);
  const childrenPerGroup = Math.max(1, Math.ceil(totalChildren / groupCount));
  const groups = Array.from({ length: groupCount }, (_, index) =>
    makeGroup(index, groupCount, childrenPerGroup),
  );
  const children: AppNode[] = [];
  const edges: Edge[] = [];
  const groupSlots = new Array(groupCount).fill(0);

  const assignGroup = (index: number) => {
    const groupIndex = index % groupCount;
    const slot = groupSlots[groupIndex];
    groupSlots[groupIndex] += 1;
    return { groupId: `group-${groupIndex}`, slot };
  };

  for (let i = 0; i < config.images; i += 1) {
    const { groupId, slot } = assignGroup(i);
    children.push({
      id: `image-${i}`,
      type: "image",
      parentId: groupId,
      position: childPosition(slot),
      width: 240,
      height: 150,
      style: { width: 240, height: 150 },
      data: {
        label: `Image material ${i}`,
        status: "completed",
        previewUrl: svgDataUri(i),
        description: `Generated concept material ${i}`,
        aspectRatio: "16:9",
        actorType: "user",
        actorUserId: "canvas-perf",
      },
    });
  }

  for (let i = 0; i < config.texts; i += 1) {
    const { groupId, slot } = assignGroup(config.images + i);
    children.push({
      id: `text-${i}`,
      type: "text",
      parentId: groupId,
      position: childPosition(slot),
      width: 270,
      height: 170,
      style: { width: 270, height: 170 },
      data: {
        label: `Brief ${i}`,
        status: "completed",
        content: `# Shot ${i}\nA compact production note with props, lighting, blocking, and downstream references.`,
        actorType: "user",
        actorUserId: "canvas-perf",
      },
    });
  }

  for (let i = 0; i < config.actions; i += 1) {
    const { groupId, slot } = assignGroup(config.images + config.texts + i);
    const imageSource = `image-${i % Math.max(1, config.images)}`;
    const textSource = `text-${i % Math.max(1, config.texts)}`;
    const actionId = `action-${i}`;
    children.push({
      id: actionId,
      type: "action-badge",
      parentId: groupId,
      position: childPosition(slot),
      data: {
        label: `Generate pass ${i}`,
        content: `Use references @${imageSource} and @${textSource} to create a polished variant.`,
        actionType: "image-gen",
        modelId: "nano-banana-2",
        modelParams: { aspectRatio: "16:9" },
        referenceImageOrder: [imageSource],
        actorType: "user",
        actorUserId: "canvas-perf",
      },
    });

    if (config.images > 0) {
      edges.push({
        id: `${imageSource}-${actionId}`,
        source: imageSource,
        target: actionId,
        type: "default",
        interactionWidth: 30,
      });
    }
    if (config.texts > 0) {
      edges.push({
        id: `${textSource}-${actionId}`,
        source: textSource,
        target: actionId,
        type: "default",
        interactionWidth: 30,
      });
    }
  }

  return {
    rawNodes: [...children, ...groups],
    edges,
  };
}

export default function CanvasPerfRoute() {
  const transientUiStore = useMemo(() => createCanvasTransientUiStore(), []);
  const renderCountersRef = useRef<RenderCounters>({ image: 0, text: 0, action: 0, group: 0 });
  const legacyMediaSubscription = useMemo(() => readLegacyMediaSubscription(), []);
  const legacyActionEdgesSubscription = useMemo(() => readLegacyActionEdgesSubscription(), []);
  const onlyRenderVisibleElements = useMemo(() => readOnlyRenderVisibleElements(), []);
  const fitView = useMemo(() => readFitView(), []);
  const { nodes, edges, metrics } = useMemo(() => {
    const config = readConfig();
    const prepStart = performance.now();
    const { rawNodes, edges } = makeMaterialCanvas(config);
    const buildMs = performance.now() - prepStart;
    const legacy = measureSort(() => legacySortNodesParentFirst(rawNodes));
    const next = measureSort(() => sanitizeNodesForReactFlow(rawNodes));
    const buildPlan = measureBuildPlanPerf(rawNodes, edges, config.actions);
    const sortedNodes = sanitizeNodesForReactFlow(rawNodes);

    return {
      nodes: sortedNodes,
      edges,
      metrics: {
        config,
        legacyMediaSubscription,
        legacyActionEdgesSubscription,
        onlyRenderVisibleElements,
        fitView,
        buildMs,
        legacySortMedianMs: legacy.medianMs,
        legacySortAvgMs: legacy.avgMs,
        newSortMedianMs: next.medianMs,
        newSortAvgMs: next.avgMs,
        sortSpeedup: legacy.medianMs / Math.max(next.medianMs, 0.001),
        sortReductionPct: ((legacy.medianMs - next.medianMs) / Math.max(legacy.medianMs, 0.001)) * 100,
        sortChecksum: { legacy: legacy.checksum, next: next.checksum },
        buildPlan,
        totalNodes: sortedNodes.length,
        totalEdges: edges.length,
      },
    };
  }, [legacyMediaSubscription, legacyActionEdgesSubscription, onlyRenderVisibleElements, fitView]);
  const [flowNodes, setFlowNodes] = useState(nodes);
  const [flowEdges, setFlowEdges] = useState(edges);
  const componentStart = useRef(performance.now());
  const measuredNodeTypes = useMemo(
    () => createMeasuredNodeTypes(renderCountersRef, legacyMediaSubscription, legacyActionEdgesSubscription),
    [legacyMediaSubscription, legacyActionEdgesSubscription],
  );

  useEffect(() => {
    let raf = 0;
    let timeout: number | undefined;
    raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const mountReadyAt = performance.now();
        const rendersBeforeUpdate = cloneCounters(renderCountersRef.current);
        const updateStart = performance.now();

        setFlowNodes((current) => {
          let updated = false;
          return current.map((node) => {
            if (updated || node.type !== "text") return node;
            updated = true;
            return {
              ...node,
              data: {
                ...node.data,
                perfPulse: Number(node.data.perfPulse ?? 0) + 1,
              },
            };
          });
        });

        timeout = window.setTimeout(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const updateReadyAt = performance.now();
              const rendersAfterUpdate = cloneCounters(renderCountersRef.current);
              const rendersBeforeEdgeUpdate = cloneCounters(renderCountersRef.current);
              const edgeUpdateStart = performance.now();

              setFlowEdges((current) => {
                if (current.some((edge) => edge.id === "__perf_unrelated_edge")) return current;
                return [
                  ...current,
                  {
                    id: "__perf_unrelated_edge",
                    source: "image-0",
                    target: "text-0",
                    type: "default",
                    interactionWidth: 30,
                  },
                ];
              });

              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  const edgeUpdateReadyAt = performance.now();
                  const rendersAfterEdgeUpdate = cloneCounters(renderCountersRef.current);
                  const domNodes = document.querySelectorAll(".react-flow__node").length;
                  const imageElements = document.querySelectorAll(".react-flow__node img").length;
                  window.__canvasPerf = {
                    ...metrics,
                    ready: true,
                    componentToReadyMs: mountReadyAt - componentStart.current,
                    singleNodeUpdateMs: updateReadyAt - updateStart,
                    updateRenders: diffCounters(rendersAfterUpdate, rendersBeforeUpdate),
                    unrelatedEdgeUpdateMs: edgeUpdateReadyAt - edgeUpdateStart,
                    unrelatedEdgeUpdateRenders: diffCounters(rendersAfterEdgeUpdate, rendersBeforeEdgeUpdate),
                    totalRenders: rendersAfterEdgeUpdate,
                    domNodes,
                    imageElements,
                    fullTextPreviews: document.querySelectorAll('[data-testid="text-node-preview"]').length,
                    renderedTextLength: document.body.innerText.length,
                  };
                });
              });
            });
          });
        }, 0);
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [metrics]);

  return (
    <CanvasTransientUiProvider store={transientUiStore}>
    <ProjectProvider projectId="canvas-perf">
      <PresenceAwarenessProvider peers={[]}>
        <MediaViewerProvider>
          <LayoutActionsProvider value={{ relayoutParent: () => {}, ungroup: () => {} }}>
            <main className="h-[calc(100vh-2rem)] w-full overflow-hidden bg-[var(--canvas-bg)]">
              <div className="absolute left-4 top-4 z-10 rounded-lg border border-overlay-border bg-overlay-surface px-3 py-2 text-xs text-content-secondary shadow-overlay">
                <span className="font-semibold">Canvas perf</span>
                <span className="ml-2">{nodes.length} nodes</span>
                <span className="ml-2">{edges.length} edges</span>
              </div>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={measuredNodeTypes}
                fitView={fitView}
                onlyRenderVisibleElements={onlyRenderVisibleElements}
                minZoom={0.08}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={12}
                  size={1.5}
                  color="var(--canvas-dot)"
                  style={{ backgroundColor: "var(--canvas-bg)" }}
                />
              </ReactFlow>
            </main>
          </LayoutActionsProvider>
        </MediaViewerProvider>
      </PresenceAwarenessProvider>
    </ProjectProvider>
    </CanvasTransientUiProvider>
  );
}
