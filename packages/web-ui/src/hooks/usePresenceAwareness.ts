/**
 * Live cursor + selection awareness over the existing /sync/:projectId WS.
 *
 * Architecture: never touches the Loro CRDT doc — awareness is pure
 * ephemeral sideband JSON. See `apps/api-cf/src/agents/project-room.ts`
 * for the matching server-side broadcaster (throttled to ~12Hz outbound;
 * stale entries pruned after 45s).
 *
 * Throttling chain:
 *   - Local cursor/selection deltas are coalesced here to ~50ms (20Hz)
 *     before hitting the WS — see SEND_THROTTLE_MS below.
 *   - Server coalesces outbound broadcasts at ~80ms (12Hz).
 *   - Server and client both prune entries idle > PEER_STALE_MS (45s); we
 *     mirror the server on receive as defence-in-depth (a server pause
 *     shouldn't strand cursors forever).
 *   - While the tab is visible and the user produced input in the last
 *     ACTIVE_WINDOW_MS (60s), we resend a heartbeat every HEARTBEAT_MS (20s).
 *     Hidden or idle tabs send one explicit clear frame instead of waking the
 *     room every heartbeat.
 *
 * Identity: the server stamps each WS with the authenticated user's
 * userId/userName/userAvatar and its `kind` — clients can NOT claim their
 * own identity. The broadcast we receive already excludes this socket, so
 * `peers` here is every other connection, including the same user's other
 * devices, windows and agents.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AwarenessBroadcastMessage,
  AwarenessPeer,
  PresenceKind,
} from '@clash/shared-types';

/** Outbound throttle for local cursor/selection updates. */
const SEND_THROTTLE_MS = 50;
/** How often an active, visible tab refreshes its awareness entry. */
export const HEARTBEAT_MS = 20_000;
/** The user counts as active if they produced input within this window. */
export const ACTIVE_WINDOW_MS = 60_000;
/**
 * Defence-in-depth: drop peers we haven't heard about for this long. Must stay
 * above HEARTBEAT_MS with margin for timer jitter, so a still-but-active
 * cursor never flickers between refreshes.
 */
export const PEER_STALE_MS = 45_000;

/**
 * 10-colour canvas palette — muted enough to sit inside the warm Clash
 * surface language, but dark enough for white cursor labels to stay legible.
 * Keep it small so two random users have a real chance of colliding;
 * stable hash ensures the SAME user always gets the SAME colour across
 * reconnects (so others' mental model "Alice is ember" survives).
 */
