/**
 * The preview transport state, derived only from what the Remotion Player
 * reports (play/pause/ended/waiting/resume/error events) plus terminal media
 * failures. The play button reads this, never the editor's play intent, so it
 * cannot claim "playing" while the Player is stalled or broken.
 */
export type PlayerTransportStatus = "paused" | "playing" | "buffering" | "error";

export type PlayerTransportState = {
  status: PlayerTransportStatus;
  error: string | null;
};

export type PlayerTransportEvent =
  | { type: "play" }
  | { type: "pause" }
  | { type: "ended" }
  | { type: "waiting" }
  | { type: "resume" }
  | { type: "error"; message: string }
  | { type: "retry" };

/** A buffering stall longer than this is reported as an error and paused. */
export const PLAYER_STALL_TIMEOUT_MS = 20_000;

export const initialPlayerTransportState: PlayerTransportState = {
  status: "paused",
  error: null,
};

export function playerTransportReducer(
  state: PlayerTransportState,
  event: PlayerTransportEvent,
): PlayerTransportState {
  switch (event.type) {
    case "play":
      // A play event never clears an error by itself; the user retries first.
      return state.status === "error" ? state : { status: "playing", error: null };
    case "pause":
    case "ended":
      // Pausing is how an error stops the clock; keep the error visible.
      return state.status === "error" || state.status === "paused"
        ? state
        : { status: "paused", error: null };
    case "waiting":
      return state.status === "playing" ? { status: "buffering", error: null } : state;
    case "resume":
      return state.status === "buffering" ? { status: "playing", error: null } : state;
    case "error":
      return state.status === "error" && state.error === event.message
        ? state
        : { status: "error", error: event.message };
    case "retry":
      return state.status === "error" ? initialPlayerTransportState : state;
  }
}

export function playerTransportIsActive(status: PlayerTransportStatus): boolean {
  return status === "playing" || status === "buffering";
}
