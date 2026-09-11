
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Node, NodeProps, NodeResizeControl, useReactFlow, useStore } from '@xyflow/react';
import { useOptionalLoroSyncContext } from '../LoroSyncContext';
import { useLayoutActions } from '../LayoutActionsContext';
import { MagicWand, FrameCorners } from '@phosphor-icons/react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Tooltip } from '../ui/tooltip';

const controlStyle = {
    background: 'var(--brand)',
    border: 'none',
    borderRadius: '50%',
    width: 10,
    height: 10,
};

const groupBackgroundByDepth = [
    'bg-warm-muted/45',
    'bg-warm-muted/55',
    'bg-warm-muted/65',
    'bg-warm-muted/75',
    'bg-warm-muted/85',
];

const GroupNode = ({ selected, data, id }: NodeProps<Node<Record<string, any>>>) => {
    const [label, setLabel] = useState(data.label || 'Group');
    const { setNodes } = useReactFlow();
    // Counter-scale the action cluster so the buttons stay at constant screen
    // size — matches the floating "Group" pill, which lives in screen-space.
    // Panning never changes counter-scaling. Unselected groups have no action
    // cluster, so they need no zoom updates either.
    const zoom = useStore(useCallback(
        (state) => selected ? state.transform[2] : 1,
        [selected],
    ));
    const loroSync = useOptionalLoroSyncContext();
    const { relayoutParent, ungroup } = useLayoutActions();
    const syncTimeoutRef = useRef<number | null>(null);

    // Return a primitive so unrelated node movement does not re-render this group.
    const depth = useStore(useCallback((state) => {
        let currentId = id;
        let level = 0;
        const visited = new Set<string>();
        while (currentId && !visited.has(currentId)) {
            visited.add(currentId);
            const node = state.nodeLookup.get(currentId);
            if (!node?.parentId) break;
            currentId = node.parentId;
            level += 1;
        }
        return level;
    }, [id]));

    useEffect(() => {
        if (typeof data.label === 'string' && data.label !== label) {
            setLabel(data.label);
        }
    }, [data.label, label]);

    // Generate background color based on depth
    const backgroundColor = useMemo(() => {
        if (selected) return 'bg-brand-light/35';

        return groupBackgroundByDepth[Math.min(depth, groupBackgroundByDepth.length - 1)];
    }, [depth, selected]);

    const scheduleLoroSync = (nextLabel: string) => {
        if (!loroSync) return;
        if (syncTimeoutRef.current) {
            window.clearTimeout(syncTimeoutRef.current);
        }
        syncTimeoutRef.current = window.setTimeout(() => {
            loroSync.updateNode(id, {
                data: { label: nextLabel },
            });
        }, 250);
    };

    useEffect(() => {
        return () => {
            if (syncTimeoutRef.current) {
                window.clearTimeout(syncTimeoutRef.current);
            }
        };
    }, []);

    return (
        <>
            {selected && (
                <>
                    <NodeResizeControl style={controlStyle} position="top-left" />
                    <NodeResizeControl style={controlStyle} position="top-right" />
                    <NodeResizeControl style={controlStyle} position="bottom-left" />
                    <NodeResizeControl style={controlStyle} position="bottom-right" />
                </>
            )}

            <div
                className={`h-full w-full border-2 transition-all duration-300 ${selected ? 'border-brand' : 'border-warm-border'} ${backgroundColor}`}
            >
                {/* Floating Title Input */}
                <div
                    className="absolute -top-8 left-4 z-10"
                    onDoubleClick={(e) => e.stopPropagation()}
                >
                    <Input
                        className="bg-transparent text-lg font-bold font-display text-slate-700 dark:text-slate-300 focus:text-slate-900 focus:outline-none"
                        value={label}
                        onChange={(evt) => {
                            const nextLabel = evt.target.value;
                            setLabel(nextLabel);
                            setNodes((nds) =>
                                nds.map((n: Node) =>
                                    n.id === id
                                        ? {
                                              ...n,
                                              data: {
                                                  ...(n.data || {}),
                                                  label: nextLabel,
                                              },
                                          }
                                        : n
                                )
                            );
                            scheduleLoroSync(nextLabel);
                        }}
                    />
                </div>

                {/* Top-right action cluster — only visible when the group is
                    selected (mirrors the floating "Group" pill, which also
                    only appears for an active selection). Same pill style as
                    that pill so group/ungroup read as a matched pair, and
                    counter-scaled so size + gap stay constant in screen px. */}
                {selected && (
                    <div
                        className="absolute z-10 flex items-center gap-1.5"
                        style={{
                            right: 0,
                            bottom: '100%',
                            marginBottom: 8 / zoom,
                            transform: `scale(${1 / zoom})`,
                            transformOrigin: '100% 100%',
                        }}
                    >
                        <Tooltip label="Ungroup (release children to parent)">
                            <Button
                                size="sm"
                                className="nodrag nopan h-7 min-h-0 rounded-md bg-warm-surface/90 px-2.5 text-xs text-slate-700 backdrop-blur hover:bg-warm-surface hover:text-slate-900 dark:text-slate-300"
                                onClick={() => ungroup(id)}
                                leftIcon={<FrameCorners className="h-3.5 w-3.5" weight="regular" />}
                            >
                                Ungroup
                            </Button>
                        </Tooltip>
                        <Tooltip label="Relayout inside group">
                            <Button
                                size="sm"
                                className="nodrag nopan h-7 min-h-0 rounded-md bg-warm-surface/90 px-2.5 text-xs text-slate-700 backdrop-blur hover:bg-warm-surface hover:text-slate-900 dark:text-slate-300"
                                onClick={() => relayoutParent(id)}
                                leftIcon={<MagicWand className="h-3.5 w-3.5" weight="regular" />}
                            >
                                Layout
                            </Button>
                        </Tooltip>
                    </div>
                )}
            </div>
        </>
    );
};

export default memo(GroupNode);
