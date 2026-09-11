import { useCallback, useMemo } from 'react';
import { useReactFlow, Node } from '@xyflow/react';
import type {
    Point,
    Size,
    Rect,
    OwnershipResult,
    LayoutNode,
} from '@clash/shared-layout';
import {
    Mesh,
    createMesh,
    getAbsoluteRect,
    getAbsolutePosition,
    getNodeSize,
    updateNodeOwnership,
    checkOwnershipChange,
    recursiveGroupScale,
    applyGroupScales,
    resolveCollisions,
    applyResolution,
} from '@clash/shared-layout';
import type { LayoutManagerConfig } from '../types';

/**
 * Maximum dimension for media nodes (matches VideoNode.MAX_MEDIA_DIMENSION)
 */
const MAX_MEDIA_DIMENSION = 500;

/**
 * Calculate scaled dimensions from natural width/height to fit within MAX_MEDIA_DIMENSION
 * Matches VideoNode.calculateScaledDimensions logic
 */
function calculateScaledDimensions(naturalWidth: number, naturalHeight: number): Size {
    if (!naturalWidth || !naturalHeight) {
        return { width: 400, height: 400 };
    }

    const scale = Math.min(1, MAX_MEDIA_DIMENSION / Math.max(naturalWidth, naturalHeight));
    return {
        width: Math.round(naturalWidth * scale),
        height: Math.round(naturalHeight * scale),
    };
}

/**
 * Calculate node dimensions from aspect ratio
 */
function calculateDimensionsFromAspectRatio(aspectRatio?: string): Size {
    if (!aspectRatio) {
        return { width: 400, height: 400 };
    }

    const parts = aspectRatio.split(':');
    if (parts.length !== 2) {
        return { width: 400, height: 400 };
    }

    const widthRatio = parseFloat(parts[0]);
    const heightRatio = parseFloat(parts[1]);

    if (!widthRatio || !heightRatio) {
        return { width: 400, height: 400 };
    }

    if (widthRatio >= heightRatio) {
        const width = MAX_MEDIA_DIMENSION;
        const height = Math.round((heightRatio / widthRatio) * MAX_MEDIA_DIMENSION);
        return { width, height };
    } else {
        const height = MAX_MEDIA_DIMENSION;
        const width = Math.round((widthRatio / heightRatio) * MAX_MEDIA_DIMENSION);
        return { width, height };
    }
}

/**
 * Get the appropriate size for a node with multiple fallback strategies.
 * Exported so the same sizing logic the canonical "+ flyout" / spawnDraft
 * path uses can be applied to clones, agent-created nodes, etc.
 */
export function getNodeSizeWithData(nodeType: string, nodeData?: any): Size {
    const defaultSize = getNodeSize(nodeType);

    if (nodeType === 'video' || nodeType === 'image') {
        if (nodeData?.naturalWidth && nodeData?.naturalHeight) {
            return calculateScaledDimensions(nodeData.naturalWidth, nodeData.naturalHeight);
        }

        if (nodeData?.aspectRatio) {
            return calculateDimensionsFromAspectRatio(nodeData.aspectRatio);
        }
    }

    return defaultSize;
}

const DEFAULT_CONFIG: LayoutManagerConfig = {
    mesh: {
        cellWidth: 50,
        cellHeight: 50,
        maxColumns: 10,
        padding: 20,
    },
    autoScale: true,
    autoResolveCollisions: true,
    maxChainReactionIterations: 10,
};

export interface UseLayoutManagerReturn {
    // Group ownership
    checkGroupOwnership: (nodeId: string) => { hasChanged: boolean; ownership: OwnershipResult };
    applyOwnershipChange: (nodeId: string, ownership: OwnershipResult) => void;

    // Collision resolution
    resolveCollisionsForNode: (nodeId: string) => void;

    // Auto-scale
    scaleGroupsForNode: (nodeId: string) => void;

    // Combined operations
    handleNodeDragEnd: (nodeId: string) => void;
    handleNodeResize: (nodeId: string) => void;

    // Mesh utilities
    snapToGrid: (position: Point) => Point;
    findNonOverlappingPosition: (
        targetPos: Point,
        nodeSize: Size,
        parentId?: string
    ) => Point;

    // Add node with auto layout
    addNodeWithLayout: (
        newNode: Partial<Node> & { type: string },
        targetPosition: Point,
        parentId?: string
    ) => Node;

    // Legacy API compatibility (used by ActionBadge)
    addNodeWithAutoLayout: (
        newNode: Partial<Node> & { type: string },
        parentNodeId: string,
        offset?: { x: number; y: number }
    ) => Node | null;

