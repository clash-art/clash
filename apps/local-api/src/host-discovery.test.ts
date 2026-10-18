import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_RECORD_SCHEMA_VERSION,
  type LocalHostDiscoveryRecord,
} from "@clash/shared-runtime";
import {
  createHostDiscoveryRecord,
  getDefaultHostDiscoveryRunDir,
  getHostDiscoveryPath,
  readHostDiscovery,
  removeHostDiscovery,
  writeHostDiscovery,
  type HostDiscoveryProbe,
} from "./host-discovery";

const liveProbe: HostDiscoveryProbe = async () => ({ live: true });
const deadProbe: HostDiscoveryProbe = async () => ({
  live: false,
  reason: "endpoint_unreachable",
});
const timeoutProbe: HostDiscoveryProbe = async () => ({
  live: false,
  reason: "timeout",
});

function activeRecord(overrides: Partial<LocalHostDiscoveryRecord> = {}): LocalHostDiscoveryRecord {
  return {
    schemaVersion: LOCAL_HOST_RECORD_SCHEMA_VERSION,
    protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
    dataSchemaVersion: 1,
    hostId: "host-1",
    endpoint: "http://127.0.0.1:49321",
    pid: process.pid,
    launchMode: "desktop",
    startedBy: "desktop",
    ownerClientId: "desktop-1",
    startedAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("local host discovery file", () => {
  it("publishes the host-owned agent CLI path for external clients", () => {
    const create = createHostDiscoveryRecord as unknown as (
      input: Record<string, unknown>
    ) => Record<string, unknown>;
    const record = create({
      endpoint: "http://127.0.0.1:49321",
      launchMode: "desktop",
      startedBy: "desktop",
      agentCliPath: "/tmp/clash-host/agent-bin/clash",
    });

    expect(record.agentCliPath).toBe("/tmp/clash-host/agent-bin/clash");
  });

  it("publishes the runtime profile so clients cannot confuse dev and prod", () => {
    const record = createHostDiscoveryRecord({
      endpoint: "http://127.0.0.1:49321",
      launchMode: "desktop",
      startedBy: "desktop",
      profile: "dev",
    });

    expect(record.profile).toBe("dev");
  });

  it("honors CLASH_HOME for the default run directory", async () => {
    const previous = process.env.CLASH_HOME;
    const clashHome = await mkdtemp(join(tmpdir(), "clash-home-"));
    process.env.CLASH_HOME = clashHome;
    try {
      expect(getDefaultHostDiscoveryRunDir()).toBe(join(clashHome, "run"));
    } finally {
      if (previous === undefined) {
        delete process.env.CLASH_HOME;
      } else {
        process.env.CLASH_HOME = previous;
      }
    }
  });

  it("derives discovery from the authoritative local-api data directory", async () => {
    const previousClashHome = process.env.CLASH_HOME;
    const previousLocalDataDir = process.env.CLASH_LOCAL_DATA_DIR;
    const staleClashHome = await mkdtemp(join(tmpdir(), "stale-clash-home-"));
    const clashHome = await mkdtemp(join(tmpdir(), "canonical-clash-home-"));
    process.env.CLASH_HOME = staleClashHome;
    process.env.CLASH_LOCAL_DATA_DIR = join(clashHome, "local-api");
    try {
      expect(getDefaultHostDiscoveryRunDir()).toBe(join(clashHome, "run"));
    } finally {
      if (previousClashHome === undefined) {
        delete process.env.CLASH_HOME;
      } else {
        process.env.CLASH_HOME = previousClashHome;
      }
      if (previousLocalDataDir === undefined) {
        delete process.env.CLASH_LOCAL_DATA_DIR;
      } else {
        process.env.CLASH_LOCAL_DATA_DIR = previousLocalDataDir;
      }
    }
  });

  it("writes and reads a valid discovery record", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const record = activeRecord();

    await writeHostDiscovery(record, { runDir });

    await expect(readHostDiscovery({ runDir, probeHost: liveProbe })).resolves.toEqual({
      status: "active",
      record,
    });
    expect((await stat(getHostDiscoveryPath(runDir))).mode & 0o777).toBe(0o600);
  });

  it("removes only a matching host id", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const record = activeRecord({ hostId: "new-host" });
    await writeHostDiscovery(record, { runDir });

    await removeHostDiscovery("old-host", { runDir });
    await expect(readHostDiscovery({ runDir, probeHost: liveProbe })).resolves.toEqual({
      status: "active",
      record,
    });

    await removeHostDiscovery("new-host", { runDir });
    await expect(readHostDiscovery({ runDir })).resolves.toEqual({ status: "inactive" });
  });

  it("replaces a stale record whose live pid belongs to an unrelated process", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const stale = activeRecord({
      hostId: "stale-host",
      pid: 4242,
      endpoint: "http://127.0.0.1:1",
    });
    await writeFile(
      getHostDiscoveryPath(runDir),
      JSON.stringify(stale, null, 2),
      "utf8",
    );
    const replacement = activeRecord({
      hostId: "new-host",
      pid: 4343,
      endpoint: "http://127.0.0.1:49322",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let records: Array<{
      event?: string;
      context?: Record<string, unknown>;
    }> = [];
    try {
      await writeHostDiscovery(replacement, {
        runDir,
        pidExists: () => true,
        probeHost: deadProbe,
      });
      records = warn.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as {
          event?: string;
          context?: Record<string, unknown>;
        },
      );
    } finally {
      warn.mockRestore();
    }

    await expect(
      readFile(getHostDiscoveryPath(runDir), "utf8").then(
        (text) => JSON.parse(text) as { hostId?: string; endpoint?: string },
      ),
    ).resolves.toMatchObject({
      hostId: "new-host",
      endpoint: "http://127.0.0.1:49322",
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "host.discovery_stale_record",
        context: expect.objectContaining({
          code: "HOST_DISCOVERY_STALE_RECORD",
          pid: 4242,
          endpoint: "http://127.0.0.1:1/",
          reason: "endpoint_unreachable",
        }),
      }),
    );
  });

  it("keeps blocking while the recorded endpoint answers as that Host", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const incumbent = activeRecord({ hostId: "live-host", pid: 4242 });
    await writeHostDiscovery(incumbent, { runDir });

    await expect(
      writeHostDiscovery(
        activeRecord({ hostId: "contender", pid: 4343 }),
        { runDir, pidExists: () => true, probeHost: liveProbe },
      ),
    ).rejects.toMatchObject({ code: "HOST_DISCOVERY_ACTIVE" });

    const stored = JSON.parse(
      await readFile(getHostDiscoveryPath(runDir), "utf8"),
    ) as { hostId?: string };
    expect(stored.hostId, "the live host keeps the record").toBe("live-host");
  });

  it("refuses to replace a live Host whose /health probe timed out", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const incumbent = activeRecord({
      hostId: "stalled-host",
      pid: 4242,
      endpoint: "http://127.0.0.1:49321",
    });
    await writeHostDiscovery(incumbent, { runDir });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        writeHostDiscovery(
          activeRecord({ hostId: "contender", pid: 4343 }),
          { runDir, pidExists: () => true, probeHost: timeoutProbe },
        ),
      ).rejects.toMatchObject({
        code: "HOST_DISCOVERY_UNRESPONSIVE",
        message: expect.stringMatching(
          /pid 4242.*127\.0\.0\.1:49321.*did not answer \/health in time/,
        ),
      });
      const records = warn.mock.calls.map(
        ([line]) => JSON.parse(String(line)) as { event?: string },
      );
      expect(records).not.toContainEqual(
        expect.objectContaining({ event: "host.discovery_stale_record" }),
      );
    } finally {
      warn.mockRestore();
    }

    const stored = JSON.parse(
      await readFile(getHostDiscoveryPath(runDir), "utf8"),
    ) as { hostId?: string };
    expect(stored.hostId, "a timed-out host keeps the record").toBe(
      "stalled-host",
    );
  });

  it("refuses to replace a live Host when the probe itself fails", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const incumbent = activeRecord({ hostId: "unprobeable-host", pid: 4242 });
    await writeHostDiscovery(incumbent, { runDir });

    await expect(
      writeHostDiscovery(
        activeRecord({ hostId: "contender", pid: 4343 }),
        {
          runDir,
          pidExists: () => true,
          probeHost: async () => {
            throw new Error("probe transport crashed");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "HOST_DISCOVERY_UNRESPONSIVE" });

    const stored = JSON.parse(
      await readFile(getHostDiscoveryPath(runDir), "utf8"),
    ) as { hostId?: string };
    expect(stored.hostId).toBe("unprobeable-host");
  });

  it("keeps a live record active when the read probe times out", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const record = activeRecord({ hostId: "stalled-read", pid: 4242 });
    await writeHostDiscovery(record, { runDir });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        readHostDiscovery({ runDir, pidExists: () => true, probeHost: timeoutProbe }),
      ).resolves.toEqual({ status: "active", record });
      const records = warn.mock.calls.map(
        ([line]) =>
          JSON.parse(String(line)) as {
            event?: string;
            context?: Record<string, unknown>;
          },
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "host.discovery_unresponsive",
          context: expect.objectContaining({
            code: "HOST_DISCOVERY_UNRESPONSIVE",
            pid: 4242,
            reason: "timeout",
          }),
        }),
      );
      expect(records).not.toContainEqual(
        expect.objectContaining({ event: "host.discovery_stale_record" }),
      );
    } finally {
      warn.mockRestore();
    }
    await expect(
      readFile(getHostDiscoveryPath(runDir), "utf8"),
    ).resolves.toContain('"hostId": "stalled-read"');
  });

  it("probes the recorded endpoint before refusing a second Host", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const health = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, host: { hostId: "live-host" } }));
    });
    await new Promise<void>((resolve) => health.listen(0, "127.0.0.1", resolve));
    const address = health.address();
    try {
      if (!address || typeof address === "string")
        throw new Error("expected a TCP address");
      const incumbent = activeRecord({
        hostId: "live-host",
        pid: 4242,
        endpoint: `http://127.0.0.1:${address.port}`,
      });
      await writeHostDiscovery(incumbent, { runDir });

      await expect(
        writeHostDiscovery(
          activeRecord({ hostId: "contender", pid: 4343 }),
          { runDir, pidExists: () => true },
        ),
      ).rejects.toMatchObject({ code: "HOST_DISCOVERY_ACTIVE" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        health.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("treats a live pid with a dead endpoint as stale when reading", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const stale = activeRecord({ hostId: "stale-read", pid: process.pid });
    await writeFile(
      getHostDiscoveryPath(runDir),
      JSON.stringify(stale, null, 2),
      "utf8",
    );

    await expect(
      readHostDiscovery({ runDir, probeHost: deadProbe }),
    ).resolves.toEqual({ status: "inactive" });
    await expect(
      readFile(getHostDiscoveryPath(runDir), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a coded error when the discovery record cannot be removed", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    const record = activeRecord();
    await writeHostDiscovery(record, { runDir });
    await chmod(runDir, 0o500);
    try {
      await expect(
        removeHostDiscovery(record.hostId, { runDir }),
      ).rejects.toMatchObject({ code: "HOST_DISCOVERY_CLEANUP_FAILED" });
    } finally {
      await chmod(runDir, 0o700);
    }
  });

  it("cleans up stale records when the pid is gone", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "clash-host-discovery-"));
    await writeFile(
      getHostDiscoveryPath(runDir),
      JSON.stringify(activeRecord({ pid: 987654321 }), null, 2),
      "utf8",
    );

    await expect(readHostDiscovery({
      runDir,
      pidExists: () => false,
    })).resolves.toEqual({ status: "inactive" });

    await expect(readFile(getHostDiscoveryPath(runDir), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
