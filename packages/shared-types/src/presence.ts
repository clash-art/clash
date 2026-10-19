/**
 * Collaboration visibility types — presence and activity sideband messages.
 *
 * These are sent as JSON text messages alongside binary Loro CRDT updates
 * over the same WebSocket connection.
 */

// ─── Connection Identity ──────────────────────────────────────

export type ClientType = "browser" | "cli" | "agent";

/**
 * Who is behind a connection. Stamped by the server from how the socket
 * authenticated (browser session = human; API token, JWT, Host, or internal
 * agent connection = agent). Never inferred from a display name, and never
 * taken from `clientType`, which is the client's own declaration.
 */
export type PresenceKind = "human" | "agent";

export interface ClientInfo {
  id: string;
  userId: string;
  clientType: ClientType;
  kind: PresenceKind;
  /** The user the connection acts for, also for an agent connection. */
  name: string;
  avatar?: string;
  /** Short server-derived device/window label; absent on older connections. */
  device?: string;
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
  /** Per-connection id: one user with two windows is two clients. */
  id: string;
  clientType: ClientType;
  kind: PresenceKind;
  userId: string;
  name: string;
  avatar?: string;
  /** Short server-derived device/window label; absent on older connections. */
  device?: string;
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
  /**
   * The receiving socket's own entry in `clients`. A client hides exactly
   * this id; the same user's other devices and windows remain peers.
   */
  selfClientId?: string;
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
// latest map of (client id → cursor + selection) out to every connected peer.
// The key is the connection, not the user: one user's second window, or an
// agent acting for that user, is a separate peer.
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
  /** Per-connection id, equal to the peer's `PresenceClient.id`. */
  clientId: string;
  /** Identity stamped by the server from the WS auth — clients can't claim. */
  userId: string;
  userName: string;
  userAvatar?: string;
  kind: PresenceKind;
  /** Cursor in flow coordinates; absent when the peer's cursor left the canvas. */
  cursor?: { x: number; y: number };
  /** Currently selected node IDs. */
  selectedNodeIds: string[];
}

/** Server → client: snapshot of every other connected client's awareness state. */
export interface AwarenessBroadcastMessage {
  type: "awareness.broadcast";
  users: AwarenessPeer[];
}

/** Host → client: loading stopped before any accepted Project snapshot was sent. */
export interface ProjectLoadErrorMessage {
  type: "project.load-error";
  projectId: string;
  /**
   * PROJECT_UPGRADE_FAILED: sent by ProjectRoom. SESSION_EXPIRED: raised by the
   * client when the room closes 1008 (authorization expired or revoked); it is
   * user_action_required in the sync error severity taxonomy.
   */
  code: "PROJECT_UPGRADE_FAILED" | "SESSION_EXPIRED";
  message: string;
  nodeId?: string;
}

/** Coded reason a Project room is not fully caught up with its cloud replica. */
export type ProjectRemoteStateCode =
  | "PROJECT_REMOTE_UNAVAILABLE"
  | "PROJECT_REMOTE_SNAPSHOT_IMPORT_FAILED"
  | "CLOUD_LINK_HANDSHAKE_TIMEOUT"
  | "CLOUD_LINK_UNREACHABLE"
  | "CLOUD_LINK_START_FAILED"
  | "CLOUD_LINK_ACTION_REQUIRED";

/**
 * Host → client: how the local Project room currently relates to its cloud replica.
 *
 * The local replica always opens and accepts edits. `unavailable` and
 * `import-failed` mean the cloud may be ahead of what this client sees; they are
 * non-fatal and clear when a later background merge succeeds.
 *
 * Snapshot catch-up and the cloud transport link share this one channel. The
 * Host reports the more severe of the two, so a connected link never hides a
 * failed snapshot import (and a retrying link never hides a ready snapshot).
 * `CLOUD_LINK_*` codes describe the transport; the `PROJECT_REMOTE_*` codes
 * describe the snapshot.
 */
export interface ProjectRemoteStateMessage {
  type: "project.remote-state";
  projectId: string;
  state: "synced" | "unavailable" | "import-failed";
  /** Coded reason; absent when `state` is `synced`. */
  code?: ProjectRemoteStateCode;
  message?: string;
  /** When the next automatic attempt is due, as an ISO timestamp. */
  retryAt?: string;
}

export type SidebandMessage =
  | PresenceMessage
  | ActivityMessage
  | AwarenessBroadcastMessage
  | ProjectLoadErrorMessage
  | ProjectRemoteStateMessage;

/**
 * Type guard: check if a parsed JSON message is a valid sideband message.
 */
export function isSidebandMessage(msg: unknown): msg is SidebandMessage {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as any).type;
  if (t === "project.load-error") {
    const error = msg as Record<string, unknown>;
    return typeof error.projectId === "string" && (error.code === "PROJECT_UPGRADE_FAILED" || error.code === "SESSION_EXPIRED")
      && typeof error.message === "string" && (error.nodeId === undefined || typeof error.nodeId === "string");
  }
  if (t === "project.remote-state") {
    const remote = msg as Record<string, unknown>;
    const state = remote.state;
    return (
      typeof remote.projectId === "string" &&
      (state === "synced" || state === "unavailable" || state === "import-failed") &&
      (remote.code === undefined ||
        remote.code === "PROJECT_REMOTE_UNAVAILABLE" ||
        remote.code === "PROJECT_REMOTE_SNAPSHOT_IMPORT_FAILED" ||
        remote.code === "CLOUD_LINK_HANDSHAKE_TIMEOUT" ||
        remote.code === "CLOUD_LINK_UNREACHABLE" ||
        remote.code === "CLOUD_LINK_START_FAILED" ||
        remote.code === "CLOUD_LINK_ACTION_REQUIRED") &&
      (remote.message === undefined || typeof remote.message === "string") &&
      (remote.retryAt === undefined || typeof remote.retryAt === "string")
    );
  }
  return t === "presence" || t === "activity" || t === "awareness.broadcast";
}

/**
 * Display label for a presence or awareness participant. An agent carries its
 * user's name, so it is told apart by `kind` alone.
 */
export function presenceLabel(participant: {
  name: string;
  kind: PresenceKind;
}): string {
  return participant.kind === "agent"
    ? `${participant.name} · Agent`
    : participant.name;
}
