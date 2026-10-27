/**
 * Contract of deploy/compose.yaml (#374 + #373): the self-host topology is
 * PostgreSQL multi-node — three api nodes, an outbox process (not a
 * GATEWAY_ROLE), an admin node, and a one-shot migrate gate — with the mock
 * upstream only in the `test` profile and an optional `all` colocation under
 * `demo`. GATEWAY_ROLE is api|admin|all|migrate only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isLoadBalancerConfig } from "../../../scripts/check-anti-patterns.ts";
import { databaseUrl, publicUrl } from "./config.ts";
import { gatewayDrainTimingsFromEnv } from "./gateway-health.ts";
import {
  gatewayRole,
  gatewayServesAdminConsole,
  gatewayServesDataPlane,
} from "./gateway-node.ts";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "../..");
const deployDir = join(packageDir, "deploy");
const composePath = join(deployDir, "compose.yaml");
const dockerfilePath = join(deployDir, "Dockerfile");
const entrypointPath = join(deployDir, "entrypoint.sh");

interface Service {
  image?: string;
  build?: { context: string; dockerfile: string };
  command?: string[];
  environment?: Record<string, string>;
  profiles?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test: string[] };
  volumes?: string[];
  ports?: string[];
  restart?: string;
  init?: boolean;
  read_only?: boolean;
  tmpfs?: string[];
  stop_grace_period?: string;
}

const compose = parse(readFileSync(composePath, "utf8"), { merge: true }) as {
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
};
const services = Object.entries(compose.services);
const scripts = (
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The source file a package script runs (its last `.ts` argument). */
function scriptEntry(name: string): string {
  const entry = scripts[name]
    ?.split(/\s+/)
    .filter((part) => part.endsWith(".ts"))
    .at(-1);
  if (!entry) throw Error(`package script ${name} runs no .ts entry`);
  return entry;
}

const runs = (service: Service, script: string) =>
  service.command?.at(-1) === scriptEntry(script);
const env = (service: Service) => service.environment ?? {};
const servicesRunning = (script: string) =>
  services.filter(([, service]) => runs(service, script));

const roleOf = (service: Service) =>
  "GATEWAY_ROLE" in env(service) ? gatewayRole(env(service)) : undefined;

const apiNodes = services.filter(
  ([, service]) => roleOf(service) === "api" && !service.profiles,
);
const adminNodes = services.filter(
  ([, service]) => roleOf(service) === "admin" && !service.profiles,
);
const allNodes = services.filter(([, service]) => roleOf(service) === "all");
const migrateGates = services.filter(
  ([, service]) => roleOf(service) === "migrate",
);
const workers = servicesRunning("worker:outbox");
const appServices = [...apiNodes, ...adminNodes, ...workers];
const defaultProfile = services.filter(([, service]) => !service.profiles);

/**
 * Compose interpolation of `${VAR:-default}` and `${VAR:?message}` (the only
 * forms the file uses); a missing required variable throws like compose.
 */
function interpolate(value: string, vars: Record<string, string> = {}): string {
  return value.replace(
    /\$\{([A-Z0-9_]+)(?::([-?])([^}]*))?\}/g,
    (_, name: string, kind?: string, fallback = "") => {
      if (vars[name]) return vars[name];
      if (kind === "?") throw Error(`required variable ${name} is missing`);
      return kind === "-" ? fallback : "";
    },
  );
}

/** Deployer-supplied variables the required interpolations name. */
const deployerVars = {
  POSTGRES_PASSWORD: "test-password",
  CLOUD_PUBLIC_URL: "http://gateway.test",
  GATEWAY_ENCRYPTION_KEYS: "test-keys",
  GATEWAY_ENCRYPTION_CURRENT: "test-kid",
};
const resolvedEnv = (service: Service) =>
  Object.fromEntries(
    Object.entries(env(service)).map(([key, value]) => [
      key,
      interpolate(value, deployerVars),
    ]),
  );

/** Compose duration ("1m30s", "60s") in milliseconds. */
function durationMs(value: string): number {
  const units: Record<string, number> = {
    h: 3_600_000,
    m: 60_000,
    s: 1_000,
    ms: 1,
  };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map((part) => part[0]).join("") !== value)
    throw Error(`not a compose duration: ${value}`);
  return parts.reduce(
    (sum, [, amount, unit]) => sum + Number(amount) * units[unit],
    0,
  );
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

