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
  /** The Player reports buffering on change, whether or not it is playing. */
  mediaBuffering: boolean;
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
  mediaBuffering: false,
};

export function playerTransportReducer(
  state: PlayerTransportState,
  event: PlayerTransportEvent,
): PlayerTransportState {
  switch (event.type) {
    case "play":
      // A play event never clears an error by itself; the user retries first.
      if (state.status === "error") return state;
      return { ...state, status: state.mediaBuffering ? "buffering" : "playing" };
    case "pause":
    case "ended":
      // Pausing is how an error stops the clock; keep the error visible.
      return state.status === "error" || state.status === "paused"
        ? state
        : { ...state, status: "paused" };
    case "waiting":
      if (state.mediaBuffering && state.status !== "playing") return state;
      return {
        ...state,
        mediaBuffering: true,
        status: state.status === "playing" ? "buffering" : state.status,
      };
    case "resume":
      if (!state.mediaBuffering && state.status !== "buffering") return state;
      return {
        ...state,
        mediaBuffering: false,
        status: state.status === "buffering" ? "playing" : state.status,
      };
    case "error":
      return state.status === "error" && state.error === event.message
        ? state
        : { ...state, status: "error", error: event.message };
    case "retry":
      return state.status === "error" ? initialPlayerTransportState : state;
  }
}

export function playerTransportIsActive(status: PlayerTransportStatus): boolean {
  return status === "playing" || status === "buffering";
}
