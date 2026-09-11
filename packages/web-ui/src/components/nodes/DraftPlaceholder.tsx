import { memo, useCallback, useMemo, useState } from 'react';
import { useReactFlow, useStore, type ReactFlowState } from '@xyflow/react';
import { Play, Image as ImageIcon, VideoCamera, TextT, SpeakerHigh } from '@phosphor-icons/react';
import { useOptionalLoroSyncContext } from '../LoroSyncContext';
import { computeBuildPlanFromGraph, type BuildPlan, type PlanEntry } from './buildPlan';
import BuildPlanDialog from './BuildPlanDialog';
import { Button } from '../ui/button';
import { Tooltip } from '../ui/tooltip';

type Modality = 'image' | 'video' | 'audio' | 'text';

interface DraftPlaceholderProps {
    nodeId: string;
    modality: Modality;
    width?: number | string;
    height?: number | string;
    compact?: boolean;
}

const MODALITY_ICON = {
    image: ImageIcon,
    video: VideoCamera,
    audio: SpeakerHigh,
    text: TextT,
} as const;

const MODALITY_LABEL: Record<Modality, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    text: 'text',
};

function arraysEqual(a: readonly string[], b: readonly string[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function entriesEqual(a: readonly PlanEntry[], b: readonly PlanEntry[]) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i];
        const right = b[i];
        if (
            left.draftId !== right.draftId ||
            left.actionNodeId !== right.actionNodeId ||
            left.actionDefinitionRef !== right.actionDefinitionRef ||
            left.actionDefinitionName !== right.actionDefinitionName ||
            left.kind !== right.kind ||
      left.modality !== right.modality ||
            left.label !== right.label ||
            left.hasPrompt !== right.hasPrompt
        ) {
            return false;
        }
    }
    return true;
}

function invocationEstimatesEqual(a: BuildPlan["estimatedInvocations"],
  b: BuildPlan["estimatedInvocations"],
) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.actionDefinitionRef !== right.actionDefinitionRef ||
      left.actionDefinitionName !== right.actionDefinitionName ||
      left.kind !== right.kind ||
      left.count !== right.count
    ) {
      return false;
    }
  }
  return true;
}

function buildPlansEqual(a: BuildPlan, b: BuildPlan) {
    return (
        a.cycle === b.cycle &&
        arraysEqual(a.blockers, b.blockers) &&
        arraysEqual(a.warnings, b.warnings) &&
    invocationEstimatesEqual(a.estimatedInvocations, b.estimatedInvocations) &&
        entriesEqual(a.entries, b.entries)
    );
}

function selectBuildPlan(state: ReactFlowState, nodeId: string): BuildPlan {
    return computeBuildPlanFromGraph(
        nodeId,
        (lookupId) => state.nodeLookup.get(lookupId),
        (lookupId) => {
            const connections = state.connectionLookup.get(lookupId);
            if (!connections) return [];
            return Array.from(connections.values())
                .filter((connection) => connection.target === lookupId)
                .map((connection) => ({
                    source: connection.source,
                    target: connection.target,
                }));
        },
    );
}

/**
 * Placeholder rendered for a node in `status: 'draft'`.
 *
 * Single button: **Build** — triggers a reverse DAG evaluation from this node.
 * Clicking opens `BuildPlanDialog` showing the cohort of drafts that will run
 * (this one + every incomplete ancestor), the model invocation breakdown, and
 * any pre-flight blockers. On confirm, every draft in the plan is flagged
 * with `runRequested: true` + a shared `cascadeToken`; `useCascadeRunner`
 * drives each one through its gate → adoption → generation.
 *
 * The button label carries a `+N` suffix when there are draft ancestors, so
 * the user sees the cost footprint before opening the dialog.
 */
