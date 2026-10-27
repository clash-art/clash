import { describe, expect, it, vi } from "vitest";

import {
  GATEWAY_KEY_RING_PERMISSIONS,
  GATEWAY_PLATFORM_PERMISSIONS,
  GATEWAY_TENANT_PERMISSIONS,
  adminConsolePermissions,
  adminRolePermissions,
  resolveGatewayAdminRequest,
  type GatewayAdminAccountIdentity,
} from "./admin-authz.js";

const admin: GatewayAdminAccountIdentity = { id: "adm_1", email: "a@admin.test", name: "A", role: "platform_admin" };
const request = (headers: Record<string, string>) => new Request("http://gateway.test/api/v1/admin/gateway/me", { headers });

describe("the shared admin gate (#372)", () => {
  it("resolves a valid admin session, alone or next to a product session cookie", async () => {
    const verify = vi.fn(async () => admin);
    expect(await resolveGatewayAdminRequest(request({ cookie: "clash-admin.session_token=s" }), verify)).toEqual({ admin });
    expect(
      await resolveGatewayAdminRequest(request({ cookie: "better-auth.session_token=p; __Secure-clash-admin.session_token=s" }), verify),
    ).toEqual({ admin });
  });

  it("refuses a token even next to an admin session, without looking the session up", async () => {
    const verify = vi.fn(async () => admin);
    for (const headers of [{ authorization: "Bearer x" }, { "x-api-key": "x" }] as Record<string, string>[]) {
      const result = await resolveGatewayAdminRequest(request({ ...headers, cookie: "clash-admin.session_token=s" }), verify);
      expect("error" in result && result.error.code).toBe("GATEWAY_ADMIN_SESSION_REQUIRED");
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("answers a product session alone as the wrong kind, and no or an invalid credential as auth required", async () => {
    const nobody = vi.fn(async () => null);
    const product = await resolveGatewayAdminRequest(request({ cookie: "better-auth.session_token=p" }), nobody);
    expect("error" in product && product.error.code).toBe("GATEWAY_ADMIN_SESSION_REQUIRED");
    for (const headers of [{}, { cookie: "clash-admin.session_token=stale" }, { cookie: "clash-admin.session_token=" }] as Record<string, string>[]) {
      const result = await resolveGatewayAdminRequest(request(headers), nobody);
      expect("error" in result && result.error.code).toBe("GATEWAY_AUTH_REQUIRED");
    }
  });
});

describe("console permissions per host (#372)", () => {
  it("reports the role's permissions the host serves, and nothing for an unknown role", () => {
    const servedByHosted = (permission: string) => !GATEWAY_KEY_RING_PERMISSIONS.includes(permission as never);
    expect(adminConsolePermissions("platform_admin", servedByHosted)).toEqual(adminRolePermissions("platform_admin").filter(servedByHosted));
    expect(adminConsolePermissions("platform_admin", servedByHosted)).not.toContain("encryption.read");
    expect(adminConsolePermissions("platform_admin", () => true)).toEqual([...adminRolePermissions("platform_admin")]);
    expect(adminConsolePermissions("owner", () => true)).toEqual([]);
  });

  it("keeps the key ring a platform permission no support_agent holds", () => {
    for (const permission of GATEWAY_KEY_RING_PERMISSIONS) {
      expect(GATEWAY_PLATFORM_PERMISSIONS).toContain(permission);
      expect(GATEWAY_TENANT_PERMISSIONS).not.toContain(permission);
      expect(adminRolePermissions("platform_admin")).toContain(permission);
      expect(adminRolePermissions("support_agent")).not.toContain(permission);
    }
  });
});
