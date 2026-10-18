import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createHostDiscoveryRecord,
  getHostDiscoveryPath,
  writeHostDiscovery,
} from "./host-discovery";

/**
 * A second live host must not silently take over the discovery record.
 *
 * The record is a single `host.json` replaced by rename, so a newly started host displaced
 * a running one without either noticing. Both kept serving on their own random ports, and
 * clients followed whichever wrote last. Asset URLs already handed out pointed at the
 * displaced port, so inlining a reference failed with a bare `fetch failed` while the
 * upstream was reachable and the log showed two ports:
 *
 *   [local-api] listening on http://127.0.0.1:49321
 *   [local-api] listening on http://127.0.0.1:55799
 *
 * A takeover is only legitimate when the recorded pid is gone.
 */
describe("host discovery has one live writer", () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "clash-discovery-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  function record(pid: number, port: number) {
    return createHostDiscoveryRecord({
      hostId: `host-${pid}`,
      endpoint: `http://127.0.0.1:${port}`,
      pid,
      launchMode: "cli-once",
      startedBy: "cli",
    });
  }

  it("refuses to displace a record whose process is still alive", async () => {
    await writeHostDiscovery(record(4242, 49321), { runDir, pidExists: () => true });
    await expect(
      writeHostDiscovery(record(4343, 55799), {
        runDir,
        pidExists: () => true,
        probeHost: async () => ({ live: true }),
      }),
    ).rejects.toThrow(/already/i);

    const stored = JSON.parse(await readFile(getHostDiscoveryPath(runDir), "utf8"));
    expect(stored.endpoint, "the running host keeps the record").toContain("49321");
  });

  it("takes over when the recorded process is gone", async () => {
    await writeHostDiscovery(record(4242, 49321), { runDir, pidExists: () => false });
    await writeHostDiscovery(record(4343, 55799), { runDir, pidExists: () => false });

    const stored = JSON.parse(await readFile(getHostDiscoveryPath(runDir), "utf8"));
    expect(stored.endpoint).toContain("55799");
  });

  it("lets the same process refresh its own record", async () => {
    await writeHostDiscovery(record(process.pid, 49321), { runDir, pidExists: () => true });
    await writeHostDiscovery(record(process.pid, 49321), { runDir, pidExists: () => true });

    const stored = JSON.parse(await readFile(getHostDiscoveryPath(runDir), "utf8"));
    expect(stored.pid).toBe(process.pid);
  });
});
