import { useCallback, useMemo } from 'react';
import type { Node as RFNode } from '@xyflow/react';
import {
    GeneratorRevisionRefSchema,
    type GeneratorRevisionRef,
    buildGenerationPayload,
    buildPendingAssetNode,
    type DirectorReferencePacket,
    type GenerationConfig,
    type ModelCard,
    type CustomActionDefinition,
    type ExecutablePluginBinding,
    type AigcActionKind,
    type PendingAssetNode,
} from '@clash/shared-types';
import { generateSemanticId } from '@clash/web-ui/lib/utils/semanticId';
import { useOptionalLoroSyncContext } from '../LoroSyncContext';
import betterAuthClient from '@clash/web-ui/lib/betterAuthClient';
import { resolveBuiltInActionKind, resolveGenerationActionType } from './generationActionKind';
import { persistPendingAssetAdoption, persistPendingAssetCreation } from './pendingAssetLoro';

type ModelParams = Record<string, string | number | boolean>;
type LoroSync = ReturnType<typeof useOptionalLoroSyncContext>;

export interface UseSpawnPendingAssetInput {
    actionBadgeId: string;
    actionType: string;
    isCustom: boolean;
    customDef: CustomActionDefinition | undefined;
    customActionParams: ModelParams;
    modelId: string;
    modelParams: ModelParams;
    selectedModel: ModelCard | undefined;
    content: string;
    lyrics: string;
    dataPrompt: string | undefined;
    pluginBinding?: ExecutablePluginBinding;
    projectId: string;
    refNodeIds: string[];
    getNodes: () => RFNode[];
    addNodeWithAutoLayout: (node: Partial<RFNode> & { id: string; type: string; data: Record<string, unknown> }, parentId: string, offset?: { x: number; y: number }) => RFNode | null;
    addNodeWithLayout: (node: Partial<RFNode> & { id: string; type: string; data: Record<string, unknown> }, targetPosition: { x: number; y: number }, parentId?: string) => RFNode;
    addEdges: (edge: { id: string; source: string; target: string; type: string }) => void;
    setNodes: (updater: (nds: RFNode[]) => RFNode[]) => void;
    loroSync: LoroSync;
    resolveGeneratorRevision?: () => Promise<GeneratorRevisionRef>;
}

export interface SpawnOpts {
    /** Host-acknowledged native revision, shared by one batch. */
    generatorRevision?: GeneratorRevisionRef;
    /** If provided, use this as the new node ID. Otherwise, generate a fresh semantic ID. */
    assetId?: string;
    /** Override the extracted label. Run uses this to append `(N)` for batch siblings. */
    labelOverride?: string;
    /** Revision-pinned Director payload for one selected Shot. */
    directorReferencePacket?: DirectorReferencePacket;
    sourceDirectorStageId?: string;
    sourceDirectorStageRevisionId?: string;
    sourceDirectorStageShotId?: string;
    /** Visual and semantic grouping for a multi-Shot generation run. */
    directorShotGroupId?: string;
    parentGroupId?: string;
    groupIndex?: number;
}

export interface AdoptOpts {
    labelOverride?: string;
    /** If provided, stamp `data.cascadeToken` on the adopted node — the cascade controller watches for this. */
    cascadeToken?: string;
}

export interface UseSpawnPendingAssetResult {
    /** Create a new node with `status: 'pending'` and edge from this action. */
    spawnPending: (opts?: SpawnOpts) => Promise<RFNode | null>;
    /** Create a new node with `status: 'draft'` and edge from this action. NodeProcessor ignores drafts. */
    spawnDraft: (opts?: SpawnOpts) => Promise<RFNode | null>;
    /**
     * Update an existing downstream draft: rewrite its data (fresh prompt/model/params + re-partitioned ref URLs),
     * flip `status: 'draft' → 'pending'`. No edge created — the draft already has one.
     */
    adoptDraft: (draftId: string, opts?: AdoptOpts) => Promise<RFNode | null>;
    canSpawn: boolean;
    disabledReason: string | null;
    /** The modality of the node this hook will create. */
    outputKind: AigcActionKind;
}

/**
 * Shared primitive set for the action-badge ↔ downstream pending/draft lifecycle.
 *
 * - `spawnPending` — existing eager path (used by Run's batch loop as fallback).
 * - `spawnDraft`   — lazy placeholder (used by the `+` flyout); NodeProcessor
 *                    ignores `status:'idle'` so no generation kicks off until
 *                    something adopts it.
 * - `adoptDraft`   — the unix-pipe trigger. Re-reads the action-badge's CURRENT
 *                    prompt/model/params/refs (crucial: upstream may have become
 *                    `completed` after the draft was created) and writes a fresh
 *                    data payload onto the draft, flipping its status to
 *                    `pending`. Takes an optional `cascadeToken` so the cascade
 *                    controller can track a run's frontier.
 *
 * All three share the same validation, prompt parsing, and ref-partition logic.
 */
