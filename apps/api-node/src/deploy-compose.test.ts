/**
 * Contract of deploy/compose.yaml (#374): the self-host topology is
 * PostgreSQL multi-node — three api nodes, a worker and an admin node behind
 * a one-shot migrate gate — with the mock upstream only in the `test` profile.
 * Services are classified by the package script entry they run, and their
 * environment is checked with the same functions the processes use.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isLoadBalancerConfig } from "../../../scripts/check-anti-patterns.ts";
import { databaseUrl, publicUrl } from "./config.ts";
import { gatewayDrainTimingsFromEnv } from "./gateway-health.ts";
import { gatewayRole } from "./gateway-node.ts";

const packageDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(packageDir, "../..");
const deployDir = join(packageDir, "deploy");
const composePath = join(deployDir, "compose.yaml");

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

const apiNodes = servicesRunning("start").filter(
  ([, service]) => gatewayRole(env(service)) === "api",
);
const adminNodes = servicesRunning("start").filter(
  ([, service]) => gatewayRole(env(service)) === "admin",
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

describe("gateway-node compose: distributed topology (#374)", () => {
  it("runs three api nodes, one worker and one admin, all on PostgreSQL", () => {
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

  it("every application process waits for the one-shot migrate gate", () => {
    const gates = services.filter(([, service]) =>
      service.command?.join(" ").match(/\brun\b.*\bmigrate$/),
    );
    expect(gates).toHaveLength(1);
    const [gateName, gate] = gates[0]!;
    expect(gate.restart).toBe("no");
    expect(gate.profiles).toBeUndefined();
    expect(Object.values(gate.depends_on ?? {})).toEqual([
      { condition: "service_healthy" },
    ]);
    expect(Object.keys(gate.depends_on ?? {})).toEqual(
      services
        .filter(([, service]) => service.image?.startsWith("postgres:"))
        .map(([name]) => name),
    );
    // The gate runs the package's own migrate script, whatever it invokes.
    expect(scripts.migrate).toBeTruthy();
    for (const [name, service] of appServices) {
      expect(service.depends_on?.[gateName], name).toEqual({
        condition: "service_completed_successfully",
      });
      expect(service.command?.join(" "), name).not.toMatch(/migrat/);
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

  it("keeps api nodes LB-friendly: readiness check, drain-length stop grace, init", () => {
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

describe("gateway-node deploy directory (#374)", () => {
  it("ships no load balancer config (CONTRIBUTING anti-pattern 4)", () => {
    for (const file of filesUnder(deployDir))
      expect(isLoadBalancerConfig(relative(repoRoot, file)), file).toBe(false);
    for (const [name, service] of services)
      expect(service.image ?? "", name).not.toMatch(
        /nginx|haproxy|traefik|caddy|envoy/i,
      );
  });

  it("builds every role from one Dockerfile whose copied repository files exist", () => {
    const builds = new Set(
      services
        .filter(([, service]) => service.build)
        .map(([, service]) =>
          resolve(deployDir, service.build!.context, service.build!.dockerfile),
        ),
    );
    expect(builds.size).toBe(1);
    const [dockerfile] = [...builds];
    expect(existsSync(dockerfile!)).toBe(true);
    for (const [name, service] of appServices)
      expect(
        service.build && resolve(deployDir, service.build.context),
        name,
      ).toBe(repoRoot);
    const copied = [
      ...readFileSync(dockerfile!, "utf8").matchAll(
        /^COPY --from=builder \/app\/(\S+)/gm,
      ),
    ].map((match) => match[1]!);
    expect(copied.length).toBeGreaterThan(0);
    for (const file of copied)
      expect(existsSync(join(repoRoot, file)), file).toBe(true);
  });
});
