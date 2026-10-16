/**
 * Coloured ring drawn around a node when one or more peers have it selected.
 *
 * Renders as a sibling of the node's main card (absolutely positioned, inset
 * negative so it sits OUTSIDE the card's border). When multiple peers select
 * the same node we stack rings outward — first peer at the closest offset,
 * subsequent peers further out — and tag each with a tiny name pill at the
 * top-right corner.
 *
 * Designed to coexist with the local user's blue selection ring (which is
 * inset to `ring-4` on the card itself). Peer rings sit at the OUTSIDE of
 * the card so the local ring's offset doesn't visually fight them.
 */
import { memo } from 'react';
import type { Peer } from '@clash/web-ui/hooks/usePresenceAwareness';
import { PresenceNameBadge } from './PresenceAvatar';

interface PeerSelectionRingProps {
  /** Peers (filtered to those selecting THIS node). */
  peers: Peer[];
}

function PeerSelectionRingImpl({ peers }: PeerSelectionRingProps) {
  if (peers.length === 0) return null;

  // Cap at 3 visible rings — beyond that the visual noise wins and we
  // collapse the overflow into a "+N" pill on the last visible ring.
  const VISIBLE = 3;
  const visible = peers.slice(0, VISIBLE);
  const overflow = peers.length - VISIBLE;

  return (
    <>
      {visible.map((peer, idx) => {
        const inset = -4 - idx * 4; // first ring -4px, each later ring 4px further out
        const showOverflowOnThis = overflow > 0 && idx === visible.length - 1;
        return (
          <div
            key={peer.clientId}
            className="pointer-events-none absolute rounded-2xl"
            style={{
              top: inset,
              left: inset,
              right: inset,
              bottom: inset,
              boxShadow: `0 0 0 2px ${peer.color}`,
              // Z-index above the card itself (the card uses ring offsets that
              // already cap around z-10..20 inside its own subtree). 0 here is
              // fine — we're absolutely positioned and within the same parent.
              zIndex: 0,
            }}
          >
            <PresenceNameBadge
              name={peer.userName}
              kind={peer.kind}
              color={peer.color}
              agentIcon
              className="absolute -top-6 left-0"
            >
              {showOverflowOnThis && (
                <span className="opacity-80">+{overflow}</span>
              )}
            </PresenceNameBadge>
          </div>
        );
      })}
    </>
  );
}

export default memo(PeerSelectionRingImpl);
