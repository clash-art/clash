import { Image as ImageIcon, VideoCamera, FilmSlate, SpeakerHigh, TextT, PencilSimple, FilmStrip, Cube } from '@phosphor-icons/react';
import {
    findCompatibleModels,
    pickDefaultModel,
    type AigcActionKind,
    type ModelCatalogEntry,
    type Modality,
} from '@clash/shared-types';
import { GENERATION_ACTION_TYPE_BY_KIND } from './generationActionKind';

export interface PipelineMenuOption {
    id: string;
    label: string;
    icon: typeof ImageIcon;
    nodeType: string;
    /**
     * Spawn payload for the new node. Source-aware so the chosen default
     * model can actually consume the upstream node's modality. For modality-agnostic
     * options (video-editor, plain text), `sourceKind` is ignored.
     */
    getNodeData: (sourceKind: Modality | undefined, catalog: ReadonlyArray<ModelCatalogEntry>) => Record<string, unknown>;
    /**
     * Whether the option is sensible for a given source modality. Derived
     * from the model registry — an option is shown only if some model of
     * the right output kind can consume `sourceKind`. Modality-agnostic
     * options (video-editor) accept anything.
     */
    isCompatibleWithSource: (sourceKind: Modality | undefined, catalog: ReadonlyArray<ModelCatalogEntry>) => boolean;
}

/** Build the spawn payload for a generation action-badge. */
function buildGenNodeData(
    outputKind: AigcActionKind,
    sourceKind?: Modality,
    catalog: ReadonlyArray<ModelCatalogEntry> = [],
): Record<string, unknown> {
    const actionType = GENERATION_ACTION_TYPE_BY_KIND[outputKind];
    // `pickDefaultModel` owns the per-kind default, not catalog array order.
    // Taking `[0]` of the compatible list made the default depend on where a
    // card happens to sit in the catalog: adding a music model above the TTS
    // models silently turned "Audio Prompt" into music generation.
    const card = pickDefaultModel({
        outputKind,
        ...(sourceKind ? { sourceKind } : {}),
        cards: catalog.map((entry) => entry.model),
    });
    const modelId = card?.id ?? '';
    const labelByKind = {
        image: 'Image Prompt',
        video: 'Video Prompt',
        audio: 'Audio Prompt',
        text: 'Text Prompt',
        model: 'Model Prompt',
    } as const satisfies Record<AigcActionKind, string>;
    return {
        label: labelByKind[outputKind],
        actionType,
        modelId,
        model: modelId,
        modelParams: { ...(card?.defaultParams ?? {}) },
        content: '# Prompt\nEnter your prompt here...',
    };
}

function hasCompatibleGenerationModel(
    outputKind: AigcActionKind,
    sourceKind?: Modality,
    catalog: ReadonlyArray<ModelCatalogEntry> = [],
): boolean {
    // The Host has already resolved this catalog. Menu visibility is a
    // capability check, not another Provider routing/credential lookup.
    return findCompatibleModels({
        outputKind,
        sourceKind,
        cards: catalog.map((entry) => entry.model),
    }).length > 0;
}

/**
 * Downstream-action options shared by SourceHandleMenu (on data nodes) and
 * ActionBadgePipelineMenu (on action-badge output handle).
 */
export const PIPELINE_MENU_OPTIONS: PipelineMenuOption[] = [
    {
        id: 'image-gen',
        label: 'Image Gen',
        icon: ImageIcon,
        nodeType: 'action-badge',
        getNodeData: (sourceKind, catalog) => buildGenNodeData('image', sourceKind, catalog),
        // Visible only when some image-output model can consume the source.
        // Without a source (manual placement), always visible.
        isCompatibleWithSource: (sourceKind, catalog) => hasCompatibleGenerationModel('image', sourceKind, catalog),
    },
    {
        id: 'video-gen',
        label: 'Video Gen',
        icon: VideoCamera,
        nodeType: 'action-badge',
        getNodeData: (sourceKind, catalog) => buildGenNodeData('video', sourceKind, catalog),
        isCompatibleWithSource: (sourceKind, catalog) => hasCompatibleGenerationModel('video', sourceKind, catalog),
    },
    {
        id: 'audio-gen',
        label: 'Audio Gen',
        icon: SpeakerHigh,
        nodeType: 'action-badge',
        getNodeData: (sourceKind, catalog) => buildGenNodeData('audio', sourceKind, catalog),
        isCompatibleWithSource: (sourceKind, catalog) => hasCompatibleGenerationModel('audio', sourceKind, catalog),
    },
    {
        id: 'text-gen',
        label: 'Text Gen',
        icon: TextT,
        nodeType: 'action-badge',
        getNodeData: (sourceKind, catalog) => buildGenNodeData('text', sourceKind, catalog),
        isCompatibleWithSource: (sourceKind, catalog) => hasCompatibleGenerationModel('text', sourceKind, catalog),
    },
    {
        id: 'model-gen',
        label: 'Model Gen',
        icon: Cube,
        nodeType: 'action-badge',
        getNodeData: (sourceKind, catalog) => buildGenNodeData('model', sourceKind, catalog),
        isCompatibleWithSource: (sourceKind, catalog) => hasCompatibleGenerationModel('model', sourceKind, catalog),
    },
    {
        id: 'video-editor',
        label: 'Video Editor',
        icon: FilmSlate,
        nodeType: 'video-editor',
        getNodeData: () => ({ label: 'Video Editor', inputs: [] }),
        isCompatibleWithSource: () => true,
    },
    {
        id: 'image-editor',
        label: 'Image Editor',
        icon: PencilSimple,
        nodeType: 'image-editor',
        // Copy-on-write image editor (crop / rotate). Editor reads upstream
        // image's signed URL, renders via canvas, uploads as a new asset.
        getNodeData: () => ({ label: 'Image Editor' }),
        // Only meaningful with an image upstream — generation/audio/video/text
        // sources can't be CoW'd by the image editor.
        isCompatibleWithSource: (sourceKind) => sourceKind === 'image',
    },
    {
        id: 'video-clipper',
        label: 'Video Clipper',
        icon: FilmStrip,
        nodeType: 'video-clipper',
        getNodeData: () => ({ label: 'Video Clipper' }),
        isCompatibleWithSource: (sourceKind) => sourceKind === 'video',
    },
];
