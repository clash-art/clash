import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import betterAuthClient from "@clash/web-ui/lib/betterAuthClient";
import Background from "@clash/gui/components/Background";
import { Button } from "@clash/gui/components/ui/button";
import { InlineAlert } from "@clash/gui/components/ui/feedback";

export type CliAuthorizationParams = {
  response_type: "code";
  client_id: "clash-cli";
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  state: string;
};

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const OAUTH_STATE = /^[A-Za-z0-9._~-]{32,128}$/;

function isLoopbackCallback(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port !== "" &&
      url.pathname === "/callback" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function parseCliAuthorizationParams(
  params: URLSearchParams,
): CliAuthorizationParams {
  const responseType = params.get("response_type") ?? "";
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const codeChallengeMethod = params.get("code_challenge_method") ?? "";
  const state = params.get("state") ?? "";
  if (
    responseType !== "code" ||
    clientId !== "clash-cli" ||
    codeChallengeMethod !== "S256" ||
    !PKCE_CHALLENGE.test(codeChallenge) ||
    !OAUTH_STATE.test(state) ||
    !isLoopbackCallback(redirectUri)
  ) {
    throw new Error("Invalid CLI authorization request.");
  }
  return {
    response_type: "code",
    client_id: "clash-cli",
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  };
}

function validateAuthorizationRedirect(
  request: CliAuthorizationParams,
  redirectUri: string,
): string {
  const expected = new URL(request.redirect_uri);
  const actual = new URL(redirectUri);
  const keys = [...actual.searchParams.keys()].sort();
  const code = actual.searchParams.get("code") ?? "";
  if (
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.username !== "" ||
    actual.password !== "" ||
    actual.hash !== "" ||
    keys.length !== 2 ||
    keys[0] !== "code" ||
    keys[1] !== "state" ||
    !/^[A-Za-z0-9_-]{8,512}$/.test(code) ||
    actual.searchParams.get("state") !== request.state
  ) {
    throw new Error("Authorization server returned an invalid callback.");
  }
  return actual.toString();
}

export async function requestCliAuthorization(
  request: CliAuthorizationParams,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl("/api/v1/cli-auth/authorize", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : "authorization_failed";
    throw new Error(`Authorization failed (${error}).`);
  }
  const redirectUri =
    body && typeof body === "object" && "redirect_uri" in body
      ? (body as { redirect_uri: unknown }).redirect_uri
      : null;
  if (typeof redirectUri !== "string") {
    throw new Error("Authorization server omitted the callback.");
  }
  return validateAuthorizationRedirect(request, redirectUri);
}

const authPanelClass =
  "clash-auth-panel w-full max-w-sm rounded-[28px] px-6 py-7 text-center sm:px-8 sm:py-8";
const authPrimaryClass =
  "clash-auth-primary mt-4 inline-flex min-h-11 items-center justify-center rounded-2xl px-6 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-warm-page";

export default function AuthCliRoute() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = params.toString();
  const authorization = useMemo(() => {
    try {
      return {
        request: parseCliAuthorizationParams(new URLSearchParams(query)),
        error: null,
      };
    } catch (error) {
      return {
        request: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [query]);
  const [status, setStatus] = useState<
    "loading" | "signin" | "authorizing" | "error"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const session = betterAuthClient.useSession();

  useEffect(() => {
    if (!authorization.request) {
      setError(authorization.error);
      setStatus("error");
      return;
    }
    if (session.isPending) return;
    if (!session.data?.user) {
      setStatus("signin");
      return;
    }
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        setStatus("authorizing");
        const redirect = await requestCliAuthorization(authorization.request);
        window.location.replace(redirect);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      }
    })();
  }, [
    authorization.error,
    authorization.request,
    session.data?.user,
    session.isPending,
  ]);

  return (
    <div className="relative min-h-screen bg-warm-page">
      <Background />
      <div className="relative z-10 flex min-h-screen items-center justify-center p-8 text-center">
        <div className={authPanelClass}>
          <h1 className="mb-2 font-display text-xl font-semibold tracking-tight text-slate-950">
            Connect to Clash
          </h1>
          {status === "loading" && (
            <p className="text-sm text-stone-500">Loading...</p>
          )}
          {status === "signin" && (
            <Button
              variant="primary"
              className={authPrimaryClass}
              onClick={() =>
                navigate("/login?returnTo=" + encodeURIComponent(window.location.pathname + window.location.search))
              }
            >
              Sign in to Clash
            </Button>
          )}
          {status === "authorizing" && (
            <p className="text-sm text-stone-500">
              Creating authorization code...
            </p>
          )}
          {status === "error" && (
            <InlineAlert
              tone="error"
              title="Could not authorize CLI"
              message={<span className="break-words font-mono text-xs">{error}</span>}
              className="mt-4 text-left"
            />
          )}
        </div>
      </div>
    </div>
  );
}
