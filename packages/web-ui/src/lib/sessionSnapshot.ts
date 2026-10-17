/**
 * Issue #160 follow-up: share the last get-session answer across tabs.
 *
 * The app opens every project in a new tab (`target="_blank"`), and a new tab
 * is a new page load. Without this each tab paid one get-session at startup,
 * even when another tab had just read the same session. Now the network
 * get-session writes its answer, with a timestamp, to localStorage. A new tab
 * whose first get-session finds a snapshot younger than
 * SESSION_SNAPSHOT_MAX_AGE_MS answers from it instead of the network.
 *
 * - Only the first get-session of a page can use the snapshot (Better Auth's
 *   mount fetch). Explicit refetches (throttled focus, after sign-in or
 *   sign-out) always hit the network.
 * - Signed-out answers, sign-out, account mutations and any API 401 clear it,
 *   so a stale snapshot is never shown as signed in after a known sign-out.
 * - The snapshot only drives UI identity. Authorization is unchanged: every
 *   API request is still checked server-side against the sessions table.
 * - It holds what get-session returns to page JS anyway (user id, name,
 *   email, image, session metadata). The session token is httpOnly and is
 *   never part of it.
 */
export const SESSION_SNAPSHOT_KEY = "clash.session-snapshot.v1";
/** Same window as the focus refetch throttle. */
export const SESSION_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

type Snapshot = { at: number; origin: string; body: string };

let firstGetSessionDone = false;
let servedSnapshotAt: number | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isGetSession(url: string, init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET") return false;
  try {
    return new URL(url, "http://localhost").pathname.endsWith("/get-session");
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function clearSessionSnapshot(): void {
  storage()?.removeItem(SESSION_SNAPSHOT_KEY);
}

function readFresh(origin: string, now: number): Snapshot | null {
  const raw = storage()?.getItem(SESSION_SNAPSHOT_KEY);
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as Snapshot;
    if (snap.origin !== origin) return null;
    if (!(now - snap.at >= 0 && now - snap.at < SESSION_SNAPSHOT_MAX_AGE_MS)) return null;
    const parsed = JSON.parse(snap.body) as { user?: { id?: string } } | null;
    return parsed?.user?.id ? snap : null;
  } catch {
    return null;
  }
}

/** When the first get-session of this page was answered from a snapshot,
 * the time that snapshot was fetched (read once). */
export function takeServedSnapshotAt(): number | null {
  const at = servedSnapshotAt;
  servedSnapshotAt = null;
  return at;
}

/** fetch wrapper for the Better Auth client. */
export async function snapshotFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = requestUrl(input);
  if (!isGetSession(url, init)) return fetch(input, init);
  const origin = new URL(url, "http://localhost").origin;
  if (!firstGetSessionDone) {
    firstGetSessionDone = true;
    const snap = readFresh(origin, Date.now());
    if (snap) {
      servedSnapshotAt = snap.at;
      return new Response(snap.body, {
        status: 200,
        headers: { "content-type": "application/json", "x-clash-session-snapshot": "1" },
      });
    }
  }
  const response = await fetch(input, init);
  try {
    if (response.ok) {
      const body = await response.clone().text();
      const parsed = JSON.parse(body) as { user?: { id?: string } } | null;
      if (parsed?.user?.id) {
        storage()?.setItem(
          SESSION_SNAPSHOT_KEY,
          JSON.stringify({ at: Date.now(), origin, body } satisfies Snapshot),
        );
      } else {
        clearSessionSnapshot();
      }
    } else if (response.status === 401) {
      clearSessionSnapshot();
    }
  } catch {
    // A body we cannot parse is never cached.
  }
  return response;
}

/** Test hook: forget per-page state. */
export function resetSessionSnapshotStateForTests(): void {
  firstGetSessionDone = false;
  servedSnapshotAt = null;
}
