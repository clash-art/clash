/**
 * Collaboration visibility types — presence and activity sideband messages.
 *
 * These are sent as JSON text messages alongside binary Loro CRDT updates
 * over the same WebSocket connection.
 */

// ─── Connection Identity ──────────────────────────────────────

export type ClientType = "browser" | "cli" | "agent";

export interface ClientInfo {
  id: string;
  userId: string;
  clientType: ClientType;
  name: string;
  avatar?: string;
  connectedAt: number;
  /**
   * If set, this client has the timeline editor open on the given node and
   * holds a soft edit-lock. Server-side writers (e.g. agent tools) should
   * refuse to mutate node.data.timelineDsl while the lock is held.
   *
   * Lock is released when:
   *   - client sends `set_editing_node` with nodeId=null (Editor closed)
   *   - WebSocket disconnects (presence is WS-bound)
   *
   * "Soft" because nothing physically prevents a writer that ignores the
   * advertisement; all timelineDsl writers are expected to consult presence.
   */
  editingNodeId?: string | null;
}

// ─── Sideband Message Types ───────────────────────────────────

export interface PresenceClient {
  id: string;
  clientType: ClientType;
  userId: string;
  name: string;
  avatar?: string;
  /** See ClientInfo.editingNodeId. Re-broadcast so all clients know who holds what. */
  editingNodeId?: string | null;
}

/**
 * Client → server: declare or release the soft edit-lock on a node.
 * Sent over the same WebSocket as binary CRDT updates.
 */
export interface SetEditingNodeMessage {
  type: "set_editing_node";
  /** nodeId to start editing, or null to release any held lock. */
  nodeId: string | null;
}

export interface PresenceMessage {
  type: "presence";
  clients: PresenceClient[];
}

export type ActivityAction = "added" | "updated" | "deleted";

export interface ActivityActor {
  clientType: ClientType;
  name: string;
}

export interface ActivityMessage {
  type: "activity";
  actor: ActivityActor;
  action: ActivityAction;
  nodeId: string;
  nodeType: string;
  label: string;
  /** Canvas that owns the node. Enables follow-mode clients to switch
   * surfaces before centering the target. Older senders may omit it. */
  canvasId?: string;
  timestamp: number;
}

// ─── Live Cursor / Selection Awareness (ephemeral) ────────────
//
// These messages ride the same /sync/:projectId WS as the binary Loro CRDT
// stream and the presence/activity sideband. They are pure ephemeral state:
// the server never persists awareness into the Loro doc — it only fans the
// latest map of (userId → cursor + selection) out to every connected peer.
//
// Throttling lives on both ends. The client coalesces local cursor/selection
// to ~50ms (20Hz) before sending `awareness.update`; the server coalesces
// outbound `awareness.broadcast` to ~80ms (12Hz). Without these caps, five
// users mousing on the canvas at 60Hz would flood the WS at 300 msg/sec.

/** Client → server: declare local cursor + selection. */
export interface AwarenessUpdateMessage {
  type: "awareness.update";
  /**
   * Cursor in flow-coordinate space (NOT screen pixels). The receiving peer
   * applies the React Flow viewport transform to render it at the right
   * screen position. Omit / set to `null` when the cursor leaves the canvas
   * (window blur, mouseleave, tab hidden) so peers see it disappear.
   */
  cursor?: { x: number; y: number } | null;
  /** Currently selected node IDs (ReactFlow). Empty array = nothing selected. */
  selectedNodeIds?: string[];
}

export interface AwarenessPeer {
  /** Identity stamped by the server from the WS auth — clients can't claim. */
  userId: string;
  userName: string;
  userAvatar?: string;
  /** Cursor in flow coordinates; absent when the peer's cursor left the canvas. */
  cursor?: { x: number; y: number };
  /** Currently selected node IDs. */
  selectedNodeIds: string[];
}

/** Server → client: snapshot of every other connected peer's awareness state. */
export interface AwarenessBroadcastMessage {
  type: "awareness.broadcast";
  users: AwarenessPeer[];
}

/** Host → client: loading stopped before any accepted Project snapshot was sent. */
export interface ProjectLoadErrorMessage {
  type: "project.load-error";
  projectId: string;
  code: "PROJECT_UPGRADE_FAILED";
  message: string;
  nodeId?: string;
}

export type SidebandMessage =
  | PresenceMessage
  | ActivityMessage
  | AwarenessBroadcastMessage
  | ProjectLoadErrorMessage;

/**
 * Type guard: check if a parsed JSON message is a valid sideband message.
 */
export function isSidebandMessage(msg: unknown): msg is SidebandMessage {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as any).type;
  if (t === "project.load-error") {
    const error = msg as Record<string, unknown>;
    return typeof error.projectId === "string" && error.code === "PROJECT_UPGRADE_FAILED"
      && typeof error.message === "string" && (error.nodeId === undefined || typeof error.nodeId === "string");
  }
  return t === "presence" || t === "activity" || t === "awareness.broadcast";
}