export function useSpawnPendingAsset(input: UseSpawnPendingAssetInput): UseSpawnPendingAssetResult {
    const {
        actionBadgeId,
        actionType,
        isCustom,
        customDef,
        customActionParams,
        modelId,
        modelParams,
        selectedModel,
        content,
        lyrics,
        dataPrompt,
        pluginBinding,
        projectId,
        refNodeIds,
        getNodes,
        addNodeWithAutoLayout,
        addNodeWithLayout,
        addEdges,
        setNodes,
        loroSync,
    } = input;

    // Pull the signed-in user once per render — used to stamp
    // `data.actorUserId` on every node we spawn / draft / adopt.
    // Phase 0 attribution: NodeProcessor refuses to dispatch a
    // generation without this, so missing it during spawn means a
    // failed node immediately. The Better Auth client returns null
    // mid-hydration; we tolerate that and stamp `''` so the node
    // builder still produces a structurally-valid record (the user
    // would see the failure on submit anyway).
    const session = betterAuthClient.useSession();
    const currentUserId = session.data?.user?.id ?? '';

    const outputKind = useMemo<AigcActionKind>(() => {
        if (isCustom) {
            return customDef?.outputType ?? 'image';
        }
        return resolveBuiltInActionKind(actionType);
    }, [isCustom, customDef, actionType]);

    // Loose gate for draft creation — a draft is just a placeholder slot, so
    // empty prompt / missing refs are fine; validation applies at run time.
    // Only hard blocker: a custom-action badge whose definition hasn't loaded.
    const disabledReason = useMemo(() => {
        if (isCustom && !customDef) return 'Custom action not loaded.';
        return null;
    }, [isCustom, customDef]);

    const canSpawn = disabledReason === null;

    /**
     * Build the `{type, data}` payload for a pending/draft node using the
     * action-badge's current state. Re-partitions refs every call — don't
     * memoize this across draft creation and later adoption.
     *
     * For `status: 'draft'`, prompt and refs are captured as-is (empty is
     * fine — the draft is just a placeholder slot). For `status: 'pending'`,
     * strict validation runs and throws on failure.
     */
    const buildShape = useCallback(
        (status: 'draft' | 'pending', opts?: SpawnOpts): Pick<PendingAssetNode, 'type' | 'data'> => {
            if (opts?.generatorRevision) {
                return { type: outputKind, data: {
                    status, generatorRevision: GeneratorRevisionRefSchema.parse(opts.generatorRevision),
                    ...(isCustom && customDef?.generator ? { generatorActionId: customDef.generator.actionId } : {}),
                    label: opts.labelOverride ?? 'Generated media', actorType: 'user', actorUserId: currentUserId,
                } };
            }
            const refNodes = refNodeIds
                .map((nid) => getNodes().find((n) => n.id === nid))
                .filter((n): n is NonNullable<typeof n> => !!n);
            const scopedRefNodes = opts?.directorReferencePacket
                ? refNodes.map((node) =>
                    node.type === 'director-stage'
                        ? {
                            ...node,
                            data: {
                                ...node.data,
                                directorReferencePacket: opts.directorReferencePacket,
                                directorShotReferencePackets: undefined,
                            },
                        }
                        : node,
                )
                : refNodes;
            const rawPrompt = (content && content.trim() !== '' ? content : '') || dataPrompt || '';

            // Same `GenerationConfig` discriminator used server-side:
            // custom actions are no longer a separate code path, just
            // a different kind of config riding the same pipeline.
            // The pending child now carries `referenceXAssetIds` for
            // custom too (previously they were dropped, leaving
            // marketplace actions unable to consume canvas assets
            // despite their manifest declaring they could).
            const config: GenerationConfig = isCustom && customDef
                ? { kind: 'custom', customDef, customActionParams }
                : { kind: 'model', modelCard: selectedModel, modelParams };

            const configId = config.kind === 'custom' ? config.customDef.id : modelId;

            const { pendingInput, validationError } = buildGenerationPayload({
                prompt: rawPrompt,
                lyrics,
                refNodes: scopedRefNodes,
                configId,
                config,
                actionType: resolveGenerationActionType(
                    actionType,
                    isCustom ? customDef?.id : undefined,
                ),
                label: opts?.labelOverride,
                pluginBinding: pluginBinding ?? (config.kind === 'custom' ? config.customDef.pluginBinding : undefined),
            });

            if (status === 'pending') {
                if (validationError) throw new Error(validationError);
            }

            const node = buildPendingAssetNode({
                ...pendingInput,
                nodeId: 'tmp', // overwritten by caller before insertion
                status,
            });

            // Stamp actor attribution. The web UI is always a user-driven
            // path — the agent path goes through createCanvasTools (server)
            // and the CLI path stamps in commands/canvas.ts.
            node.data.actorType = 'user';
            node.data.actorUserId = currentUserId;
            if (opts?.directorReferencePacket) {
                node.data.directorReferencePacket = opts.directorReferencePacket;
                node.data.sourceDirectorStageId = opts.sourceDirectorStageId
                    ?? opts.directorReferencePacket.stageId;
                node.data.sourceDirectorStageRevisionId = opts.sourceDirectorStageRevisionId
                    ?? opts.directorReferencePacket.stageRevisionId;
                node.data.sourceDirectorStageShotId = opts.sourceDirectorStageShotId
                    ?? opts.directorReferencePacket.scope?.selectedShotIds[0];
                node.data.directorShotGroupId = opts.directorShotGroupId;
            }

            // Pending media nodes intentionally omit `data.src`. Asset
            // identity lives on `referenceImage/Video/AudioAssetIds`; the
            // server resolves R2 keys via D1 lookup. Keeping a stale src
            // field used to be the trap that made partitionRefs /
            // NodeProcessor disagree about what the source of truth is.
            return { type: node.type, data: node.data };
        },
        [
            actionType,
            outputKind,
            isCustom,
            customDef,
            customActionParams,
            modelId,
            modelParams,
            selectedModel,
            content,
            lyrics,
            dataPrompt,
            pluginBinding,
            refNodeIds,
            getNodes,
            currentUserId,
        ],
    );

    const createAndWire = useCallback(
        async (status: 'draft' | 'pending', opts?: SpawnOpts): Promise<RFNode | null> => {
            const generatorRevision = opts?.generatorRevision ?? await input.resolveGeneratorRevision?.();
            const { type, data } = buildShape(status, { ...opts, ...(generatorRevision ? { generatorRevision } : {}) });
            const newId = opts?.assetId ?? (await generateSemanticId(projectId));

            // Offset from the action-badge's actual width + a consistent gap,
            // not the layout manager's fixed 300px default. Otherwise wide
            // downstream drafts (~500px) visually overlap the parent's right
            // edge when starting at parent.x+300, and the mesh collision-
            // resolver has to scatter them.
            const parent = getNodes().find((n) => n.id === actionBadgeId);
            const parentWidth = typeof parent?.width === 'number'
                ? parent.width
                : typeof parent?.style?.width === 'number'
                    ? parent.style.width
                    : 260;
            const offset = { x: parentWidth + 80, y: 0 };

            const newNode = opts?.parentGroupId
                ? addNodeWithLayout(
                    { id: newId, type, data },
                    {
                        x: 32,
                        y: 64 + Math.max(0, opts.groupIndex ?? 0) * 360,
                    },
                    opts.parentGroupId,
                )
                : addNodeWithAutoLayout({ id: newId, type, data }, actionBadgeId, offset);
            if (!newNode) return null;

            const edgeId = `${actionBadgeId}-${newId}`;
            const edge = { id: edgeId, source: actionBadgeId, target: newId, type: 'default' };
            addEdges(edge);
            persistPendingAssetCreation(loroSync, newNode, edge);

            return newNode;
        },
        [actionBadgeId, buildShape, projectId, addNodeWithAutoLayout, addNodeWithLayout, addEdges, loroSync, getNodes, input.resolveGeneratorRevision],
    );

    const spawnPending = useCallback(
        (opts?: SpawnOpts) => createAndWire('pending', opts),
        [createAndWire],
    );

    const spawnDraft = useCallback(
        (opts?: SpawnOpts) => createAndWire('draft', opts),
        [createAndWire],
    );

    const adoptDraft = useCallback(
        async (draftId: string, opts?: AdoptOpts): Promise<RFNode | null> => {
            const generatorRevision = await input.resolveGeneratorRevision?.();
            const { data: nextData } = buildShape('pending', {
                ...(generatorRevision ? { generatorRevision } : {}),
                labelOverride: opts?.labelOverride,
            });
            const payload: Record<string, unknown> = { ...nextData };
            if (opts?.cascadeToken) {
                payload.cascadeToken = opts.cascadeToken;
            }

            let updated: RFNode | null = null;
            setNodes((nds) =>
                nds.map((n) => {
                    if (n.id !== draftId) return n;
                    const merged = { ...n, data: { ...n.data, ...payload } };
                    updated = merged;
                    return merged;
                }),
            );

            if (updated) persistPendingAssetAdoption(loroSync, draftId, payload);

            return updated;
        },
        [buildShape, setNodes, loroSync, input.resolveGeneratorRevision],
    );

    return { spawnPending, spawnDraft, adoptDraft, canSpawn, disabledReason, outputKind };
}
