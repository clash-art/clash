import { randomUUID } from "node:crypto";
import { CloudServiceSchema, CloudAccountSchema } from "@clash/shared-types";
import {
  authorizationUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  runLoopbackFlow,
} from "./auth-flow.js";
import { cloudOrigin, createCloudAccounts } from "./cloud-accounts.js";

type LoginStatus = {
  id: string;
  serviceUrl: string;
  authorizationUrl: string;
  state: "pending" | "succeeded" | "failed" | "cancelled";
  error?: string;
};
export function createCloudLogin(options: {
  dataDir: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}) {
  const accounts = createCloudAccounts(options.dataDir);
  const fetcher = options.fetch ?? fetch;
  let active: { status: LoginStatus; cancel: () => void } | undefined;
  const request: typeof fetch = (url, init) =>
    fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  return {
    async start(value: string) {
      const serviceUrl = cloudOrigin(value);
      const response = await request(serviceUrl + "/api/v1/cloud");
      if (!response.ok)
        throw Error(`Cloud service discovery failed (HTTP ${response.status})`);
      const parsed = CloudServiceSchema.safeParse(await response.json());
      if (!parsed.success)
        throw Error(
          "This service does not support Clash browser sign-in. Update the self-hosted service.",
        );
      active?.cancel();
      await accounts.select(serviceUrl);
      const pkce = await createPkcePair();
      const flow = runLoopbackFlow({
        open: () => {},
        timeoutMs: options.timeoutMs,
      });
      // Attach a handler before binding completes so cancellation cannot reject unobserved.
      void flow.result.catch(() => {});
      const started = await flow.started;
      const status: LoginStatus = {
        id: randomUUID(),
        serviceUrl,
        state: "pending",
        authorizationUrl: authorizationUrl({
          open: serviceUrl + parsed.data.auth.authorizationPath,
          clientId: parsed.data.auth.clientId,
          redirectUri: started.redirectUri,
          state: started.state,
          challenge: pkce.challenge,
        }),
      };
      const entry = {
        status,
        cancel: () => {
          if (status.state === "pending") {
            status.state = "cancelled";
            flow.cancel();
          }
        },
      };
      active = entry;
      void (async () => {
        try {
          const callback = await flow.result;
          if (callback.error || !callback.code)
            throw Error("Authorization was not granted");
          const token = await exchangeAuthorizationCode({
            tokenUrl: serviceUrl + parsed.data.auth.tokenPath,
            clientId: parsed.data.auth.clientId,
            code: callback.code,
            verifier: pkce.verifier,
            redirectUri: started.redirectUri,
            fetch: request,
          });
          const accountResponse = await request(
            serviceUrl + "/api/v1/cloud/account",
            { headers: { authorization: `Bearer ${token.accessToken}` } },
          );
          if (!accountResponse.ok)
            throw Error("Could not verify cloud account");
          const identity = CloudAccountSchema.parse(
            await accountResponse.json(),
          );
          if (active !== entry || status.state !== "pending") return;
          await accounts.save(
            serviceUrl,
            { token: token.accessToken, user: identity.user },
            () => active === entry && status.state === "pending",
          );
          if (active === entry && status.state === "pending")
            status.state = "succeeded";
        } catch {
          if (status.state === "pending") {
            status.state = "failed";
            status.error = "Sign-in did not complete. Please try again.";
          }
        }
      })();
      return { ...status };
    },
    status(id: string) {
      if (active?.status.id !== id) throw Error("Sign-in session not found");
      return { ...active.status };
    },
    cancel() {
      active?.cancel();
    },
    close() {
      active?.cancel();
    },
  };
}
