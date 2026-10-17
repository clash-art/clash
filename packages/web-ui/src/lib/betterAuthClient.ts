import { createAuthClient } from "better-auth/react";
import { cloudflareClient } from "better-auth-cloudflare/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { runtimeApiUrl } from "./runtimeConfig";
import { clearSessionSnapshot, snapshotFetch } from "./sessionSnapshot";

export type SessionQuery = {
  data: {
    user?: {
      id?: string | null;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    } | null;
  } | null;
  isPending: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

type AuthResult = {
  data?: unknown;
  error?: {
    code?: string;
    message?: string;
  } | null;
};

type AuthClient = {
  updateUser: (input: { name: string }) => Promise<AuthResult>;
  useSession: () => SessionQuery;
  emailOtp: {
    sendVerificationOtp: (input: {
      email: string;
      type: "sign-in";
    }) => Promise<AuthResult>;
  };
  signIn: {
    emailOtp: (input: { email: string; otp: string }) => Promise<AuthResult>;
    email: (input: unknown) => Promise<AuthResult>;
    social: (input: unknown) => Promise<AuthResult>;
  };
  signUp: {
    email: (input: unknown) => Promise<AuthResult>;
  };
  signOut: (input?: unknown) => Promise<AuthResult>;
};

/** Better Auth's session atom state (nanostores). */
export type SessionAtomState = {
  data: SessionQuery["data"];
  error: ({ status?: number } & Record<string, unknown>) | Error | null;
  isPending: boolean;
  isRefetching: boolean;
  refetch: () => Promise<unknown>;
};

export type SessionAtom = {
  get(): SessionAtomState;
  set(value: SessionAtomState): void;
  listen(listener: (value: SessionAtomState) => void): () => void;
};

/**
 * Better Auth paths whose success makes the client refetch the session (its
 * own `$sessionSignal` matchers plus the email OTP plugin's). Better Auth
 * fires that signal 10ms after the response, so a caller that navigates
 * straight after sign-in would otherwise read the stale session first.
 */
const SESSION_MUTATION_PATHS = [
  "/sign-in/email",
  "/sign-in/email-otp",
  "/sign-up/email",
  "/sign-out",
  "/update-user",
  "/update-session",
  "/delete-user",
  "/verify-email",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/change-email",
  "/change-password",
  "/email-otp/request-email-change",
];

let sessionMutationListener: (() => void) | undefined;

/** Called synchronously when a session-changing auth request succeeds. */
export function setSessionMutationListener(listener: (() => void) | undefined) {
  sessionMutationListener = listener;
}

function notifySessionMutation(url: unknown) {
  let pathname: string;
  try {
    pathname = new URL(String(url), "http://localhost").pathname;
  } catch {
    return;
  }
  if (SESSION_MUTATION_PATHS.some((path) => pathname.endsWith(path))) {
    clearSessionSnapshot();
    sessionMutationListener?.();
  }
}

let _client: AuthClient | null = null;

function authBaseUrl(): string {
  const url = runtimeApiUrl("/api/better-auth");
  if (/^https?:/.test(url)) return url;
  return `${window.location.origin}${url}`;
}

function getClient(): AuthClient {
  if (_client) return _client;
  if (typeof window === "undefined") {
    return SSR_STUB as unknown as AuthClient;
  }
  _client = createAuthClient({
    baseURL: authBaseUrl(),
    plugins: [cloudflareClient(), emailOTPClient()],
    // Issue #160: no focus/interval refetch here; sessionStore owns the one
    // throttled focus refetch. Sign-in/out still refetch via $sessionSignal
    // and other tabs via Better Auth's storage broadcast.
    sessionOptions: { refetchOnWindowFocus: false, refetchInterval: 0 },
    fetchOptions: {
      // Resolve `fetch` per request rather than capturing it at creation.
      // Issue #160: the first get-session of a page may be answered from a
      // fresh cross-tab snapshot (see sessionSnapshot.ts).
      customFetchImpl: (input: RequestInfo | URL, init?: RequestInit) =>
        snapshotFetch(input, init),
      onSuccess: (context: { request: { url: unknown } }) => {
        notifySessionMutation(context.request.url);
      },
    },
  } as any) as unknown as AuthClient;
  return _client;
}

/** The app-wide session atom, or null where no Better Auth client exists. */
export function getAuthSessionAtom(): SessionAtom | null {
  const client = getClient() as unknown as {
    $store?: { atoms?: { session?: SessionAtom } };
  };
  return client.$store?.atoms?.session ?? null;
}

// On SSR there's no `window.location.origin`, so we can't construct a real
// client. Components that call `useSession()` during render get an empty
// session; the real client takes over after hydration. Mutating calls
// (signIn, signOut, …) only fire from event handlers, never during SSR,
// so we don't need to stub those — accessing them on SSR throws, which is
// what we want.
const SSR_STUB = {
  useSession: () => ({
    data: null,
    isPending: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
  signIn: {
    email: () =>
      Promise.reject(new Error("Auth client is unavailable during SSR")),
    social: () =>
      Promise.reject(new Error("Auth client is unavailable during SSR")),
  },
  signUp: {
    email: () =>
      Promise.reject(new Error("Auth client is unavailable during SSR")),
  },
  signOut: () =>
    Promise.reject(new Error("Auth client is unavailable during SSR")),
};

const betterAuthClient = new Proxy(
  {},
  {
    get(_target, prop) {
      return (getClient() as any)[prop as any];
    },
  },
) as AuthClient;

export default betterAuthClient;
