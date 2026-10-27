import { describe, expect, it } from "vitest";
import {
  GATEWAY_MIGRATE_DEFAULT_LOCK_TIMEOUT_MS,
  runGatewayCli,
  type GatewayCliDeps,
} from "./gateway-cli.ts";
import { MigrationError, type MigrationReport } from "./migrations.ts";
import { GatewaySeedError } from "./gateway-seed.ts";

const DATABASE_URL = "postgresql://clash:pw@127.0.0.1:5432/clash_staging";
const report: MigrationReport = {
  bootstrap: false,
  applied: ["a"],
  pending: [],
  ahead: [],
  appliedNow: ["b"],
};

function harness(overrides: Partial<GatewayCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const migrateCalls: Parameters<GatewayCliDeps["migrate"]>[0][] = [];
  let seeds = 0;
  const deps: GatewayCliDeps = {
    env: { DATABASE_URL },
    migrate: async (options) => {
      migrateCalls.push(options);
      return report;
    },
    seed: async () => {
      seeds += 1;
      return { models: 1, prices: 2 };
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    ...overrides,
  };
  return { deps, out, err, migrateCalls, seeds: () => seeds };
}

describe("gateway CLI (#377)", () => {
  it("migrate maps flags onto one locked run and prints its JSON report", async () => {
    const run = harness();
    expect(await runGatewayCli(["migrate"], run.deps)).toBe(0);
    expect(
      await runGatewayCli(
        ["migrate", "--plan", "--allow-contract", "--lock-timeout-ms", "250"],
        run.deps,
      ),
    ).toBe(0);
    expect(run.migrateCalls).toEqual([
      {
        plan: false,
        allowContract: false,
        lockTimeoutMs: GATEWAY_MIGRATE_DEFAULT_LOCK_TIMEOUT_MS,
      },
      { plan: true, allowContract: true, lockTimeoutMs: 250 },
    ]);
    expect(run.out.map((line) => JSON.parse(line))).toEqual([
      { command: "migrate", ...report },
      { command: "plan", ...report },
    ]);
    expect(run.err).toEqual([]);
  });

  it("rejects usage errors with exit 2 before touching the database", async () => {
    const run = harness();
    for (const argv of [
      [],
      ["deploy"],
      ["migrate", "--force"],
      ["migrate", "--lock-timeout-ms", "0"],
      ["migrate", "--lock-timeout-ms", "soon"],
      ["seed", "--models", "x.json"],
    ])
      expect(await runGatewayCli(argv, run.deps), argv.join(" ")).toBe(2);
    expect(run.migrateCalls).toEqual([]);
    expect(run.seeds()).toBe(0);
    expect(
      run.err.every((line) => line.startsWith("GATEWAY_CLI_USAGE: ")),
    ).toBe(true);
  });

  it("requires a PostgreSQL DATABASE_URL and never echoes it", async () => {
    for (const env of [{}, { DATABASE_URL: "mysql://u:pw@db/x" }]) {
      const run = harness({ env });
      expect(await runGatewayCli(["migrate"], run.deps)).toBe(1);
      expect(await runGatewayCli(["seed"], run.deps)).toBe(1);
      expect(run.migrateCalls).toEqual([]);
      expect(run.seeds()).toBe(0);
      expect(run.err).toHaveLength(2);
      for (const line of run.err) {
        expect(line).toMatch(/^GATEWAY_CLI_CONFIG: DATABASE_URL /);
        expect(line).not.toContain("pw");
      }
    }
  });

  it("prints coded migration and seed failures", async () => {
    const run = harness({
      migrate: async () => {
        throw new MigrationError(
          "MIGRATION_CONTRACT_REFUSED",
          "Contract migrations need --allow-contract: c",
          ["c"],
        );
      },
      seed: async () => {
        throw new GatewaySeedError(
          "GATEWAY_SEED_SCHEMA_PENDING",
          "Run gateway migrate first; pending: c",
        );
      },
    });
    expect(await runGatewayCli(["migrate"], run.deps)).toBe(1);
    expect(await runGatewayCli(["seed"], run.deps)).toBe(1);
    expect(run.err).toEqual([
      "MIGRATION_CONTRACT_REFUSED: Contract migrations need --allow-contract: c",
      "GATEWAY_SEED_SCHEMA_PENDING: Run gateway migrate first; pending: c",
    ]);
    expect(run.out).toEqual([]);
  });

  it("reports an uncoded driver failure by class and SQLSTATE only", async () => {
    const leaky = Object.assign(Error(`connect failed for ${DATABASE_URL}`), {
      code: "28P01",
    });
    const run = harness({
      migrate: async () => {
        throw leaky;
      },
      seed: async () => {
        throw leaky;
      },
    });
    expect(await runGatewayCli(["migrate"], run.deps)).toBe(1);
    expect(await runGatewayCli(["seed"], run.deps)).toBe(1);
    expect(run.err).toEqual([
      'GATEWAY_MIGRATE_FAILED: {"error_name":"Error","error_code":"28P01"}',
      'GATEWAY_SEED_FAILED: {"error_name":"Error","error_code":"28P01"}',
    ]);
  });

  it("seed prints its counts", async () => {
    const run = harness();
    expect(await runGatewayCli(["seed"], run.deps)).toBe(0);
    expect(JSON.parse(run.out[0]!)).toEqual({
      command: "seed",
      deepseek: "flash-only",
      models: 1,
      prices: 2,
    });
  });
});
