/**
 * Clash official provider on the desktop Host (#357).
 *
 * The Host mints a short-lived `sk_gw_` gateway token with the signed-in
 * cloud credential (`POST <service>/api/v1/gateway/tokens`) and passes it to
 * an ACP agent's gateway auth method. The raw token lives in memory only
 * until that handoff: it is never written to disk and never sent to the
 * renderer. What is persisted is non-secret: the user's credential priority
 * and, per harness, the handed-off key id and expiry so the Host can renew
 * or re-mint it.
 *
 * Signed out or offline, there is no fallback to any platform key: the
 * official path fails with GATEWAY_AUTH_REQUIRED.
 */
import {
  DEFAULT_AGENT_CREDENTIAL_PRIORITY,
  MintedGatewayTokenSchema,
  OFFICIAL_GATEWAY_ACP_PROVIDER_NAME,
  OFFICIAL_GATEWAY_CLIENT_CODES,
  OFFICIAL_GATEWAY_PROVIDER_ID,
  RenewedGatewayTokenSchema,
  isOfficialGatewayAuthMethod,
  isOfficialGatewayClientCode,
  type AgentCredentialPriority,
  type OfficialGatewayClientCode,
  type OfficialGatewayStatus,
} from "@clash/shared-types";
import { cloudOrigin, createCloudAccounts } from "./cloud-accounts.js";
import { createSqliteLocalConfigStore } from "./local-config-store.js";
import type { LocalAcpHarness, LocalAcpHarnessAuth } from "./local-acp.js";

const STATE_KEY = "official_gateway";
/** A handoff this close to expiry is renewed (or re-minted) before a session starts. */
export const OFFICIAL_GATEWAY_REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class OfficialGatewayError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;

  constructor(
    code: string,
    options: { status?: number; message?: string; reason?: string } = {},
  ) {
    const known = isOfficialGatewayClientCode(code)
      ? OFFICIAL_GATEWAY_CLIENT_CODES[code]
      : null;
    super(options.message ?? known?.message ?? "The Clash gateway failed.");
    this.name = "OfficialGatewayError";
    this.code = code;
    this.status = options.status ?? known?.status ?? 502;
    if (options.reason) this.reason = options.reason;
  }
}

function authRequired(reason: string, message?: string) {
  return new OfficialGatewayError("GATEWAY_AUTH_REQUIRED", {
    reason,
    ...(message ? { message } : {}),
  });
}

export function gatewayAuthMethodId(
  auth: Pick<LocalAcpHarnessAuth, "methods"> | undefined,
): string | null {
  return auth?.methods?.find(isOfficialGatewayAuthMethod)?.id ?? null;
}

export type AgentCredentialDecision =
  | { action: "keep" }
  | { action: "handoff"; methodId: string }
  | { action: "refresh" }
  | { action: "auth-required" };

/**
 * What the Host does for a harness before a session starts.
 *
 * - An existing official handoff is kept fresh whatever the priority: the
 *   user chose it, and authenticating with anything else removes it.
 * - `official-first` hands off whenever the user is signed in, replacing the
 *   harness's own credential; signed out, the harness's own credential is
 *   used if it has one, otherwise GATEWAY_AUTH_REQUIRED.
 * - `byok-first` keeps the harness's own credential and hands off only when
 *   the harness has none.
 */
export function decideAgentCredential(input: {
  priority: AgentCredentialPriority;
  signedIn: boolean;
  gatewayMethodId: string | null;
  authStatus: LocalAcpHarnessAuth["status"] | undefined;
  handoff: { expiresAt: number } | null;
  now: number;
}): AgentCredentialDecision {
  if (input.handoff) {
    if (!input.signedIn) return { action: "auth-required" };
    return input.handoff.expiresAt - input.now <=
      OFFICIAL_GATEWAY_REFRESH_MARGIN_MS
      ? { action: "refresh" }
      : { action: "keep" };
  }
  if (!input.gatewayMethodId) return { action: "keep" };
  const needsAuth = input.authStatus === "needs-auth";
  if (input.priority === "official-first") {
    if (input.signedIn)
      return { action: "handoff", methodId: input.gatewayMethodId };
    return needsAuth ? { action: "auth-required" } : { action: "keep" };
  }
  return needsAuth && input.signedIn
    ? { action: "handoff", methodId: input.gatewayMethodId }
    : { action: "keep" };
}

