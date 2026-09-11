import { describe, expect, it } from 'vitest';
import {
  buildCopilotPrompt,
  buildProjectMentionSources,
  type CopilotWorkspaceContext,
} from './copilotWorkspaceContext';

describe('buildProjectMentionSources', () => {
  it('keeps every current-canvas node including actions and ranks other canvases last', () => {
    const sources = buildProjectMentionSources({
      activeCanvasId: 'canvas-main',
      activeSurface: { kind: 'canvas', canvasId: 'canvas-main' },
      canvases: [
        { id: 'canvas-main', name: 'Main' },
        { id: 'canvas-review', name: 'Review' },
      ],
      nodes: [
        { id: 'image-1', type: 'image', canvasId: 'canvas-main', data: { label: 'Hero image' } },
        { id: 'action-1', type: 'action', canvasId: 'canvas-main', data: { label: 'Render variants' } },
        { id: 'review-note', type: 'text', canvasId: 'canvas-review', data: { label: 'Legal note' } },
      ],
      assets: [
        { id: 'asset-1', name: 'Logo master', kind: 'image', metadata: {}, thumbnailUrl: 'https://media.clash.test/logo.png' },
      ],
      timelines: [
        { id: 'timeline-1', name: 'Social cut' },
      ],
    });

    expect(sources.map((source) => [source.id, source.scope, source.kind])).toEqual([
      ['image-1', 'current-canvas', 'node'],
      ['action-1', 'current-canvas', 'node'],
      ['asset-1', 'project-assets', 'asset'],
      ['timeline-1', 'timelines', 'timeline'],
      ['review-note', 'other-canvases', 'node'],
    ]);
    expect(sources.find((source) => source.id === 'action-1')?.description).toContain('Action');
    expect(sources.find((source) => source.id === 'review-note')?.description).toContain('Review');
  });

  it('puts the open timeline before project assets', () => {
    const sources = buildProjectMentionSources({
      activeCanvasId: 'canvas-main',
      activeSurface: { kind: 'timeline', timelineId: 'timeline-2' },
      canvases: [{ id: 'canvas-main', name: 'Main' }],
      nodes: [],
      assets: [{ id: 'asset-1', name: 'Logo', kind: 'image', metadata: {} }],
      timelines: [
        { id: 'timeline-1', name: 'Rough cut' },
        { id: 'timeline-2', name: 'Final cut' },
      ],
    });

    expect(sources.slice(0, 3).map((source) => source.id)).toEqual([
      'timeline-2',
      'asset-1',
      'timeline-1',
    ]);
    expect(sources[0]?.scope).toBe('current-surface');
  });

  it('puts the open Director Stage first and preserves it as an agent-addressable surface', () => {
    const sources = buildProjectMentionSources({
      activeCanvasId: 'canvas-main',
      activeSurface: { kind: 'director-stage', stageId: 'stage-2' },
      canvases: [{ id: 'canvas-main', name: 'Main' }],
      nodes: [],
      assets: [{ id: 'asset-1', name: 'Backdrop', kind: 'image', metadata: {} }],
      timelines: [],
      directorStages: [
        { id: 'stage-1', name: 'Wide blocking' },
        { id: 'stage-2', name: 'Close-up blocking' },
      ],
    });

    expect(sources.slice(0, 3).map((source) => [source.id, source.kind, source.scope])).toEqual([
      ['stage-2', 'director-stage', 'current-surface'],
      ['asset-1', 'asset', 'project-assets'],
      ['stage-1', 'director-stage', 'director-stages'],
    ]);
  });
});

