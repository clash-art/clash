import type { GatewayLogger } from "@clash/gateway-core";

import { serverLog } from "../logger";

/** gateway-core's logger over the Worker's structured log; never throws. */
export function workersLogger(): GatewayLogger {
  const log = serverLog.child("gateway");
  const safe =
    (level: "info" | "warn" | "error"): GatewayLogger["info"] =>
    (event, fields) => {
      try {
        log[level](event, fields ?? {});
      } catch {
        // GatewayLogger must never throw.
      }
    };
  return { info: safe("info"), warn: safe("warn"), error: safe("error") };
}
