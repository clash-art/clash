import { memo, useState, useCallback, useMemo } from 'react';
import { useReactFlow, Node } from '@xyflow/react';
import type { Edge, Node as RFNode } from '@xyflow/react';
import { Copy } from '@phosphor-icons/react';
import { useOptionalLoroSyncContext } from '../LoroSyncContext';
import { useProject } from '../ProjectContext';
import { useLayoutManager } from '@clash/web-ui/lib/layout';
import { generateSemanticId } from '@clash/web-ui/lib/utils/semanticId';
import type { Modality } from '@clash/shared-types';
import { collectLayoutNodePatches, applyLayoutPatchesToLoro } from '@clash/web-ui/lib/loroNodeSync';
import { PIPELINE_MENU_OPTIONS, type PipelineMenuOption } from './pipelineMenuOptions';
import { computeTrajectory, type TrajectorySubgraph } from './trajectoryPlan';
import CloneTrajectoryDialog from './CloneTrajectoryDialog';
import {
    NodeHandleDropdownMenu,
    NodeHandleDropdownMenuHeader,
    NodeHandleDropdownMenuItem,
    NodeHandleDropdownMenuSeparator,
} from './NodeHandleDropdownMenu';

interface SourceHandleMenuProps {
    nodeId: string;
    sourceType: Modality;
}

interface CloneDialogState {
    subgraph: TrajectorySubgraph;
    nodes: RFNode[];
    edges: Edge[];
}