describe("gateway-node compose: distributed topology (#374 + #373)", () => {
  it("runs three api nodes, one outbox process and one admin, all on PostgreSQL", () => {
    expect(apiNodes).toHaveLength(3);
    expect(workers).toHaveLength(1);
    expect(adminNodes).toHaveLength(1);
    const postgres = services.filter(([, service]) =>
      service.image?.startsWith("postgres:"),
    );
    expect(postgres).toHaveLength(1);
    for (const [name, service] of appServices) {
      const url = new URL(databaseUrl(resolvedEnv(service)));
      expect(url.hostname, name).toBe(postgres[0]![0]);
      expect(service.profiles, name).toBeUndefined();
    }
  });

  it("GATEWAY_ROLE is only api|admin|all|migrate (no gateway worker role)", () => {
    for (const [name, service] of services) {
      if (!("GATEWAY_ROLE" in env(service))) continue;
      const role = gatewayRole(env(service));
      expect(["api", "admin", "all", "migrate"], name).toContain(role);
      expect(role, name).not.toBe("worker");
    }
    // Outbox process is a command override, not GATEWAY_ROLE.
    for (const [name, service] of workers)
      expect(env(service).GATEWAY_ROLE, name).toBeUndefined();
  });

  it("the api nodes are interchangeable: one image, one environment, one shared blob volume", () => {
    const [first, ...rest] = apiNodes.map(([, service]) => service);
    for (const node of rest) {
      expect(node.image).toBe(first!.image);
      expect(node.command).toEqual(first!.command);
      expect(node.environment).toEqual(first!.environment);
    }
    for (const [name, service] of appServices) {
      const mounts = (service.volumes ?? []).map((volume) => volume.split(":"));
      for (const directory of [
        env(service).CLOUD_ASSET_DIR,
        env(service).CLOUD_CONTENT_DIR,
      ]) {
        const mount = mounts.find(([, target]) =>
          directory?.startsWith(`${target}/`),
        );
        expect(mount, `${name} ${directory}`).toBeDefined();
        // A named volume shared by every node, not a per-container path.
        expect(Object.keys(compose.volumes)).toContain(mount![0]);
        expect(mount![0]).toBe(
          (apiNodes[0]![1].volumes ?? [])[0]!.split(":")[0],
        );
      }
    }
  });

  it("every application process waits for the one-shot migrate gate (GATEWAY_ROLE=migrate)", () => {
    expect(migrateGates).toHaveLength(1);
    const [gateName, gate] = migrateGates[0]!;
    expect(gate.restart).toBe("no");
    expect(gate.profiles).toBeUndefined();
    expect(gate.command, gateName).toBeUndefined();
    expect(Object.values(gate.depends_on ?? {})).toEqual([
      { condition: "service_healthy" },
    ]);
    expect(Object.keys(gate.depends_on ?? {})).toEqual(
      services
        .filter(([, service]) => service.image?.startsWith("postgres:"))
        .map(([name]) => name),
    );
    expect(scripts.migrate).toBeTruthy();
    for (const [name, service] of appServices) {
      expect(service.depends_on?.[gateName], name).toEqual({
        condition: "service_completed_successfully",
      });
      expect(service.command?.join(" ") ?? "", name).not.toMatch(/migrat/);
      expect(roleOf(service), name).not.toBe("migrate");
    }
  });

  it("wires admin (+ demo all) to the separate admin listener (#371/#372)", () => {
    for (const [name, service] of [...adminNodes, ...allNodes]) {
      const role = roleOf(service)!;
      expect(gatewayServesAdminConsole(role), name).toBe(true);
      expect(env(service).GATEWAY_ADMIN_PORT, name).toMatch(/^\d+$/);
      expect(env(service).GATEWAY_ADMIN_WEB_DIR, name).toBeTruthy();
      expect(service.ports?.join(" "), name).toContain(
        `:${env(service).GATEWAY_ADMIN_PORT}`,
      );
    }
    for (const [name, service] of apiNodes)
      expect(gatewayServesDataPlane(roleOf(service)!), name).toBe(true);
    for (const [name, service] of allNodes) {
      expect(service.profiles, name).toEqual(["demo"]);
      expect(gatewayServesDataPlane(roleOf(service)!), name).toBe(true);
    }
  });

  it("puts the mock upstream under the test profile only", () => {
    const mocks = servicesRunning("mock-upstream");
    expect(mocks.length).toBeGreaterThan(0);
    for (const [name, service] of mocks)
      expect(service.profiles, name).toEqual(["test"]);
    for (const [name, service] of services)
      if (env(service).MOCK_UPSTREAM_ALLOW_NON_LOOPBACK !== undefined)
        expect(service.profiles, name).toEqual(["test"]);
    // The default topology never needs a profiled service to start.
    const profiled = new Set(
      services.filter(([, service]) => service.profiles).map(([name]) => name),
    );
    for (const [name, service] of defaultProfile)
      for (const dependency of Object.keys(service.depends_on ?? {}))
        expect(profiled.has(dependency), `${name} -> ${dependency}`).toBe(
          false,
        );
  });

  it("has no SQLite/filesystem single-node topology and requires no Redis (decision 12)", () => {
    expect(appServices.length).toBeGreaterThan(1);
    for (const [name, service] of services) {
      const facts = JSON.stringify({ name, ...service });
      expect(facts, name).not.toMatch(/sqlite/i);
      expect(service.profiles ?? [], name).not.toContain("minimal");
      if ("GATEWAY_ROLE" in env(service))
        expect(() => gatewayRole(env(service)), name).not.toThrow();
    }
    for (const [name, service] of defaultProfile) {
      expect(service.image ?? "", name).not.toMatch(/redis|valkey/i);
      expect(Object.keys(env(service)).join(" "), name).not.toMatch(/REDIS/);
    }
  });

  it("keeps api nodes LB-friendly: readiness check, drain-length stop grace, init, read-only rootfs", () => {
    for (const [name, service] of apiNodes) {
      const port = env(service).PORT;
      expect(service.healthcheck?.test.join(" "), name).toContain(
        `:${port}/readyz`,
      );
      const drain = gatewayDrainTimingsFromEnv(env(service));
      expect(
        durationMs(service.stop_grace_period ?? "0s"),
        name,
      ).toBeGreaterThan(drain.delayMs + drain.graceMs + drain.settleMs);
      expect(service.init, name).toBe(true);
      expect(service.read_only, name).toBe(true);
      expect(service.tmpfs, name).toContain("/tmp");
    }
  });

  it("requires secrets from the deployer and publishes on loopback by default", () => {
    for (const [name, service] of appServices) {
      expect(publicUrl(resolvedEnv(service)), name).toBe(
        deployerVars.CLOUD_PUBLIC_URL,
      );
      for (const key of [
        "DATABASE_URL",
        "CLOUD_PUBLIC_URL",
        "GATEWAY_ENCRYPTION_KEYS",
        "GATEWAY_ENCRYPTION_CURRENT",
      ])
        if (key in env(service))
          expect(
            () => interpolate(env(service)[key]!),
            `${name} ${key}`,
          ).toThrow(/required variable/);
    }
    for (const [name, service] of apiNodes)
      expect(env(service).GATEWAY_ENCRYPTION_KEYS, name).toBeDefined();
    for (const [name, service] of services)
      for (const port of service.ports ?? [])
        expect(interpolate(port), name).toMatch(/^127\.0\.0\.1:/);
  });
});

