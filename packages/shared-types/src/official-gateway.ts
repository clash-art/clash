/**
 * Desktop Host handoff to the Clash official model gateway (#357).
 *
 * The Host mints a short-lived `sk_gw_` token from the signed-in cloud
 * credential and passes it to an ACP agent's gateway auth method. The raw
 * token stays in Host memory for the handoff only: it is never written to
 * disk and never returned to the renderer. The gateway error table in
 * `@clash/gateway-core` (`errors.ts`) is the source of every code below.
 */
import { z } from "zod";
import { lazySchema } from "./lazy-schema.js";

/** The Host-managed provider row; not a stored provider account. */
export const OFFICIAL_GATEWAY_PROVIDER_ID = "clash-official";
/** `providerName` handed to the ACP gateway auth method. */
export const OFFICIAL_GATEWAY_ACP_PROVIDER_NAME = "clash";

/** An ACP auth method that takes the gateway fields (baseUrl + api-key). */
export function isOfficialGatewayAuthMethod(
  method:
    | { form?: string; vars?: ReadonlyArray<{ name: string }> }
    | undefined,
): boolean {
  if (method?.form !== "fields") return false;
  const names = new Set((method.vars ?? []).map((variable) => variable.name));
  return names.has("baseUrl") && names.has("api-key");
}

/**
 * Which credential an agent harness uses first when both the user's own key
 * (BYOK, the harness's own sign-in) and the Clash official gateway are usable.
 */
export const AGENT_CREDENTIAL_PRIORITIES = [
  "byok-first",
  "official-first",
] as const;
export type AgentCredentialPriority =
  (typeof AGENT_CREDENTIAL_PRIORITIES)[number];
export const DEFAULT_AGENT_CREDENTIAL_PRIORITY: AgentCredentialPriority =
  "byok-first";

interface OfficialGatewayClientCodeDefinition {
  status: number;
  /** A fresh token can fix it: the Host re-mints and hands off again. */
  remint: boolean;
  message: string;
}

const clientCodes = {
  GATEWAY_AUTH_REQUIRED: {
    status: 401,
    remint: true,
    message:
      "Sign in to your Clash account to use the Clash official provider.",
  },
  GATEWAY_TOKEN_EXPIRED: {
    status: 401,
    remint: true,
    message:
      "The Clash gateway token expired. Clash is minting a new one; send your message again.",
  },
  GATEWAY_TOKEN_REVOKED: {
    status: 401,
    remint: true,
    message:
      "The Clash gateway token was revoked. Clash is minting a new one; send your message again.",
  },
  GATEWAY_MODEL_NOT_ALLOWED: {
    status: 403,
    remint: false,
    message:
      "This model is not available to your Clash official provider token. Choose another model.",
  },
  GATEWAY_BUDGET_EXCEEDED: {
    status: 402,
    remint: false,
    message:
      "Your Clash credits for this request are used up. Top up, or ask your team owner for more budget.",
  },
  GATEWAY_CAPABILITY_UNAVAILABLE: {
    status: 501,
    remint: false,
    message:
      "This agent has no gateway sign-in method, so it cannot use the Clash official provider.",
  },
} as const satisfies Record<string, OfficialGatewayClientCodeDefinition>;

export type OfficialGatewayClientCode = keyof typeof clientCodes;
export const OFFICIAL_GATEWAY_CLIENT_CODES: Readonly<
  Record<OfficialGatewayClientCode, Readonly<OfficialGatewayClientCodeDefinition>>
> = clientCodes;

export function isOfficialGatewayClientCode(
  value: unknown,
): value is OfficialGatewayClientCode {
  return typeof value === "string" && Object.hasOwn(clientCodes, value);
}

const CODE_PATTERN = /\bGATEWAY_[A-Z_]+\b/g;

/** The first official-gateway client code named in an agent's error text. */
export function officialGatewayCodeIn(
  text: string,
): OfficialGatewayClientCode | null {
  for (const match of text.matchAll(CODE_PATTERN))
    if (isOfficialGatewayClientCode(match[0])) return match[0];
  return null;
}

/** `CODE: message`, the text an agent session shows for a coded failure. */
export function officialGatewayErrorText(code: OfficialGatewayClientCode): string {
  return `${code}: ${clientCodes[code].message}`;
}

export let OfficialGatewayStatusSchema = lazySchema(() => (
z.object({
  providerId: z.literal(OFFICIAL_GATEWAY_PROVIDER_ID),
  serviceUrl: z.string().url(),
  signedIn: z.boolean(),
  user: z.object({ email: z.string(), name: z.string() }).nullable(),
  priority: z.enum(AGENT_CREDENTIAL_PRIORITIES),
  /** Latest expiry over the harness handoffs; the token itself is never exposed. */
  token: z.object({
    state: z.enum(["none", "active", "expired"]),
    expiresAt: z.string().nullable(),
  }),
  handoffs: z.array(
    z.object({
      harnessId: z.string(),
      methodId: z.string(),
      expiresAt: z.string(),
    }),
  ),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
})
), (real) => { OfficialGatewayStatusSchema = real; });
export type OfficialGatewayStatus = z.infer<typeof OfficialGatewayStatusSchema>;

export let UpdateOfficialGatewayRequestSchema = lazySchema(() => (
z.object({ priority: z.enum(AGENT_CREDENTIAL_PRIORITIES) }).strict()
), (real) => { UpdateOfficialGatewayRequestSchema = real; });

/** `POST /api/v1/gateway/tokens` 201 body, as far as the Host reads it. */
export let MintedGatewayTokenSchema = lazySchema(() => (
z.object({
  token: z.string().startsWith("sk_gw_"),
  expiresAt: z.string().datetime(),
  baseUrl: z.string().url(),
  keyId: z.string().min(1),
})
), (real) => { MintedGatewayTokenSchema = real; });

/** `POST /api/v1/gateway/tokens/:id/renew` 200 body. */
export let RenewedGatewayTokenSchema = lazySchema(() => (
z.object({ keyId: z.string().min(1), expiresAt: z.string().datetime() })
), (real) => { RenewedGatewayTokenSchema = real; });