interface HandoffRecord {
  methodId: string;
  keyId: string;
  /** ISO 8601. */
  expiresAt: string;
  serviceUrl: string;
}

interface PersistedState {
  priority: AgentCredentialPriority;
  handoffs: Record<string, HandoffRecord>;
}

function normalizeState(value: unknown): PersistedState {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const priority =
    raw.priority === "official-first" || raw.priority === "byok-first"
      ? raw.priority
      : DEFAULT_AGENT_CREDENTIAL_PRIORITY;
  const handoffs: Record<string, HandoffRecord> = {};
  if (raw.handoffs && typeof raw.handoffs === "object") {
    for (const [harnessId, record] of Object.entries(raw.handoffs)) {
      const r = record as Partial<HandoffRecord> | null;
      if (
        typeof r?.methodId === "string" &&
        typeof r.keyId === "string" &&
        typeof r.expiresAt === "string" &&
        Number.isFinite(Date.parse(r.expiresAt)) &&
        typeof r.serviceUrl === "string"
      )
        handoffs[harnessId] = {
          methodId: r.methodId,
          keyId: r.keyId,
          expiresAt: r.expiresAt,
          serviceUrl: r.serviceUrl,
        };
    }
  }
  return { priority, handoffs };
}

/** The adapter surface the handoff drives (`LocalAcpAdapter`). */
export interface OfficialGatewayHarnessPort {
  listHarnesses?(opts?: {
    probe?: boolean | "auth" | "config" | "none";
  }): Promise<{ harnesses: LocalAcpHarness[] }>;
  authenticateHarness?(
    id: string,
    options?: { methodId?: string; values?: Record<string, string> },
  ): Promise<{ harnesses: LocalAcpHarness[] }>;
}

/** Hooks `LocalAcpAdapter` calls around agent sessions. */
export interface OfficialGatewaySessionHook {
  /** Renew, re-mint or hand off before a session starts; never throws. */
  prepareSession(agent: {
    id: string;
    auth?: LocalAcpHarnessAuth;
  }): Promise<{ gatewayCode?: OfficialGatewayClientCode; handedOff?: boolean }>;
  /** Whether this harness currently runs on an official handoff. */
  hasHandoff(harnessId: string): boolean;
  /**
   * A session reported a gateway 401: mint a new token and hand it off again.
   * Resolves null when the agent now has a fresh token, otherwise the code
   * that stops it (GATEWAY_AUTH_REQUIRED when signed out or offline).
   */
  onUnauthorized(harnessId: string): Promise<OfficialGatewayClientCode | null>;
}

interface MintedToken {
  token: string;
  keyId: string;
  expiresAt: number;
  baseUrl: string;
  serviceUrl: string;
}