describe("gateway-node deploy directory (#374 + #373)", () => {
  it("ships no load balancer config (CONTRIBUTING anti-pattern 4)", () => {
    for (const file of filesUnder(deployDir))
      expect(isLoadBalancerConfig(relative(repoRoot, file)), file).toBe(false);
    for (const [name, service] of services)
      expect(service.image ?? "", name).not.toMatch(
        /nginx|haproxy|traefik|caddy|envoy/i,
      );
  });

  it("builds every role from one multi-stage Dockerfile with digest pin, tini, healthz, entrypoint", () => {
    const builds = new Set(
      services
        .filter(([, service]) => service.build)
        .map(([, service]) =>
          resolve(deployDir, service.build!.context, service.build!.dockerfile),
        ),
    );
    expect(builds.size).toBe(1);
    const [dockerfile] = [...builds];
    expect(dockerfile).toBe(dockerfilePath);
    expect(existsSync(dockerfile!)).toBe(true);
    expect(existsSync(entrypointPath)).toBe(true);
    for (const [name, service] of [...appServices, ...migrateGates])
      expect(
        service.build && resolve(deployDir, service.build.context),
        name,
      ).toBe(repoRoot);
    const body = readFileSync(dockerfile!, "utf8");
    expect(body).toMatch(/pnpm deploy --filter @clash\/api-node --prod/);
    expect(body).toMatch(/Deliberate tsx ship/i);
    expect(body).toMatch(/node:24-slim@sha256:[a-f0-9]{64}/);
    expect(body).toMatch(/\btini\b/);
    expect(body).toMatch(/USER node/);
    expect(body).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
    expect(body).toMatch(/gateway-entrypoint/);
    expect(body).not.toMatch(/GATEWAY_ENCRYPTION_KEYS=|POSTGRES_PASSWORD=/);
    const entry = readFileSync(entrypointPath, "utf8");
    for (const role of ["api", "admin", "all", "migrate"])
      expect(entry).toContain(role);
    expect(entry).not.toMatch(/GATEWAY_ROLE=worker|role\) in\s*\n\s*worker/);
    expect(entry).toMatch(/api\|admin\|all/);
    const copied = [
      ...body.matchAll(/^COPY --from=builder \/app\/(\S+)/gm),
    ].map((match) => match[1]!);
    expect(copied.length).toBeGreaterThan(0);
    for (const file of copied)
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });

  it("security contract (#385): no admin EXPOSE, loopback publish, no staff prompt flag", () => {
    const body = readFileSync(dockerfilePath, "utf8");
    const exposes = [...body.matchAll(/^\s*EXPOSE\s+(\S+)/gim)].map((m) => m[1]);
    expect(exposes).toEqual(["8080"]);
    const text = readFileSync(composePath, "utf8");
    expect(text).toMatch(/GATEWAY_PUBLISH_HOST:-\s*127\.0\.0\.1/);
    expect(text).not.toMatch(/GATEWAY_STAFF_PROMPT_ACCESS\s*:\s*["']?enabled/);
    for (const [name, service] of [...adminNodes, ...allNodes]) {
      const published = (service.ports ?? []).join(" ");
      expect(published, name).toMatch(/127\.0\.0\.1|GATEWAY_PUBLISH_HOST/);
    }
  });

});