const SourceHandleMenu = ({ nodeId, sourceType }: SourceHandleMenuProps) => {
    const [cloneDialog, setCloneDialog] = useState<CloneDialogState | null>(null);
    const [hasUpstreamTrajectory, setHasUpstreamTrajectory] = useState(false);
    const { enabledModelCatalog, projectId } = useProject();
    const { addEdges, getNodes, getEdges } = useReactFlow();
    const loroSync = useOptionalLoroSyncContext();

    const onNodesMutated = useCallback(
        (prevNodes: Node[], nextNodes: Node[]) => {
            if (!loroSync) return;
            const patches = collectLayoutNodePatches(prevNodes, nextNodes);
            applyLayoutPatchesToLoro(loroSync, patches);
        },
        [loroSync]
    );
    const { addNodeWithAutoLayout, addNodeWithLayout } = useLayoutManager({ onNodesMutated });

    // Filter options by this source's modality — e.g. video source shouldn't
    // offer Image Gen because no mainstream image model accepts video refs.
    const visibleOptions = useMemo(() => {
        return PIPELINE_MENU_OPTIONS.filter((opt) => opt.isCompatibleWithSource(sourceType, enabledModelCatalog));
    }, [enabledModelCatalog, sourceType]);

    const refreshHasUpstreamTrajectory = useCallback(() => {
        const nodes = getNodes();
        const edges = getEdges();
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        setHasUpstreamTrajectory(
            edges.some((edge) => edge.target === nodeId && nodeById.get(edge.source)?.type === 'action-badge'),
        );
    }, [getEdges, getNodes, nodeId]);

    const handleOptionClick = useCallback(
        async (option: PipelineMenuOption) => {
            const newNodeId = await generateSemanticId(projectId);

            const newNode = addNodeWithAutoLayout(
                {
                    id: newNodeId,
                    type: option.nodeType,
                    data: option.getNodeData(sourceType, enabledModelCatalog),
                },
                nodeId
            );

            if (!newNode) return;

            if (loroSync) {
                loroSync.addNode(newNode.id, newNode);
            }

            const edgeId = `${nodeId}-${newNodeId}`;
            addEdges({
                id: edgeId,
                source: nodeId,
                target: newNodeId,
                type: 'default',
            });

            if (loroSync) {
                loroSync.addEdge(edgeId, {
                    id: edgeId,
                    source: nodeId,
                    target: newNodeId,
                    type: 'default',
                });
            }
        },
        [nodeId, projectId, addNodeWithAutoLayout, addEdges, loroSync, sourceType, enabledModelCatalog]
    );

    const handleCloneClick = useCallback(
        () => {
            const nodes = getNodes() as RFNode[];
            const edges = getEdges();
            const sub = computeTrajectory(nodeId, nodes, edges);
            // Need at least one cloneset node (i.e. more than just heads) to be useful.
            const clonesetSize = sub.nodeIds.size - sub.headIds.size;
            if (clonesetSize <= 0) return;
            setCloneDialog({ subgraph: sub, nodes, edges });
        },
        [nodeId, getEdges, getNodes],
    );

    const handleCloneApply = useCallback(
        ({ newNodes, newEdges }: { newNodes: RFNode[]; newEdges: import('@xyflow/react').Edge[] }) => {
            // Route every cloned node through the canonical layout pipeline
            // (same path the toolbar "+" / spawnDraft uses) so the layout
            // manager handles collision avoidance against existing canvas
            // nodes, group auto-scaling, and chain-reaction collision
            // resolution. Each call sees the prior insertions, so multiple
            // clones in one batch don't stack on top of each other either.
            const placedNodes: RFNode[] = [];
            for (const n of newNodes) {
                if (!n.type) continue;
                const placed = addNodeWithLayout(
                    { id: n.id, type: n.type, data: n.data },
                    n.position,
                    undefined,
                );
                if (placed) placedNodes.push(placed);
            }
            if (loroSync) {
                if (!loroSync.addGraph(placedNodes, newEdges)) return;
            } else {
                for (const ed of newEdges) addEdges(ed);
            }
            setCloneDialog(null);
        },
        [addNodeWithLayout, addEdges, loroSync],
    );

    const handleOpenChange = useCallback((open: boolean) => {
        if (open) refreshHasUpstreamTrajectory();
    }, [refreshHasUpstreamTrajectory]);

    return (
        <>
            <NodeHandleDropdownMenu
                ariaLabel="Add next or clone"
                triggerLabel="Open downstream actions"
                contentClassName="min-w-[180px]"
                handleClassName="!border-warm-surface"
                onOpenChange={handleOpenChange}
                ownerId={`${nodeId}:source-handle`}
            >
                <NodeHandleDropdownMenuHeader>Add next</NodeHandleDropdownMenuHeader>

                {visibleOptions.map((option) => {
                    const Icon = option.icon;
                    return (
                        <NodeHandleDropdownMenuItem
                            key={option.id}
                            aria-label={`Add ${option.label} downstream`}
                            onSelect={() => { void handleOptionClick(option); }}
                            className="text-slate-800 hover:bg-warm-hover hover:text-slate-950 dark:text-slate-200"
                        >
                            <Icon className="h-5 w-5 shrink-0" weight="regular" aria-hidden="true" />
                            <span className="font-medium">{option.label}</span>
                        </NodeHandleDropdownMenuItem>
                    );
                })}

                {hasUpstreamTrajectory && (
                    <>
                        <NodeHandleDropdownMenuSeparator>or clone upstream</NodeHandleDropdownMenuSeparator>
                        <NodeHandleDropdownMenuItem
                            onSelect={handleCloneClick}
                            aria-label="Clone upstream trajectory - opens a preview dialog"
                            className="text-slate-800 hover:bg-warm-hover hover:text-slate-950 dark:text-slate-200"
                        >
                            <Copy className="h-4 w-4 shrink-0" weight="regular" aria-hidden="true" />
                            <span className="font-medium">Clone trajectory</span>
                        </NodeHandleDropdownMenuItem>
                    </>
                )}
            </NodeHandleDropdownMenu>

            {cloneDialog && (
                <CloneTrajectoryDialog
                    open={true}
                    subgraph={cloneDialog.subgraph}
                    nodes={cloneDialog.nodes}
                    edges={cloneDialog.edges}
                    projectId={projectId}
                    onApply={handleCloneApply}
                    onCancel={() => setCloneDialog(null)}
                />
            )}
        </>
    );
};

export default memo(SourceHandleMenu);
