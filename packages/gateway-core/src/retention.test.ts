import { describe, expect, it } from "vitest";

import { GatewayError } from "./errors.js";
import type { GatewayPorts } from "./ports.js";
import {
  gatewayRetentionKeys,
  purgeExpiredGatewayBodies,
  readRetainedExchange,
  retainGatewayExchange,
  type RetainExchangeInput,
} from "./retention.js";
import { catalogFixture } from "./testing/fixtures.js";
import { createMemoryGatewayPorts } from "./testing/memory-ports.js";

const fixture = catalogFixture();

function memory() {
  return createMemoryGatewayPorts({
    identities: {},
    catalog: fixture.catalog,
    providers: fixture.providers,
    keys: fixture.keys,
    prices: [],
    budgets: [],
    startAt: 1_800_000_000_000,
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);
const exchange = (requestId: string): RetainExchangeInput => ({
  requestId,
  identity: { tenantId: "tenant-a", userId: "user-a", keyId: "key-a" },
  request: { body: bytes(`{"q":"${requestId}"}`), contentType: "application/json" },
  response: { status: 200, body: bytes(`{"a":"${requestId}"}`), contentType: "application/json" },
});

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return (error as GatewayError).code;
  }
  return "resolved";
};

describe("body retention", () => {
  it("deletes written bodies when the metadata row cannot be written, so none outlives its metadata", async () => {
    const gateway = memory();
    const ports: GatewayPorts = {
      ...gateway.ports,
      retention: { ...gateway.ports.retention, record: () => Promise.reject(new GatewayError("GATEWAY_INTERNAL")) },
    };
    const outcome = await retainGatewayExchange(ports, exchange("r1"));
    expect(outcome).toMatchObject({ status: "failed", code: "GATEWAY_RETENTION_FAILED", cause: "GATEWAY_INTERNAL", marker: "unrecorded" });
    const keys = gatewayRetentionKeys("r1");
    expect(await gateway.ports.blobs.get(keys.request)).toBeNull();
    expect(await gateway.ports.blobs.get(keys.response)).toBeNull();
    expect(gateway.logs).toContainEqual(
      expect.objectContaining({ level: "error", event: "gateway.retention_failed", fields: expect.objectContaining({ requestId: "r1", code: "GATEWAY_RETENTION_FAILED" }) }),
    );
    // The log carries metadata only.
    expect(JSON.stringify(gateway.logs)).not.toContain('{"q"');
  });

  it("refuses bodies that are missing or no longer match their SHA-256", async () => {
    const gateway = memory();
    await retainGatewayExchange(gateway.ports, exchange("r2"));
    const keys = gatewayRetentionKeys("r2");
    await gateway.ports.blobs.put(keys.response, { body: bytes("tampered"), contentType: "application/json" });
    expect(await code(readRetainedExchange(gateway.ports, { requestId: "r2" }))).toBe("GATEWAY_RETENTION_FAILED");
    await gateway.ports.blobs.delete(keys.request);
    expect(await code(readRetainedExchange(gateway.ports, { requestId: "r2" }))).toBe("GATEWAY_RETENTION_FAILED");
    expect(await code(readRetainedExchange(gateway.ports, { requestId: "never" }))).toBe("GATEWAY_PROMPT_NOT_RETAINED");
  });

  it("answers expired once the retention has passed, before purge runs, and purge then deletes the bodies once", async () => {
    const gateway = memory();
    await retainGatewayExchange(gateway.ports, { ...exchange("r3"), ttlMs: 1_000 });
    expect((await readRetainedExchange(gateway.ports, { requestId: "r3" })).entry.status).toBe("stored");
    gateway.advance(1_000);
    expect(await code(readRetainedExchange(gateway.ports, { requestId: "r3" }))).toBe("GATEWAY_PROMPT_EXPIRED");
    // Bodies still exist until purge: expiry, not purge, decides readability.
    expect(await gateway.ports.blobs.get(gatewayRetentionKeys("r3").request)).not.toBeNull();
    expect(await purgeExpiredGatewayBodies(gateway.ports)).toEqual({ purged: 1, failed: 0 });
    expect(await gateway.ports.blobs.get(gatewayRetentionKeys("r3").request)).toBeNull();
    expect(await purgeExpiredGatewayBodies(gateway.ports)).toEqual({ purged: 0, failed: 0 });
    expect(await code(readRetainedExchange(gateway.ports, { requestId: "r3" }))).toBe("GATEWAY_PROMPT_EXPIRED");
  });

  it("keeps a row whose purge failed for the next run", async () => {
    const gateway = memory();
    await retainGatewayExchange(gateway.ports, { ...exchange("r4"), ttlMs: 0 });
    const broken: GatewayPorts = {
      ...gateway.ports,
      blobs: { ...gateway.ports.blobs, delete: () => Promise.reject(new GatewayError("GATEWAY_INTERNAL")) },
    };
    expect(await purgeExpiredGatewayBodies(broken)).toEqual({ purged: 0, failed: 1 });
    expect((await gateway.ports.retention.get({ requestId: "r4" }))?.status).toBe("stored");
    expect(await purgeExpiredGatewayBodies(gateway.ports)).toEqual({ purged: 1, failed: 0 });
  });
});