export interface OfficialGatewayOptions {
  dataDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export function createOfficialGateway(options: OfficialGatewayOptions) {
  const accounts = createCloudAccounts(options.dataDir);
  const store = createSqliteLocalConfigStore(options.dataDir);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  let harnesses: OfficialGatewayHarnessPort | null = null;
  /** Minted at sign-in for the next handoff; memory only. */
  let pending: MintedToken | null = null;
  let lastError: { code: string; message: string } | null = null;
  /** Mirror of the persisted handoff ids for the synchronous session check. */
  let handoffIds = new Set<string>();
  const inFlight = new Map<string, Promise<unknown>>();
  let stateQueue: Promise<unknown> = Promise.resolve();

  const loadState = async () => {
    const state = normalizeState(await store.getJson(STATE_KEY));
    handoffIds = new Set(Object.keys(state.handoffs));
    return state;
  };
  const updateState = (update: (state: PersistedState) => void) => {
    const next = stateQueue.then(async () => {
      const state = await loadState();
      update(state);
      await store.setJson(STATE_KEY, state);
      handoffIds = new Set(Object.keys(state.handoffs));
      return state;
    });
    stateQueue = next.catch(() => undefined);
    return next;
  };
  const ready = loadState().catch(() => undefined);

  const request = (url: string, init: RequestInit) =>
    fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

  async function signedInCredential(): Promise<{
    serviceUrl: string;
    token: string;
  }> {
    const status = await accounts.status();
    const token = status.user
      ? await accounts.token(status.serviceUrl)
      : undefined;
    if (!token) throw authRequired("signed_out");
    return { serviceUrl: status.serviceUrl, token };
  }

  async function codedFailure(response: Response): Promise<OfficialGatewayError> {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    const headerCode = response.headers.get("x-clash-error-code");
    const code =
      headerCode && /^GATEWAY_[A-Z_]+$/.test(headerCode)
        ? headerCode
        : typeof body?.error?.code === "string" &&
            /^GATEWAY_[A-Z_]+$/.test(body.error.code)
          ? body.error.code
          : "GATEWAY_INTERNAL";
    // A renewed key past its expiry; anything else at 401 is the sign-in itself.
    if (
      response.status === 401 &&
      code !== "GATEWAY_TOKEN_EXPIRED" &&
      code !== "GATEWAY_TOKEN_REVOKED"
    )
      return authRequired(
        "session_rejected",
        "Your Clash sign-in is no longer valid. Sign in again to use the Clash official provider.",
      );
    return new OfficialGatewayError(code, {
      status: response.status,
      ...(typeof body?.error?.message === "string"
        ? { message: body.error.message }
        : {}),
    });
  }

  async function send(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    try {
      return await request(url, init);
    } catch {
      throw authRequired(
        "offline",
        "Clash could not reach your Clash service to get a gateway token. Check your connection and try again.",
      );
    }
  }

  async function mint(): Promise<MintedToken> {
    const credential = await signedInCredential();
    const response = await send(
      `${credential.serviceUrl}/api/v1/gateway/tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    if (!response.ok) throw await codedFailure(response);
    const parsed = MintedGatewayTokenSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success)
      throw new OfficialGatewayError("GATEWAY_INTERNAL", {
        status: 502,
        message: "The Clash service answered the token request unexpectedly.",
      });
    return {
      token: parsed.data.token,
      keyId: parsed.data.keyId,
      expiresAt: Date.parse(parsed.data.expiresAt),
      baseUrl: parsed.data.baseUrl.replace(/\/+$/, ""),
      serviceUrl: credential.serviceUrl,
    };
  }

  async function revoke(serviceUrl: string, keyIds: string[]) {
    if (keyIds.length === 0) return;
    const token = await accounts.token(serviceUrl).catch(() => undefined);
    if (!token) return;
    await Promise.allSettled(
      keyIds.map((keyId) =>
        request(
          `${serviceUrl}/api/v1/gateway/tokens/${encodeURIComponent(keyId)}`,
          { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        ),
      ),
    );
  }

  /** The pre-minted sign-in token if it is still fresh, else a new one. */
  async function takeToken(): Promise<MintedToken> {
    const candidate = pending;
    pending = null;
    if (candidate) {
      const current = await accounts.status();
      if (
        candidate.serviceUrl === current.serviceUrl &&
        current.user &&
        candidate.expiresAt - now() > OFFICIAL_GATEWAY_REFRESH_MARGIN_MS
      )
        return candidate;
    }
    return mint();
  }

  function remember(error: unknown): OfficialGatewayError {
    const coded =
      error instanceof OfficialGatewayError
        ? error
        : new OfficialGatewayError("GATEWAY_INTERNAL", {
            message:
              error instanceof Error ? error.message : "The Clash gateway failed.",
          });
    lastError = { code: coded.code, message: coded.message };
    log("official_gateway.failed", {
      code: coded.code,
      ...(coded.reason ? { reason: coded.reason } : {}),
    });
    return coded;
  }

  function requirePort() {
    if (!harnesses?.authenticateHarness)
      throw new OfficialGatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
        status: 404,
        message: "Local agent harnesses are unavailable on this Host.",
      });
    return harnesses as Required<Pick<OfficialGatewayHarnessPort, "authenticateHarness">> &
      OfficialGatewayHarnessPort;
  }

  async function resolveMethodId(harnessId: string, methodId?: string) {
    const port = requirePort();
    const listed = port.listHarnesses
      ? (await port.listHarnesses({ probe: "none" })).harnesses.find(
          (harness) => harness.id === harnessId,
        )
      : undefined;
    const methods = listed?.auth?.methods;
    if (methodId) {
      const method = methods?.find((candidate) => candidate.id === methodId);
      if (method && !isOfficialGatewayAuthMethod(method))
        throw new OfficialGatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
          status: 400,
        });
      return methodId;
    }
    const found = gatewayAuthMethodId(listed?.auth);
    if (!found)
      throw new OfficialGatewayError("GATEWAY_CAPABILITY_UNAVAILABLE", {
        status: 400,
      });
    return found;
  }

  /** Mint (or take the sign-in token) and pass it to the harness's gateway auth. */
  async function handoffNow(harnessId: string, methodId: string) {
    const port = requirePort();
    const minted = await takeToken();
    let result: { harnesses: LocalAcpHarness[] };
    try {
      result = await port.authenticateHarness(harnessId, {
        methodId,
        values: {
          baseUrl: `${minted.baseUrl}/v1`,
          "api-key": minted.token,
          providerName: OFFICIAL_GATEWAY_ACP_PROVIDER_NAME,
        },
      });
    } catch (error) {
      // The agent never took it: do not leave a live token behind, and never
      // let an agent's error text echo it.
      void revoke(minted.serviceUrl, [minted.keyId]);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.split(minted.token).join("[redacted]"));
    }
    await updateState((state) => {
      state.handoffs[harnessId] = {
        methodId,
        keyId: minted.keyId,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        serviceUrl: minted.serviceUrl,
      };
    });
    lastError = null;
    log("official_gateway.handoff", { harnessId, keyId: minted.keyId });
    return result;
  }

  /** One handoff/refresh per harness at a time. */
  function single<T>(harnessId: string, run: () => Promise<T>): Promise<T> {
    const running = inFlight.get(harnessId) as Promise<T> | undefined;
    if (running) return running;
    const next = run().finally(() => inFlight.delete(harnessId));
    inFlight.set(harnessId, next);
    return next;
  }

  async function renew(harnessId: string, record: HandoffRecord) {
    const credential = await signedInCredential();
    if (credential.serviceUrl !== record.serviceUrl)
      throw authRequired("service_changed");
    const response = await send(
      `${record.serviceUrl}/api/v1/gateway/tokens/${encodeURIComponent(record.keyId)}/renew`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${credential.token}` },
      },
    );
    if (!response.ok) throw await codedFailure(response);
    const parsed = RenewedGatewayTokenSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success)
      throw new OfficialGatewayError("GATEWAY_INTERNAL", { status: 502 });
    await updateState((state) => {
      const current = state.handoffs[harnessId];
      if (current?.keyId === record.keyId)
        current.expiresAt = parsed.data.expiresAt;
    });
  }

  /**
   * Renew the handed-off token; an expired or revoked one is re-minted.
   * Resolves true only when the agent received a new token.
   */
  async function refresh(harnessId: string, record: HandoffRecord) {
    try {
      await renew(harnessId, record);
      return false;
    } catch (error) {
      const coded = error instanceof OfficialGatewayError ? error : null;
      // Offline: the current token may still be valid; keep it.
      if (coded?.reason === "offline" || coded?.reason === "signed_out")
        throw error;
      await handoffNow(harnessId, record.methodId);
      return true;
    }
  }

  const sessionHook: OfficialGatewaySessionHook = {
    async prepareSession(agent) {
      await ready;
      try {
        const state = await loadState();
        const cloud = await accounts.status();
        const record = state.handoffs[agent.id] ?? null;
        const signedIn = Boolean(
          cloud.user && (await accounts.token(cloud.serviceUrl)),
        );
        const decision = decideAgentCredential({
          priority: state.priority,
          signedIn,
          gatewayMethodId: gatewayAuthMethodId(agent.auth),
          authStatus: agent.auth?.status,
          handoff:
            record && record.serviceUrl === cloud.serviceUrl
              ? { expiresAt: Date.parse(record.expiresAt) }
              : record
                ? { expiresAt: 0 }
                : null,
          now: now(),
        });
        switch (decision.action) {
          case "keep":
            return {};
          case "auth-required":
            return { gatewayCode: "GATEWAY_AUTH_REQUIRED" };
          case "handoff":
            await single(agent.id, () =>
              handoffNow(agent.id, decision.methodId),
            );
            return { handedOff: true };
          case "refresh":
            return (await single(agent.id, () => refresh(agent.id, record!)))
              ? { handedOff: true }
              : {};
        }
      } catch (error) {
        const coded = remember(error);
        return isOfficialGatewayClientCode(coded.code)
          ? { gatewayCode: coded.code }
          : {};
      }
    },
    hasHandoff(harnessId) {
      return handoffIds.has(harnessId);
    },
    async onUnauthorized(harnessId) {
      await ready;
      try {
        const state = await loadState();
        const record = state.handoffs[harnessId];
        if (!record) return "GATEWAY_AUTH_REQUIRED";
        await single(harnessId, () => handoffNow(harnessId, record.methodId));
        return null;
      } catch (error) {
        const coded = remember(error);
        return isOfficialGatewayClientCode(coded.code)
          ? coded.code
          : "GATEWAY_AUTH_REQUIRED";
      }
    },
  };

  return {
    sessionHook,
    attachHarnesses(port: OfficialGatewayHarnessPort) {
      harnesses = port;
    },
    async status(): Promise<OfficialGatewayStatus> {
      const [state, cloud] = await Promise.all([loadState(), accounts.status()]);
      const signedIn = Boolean(
        cloud.user && (await accounts.token(cloud.serviceUrl)),
      );
      const handoffs = Object.entries(state.handoffs)
        .filter(([, record]) => record.serviceUrl === cloud.serviceUrl)
        .map(([harnessId, record]) => ({
          harnessId,
          methodId: record.methodId,
          expiresAt: record.expiresAt,
        }));
      const expiries = [
        ...handoffs.map((handoff) => Date.parse(handoff.expiresAt)),
        ...(pending && pending.serviceUrl === cloud.serviceUrl
          ? [pending.expiresAt]
          : []),
      ];
      const latest = expiries.length > 0 ? Math.max(...expiries) : null;
      return {
        providerId: OFFICIAL_GATEWAY_PROVIDER_ID,
        serviceUrl: cloud.serviceUrl,
        signedIn,
        user: signedIn && cloud.user
          ? { email: cloud.user.email, name: cloud.user.name }
          : null,
        priority: state.priority,
        token: {
          state:
            latest === null ? "none" : latest > now() ? "active" : "expired",
          expiresAt: latest === null ? null : new Date(latest).toISOString(),
        },
        handoffs,
        lastError,
      };
    },
    async setPriority(priority: AgentCredentialPriority) {
      await updateState((state) => {
        state.priority = priority;
      });
    },
    /** User-chosen handoff (Settings or the agent auth dialog). */
    async handoff(harnessId: string, methodId?: string) {
      try {
        const resolved = await resolveMethodId(harnessId, methodId);
        return await single(harnessId, () => handoffNow(harnessId, resolved));
      } catch (error) {
        throw remember(error);
      }
    },
    /** The harness was authenticated with the user's own credential. */
    async forgetHandoff(harnessId: string) {
      await ready;
      if (!handoffIds.has(harnessId)) return;
      await updateState((current) => {
        delete current.handoffs[harnessId];
      });
    },
    /** Mint on sign-in so the first handoff is ready and problems show early. */
    async onSignedIn(serviceUrl: string) {
      try {
        const minted = await mint();
        if (minted.serviceUrl !== cloudOrigin(serviceUrl)) return;
        if (pending) void revoke(pending.serviceUrl, [pending.keyId]);
        pending = minted;
        lastError = null;
      } catch (error) {
        remember(error);
      }
    },
    /** Before the cloud credential is dropped: revoke what it minted. */
    async onSignedOut(serviceUrl: string) {
      const origin = cloudOrigin(serviceUrl);
      let keyIds: string[] = [];
      await updateState((state) => {
        for (const [harnessId, record] of Object.entries(state.handoffs)) {
          if (record.serviceUrl !== origin) continue;
          keyIds.push(record.keyId);
          delete state.handoffs[harnessId];
        }
      }).catch(() => undefined);
      if (pending?.serviceUrl === origin) {
        keyIds = [...keyIds, pending.keyId];
        pending = null;
      }
      await revoke(origin, keyIds);
      lastError = null;
    },
  };
}

export type OfficialGateway = ReturnType<typeof createOfficialGateway>;
