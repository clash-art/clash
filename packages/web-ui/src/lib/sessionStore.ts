/**
 * Issue #160: the one client-side session source.
 *
 * Better Auth keeps the session in a single nanostores atom per client; every
 * `betterAuthClient.useSession()` reads it. This module makes route loaders
 * read that same atom instead of fetching get-session themselves, keeps the
 * atom mounted so it is fetched once per page load, owns the only focus
 * refetch (at most once per five minutes), and signs the app out on an API
 * 401 without asking the server again.
 *
 * Local-user runtimes (Desktop, local Host) have no Better Auth: nothing here
 * touches the network there.
 */
import { useSyncExternalStore } from "react";
import {
  getAuthSessionAtom,
  setSessionMutationListener,
  type SessionAtom,
  type SessionAtomState,
} from "./betterAuthClient";
import {
  getRuntimeCapabilities,
  setApiUnauthorizedListener,
} from "./runtimeConfig";

/** A focus refetch happens only this long after the previous session fetch. */
export const SESSION_FOCUS_REFETCH_MS = 5 * 60 * 1000;

/** Better Auth signals its post-mutation refetch after 10ms; allow for that. */
const MUTATION_SIGNAL_GRACE_MS = 50;

export type SessionSnapshot = Pick<SessionAtomState, "data" | "error">;

let source: SessionAtom | null = null;
let lastFetchAt = 0;
let wasRefetching = false;
let mutationPending = false;
let retry: Promise<unknown> | undefined;

setSessionMutationListener(() => {
  mutationPending = true;
});
setApiUnauthorizedListener(() => markSignedOut());

function startSessionSource(): SessionAtom | null {
  if (source) return source;
  if (getRuntimeCapabilities().auth.mode !== "better-auth") return null;
  const session = getAuthSessionAtom();
  if (!session) return null;
  source = session;
  wasRefetching = session.get().isRefetching;
  if (wasRefetching) lastFetchAt = Date.now();
  // Never unsubscribed: Better Auth fetches whenever the atom (re)mounts, so
  // keeping it mounted is what makes the startup fetch the only one.
  session.listen((state) => {
    if (state.isRefetching && !wasRefetching) {
      lastFetchAt = Date.now();
      mutationPending = false;
    }
    wasRefetching = state.isRefetching;
  });
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", refetchOnFocus);
  }
  return session;
}

function refetchOnFocus() {
  if (!source || document.visibilityState !== "visible") return;
  if (Date.now() - lastFetchAt < SESSION_FOCUS_REFETCH_MS) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  lastFetchAt = Date.now();
  void source.get().refetch();
}

function settled(session: SessionAtom): Promise<SessionAtomState> {
  const current = session.get();
  if (!current.isPending && !current.isRefetching) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const stop = session.listen((state) => {
      if (state.isPending || state.isRefetching) return;
      stop();
      resolve(state);
    });
  });
}

/** Wait for the refetch Better Auth schedules after sign-in/sign-out. */
function mutationRefetchStarted(session: SessionAtom): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      if (mutationPending) {
        mutationPending = false;
        void session.get().refetch();
      }
      resolve();
    }, MUTATION_SIGNAL_GRACE_MS);
    const stop = session.listen((state) => {
      if (!state.isRefetching) return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

function isUnauthorized(error: SessionAtomState["error"]): boolean {
  return !!error && "status" in error && error.status === 401;
}

/**
 * The shared session. The first call starts the one startup fetch; later
 * calls (route loaders on every navigation) reuse the cached value. A failed
 * (non-401) fetch is retried once per caller rather than cached.
 */
export async function getSession(): Promise<SessionSnapshot> {
  const session = startSessionSource();
  if (!session) return { data: null, error: null };
  if (mutationPending) await mutationRefetchStarted(session);
  let state = await settled(session);
  if (state.error && !state.data && !isUnauthorized(state.error)) {
    retry ??= state.refetch().finally(() => {
      retry = undefined;
    });
    await retry;
    state = await settled(session);
  }
  return { data: state.data, error: state.error };
}

/**
 * The HTTP status a loader should fail with when the session could not be
 * read, or null when the snapshot is a definite answer (signed in or out).
 */
export function sessionFailureStatus(snapshot: SessionSnapshot): number | null {
  const { data, error } = snapshot;
  if (data?.user?.id || !error || isUnauthorized(error)) return null;
  return "status" in error && typeof error.status === "number"
    ? error.status
    : 503;
}

/** An API answered 401: show the app signed out, without a get-session. */
export function markSignedOut(): void {
  if (!source) return;
  const current = source.get();
  if (current.data === null && !current.isPending && !current.isRefetching) {
    return;
  }
  source.set({
    ...current,
    data: null,
    error: null,
    isPending: false,
    isRefetching: false,
  });
}

function subscribe(onChange: () => void): () => void {
  return startSessionSource()?.listen(onChange) ?? (() => {});
}

function signedInSnapshot(): boolean | null {
  const state = source?.get();
  if (!state || state.isPending) return null;
  return !!state.data?.user?.id;
}

/**
 * Whether the shared session has a user; null while unknown or where the
 * runtime has no Better Auth session.
 */
export function useSessionSignedIn(): boolean | null {
  return useSyncExternalStore(subscribe, signedInSnapshot, () => null);
}
