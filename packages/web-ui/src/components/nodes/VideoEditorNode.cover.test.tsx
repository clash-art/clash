// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import VideoEditorNode from './VideoEditorNode';
import { assetPreviewMedia } from '../../features/assets/media-url';

const mocks = vi.hoisted(() => ({
    nodes: [
        {
            id: 'video-node',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { assetId: 'video-asset' },
        },
        {
            id: 'audio-node',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { assetId: 'audio-asset' },
        },
    ],
    timelineState: {
        tracks: [
            {
                id: 'primary',
                items: [
                    {
                        id: 'clip-1',
                        type: 'video',
                        from: 0,
                        durationInFrames: 90,
                        sourceNodeId: 'video-node',
                    },
                ] as Array<{
                    id: string;
                    type: string;
                    from: number;
                    durationInFrames: number;
                    sourceNodeId?: string;
                    assetId?: string;
                }>,
            },
        ],
    },
    asset: {
        id: 'video-asset',
        kind: 'video',
        status: 'ready' as const,
        url: 'https://media.clash.test/video',
        thumbnailUrl: 'https://media.clash.test/video-cover.webp' as string | undefined,
        metadata: {},
    },
    audioAsset: {
        id: 'audio-asset',
        kind: 'audio',
        status: 'ready' as const,
        url: 'https://media.clash.test/narration',
        metadata: {},
    },
}));

vi.mock('@xyflow/react', () => ({
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    useReactFlow: () => ({
        getNodes: () => mocks.nodes,
        getEdges: () => [],
        addNodes: vi.fn(),
        addEdges: vi.fn(),
        getNode: vi.fn(),
        setNodes: vi.fn(),
    }),
}));

vi.mock('../VideoEditorContext', () => ({
    useVideoEditor: () => ({ openTimeline: vi.fn() }),
}));

vi.mock('../ProjectContext', () => ({
    useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('../LoroSyncContext', () => ({
    useOptionalLoroSyncContext: () => ({
        timelines: [{
            id: 'timeline-1',
            revisionId: 'revision-1',
            state: mocks.timelineState,
        }],
        doc: {
            subscribe: () => () => undefined,
            getMap: () => ({
                get: () => ({ data: { timelineId: 'timeline-1' } }),
            }),
        },
    }),
}));

vi.mock('@clash/web-ui/lib/hooks/useAsset', () => ({
    getAsset: vi.fn(async (_projectId: string, assetId: string) =>
        assetId === mocks.audioAsset.id ? mocks.audioAsset : mocks.asset),
}));

const baseNodeProps = {
    selected: false,
    dragging: false,
    draggable: true,
    selectable: true,
    deletable: true,
    zIndex: 1,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
};

afterEach(() => {
    cleanup();
    mocks.asset.thumbnailUrl = 'https://media.clash.test/video-cover.webp';
    mocks.nodes = [
        {
            id: 'video-node',
            type: 'video',
            position: { x: 0, y: 0 },
            data: { assetId: 'video-asset' },
        },
        {
            id: 'audio-node',
            type: 'audio',
            position: { x: 0, y: 0 },
            data: { assetId: 'audio-asset' },
        },
    ];
    mocks.timelineState.tracks[0].items = [
        {
            id: 'clip-1',
            type: 'video',
            from: 0,
            durationInFrames: 90,
            sourceNodeId: 'video-node',
        },
    ];
});

describe('VideoEditorNode cover', () => {
    it('resolves an Asset-only clip without persisting a synthetic Canvas hint', async () => {
        mocks.nodes = [];
        mocks.timelineState.tracks[0].items = [{
            id: 'asset-only', type: 'video', assetId: 'video-asset', from: 0, durationInFrames: 60,
        }];
        render(<VideoEditorNode {...baseNodeProps} id="timeline-action" type="videoEditor" data={{ timelineId: 'timeline-1' }} />);
        await waitFor(() => expect(document.querySelector('img')?.getAttribute('src')).toBe(mocks.asset.thumbnailUrl));
        expect(mocks.timelineState.tracks[0].items[0]).not.toHaveProperty('sourceNodeId');
    });

    it('uses the Host-projected thumbnail without reconstructing a storage locator', () => {
        expect(assetPreviewMedia(mocks.asset as never)).toEqual({
            kind: 'image',
            source: mocks.asset.thumbnailUrl,
        });
    });

    it('uses the asset media URL for a persisted video cover', async () => {
        render(
            <VideoEditorNode
                {...baseNodeProps}
                id="timeline-action"
                type="videoEditor"
                data={{ timelineId: 'timeline-1' }}
            />,
        );

        await waitFor(() => {
            expect(document.querySelector('img')?.getAttribute('src')).toBe(mocks.asset.thumbnailUrl);
        });
    });

    it('renders a local video source when its cover is not available yet', async () => {
        mocks.asset.thumbnailUrl = undefined;

        render(
            <VideoEditorNode
                {...baseNodeProps}
                id="timeline-action"
                type="videoEditor"
                data={{ timelineId: 'timeline-1' }}
            />,
        );

        await waitFor(() => {
            expect(document.querySelector('video')?.getAttribute('src')).toBe(mocks.asset.url);
        });
        expect(document.querySelector('img')).toBeNull();
    });

    it('uses the earliest visual asset instead of an earlier audio item', async () => {
        mocks.timelineState.tracks[0].items = [
            {
                id: 'narration',
                type: 'audio',
                from: 0,
                durationInFrames: 120,
                sourceNodeId: 'audio-node',
            },
            {
                id: 'clip-1',
                type: 'video',
                from: 30,
                durationInFrames: 90,
                sourceNodeId: 'video-node',
            },
        ];

        render(
            <VideoEditorNode
                {...baseNodeProps}
                id="timeline-action"
                type="videoEditor"
                data={{ timelineId: 'timeline-1' }}
            />,
        );

        await waitFor(() => {
            expect(document.querySelector('img')?.getAttribute('src')).toBe(mocks.asset.thumbnailUrl);
        });
    });

    it('resolves a project or local asset directly when no Canvas node exists', async () => {
        mocks.nodes = [];
        mocks.timelineState.tracks[0].items = [
            {
                id: 'clip-1',
                type: 'video',
                from: 0,
                durationInFrames: 90,
                sourceNodeId: 'timeline-asset:video-asset',
                assetId: 'video-asset',
            },
        ];

        render(
            <VideoEditorNode
                {...baseNodeProps}
                id="timeline-action"
                type="videoEditor"
                data={{ timelineId: 'timeline-1' }}
            />,
        );

        await waitFor(() => {
            expect(document.querySelector('img')?.getAttribute('src')).toBe(mocks.asset.thumbnailUrl);
        });
    });
});