describe('buildCopilotPrompt', () => {
  it('includes the active product surface while preserving the user request', () => {
    const context: CopilotWorkspaceContext = {
      projectId: 'project-7',
      projectName: 'Launch Film',
      activeSurface: {
        kind: 'canvas',
        id: 'canvas-main',
        name: 'Main Storyboard',
      },
    };
    const result = buildCopilotPrompt(
      'Use @[Render variants](node:action-1) with @[Logo master](node:asset-1)',
      context,
      [
        {
          id: 'action-1',
          type: 'action',
          label: 'Render variants',
          kind: 'node',
          scope: 'current-canvas',
          canvasId: 'canvas-main',
          canvasName: 'Main Storyboard',
        },
        {
          id: 'asset-1',
          type: 'image',
          label: 'Logo master',
          kind: 'asset',
          scope: 'project-assets',
        },
      ],
    );

    expect(result.endsWith('Use @[Render variants](node:action-1) with @[Logo master](node:asset-1)')).toBe(true);
    const payload = JSON.parse(result.split('<!-- clash-workspace-context ')[1].split(' -->')[0]);
    expect(payload.projectId).toBe(context.projectId);
    expect(payload.projectName).toBe(context.projectName);
    expect(payload.activeSurface).toEqual(context.activeSurface);
  });

  it('includes the live browser summary because ephemeral browser state is not available through Clash MCP', () => {
    const result = buildCopilotPrompt(
      'Compare the options on this page.',
      {
        projectId: 'project-7',
        projectName: 'Launch Film',
        activeSurface: {
          kind: 'browser',
          id: 'browser-1',
          name: 'Reference docs',
          browser: {
            url: 'https://docs.example/models',
            title: 'Models',
            text: 'Fast model Accurate model',
            interactiveElements: [
              { tag: 'a', label: 'Accurate model', selector: '#accurate' },
            ],
          },
        },
      },
    );

    expect(result).toContain('clash-workspace-context');
    expect(result).toContain('https://docs.example/models');
    expect(result).toContain('Fast model Accurate model');
    expect(result.endsWith('Compare the options on this page.')).toBe(true);
  });

  it('embeds agent annotations as structured object addresses before the visible prompt', () => {
    const annotation = {
      id: 'annotation-1',
      kind: 'agent-annotation',
      note: 'Keep the entrance, but move the logo reveal two seconds earlier.',
      target: {
        projectId: 'project-7',
        surface: 'timeline',
        surfaceId: 'timeline-final',
        surfaceLabel: 'Final cut',
        revisionId: 'timeline-revision-4',
        objectId: 'clip-logo',
        objectType: 'video',
        objectLabel: 'Logo reveal',
        parentId: 'track-brand',
        objectPath: 'timelines/timeline-final/tracks/track-brand/items/clip-logo',
        capabilities: ['read', 'modify'],
        selection: {
          kind: 'text-quote',
          exact: 'Director：14 tests Web 相关回归：62 tests',
          prefix: 'Timeline：215 tests ',
          suffix: ' 三个相关包类型检查通过',
          visualRects: [
            { x: 0.12, y: 0.42, width: 0.3, height: 0.04 },
          ],
        },
      },
    };

    const result = buildCopilotPrompt(
      'Apply the review notes.',
      {
        projectId: 'project-7',
        projectName: 'Launch Film',
        activeSurface: {
          kind: 'timeline',
          id: 'timeline-final',
          name: 'Final cut',
        },
      },
      [],
      // The fourth argument is the feature under test.
      [annotation] as never,
    );

    expect(result).toContain('<!-- clash-agent-annotations ');
    expect(result).toContain('"kind":"agent-annotation"');
    expect(result).toContain('"surface":"timeline"');
    expect(result).toContain('"objectPath":"timelines/timeline-final/tracks/track-brand/items/clip-logo"');
    expect(result).toContain('"note":"Keep the entrance, but move the logo reveal two seconds earlier."');
    expect(result).toContain('"kind":"text-quote"');
    expect(result).toContain('"exact":"Director：14 tests Web 相关回归：62 tests"');
    expect(result).toMatch(/clash-agent-annotations[\s\S]*-->\nApply the review notes\.$/);
  });
});