const PEER_COLORS = [
  '#b63d2f', // coral
  '#c2410c', // ember
  '#9a3412', // rust
  '#854d0e', // umber
  '#4d7c0f', // moss
  '#166534', // pine
  '#0f766e', // jade
  '#be123c', // rose
  '#7f1d1d', // clay
  '#475569', // slate
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForUserId(userId: string): string {
  return PEER_COLORS[hashString(userId) % PEER_COLORS.length];
}

export interface Peer {
  /** Per-connection id; the identity of a peer. */
  clientId: string;
  /** Shared by every session of one user, and the source of `color`. */
  userId: string;
  kind: PresenceKind;
  userName: string;
  userAvatar?: string;
  color: string;
  cursor?: { x: number; y: number };
  selectedNodeIds: string[];
}

interface InternalPeer extends Peer {
  /** Local-side timestamp from the last awareness broadcast that included this peer. */
  lastSeen: number;
}

export interface UsePresenceAwarenessReturn {
  /** All other connected clients with live awareness state. */
  peers: Peer[];
  /** Update the local cursor in flow coordinates. Pass null/undefined when leaving the canvas. */
  setLocalCursor: (cursor: { x: number; y: number } | null | undefined) => void;
  /** Update the local selection (ReactFlow node IDs). */
  setLocalSelection: (nodeIds: string[]) => void;
}

interface UsePresenceAwarenessOptions {
  /**
   * Subscribe to incoming awareness broadcasts. Pass `onAwareness` from
   * the matching `useLoroSync` instance — this hook does NOT open its
   * own WebSocket; it rides on the existing /sync connection.
   */
  registerOnAwareness: (handler: ((msg: AwarenessBroadcastMessage) => void) | null) => void;
  /** Send a JSON frame on the existing /sync WS (best-effort, drops if not OPEN). */
  sendSideband: (msg: object) => void;
}

/**
 * Internal helper to wire up cursor + selection awareness without re-creating
 * the LoroSync WS. ProjectEditor passes the same WS plumbing it already uses
 * for presence/activity here so we get one socket for everything.
 */
export function usePresenceAwareness(
  options: UsePresenceAwarenessOptions,
): UsePresenceAwarenessReturn {
  const { registerOnAwareness, sendSideband } = options;

  // Peers are keyed by client id — the same user's second window or agent is
  // its own peer with its own cursor, sharing only the user's name and colour.
  const [peers, setPeers] = useState<Peer[]>([]);

  // Latest local state — kept in a ref so the throttle setTimeout can flush
  // the most-recent values rather than the values captured at scheduling time.
  const localStateRef = useRef<{
    cursor: { x: number; y: number } | undefined;
    selectedNodeIds: string[];
  }>({ cursor: undefined, selectedNodeIds: [] });

  // Track what was actually SENT so we can skip no-op flushes.
  const lastSentRef = useRef<{
    cursor: { x: number; y: number } | undefined;
    selectedNodeIds: string[];
    cursorPresent: boolean;
  }>({ cursor: undefined, selectedNodeIds: [], cursorPresent: false });

  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSendAtRef = useRef(0);
  // Last time the user produced input (or changed cursor/selection), and
  // whether we've already sent the one clear frame that marks us away.
  const lastInputAtRef = useRef(0);
  const awayRef = useRef(false);

  const flushSend = useCallback(() => {
    sendTimerRef.current = null;
    lastSendAtRef.current = Date.now();
    const { cursor, selectedNodeIds } = localStateRef.current;

    // Skip identical resends to keep the WS quiet during idle periods.
    const prev = lastSentRef.current;
    const cursorSame =
      (prev.cursor?.x === cursor?.x && prev.cursor?.y === cursor?.y) &&
      // Distinguish "no cursor right now" from "haven't sent yet"
      ((cursor === undefined) === (prev.cursor === undefined));
    const selectionSame =
      prev.selectedNodeIds.length === selectedNodeIds.length &&
      prev.selectedNodeIds.every((id, i) => id === selectedNodeIds[i]);
    if (cursorSame && selectionSame && prev.cursorPresent) return;

    sendSideband({
      type: 'awareness.update',
      // `null` is the explicit "I left the canvas" signal — the server
      // distinguishes that from "no field provided" only by what we send,
      // so we always pass an explicit value once we've started sending.
      cursor: cursor ?? null,
      selectedNodeIds,
    });

    lastSentRef.current = {
      cursor,
      selectedNodeIds: [...selectedNodeIds],
      cursorPresent: true,
    };
  }, [sendSideband]);

  const scheduleSend = useCallback(() => {
    if (sendTimerRef.current) return;
    const now = Date.now();
    const sinceLast = now - lastSendAtRef.current;
    const delay = sinceLast >= SEND_THROTTLE_MS ? 0 : SEND_THROTTLE_MS - sinceLast;
    sendTimerRef.current = setTimeout(flushSend, delay);
  }, [flushSend]);

  /**
   * Send ONE explicit clear frame and stay quiet until the tab is visible and
   * the user is active again. Peers drop the cursor immediately instead of
   * waiting for PEER_STALE_MS, and the hibernated room is no longer woken by
   * a heartbeat every HEARTBEAT_MS.
   */
  const markAway = useCallback(() => {
    if (awayRef.current) return;
    awayRef.current = true;
    if (sendTimerRef.current) {
      clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    sendSideband({ type: 'awareness.update', cursor: null, selectedNodeIds: [] });
    lastSentRef.current = { cursor: undefined, selectedNodeIds: [], cursorPresent: true };
  }, [sendSideband]);

  /** Record user activity, returning from away with an immediate forced send. */
  const noteActivity = useCallback(() => {
    lastInputAtRef.current = Date.now();
    if (!awayRef.current) return;
    awayRef.current = false;
    if (sendTimerRef.current) {
      clearTimeout(sendTimerRef.current);
      sendTimerRef.current = null;
    }
    // Reset the no-op guard so the first frame after returning is always sent,
    // exactly as the heartbeat does.
    lastSentRef.current.cursorPresent = false;
    flushSend();
  }, [flushSend]);

  const setLocalCursor = useCallback(
    (cursor: { x: number; y: number } | null | undefined) => {
      // Both null and undefined collapse to "no cursor" — peers should see it
      // disappear in either case (window blur, leave canvas, unmount).
      const next = cursor && typeof cursor.x === 'number' && typeof cursor.y === 'number'
        ? { x: cursor.x, y: cursor.y }
        : undefined;
      const prev = localStateRef.current.cursor;
      if (prev?.x === next?.x && prev?.y === next?.y) return;
      localStateRef.current.cursor = next;
      noteActivity();
      scheduleSend();
    },
    [noteActivity, scheduleSend],
  );

  const setLocalSelection = useCallback(
    (nodeIds: string[]) => {
      const prev = localStateRef.current.selectedNodeIds;
      const same =
        prev.length === nodeIds.length && prev.every((id, i) => id === nodeIds[i]);
      if (same) return;
      localStateRef.current.selectedNodeIds = nodeIds;
      noteActivity();
      scheduleSend();
    },
    [noteActivity, scheduleSend],
  );

  // Subscribe to incoming broadcasts. We replace the broadcast snapshot
  // wholesale on every frame — the server sends the full set, so a stale
  // peer that vanished from the snapshot is simply dropped here too.
  useEffect(() => {
    const handler = (msg: AwarenessBroadcastMessage) => {
      const now = Date.now();
      const next: Peer[] = msg.users.map((u) => peerFromBroadcast(u, now));
      setPeers((current) => {
        // Merge with any local-only "still alive" entries we haven't yet
        // pruned via stale-sweep — but normally `next` is the whole truth.
        const surviving = current.filter(
          (p) => !next.some((n) => n.clientId === p.clientId) &&
            // Keep only entries fresh enough to display
            internalLastSeen(p) > now - PEER_STALE_MS,
        );
        return [...next, ...surviving];
      });
    };
    registerOnAwareness(handler);
    return () => registerOnAwareness(null);
  }, [registerOnAwareness]);

  // Defence-in-depth stale sweep. The server already prunes, but a brief
  // server pause or in-flight reconnect shouldn't leave cursors stranded.
  useEffect(() => {
    const id = setInterval(() => {
      const cutoff = Date.now() - PEER_STALE_MS;
      setPeers((current) => {
        const next = current.filter((p) => internalLastSeen(p) > cutoff);
        return next.length === current.length ? current : next;
      });
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Passive activity tracking. Only these events refresh the heartbeat window;
  // pointermove fires often but the handler is a cheap timestamp update.
  useEffect(() => {
    const onInput = () => noteActivity();
    const events = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'focus'] as const;
    for (const event of events) {
      window.addEventListener(event, onInput, { passive: true });
    }
    return () => {
      for (const event of events) {
        window.removeEventListener(event, onInput);
      }
    };
  }, [noteActivity]);

  // Hide = one clear frame, then silence. Returning to the tab counts as
  // activity so the current local state is sent again immediately.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markAway();
      } else {
        noteActivity();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [markAway, noteActivity]);

  // Periodically refresh our local state so peers' staleness sweeps keep us
  // alive while the user holds the cursor still. A hidden or idle tab never
  // resends: it sends the single clear frame from markAway instead.
  useEffect(() => {
    const id = setInterval(() => {
      const { cursor, selectedNodeIds } = localStateRef.current;
      if (!cursor && selectedNodeIds.length === 0) return;
      if (awayRef.current) return;
      if (
        document.visibilityState !== 'visible' ||
        Date.now() - lastInputAtRef.current >= ACTIVE_WINDOW_MS
      ) {
        markAway();
        return;
      }
      // Force a send even if values match prev — the heartbeat is the point.
      lastSentRef.current.cursorPresent = false;
      flushSend();
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [flushSend, markAway]);

  // Cleanup: explicit "cursor gone" on unmount so peers don't see a ghost.
  useEffect(() => {
    return () => {
      if (sendTimerRef.current) {
        clearTimeout(sendTimerRef.current);
        sendTimerRef.current = null;
      }
      sendSideband({ type: 'awareness.update', cursor: null, selectedNodeIds: [] });
    };
  }, [sendSideband]);

  return useMemo(
    () => ({ peers, setLocalCursor, setLocalSelection }),
    [peers, setLocalCursor, setLocalSelection],
  );
}

// ─── Internals ────────────────────────────────────────────────

/**
 * We stash `lastSeen` on Peer via a non-enumerable symbol so the public
 * `Peer` shape stays minimal. This avoids leaking infrastructure timing
 * into consumer types while still letting our stale sweeper see it.
 */
const LAST_SEEN_SYMBOL: unique symbol = Symbol('lastSeen');

function peerFromBroadcast(u: AwarenessPeer, now: number): Peer {
  const peer: Peer & { [LAST_SEEN_SYMBOL]?: number } = {
    clientId: u.clientId,
    userId: u.userId,
    kind: u.kind,
    userName: u.userName,
    userAvatar: u.userAvatar,
    color: colorForUserId(u.userId),
    cursor: u.cursor,
    selectedNodeIds: u.selectedNodeIds ?? [],
  };
  Object.defineProperty(peer, LAST_SEEN_SYMBOL, {
    value: now,
    enumerable: false,
    writable: true,
  });
  return peer;
}

function internalLastSeen(p: Peer): number {
  return (p as unknown as { [LAST_SEEN_SYMBOL]?: number })[LAST_SEEN_SYMBOL] ?? 0;
}

// Re-export for consumers that need to render the local user's own colour
// (e.g. "you are this colour" hint in a peers UI).
export type { InternalPeer };
