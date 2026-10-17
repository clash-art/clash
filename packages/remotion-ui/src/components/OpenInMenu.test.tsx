// @vitest-environment jsdom
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenInMenu } from './OpenInMenu';

afterEach(() => cleanup());

const availability = [
  {
    target: 'premiere-pro' as const,
    applicationName: 'Adobe Premiere Pro',
    installed: true,
  },
  {
    target: 'final-cut-pro' as const,
    applicationName: 'Final Cut Pro',
    installed: false,
  },
  {
    target: 'davinci-resolve' as const,
    applicationName: 'DaVinci Resolve',
    installed: false,
  },
];

describe('OpenInMenu', () => {
  it('uses one Export trigger for video export and NLE handoff', async () => {
    render(
      <OpenInMenu
        onExport={async () => undefined}
        onOpenInNle={async () => undefined}
        availability={availability}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Export' }).className).toContain(
      'clash-workbench-control-button',
    );
    expect(screen.getByRole('button', { name: 'Export' }).className).not.toContain(
      'rounded-md',
    );
    expect(screen.queryByRole('button', { name: 'Open in' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByRole('menuitem', { name: 'Export video' }),
    ).toBeTruthy();
    expect(screen.getByText('Open in')).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: /Adobe Premiere Pro/ }),
    ).toBeTruthy();
  });

  it('runs video export from the combined menu', async () => {
    const onExport = vi.fn(async () => undefined);
    render(
      <OpenInMenu
        onExport={onExport}
        onOpenInNle={async () => undefined}
        availability={availability}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Export video' }),
    );

    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
  });

  it('shows the active Timeline export inside the Export menu', async () => {
    render(
      <OpenInMenu
        exportProgress={[
          {
            renderNodeId: 'render-1',
            timelineId: 'timeline-1',
            timelineRevisionId: 'timeline-revision-v1:abc',
            status: 'rendering',
            progress: 0.42,
          },
        ]}
        onExport={async () => undefined}
        availability={availability}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Export/ }));

    expect(await screen.findByText('Exporting video')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Video export progress' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('menuitem', { name: 'Export video' })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('can be reopened during its own export to cancel it', async () => {
    const onCancelExport = vi.fn();
    const { rerender } = render(
      <OpenInMenu
        onExport={() => new Promise<void>(() => undefined)}
        onCancelExport={onCancelExport}
        availability={availability}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export video' }));
    // The executor reports progress before any render node exists.
    rerender(
      <OpenInMenu
        exportProgress={[
          {
            renderNodeId: 'active-render:timeline-1',
            timelineId: 'timeline-1',
            timelineRevisionId: 'timeline-revision-v1:abc',
            status: 'rendering',
            progress: 0.1,
          },
        ]}
        onExport={() => new Promise<void>(() => undefined)}
        onCancelExport={onCancelExport}
        availability={availability}
      />,
    );
    const button = screen.getByRole('button', { name: /Exporting/ });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel video export' }));
    expect(onCancelExport).toHaveBeenCalledTimes(1);
  });

  it('opens an installed editor from the combined menu', async () => {
    const onOpenInNle = vi.fn(async () => undefined);
    render(
      <OpenInMenu
        onExport={async () => undefined}
        onOpenInNle={onOpenInNle}
        availability={availability}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /Adobe Premiere Pro/ }),
    );

    await waitFor(() =>
      expect(onOpenInNle).toHaveBeenCalledWith('premiere-pro'),
    );
  });
});
