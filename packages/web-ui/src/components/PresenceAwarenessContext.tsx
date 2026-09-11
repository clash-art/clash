/** Presence updates are independent of the node tree. A cursor broadcast should
 * only render consumers whose selected slice changed, not every canvas card. */
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Peer } from "@clash/web-ui/hooks/usePresenceAwareness";

const EMPTY_PEERS: Peer[] = [];

function samePeer(left: Peer, right: Peer): boolean {
  return (
    left === right ||
    (left.userId === right.userId &&
      left.userName === right.userName &&
      left.userAvatar === right.userAvatar &&
      left.color === right.color &&
      left.cursor?.x === right.cursor?.x &&
      left.cursor?.y === right.cursor?.y &&
      left.selectedNodeIds.length === right.selectedNodeIds.length &&
      left.selectedNodeIds.every(
        (id, index) => id === right.selectedNodeIds[index],
      ))
  );
}

function samePeers(left: Peer[], right: Peer[]): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((peer, index) => samePeer(peer, right[index])))
  );
}

function createPresenceStore(initialPeers: Peer[]) {
  let peers: Peer[] = EMPTY_PEERS;
  let peersByNodeId = new Map<string, Peer[]>();
  const listeners = new Set<() => void>();
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getPeers: () => peers,
    getSelecting: (nodeId: string) => peersByNodeId.get(nodeId) ?? EMPTY_PEERS,
    update(nextPeers: Peer[]) {
      if (samePeers(peers, nextPeers)) return;
      const nextByNodeId = new Map<string, Peer[]>();
      for (const peer of nextPeers) {
        for (const nodeId of peer.selectedNodeIds) {
          const selecting = nextByNodeId.get(nodeId);
          if (selecting) selecting.push(peer);
          else nextByNodeId.set(nodeId, [peer]);
        }
      }
      for (const [nodeId, selecting] of nextByNodeId) {
        const previous = peersByNodeId.get(nodeId);
        if (previous && samePeers(previous, selecting))
          nextByNodeId.set(nodeId, previous);
      }
      peers = nextPeers;
      peersByNodeId = nextByNodeId;
      listeners.forEach((listener) => listener());
    },
  };
  store.update(initialPeers);
  return store;
}

const Ctx = createContext(createPresenceStore(EMPTY_PEERS));

export function PresenceAwarenessProvider({
  peers,
  children,
}: {
  peers: Peer[];
  children: ReactNode;
}) {
  const [store] = useState(() => createPresenceStore(peers));
  // Publish after commit, before paint; never mutate an external store during render.
  useLayoutEffect(() => store.update(peers), [peers, store]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function usePeersSelectingNode(nodeId: string): Peer[] {
  const store = useContext(Ctx);
  const snapshot = () => store.getSelecting(nodeId);
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** Full awareness state, including cursor coordinates. */
export function useAllPeers(): Peer[] {
  const store = useContext(Ctx);
  return useSyncExternalStore(store.subscribe, store.getPeers, store.getPeers);
}

/** Resolve attribution independently of cursor/selection updates. */
export function usePeerName(userId: string | undefined): string | undefined {
  const store = useContext(Ctx);
  const snapshot = () =>
    store.getPeers().find((peer) => peer.userId === userId)?.userName;
  return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
