// @vitest-environment jsdom
import { Suspense } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAgentCopilot } from './useAgentCopilot';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function DisabledCopilot({ threadId }: { threadId: string }) {
  const chat = useAgentCopilot({ projectId: 'local-only', threadId, enabled: false });
  return <div>{chat.connected ? 'connected' : 'local ready'}</div>;
}

it('does not fetch hosted history or suspend local work when the cloud copilot is disabled', async () => {
  // Exercise the real Agents/chat hooks: disabling the WebSocket alone does
  // not disable the chat SDK's separate HTTP history request.
  const fetch = vi.fn().mockResolvedValue(new Response('[]'));
  vi.stubGlobal('fetch', fetch);
  const view = await act(async () => render(<Suspense fallback="loading"><DisabledCopilot threadId="first" /></Suspense>));
  expect(screen.getByText('local ready')).toBeInTheDocument();
  await act(async () => view.rerender(<Suspense fallback="loading"><DisabledCopilot threadId="second" /></Suspense>));
  expect(screen.getByText('local ready')).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});
