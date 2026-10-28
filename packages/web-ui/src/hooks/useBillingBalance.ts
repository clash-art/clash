/**
 * Credits badge for account chrome. Only meaningful when the hosted billing
 * console plugin is registered (configureConsolePlugins). Reads the caller's
 * personal (or first owned) tenant wallet via gateway
 * `GET /api/v1/gateway/tenants/:tenantId/billing`.
 */
import { useEffect, useState } from "react";
import { MICRO } from "@clash/web-ui/lib/adminClient";
import { teamApi, TeamApiError } from "@clash/web-ui/lib/teamClient";

export interface BillingBalance {
  /** Display credits (microCredits / 1e6). */
  available: number;
  topup: number;
  grant: number;
  grant_expires_at: number | null;
  hold: number;
}

export type BillingBalanceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "unauthenticated" }
  | { status: "ready"; balance: BillingBalance }
  | { status: "error"; message: string };

function microToCredits(micro: number | null | undefined): number {
  if (micro === null || micro === undefined) return 0;
  return micro / MICRO;
}

export function useBillingBalance(enabled: boolean): BillingBalanceState {
  const [state, setState] = useState<BillingBalanceState>(
    enabled ? { status: "loading" } : { status: "unavailable" },
  );

  useEffect(() => {
    if (!enabled) {
      setState({ status: "unavailable" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    void (async () => {
      try {
        const { teams } = await teamApi.teams();
        const tenant =
          teams.find((entry) => entry.kind === "personal" && entry.role === "owner") ??
          teams.find((entry) => entry.role === "owner") ??
          teams[0];
        if (!tenant) {
          if (!cancelled) setState({ status: "unavailable" });
          return;
        }
        const summary = await teamApi.billing(tenant.tenantId);
        if (cancelled) return;
        const wallet = summary.wallet;
        if (!wallet) {
          setState({
            status: "ready",
            balance: {
              available: 0,
              topup: 0,
              grant: 0,
              grant_expires_at: null,
              hold: 0,
            },
          });
          return;
        }
        setState({
          status: "ready",
          balance: {
            available: microToCredits(wallet.availableMicroCredits),
            topup: 0,
            grant: microToCredits(wallet.limitMicroCredits),
            grant_expires_at: null,
            hold: microToCredits(wallet.reservedMicroCredits),
          },
        });
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof TeamApiError) {
          if (err.status === 401 || err.status === 403) {
            setState({ status: "unauthenticated" });
            return;
          }
          if (err.status === 404) {
            setState({ status: "unavailable" });
            return;
          }
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
          setState({ status: "unauthenticated" });
          return;
        }
        setState({ status: "error", message: msg });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}
