/**
 * #385 / N29 — mechanical self-host security defaults: admin not on the
 * public port, no prompt/body retention by default, Flash-only seed constant,
 * image EXPOSE surface. Complements gateway-admin.test.ts (socket separation)
 * and deploy-compose.test.ts (topology).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { unavailablePort } from "@clash/gateway-core";
import { gatewayAdminListenerFromEnv } from "./gateway-admin.ts";
import {
  GATEWAY_ROLES,
  gatewayRole,
  gatewayServesAdminConsole,
  gatewayServesDataPlane,
} from "./gateway-node.ts";
import {
  GATEWAY_SEED_DEEPSEEK_FLASH,
  assertGatewaySeedFlashOnly,
} from "./gateway-seed.ts";

const packageDir = resolve(import.meta.dirname, "..");
const deployDir = join(packageDir, "deploy");
const gatewayNodeSrc = readFileSync(join(packageDir, "src/gateway-node.ts"), "utf8");

describe("gateway-node security defaults (#385)", () => {
  it("GATEWAY_ROLE matrix is api|admin|all|migrate with separate admin console roles", () => {
    expect([...GATEWAY_ROLES]).toEqual(["api", "admin", "all", "migrate"]);
    expect(gatewayRole({})).toBe("api");
    expect(gatewayServesDataPlane("api")).toBe(true);
    expect(gatewayServesDataPlane("admin")).toBe(false);
    expect(gatewayServesAdminConsole("admin")).toBe(true);
    expect(gatewayServesAdminConsole("api")).toBe(false);
    expect(gatewayServesDataPlane("all")).toBe(true);
    expect(gatewayServesAdminConsole("all")).toBe(true);
  });

  it("admin listener is off by default and never shares the public PORT", () => {
    expect(gatewayAdminListenerFromEnv({}, 8080)).toBeUndefined();
    expect(() =>
      gatewayAdminListenerFromEnv({ GATEWAY_ADMIN_PORT: "8080" }, 8080),
    ).toThrow(/differ/);
    const listener = gatewayAdminListenerFromEnv(
      { GATEWAY_ADMIN_PORT: "8090" },
      8080,
    );
    expect(listener?.port).toBe(8090);
    expect(listener?.hostname).toBe("127.0.0.1");
  });

  it("wires retention as unavailablePort (no prompt/response logging by default)", async () => {
    expect(gatewayNodeSrc).toMatch(
      /retention:\s*unavailablePort\(\s*["']retention["']\s*\)/,
    );
    expect(gatewayNodeSrc).not.toMatch(
      /retention\s*:\s*\{[^}]*enabled\s*:\s*true/,
    );
    expect(gatewayNodeSrc).not.toMatch(
      /GATEWAY_STAFF_PROMPT_ACCESS\s*=\s*["']enabled["']/,
    );
    const retention = unavailablePort<{ record: (input: unknown) => Promise<unknown> }>(
      "retention",
    );
    await expect(retention.record({})).rejects.toMatchObject({
      code: "GATEWAY_CAPABILITY_UNAVAILABLE",
      details: { port: "retention" },
    });
  });

  it("Dockerfile exposes only the public PORT; compose defaults publish host to loopback", () => {
    const dockerfile = readFileSync(join(deployDir, "Dockerfile"), "utf8");
    const exposes = [...dockerfile.matchAll(/^\s*EXPOSE\s+(\S+)/gim)].map(
      (m) => m[1],
    );
    expect(exposes).toEqual(["8080"]);
    expect(dockerfile).not.toMatch(
      /GATEWAY_ENCRYPTION_KEYS=|POSTGRES_PASSWORD=/,
    );

    const compose = readFileSync(join(deployDir, "compose.yaml"), "utf8");
    expect(compose).toMatch(/GATEWAY_PUBLISH_HOST:-\s*127\.0\.0\.1/);
    expect(compose).not.toMatch(
      /GATEWAY_STAFF_PROMPT_ACCESS\s*:\s*["']?enabled/,
    );
    expect(compose).toMatch(/GATEWAY_ADMIN_PORT:\s*"8090"/);
  });

  it("DeepSeek seed default is Flash-only and refuses a non-Flash DeepSeek card", () => {
    expect(GATEWAY_SEED_DEEPSEEK_FLASH).toMatch(/flash/i);
    expect(() =>
      assertGatewaySeedFlashOnly([
        {
          modelCode: GATEWAY_SEED_DEEPSEEK_FLASH,
          upstreamId: "deepseek",
          card: {
            implementations: [
              { upstreamId: "deepseek", upstreamModel: GATEWAY_SEED_DEEPSEEK_FLASH },
            ],
          },
        },
      ]),
    ).not.toThrow();
    expect(() =>
      assertGatewaySeedFlashOnly([
        { modelCode: "deepseek-chat", upstreamId: "deepseek" },
      ]),
    ).toThrow(/Flash only/i);
  });
});