const DraftPlaceholder = ({ nodeId, modality, width, height, compact = false }: DraftPlaceholderProps) => {
    const { setNodes } = useReactFlow();
    const loroSync = useOptionalLoroSyncContext();
    const [dialogOpen, setDialogOpen] = useState(false);

    const Icon = MODALITY_ICON[modality];

    const selectPlan = useMemo(() => {
        let previousNodes: ReactFlowState['nodes'] | undefined;
        let previousEdges: ReactFlowState['edges'] | undefined;
        let previousPlan: BuildPlan | undefined;
        return (state: ReactFlowState) => {
            // React Flow mutates its lookup Maps in place but publishes new
            // node/edge arrays for graph edits. Key on those arrays so pan,
            // zoom and pointer updates do not walk the dependency graph.
            if (!previousPlan || previousNodes !== state.nodes || previousEdges !== state.edges) {
                previousPlan = selectBuildPlan(state, nodeId);
                previousNodes = state.nodes;
                previousEdges = state.edges;
            }
            return previousPlan;
        };
    }, [nodeId]);
    const plan = useStore(selectPlan, buildPlansEqual);

    const ancestorCount = Math.max(0, plan.entries.length - 1);
    const totalCalls = plan.estimatedInvocations.reduce((total, estimate) => total + estimate.count, 0);
    const targetEntry = plan.entries[plan.entries.length - 1];
    const targetLabel = targetEntry?.label ?? 'this draft';

    const openDialog = useCallback(
        (e: React.MouseEvent) => {
            e.stopPropagation();
            setDialogOpen(true);
        },
        [],
    );

    const closeDialog = useCallback(() => setDialogOpen(false), []);

    const confirm = useCallback(() => {
        const token = `cascade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const draftIds = new Set(plan.entries.map((e) => e.draftId));
        setNodes((nds) =>
            nds.map((n) => {
                if (!draftIds.has(n.id)) return n;
                return { ...n, data: { ...n.data, runRequested: true, cascadeToken: token } };
            }),
        );
        if (loroSync) {
            for (const id of draftIds) {
                loroSync.updateNode(id, { data: { runRequested: true, cascadeToken: token } });
            }
        }
        setDialogOpen(false);
    }, [plan, setNodes, loroSync]);

    const buttonDisabled = plan.cycle || plan.entries.length === 0;
    const suffix = ancestorCount > 0 ? ` +${ancestorCount}` : '';
    const buttonLabel = plan.cycle
        ? 'Cycle detected'
        : plan.blockers.length > 0
            ? 'Has blockers - open to review'
            : totalCalls > 0
                ? `Will run ${totalCalls} model call${totalCalls === 1 ? '' : 's'}`
                : 'Build this draft';
    const buttonAriaLabel = buttonDisabled
        ? buttonLabel
        : ancestorCount > 0
            ? `Build - ${totalCalls} model call${totalCalls === 1 ? '' : 's'}, ${ancestorCount} upstream draft${ancestorCount === 1 ? '' : 's'}`
            : 'Build this draft';

    return (
        <>
            <div
                className={compact
                    ? 'relative flex h-full w-full flex-row items-center justify-between gap-2 px-3 py-2'
                    : 'relative flex flex-col items-center justify-center gap-3 rounded-matrix border-2 border-dashed border-warm-border bg-warm-muted/60 p-4'}
                style={{ width: width ?? '100%', height: height ?? '100%' }}
                role="group"
                aria-label={`Draft ${MODALITY_LABEL[modality]} placeholder`}
            >
                {compact ? (
                    <>
                        <div className="flex min-w-0 items-center gap-2 text-slate-700 dark:text-slate-300">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-audio/10 text-audio">
                                <Icon size={18} weight="duotone" aria-hidden="true" />
                            </span>
                            <span className="truncate text-xs font-semibold">Draft {MODALITY_LABEL[modality]}</span>
                        </div>
                        <Tooltip label={buttonLabel}>
                            <Button
                                onClick={openDialog}
                                disabled={buttonDisabled}
                                size="sm"
                                shape="rounded"
                                leftIcon={<Play size={11} weight="fill" />}
                                className="clash-node-primary h-8 min-h-8 shrink-0 rounded-lg px-3 text-xs font-semibold motion-reduce:transition-none focus-visible:ring-offset-warm-surface"
                                aria-label={buttonAriaLabel}
                            >
                                <span aria-hidden="true">Build{suffix}</span>
                            </Button>
                        </Tooltip>
                    </>
                ) : (
                    <>
                        <div className="flex flex-col items-center gap-1 text-slate-700 dark:text-slate-300">
                            <Icon size={28} weight="duotone" aria-hidden="true" />
                            <span className="text-[11px] font-bold uppercase tracking-wider">Draft {MODALITY_LABEL[modality]}</span>
                        </div>
                        <div className="flex w-full max-w-[200px] flex-col gap-1.5">
                            <Tooltip label={buttonLabel}>
                                <Button
                                    onClick={openDialog}
                                    disabled={buttonDisabled}
                                    size="md"
                                    shape="rounded"
                                    leftIcon={<Play size={12} weight="fill" />}
                                    className="clash-node-primary w-full rounded-lg px-4 py-2.5 text-sm font-semibold motion-reduce:transition-none focus-visible:ring-offset-warm-muted"
                                    aria-label={buttonAriaLabel}
                                >
                                    <span aria-hidden="true">Build{suffix}</span>
                                </Button>
                            </Tooltip>
                        </div>
                    </>
                )}
            </div>

            <BuildPlanDialog
                open={dialogOpen}
                targetLabel={targetLabel}
                plan={plan}
                onConfirm={confirm}
                onCancel={closeDialog}
            />
        </>
    );
};

export default memo(DraftPlaceholder);
