import { describe, expect, it } from "vitest";
import { GATEWAY_ERROR_TABLE, isGatewayErrorCode } from "@clash/gateway-core";
import { OFFICIAL_GATEWAY_CLIENT_CODES } from "@clash/shared-types";

/**
 * The desktop Host (#357) reads gateway codes from agent error text and Host
 * responses. Its table must stay a subset of the gateway's own error table,
 * which is what the data plane actually answers with.
 */
describe("official gateway client codes", () => {
  it("are gateway-core codes with the gateway's HTTP status", () => {
    for (const [code, definition] of Object.entries(
      OFFICIAL_GATEWAY_CLIENT_CODES,
    )) {
      expect(isGatewayErrorCode(code), code).toBe(true);
      if (!isGatewayErrorCode(code)) continue;
      expect(definition.status, code).toBe(GATEWAY_ERROR_TABLE[code].status);
    }
  });
});