    // Mesh instance
    mesh: Mesh;
}

/**
 * Unified hook for layout management
 */
export function useLayoutManager(
    config: Partial<LayoutManagerConfig> = {}
): UseLayoutManagerReturn {
    const { getNodes, setNodes } = useReactFlow();

    const finalConfig = useMemo(() => ({
        ...DEFAULT_CONFIG,
        ...config,
        mesh: { ...DEFAULT_CONFIG.mesh, ...config.mesh },
    }), [config]);

    const mesh = useMemo(() => createMesh(finalConfig.mesh), [finalConfig.mesh]);

    const checkGroupOwnership = useCallback((nodeId: string) => {
        const nodes = getNodes();
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) {
            return { hasChanged: false, ownership: { newParentId: undefined, relativePosition: { x: 0, y: 0 } } };
        }
        return checkOwnershipChange(node, nodes);
    }, [getNodes]);

    const applyOwnershipChange = useCallback((nodeId: string, ownership: OwnershipResult) => {
        setNodes((nodes) => {
            const nextNodes = updateNodeOwnership(nodes, nodeId, ownership) as Node[];
            finalConfig.onNodesMutated?.(nodes, nextNodes);
            return nextNodes;
        });
    }, [setNodes, finalConfig]);

    const resolveCollisionsForNode = useCallback((nodeId: string) => {
        setNodes((nodes) => {
            const result = resolveCollisions(nodes, nodeId, mesh, {
                maxIterations: finalConfig.maxChainReactionIterations,
            });
            if (result.steps.length > 0) {
                console.log(`[LayoutManager] Resolved ${result.steps.length} collision(s) in ${result.iterations} iteration(s)`);
                const nextNodes = applyResolution(nodes, result) as Node[];
                finalConfig.onNodesMutated?.(nodes, nextNodes);
                return nextNodes;
            }
            return nodes;
        });
    }, [setNodes, mesh, finalConfig]);

    const scaleGroupsForNode = useCallback((nodeId: string) => {
        setNodes((nodes) => {
            const scales = recursiveGroupScale(nodeId, nodes);
            if (scales.size > 0) {
                console.log(`[LayoutManager] Scaled ${scales.size} group(s)`);
                const nextNodes = applyGroupScales(nodes, scales) as Node[];
                finalConfig.onNodesMutated?.(nodes, nextNodes);
                return nextNodes;
            }
            return nodes;
        });
    }, [setNodes, finalConfig]);

    const handleNodeDragEnd = useCallback((nodeId: string) => {
        const { hasChanged, ownership } = checkGroupOwnership(nodeId);

        setNodes((nodes) => {
            let updatedNodes: Node[] = nodes;

            if (hasChanged) {
                console.log(`[LayoutManager] Node ${nodeId} ownership changed to ${ownership.newParentId || 'root'}`);
                updatedNodes = updateNodeOwnership(updatedNodes, nodeId, ownership) as Node[];
            }

            if (finalConfig.autoScale) {
                const scales = recursiveGroupScale(nodeId, updatedNodes);
                if (scales.size > 0) {
                    updatedNodes = applyGroupScales(updatedNodes, scales) as Node[];

                    if (finalConfig.autoResolveCollisions) {
                        for (const groupId of scales.keys()) {
                            const result = resolveCollisions(updatedNodes, groupId, mesh, {
                                maxIterations: finalConfig.maxChainReactionIterations,
                            });
                            if (result.steps.length > 0) {
                                updatedNodes = applyResolution(updatedNodes, result) as Node[];
                            }
                        }
                    }
                }
            }

            if (updatedNodes !== nodes) {
                finalConfig.onNodesMutated?.(nodes, updatedNodes);
            }
            return updatedNodes;
        });
    }, [checkGroupOwnership, setNodes, mesh, finalConfig]);

    const handleNodeResize = useCallback((nodeId: string) => {
        setNodes((nodes) => {
            let updatedNodes: Node[] = nodes;

            if (finalConfig.autoScale) {
                const scales = recursiveGroupScale(nodeId, updatedNodes);
                if (scales.size > 0) {
                    updatedNodes = applyGroupScales(updatedNodes, scales) as Node[];
                }
            }

            if (finalConfig.autoResolveCollisions) {
                const result = resolveCollisions(updatedNodes, nodeId, mesh, {
                    maxIterations: finalConfig.maxChainReactionIterations,
                });
                if (result.steps.length > 0) {
                    updatedNodes = applyResolution(updatedNodes, result) as Node[];
                }
            }

            if (updatedNodes !== nodes) {
                finalConfig.onNodesMutated?.(nodes, updatedNodes);
            }
            return updatedNodes;
        });
    }, [setNodes, mesh, finalConfig]);

    const snapToGrid = useCallback((position: Point): Point => {
        return mesh.snapToGrid(position);
    }, [mesh]);

    const findNonOverlappingPosition = useCallback((
        targetPos: Point,
        nodeSize: Size,
        parentId?: string
    ): Point => {
        const nodes = getNodes();

        const siblings = nodes.filter((n) => n.parentId === parentId && n.type !== 'group');

        const occupiedRects: Rect[] = siblings.map((s) => {
            const rect = getAbsoluteRect(s, nodes);
            return rect;
        });

        let absTargetPos = targetPos;
        if (parentId) {
            const parent = nodes.find((n) => n.id === parentId);
            if (parent) {
                const parentAbsPos = getAbsolutePosition(parent, nodes);
                absTargetPos = {
                    x: parentAbsPos.x + targetPos.x,
                    y: parentAbsPos.y + targetPos.y,
                };
            }
        }

        const newAbsPos = mesh.findNonOverlappingPosition(absTargetPos, nodeSize, occupiedRects);

        if (parentId) {
            const parent = nodes.find((n) => n.id === parentId);
            if (parent) {
                const parentAbsPos = getAbsolutePosition(parent, nodes);
                return {
                    x: newAbsPos.x - parentAbsPos.x,
                    y: newAbsPos.y - parentAbsPos.y,
                };
            }
        }

        return newAbsPos;
    }, [getNodes, mesh]);

    const addNodeWithLayout = useCallback((
        newNode: Partial<Node> & { type: string },
        targetPosition: Point,
        parentId?: string
    ): Node => {
        const nodeSize = getNodeSizeWithData(newNode.type, newNode.data);

        const position = findNonOverlappingPosition(targetPosition, nodeSize, parentId);

        const completeNode: Node = {
            ...newNode,
            id: newNode.id || `node-${Date.now()}`,
            type: newNode.type,
            position,
            parentId,
            data: newNode.data || {},
            width: nodeSize.width,
            height: nodeSize.height,
        };

        setNodes((nodes) => {
            let updatedNodes: Node[] = [...nodes, completeNode];

            if (finalConfig.autoScale && parentId) {
                const scales = recursiveGroupScale(completeNode.id, updatedNodes);
                if (scales.size > 0) {
                    updatedNodes = applyGroupScales(updatedNodes, scales) as Node[];

                    if (finalConfig.autoResolveCollisions) {
                        for (const groupId of scales.keys()) {
                            const result = resolveCollisions(updatedNodes, groupId, mesh, {
                                maxIterations: finalConfig.maxChainReactionIterations,
                            });
                            if (result.steps.length > 0) {
                                updatedNodes = applyResolution(updatedNodes, result) as Node[];
                            }
                        }
                    }
                }
            }

            finalConfig.onNodesMutated?.(nodes, updatedNodes);
            return updatedNodes;
        });

        return completeNode;
    }, [findNonOverlappingPosition, setNodes, mesh, finalConfig]);

    const addNodeWithAutoLayout = useCallback((
        newNode: Partial<Node> & { type: string },
        parentNodeId: string,
        offset: { x: number; y: number } = { x: 300, y: 0 }
    ): Node | null => {
        const nodes = getNodes();
        const parentNode = nodes.find(n => n.id === parentNodeId);
        if (!parentNode) {
            console.error('[useLayoutManager] Parent node not found:', parentNodeId);
            return null;
        }

        const parentGroupId = parentNode.parentId;

        const parentAbsPos = getAbsolutePosition(parentNode, nodes);
        const absTargetPos = {
            x: parentAbsPos.x + offset.x,
            y: parentAbsPos.y + offset.y,
        };

        if (parentGroupId) {
            const parentGroup = nodes.find((n) => n.id === parentGroupId);
            if (parentGroup) {
                const groupAbsPos = getAbsolutePosition(parentGroup, nodes);
                const relTargetPos = {
                    x: absTargetPos.x - groupAbsPos.x,
                    y: absTargetPos.y - groupAbsPos.y,
                };
                return addNodeWithLayout(newNode, relTargetPos, parentGroupId);
            }
        }

        return addNodeWithLayout(newNode, absTargetPos, undefined);
    }, [getNodes, addNodeWithLayout]);

    return {
        checkGroupOwnership,
        applyOwnershipChange,
        resolveCollisionsForNode,
        scaleGroupsForNode,
        handleNodeDragEnd,
        handleNodeResize,
        snapToGrid,
        findNonOverlappingPosition,
        addNodeWithLayout,
        addNodeWithAutoLayout,
        mesh,
    };
}
