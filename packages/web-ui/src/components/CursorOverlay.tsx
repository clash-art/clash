/**
 * Renders peer cursors + name labels on top of the ReactFlow canvas.
 *
 * MUST be mounted as a child of `<ReactFlow>` so `useViewport` resolves
 * the current pan/zoom. The cursors are positioned in flow-coordinate
 * space (peers send their pointer position pre-transformed to flow
 * coords, so pan/zoom on our side keeps relative positions stable).
 *
 * z-index: above nodes (which top out at ~CHILD_NODE_Z_INDEX_BASE+depth
 * in ProjectEditor) but below the toolbar/header chrome (z-10..z-50).
 * We pick the z-10..z-20 band and inline z-index because we're rendering
 * an absolutely-positioned layer inside ReactFlow's coordinate system.
 */
import { memo } from 'react';
import { motion } from 'framer-motion';
import { Cursor } from '@phosphor-icons/react';
import { useViewport } from '@xyflow/react';
import type { Peer } from '@clash/web-ui/hooks/usePresenceAwareness';
import { PresenceAgentBadge, PresenceNameBadge } from './PresenceAvatar';

interface CursorOverlayProps {
  peers: Peer[];
}

function CursorOverlayImpl({ peers }: CursorOverlayProps) {
  const { x: vx, y: vy, zoom } = useViewport();

  return (
    <div
      // pointer-events-none so peer cursors never block local interaction.
      // Inset 0 + overflow visible lets cursors at the edge render past
      // the canvas without being clipped by an intermediate container.
      className="pointer-events-none absolute inset-0 overflow-visible"
      style={{ zIndex: 15 }}
      aria-hidden
    >
      {peers.map((peer) => {
        if (!peer.cursor) return null;
        // Flow → screen: same affine ReactFlow uses internally.
        const screenX = peer.cursor.x * zoom + vx;
        const screenY = peer.cursor.y * zoom + vy;
        return (
          <motion.div
            key={peer.clientId}
            data-peer-cursor={peer.clientId}
            className="absolute left-0 top-0"
            // Eases the gap between throttled updates (server fans at 12Hz;
            // without it the cursor would step). `linear` matches mouse
            // intuition better than an eased curve, which lags noticeably
            // during continuous motion.
            initial={false}
            animate={{ x: screenX, y: screenY }}
            transition={{ duration: 0.08, ease: 'linear' }}
          >
            {/* Nudged so the arrow tip — not the icon box — sits exactly at
                the reported position. An agent keeps its user's cursor. */}
            <span className="relative -ml-[3px] -mt-[3px] block size-5">
              <Cursor
                size={20}
                weight="fill"
                color={peer.color}
                className="drop-shadow-sm"
              />
              {peer.kind === 'agent' && <PresenceAgentBadge color={peer.color} />}
            </span>

            <PresenceNameBadge
              name={peer.userName}
              kind={peer.kind}
              color={peer.color}
              className="absolute left-4 top-5"
            />
          </motion.div>
        );
      })}
    </div>
  );
}

export default memo(CursorOverlayImpl);
