import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  AGENT_CREDENTIAL_PRIORITIES,
  OFFICIAL_CLOUD_URL,
  type AgentCredentialPriority,
  type OfficialGatewayStatus,
} from "@clash/shared-types";
import { runtimeApiUrl } from "../lib/runtimeConfig";
import { isBillingPluginEnabled } from "../lib/consolePlugins";
import { canOpenExternalUrl, openExternalUrl } from "../lib/openExternalUrl";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { InlineAlert } from "./ui/feedback";
import { SettingsRow } from "./SettingsPrimitives";

/** Hosted Polar billing UI — in-app when the plugin is registered; system browser on desktop. */
const OFFICIAL_BILLING_URL = `${OFFICIAL_CLOUD_URL}/billing`;

const STATUS_PATH = "/api/v1/local/official-gateway";

/** A Host error body: `{ error, code? }`; coded failures read `CODE: message`. */
export async function officialGatewayResponseError(
  response: Response,
): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    code?: unknown;
  } | null;
  const message =
    typeof body?.error === "string"
      ? body.error
      : `HTTP ${response.status}`;
  return new Error(
    typeof body?.code === "string" && body.code.startsWith("GATEWAY_")
      ? `${body.code}: ${message}`
      : message,
  );
}

async function gatewayRequest(init?: RequestInit) {
  const response = await fetch(runtimeApiUrl(STATUS_PATH), {
    credentials: "include",
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!response.ok) throw await officialGatewayResponseError(response);
  return (await response.json()) as OfficialGatewayStatus;
}

const PRIORITY_COPY: Record<
  AgentCredentialPriority,
  { title: string; description: string }
> = {
  "byok-first": {
    title: "Your own keys first",
    description:
      "Agents keep the sign-in or API key you gave them. Clash official is used only by agents that have none.",
  },
  "official-first": {
    title: "Clash official first",
    description:
      "While you are signed in, agents with a gateway sign-in method use Clash official, billed to your Clash credits.",
  },
};

function isPriority(value: string): value is AgentCredentialPriority {
  return (AGENT_CREDENTIAL_PRIORITIES as readonly string[]).includes(value);
}

function tokenLabel(token: OfficialGatewayStatus["token"]): string {
  if (token.state === "none" || !token.expiresAt) return "No gateway key yet";
  const time = new Date(token.expiresAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return token.state === "active"
    ? `Gateway key active until ${time}`
    : "Gateway key expired; a new one is minted when an agent starts";
}

/**
 * The Host-managed Clash official provider (#357). It is not a stored
 * provider account: the Host mints short-lived gateway keys from the cloud
 * sign-in and hands them to local agents, so this row shows status and the
 * user's BYOK/official priority only. Keys are never shown.
 */
function budgetTopUpAction() {
  // Hosted web (billing plugin overlaid): stay in-app on /billing.
  if (isBillingPluginEnabled()) {
    return (
      <Link
        to="/billing"
        className="text-sm font-medium underline underline-offset-2"
      >
        Top up credits
      </Link>
    );
  }
  // Desktop client: OSS build has no billing plugin — jump to hosted checkout
  // in the system browser (same openExternal path as CloudConnection login).
  if (canOpenExternalUrl()) {
    return (
      <button
        type="button"
        className="text-sm font-medium underline underline-offset-2"
        onClick={() => {
          void openExternalUrl(OFFICIAL_BILLING_URL);
        }}
      >
        Top up credits
      </button>
    );
  }
  return undefined;
}

export function OfficialGatewayProviderRow() {
  const [status, setStatus] = useState<OfficialGatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus(await gatewayRequest());
  }, []);
  useEffect(() => {
    let active = true;
    void gatewayRequest()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);

  const updatePriority = async (priority: AgentCredentialPriority) => {
    if (!status || priority === status.priority) return;
    const previous = status;
    setStatus({ ...status, priority });
    setSaving(true);
    setError(null);
    try {
      setStatus(
        await gatewayRequest({
          method: "PATCH",
          body: JSON.stringify({ priority }),
        }),
      );
    } catch (e) {
      setStatus(previous);
      setError(e instanceof Error ? e.message : String(e));
      await load().catch(() => undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow
      as="section"
      aria-labelledby="official-gateway-heading"
      className="space-y-3 px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id="official-gateway-heading"
            className="text-sm font-semibold text-foreground"
          >
            Clash official
          </h3>
          <p className="text-xs text-muted-foreground">
            Clash-hosted models for local agents, billed to your Clash credits.
            Clash gives agents short-lived keys and never shows or saves them.
          </p>
        </div>
        {status ? (
          status.signedIn ? (
            <div className="flex flex-col items-end gap-1 text-right">
              <span role="status" className="text-sm text-muted-foreground">
                Signed in as {status.user?.name || status.user?.email}
              </span>
              {/* Desktop has no billing plugin; offer hosted Polar checkout via system browser. */}
              {!isBillingPluginEnabled() && canOpenExternalUrl() ? (
                <button
                  type="button"
                  className="text-sm font-medium text-brand hover:underline"
                  onClick={() => {
                    void openExternalUrl(OFFICIAL_BILLING_URL);
                  }}
                >
                  Top up credits
                </button>
              ) : null}
            </div>
          ) : (
            <Link
              to="/settings?section=sync"
              className="text-sm font-medium text-brand hover:underline"
            >
              Sign in to use Clash official
            </Link>
          )
        ) : null}
      </div>
      {status ? (
        <>
          {status.signedIn ? (
            <p className="text-xs text-muted-foreground">
              {tokenLabel(status.token)}
              {status.handoffs.length > 0
                ? ` · Used by ${status.handoffs.map((handoff) => handoff.harnessId).join(", ")}`
                : ""}
            </p>
          ) : null}
          <RadioGroup
            aria-label="Agent credential priority"
            value={status.priority}
            disabled={saving}
            onValueChange={(value) => {
              if (isPriority(value)) void updatePriority(value);
            }}
            className="sm:grid-cols-2"
          >
            {AGENT_CREDENTIAL_PRIORITIES.map((priority) => (
              <RadioGroupItem key={priority} value={priority}>
                <span className="block text-sm font-medium text-foreground">
                  {PRIORITY_COPY[priority].title}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {PRIORITY_COPY[priority].description}
                </span>
              </RadioGroupItem>
            ))}
          </RadioGroup>
          {status.lastError ? (
            <InlineAlert
              tone="error"
              title={`${status.lastError.code}: ${status.lastError.message}`}
              action={
                status.lastError.code === "GATEWAY_BUDGET_EXCEEDED"
                  ? budgetTopUpAction()
                  : undefined
              }
            />
          ) : null}
        </>
      ) : !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading Clash official…
        </p>
      ) : null}
      {error ? <InlineAlert tone="error" title={error} /> : null}
    </SettingsRow>
  );
}
