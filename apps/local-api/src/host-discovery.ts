import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  LOCAL_HOST_DATA_SCHEMA_VERSION,
  LOCAL_HOST_PROTOCOL_VERSION,
  LOCAL_HOST_RECORD_SCHEMA_VERSION,
  isLocalHostDiscoveryRecord,
  type HostLaunchMode,
  type HostStartedBy,
  type LocalHostDiscoveryRecord,
} from "@clash/shared-runtime";
import { createStructuredLogger } from "@clash/shared-runtime/logging";
import {
  clashHomeForLocalDataDir,
  defaultLocalApiDataDir,
  resolveClashProfile,
  type ClashRuntimeProfile,
} from "./local-paths.js";

export type HostDiscoveryState =
  | { status: "active"; record: LocalHostDiscoveryRecord }
  | { status: "inactive" };

/** Why a record with a live pid is still stale: its endpoint is not that Host. */
export type HostDiscoveryProbeResult =
  { live: true } | { live: false; reason: string };

export type HostDiscoveryProbe = (
  record: LocalHostDiscoveryRecord,
) => Promise<HostDiscoveryProbeResult>;

export interface HostDiscoveryReadOptions {
  runDir?: string;
  pidExists?: (pid: number) => boolean;
  /** Defaults to a short `GET /health` against the recorded endpoint. */
  probeHost?: HostDiscoveryProbe;
}

export interface HostDiscoveryWriteOptions {
  runDir?: string;
}

export interface HostDiscoveryWriteCheckOptions extends HostDiscoveryWriteOptions {
  pidExists?: (pid: number) => boolean;
  /** Defaults to a short `GET /health` against the recorded endpoint. */
  probeHost?: HostDiscoveryProbe;
}

/** A coded discovery failure; callers surface `code` instead of a bare message. */
export class HostDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "HostDiscoveryError";
  }
}

const discoveryLog = createStructuredLogger({
  component: "local-api",
  module: "host-discovery",
});

const HEALTH_PROBE_TIMEOUT_MS = 1_500;

/**
 * Probe outcomes that prove the record is stale. A timeout does not: the pid is
 * still alive, so the process may just have a blocked event loop (a large
 * import can stall it for seconds). Treating that as stale would let a second
 * Host displace a live one, recreating the race this record prevents.
 */
function isStaleProbeReason(reason: string): boolean {
  return (
    reason === "invalid_endpoint" ||
    reason === "non_loopback_endpoint" ||
    reason === "endpoint_unreachable" ||
    reason === "host_id_mismatch" ||
    reason === "invalid_response" ||
    reason.startsWith("http_")
  );
}

function unresponsiveMessage(
  record: LocalHostDiscoveryRecord,
  reason: string,
): string {
  return `Local host ${record.hostId} (pid ${record.pid}) at ${record.endpoint} did not answer /health in time (${reason}); refusing to replace its discovery record.`;
}

/**
 * A pid is not an identity: after a crash or power loss the number can be
 * reused by an unrelated process. The discovery record is only live when the
 * endpoint it advertises answers `/health` as the Host that wrote it.
 */
export async function probeHostDiscoveryEndpoint(
  record: LocalHostDiscoveryRecord,
  options: { timeoutMs?: number } = {},
): Promise<HostDiscoveryProbeResult> {
  let endpoint: URL;
  try {
    endpoint = new URL("/health", record.endpoint);
  } catch {
    return { live: false, reason: "invalid_endpoint" };
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    (hostname !== "127.0.0.1" &&
      hostname !== "localhost" &&
      hostname !== "::1" &&
      hostname !== "[::1]")
  ) {
    return { live: false, reason: "non_loopback_endpoint" };
  }
  try {
    const response = await fetch(endpoint, {
      signal: AbortSignal.timeout(options.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { live: false, reason: `http_${response.status}` };
    }
    const body = (await response.json()) as {
      ok?: unknown;
      host?: { hostId?: unknown };
    };
    if (body.ok !== true || typeof body.host?.hostId !== "string") {
      return { live: false, reason: "invalid_response" };
    }
    if (body.host.hostId !== record.hostId) {
      return { live: false, reason: "host_id_mismatch" };
    }
    return { live: true };
  } catch (error) {
    const name =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "";
    return {
      live: false,
      reason:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : "endpoint_unreachable",
    };
  }
}

function staleRecordContext(
  record: LocalHostDiscoveryRecord,
  reason: string,
): Record<string, unknown> {
  return {
    code: "HOST_DISCOVERY_STALE_RECORD",
    hostId: record.hostId,
    pid: record.pid,
    endpoint: record.endpoint,
    reason,
  };
}

async function probeOrStale(
  record: LocalHostDiscoveryRecord,
  probeHost: HostDiscoveryProbe,
): Promise<HostDiscoveryProbeResult> {
  try {
    return await probeHost(record);
  } catch (error) {
    return {
      live: false,
      reason:
        error instanceof Error
          ? `probe_failed: ${error.message}`
          : "probe_failed",
    };
  }
}

export function getDefaultHostDiscoveryRunDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return join(clashHomeForLocalDataDir(defaultLocalApiDataDir(env)), "run");
}

export function getHostDiscoveryPath(
  runDir = getDefaultHostDiscoveryRunDir(),
): string {
  return join(runDir, "host.json");
}

export function createHostDiscoveryRecord(options: {
  endpoint: string;
  launchMode: HostLaunchMode;
  startedBy: HostStartedBy;
  profile?: ClashRuntimeProfile;
  runtimeFingerprint?: string;
  agentCliPath?: string;
  ownerClientId?: string;
  pid?: number;
  hostId?: string;
  now?: Date;
}): LocalHostDiscoveryRecord {
  const now = (options.now ?? new Date()).toISOString();
  return {
    schemaVersion: LOCAL_HOST_RECORD_SCHEMA_VERSION,
    protocolVersion: LOCAL_HOST_PROTOCOL_VERSION,
    dataSchemaVersion: LOCAL_HOST_DATA_SCHEMA_VERSION,
    hostId: options.hostId ?? randomUUID(),
    endpoint: options.endpoint,
    pid: options.pid ?? process.pid,
    launchMode: options.launchMode,
    startedBy: options.startedBy,
    profile: options.profile ?? resolveClashProfile(),
    runtimeFingerprint:
      (options.runtimeFingerprint ??
        process.env.CLASH_DAEMON_RUNTIME_FINGERPRINT?.trim()) ||
      undefined,
    agentCliPath: options.agentCliPath,
    ownerClientId: options.ownerClientId,
    startedAt: now,
    updatedAt: now,
  };
}

export async function writeHostDiscovery(
  record: LocalHostDiscoveryRecord,
  options: HostDiscoveryWriteCheckOptions = {},
): Promise<void> {
  if (!isLocalHostDiscoveryRecord(record)) {
    throw new Error("Invalid local host discovery record");
  }
  const runDir = options.runDir ?? getDefaultHostDiscoveryRunDir();
  await mkdir(runDir, { recursive: true });
  const finalPath = getHostDiscoveryPath(runDir);

  // One live host owns the record.
  //
  // The file is replaced by rename, so a second host used to displace a running one without
  // either noticing. Both stayed up on their own random ports and clients followed whichever
  // wrote last, while asset URLs already handed out still pointed at the displaced port --
  // inlining a reference then failed with a bare `fetch failed` even though the upstream was
  // fine. Refusing the write turns that silent race into a startup error naming the holder.
  //
  // A live pid is not enough: after a SIGKILL the pid can be reused by an unrelated process.
  // Only a Host that answers `/health` as the record's hostId keeps the record.
  const pidExists = options.pidExists ?? defaultPidExists;
  const probeHost = options.probeHost ?? probeHostDiscoveryEndpoint;
  let incumbent: unknown;
  try {
    incumbent = JSON.parse(await readFile(finalPath, "utf8"));
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  if (isLocalHostDiscoveryRecord(incumbent) && incumbent.pid !== record.pid) {
    if (!pidExists(incumbent.pid)) {
      discoveryLog.warn(
        "host.discovery_stale_record",
        staleRecordContext(incumbent, "pid_not_running"),
      );
    } else {
      const probe = await probeOrStale(incumbent, probeHost);
      if (probe.live) {
        throw new HostDiscoveryError(
          "HOST_DISCOVERY_ACTIVE",
          `A local host is already active on ${incumbent.endpoint} (pid ${incumbent.pid}); stop it before starting another.`,
        );
      }
      if (!isStaleProbeReason(probe.reason)) {
        // A live pid whose endpoint merely timed out is not stale. The Host may
        // be stalled (for example a multi-second import); replacing the record
        // would let this second Host and the stalled one both serve clients.
        throw new HostDiscoveryError(
          "HOST_DISCOVERY_UNRESPONSIVE",
          unresponsiveMessage(incumbent, probe.reason),
        );
      }
      discoveryLog.warn(
        "host.discovery_stale_record",
        staleRecordContext(incumbent, probe.reason),
      );
    }
  }

  const tmpPath = join(
    runDir,
    `host.${record.hostId}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmpPath, finalPath);
  await chmod(finalPath, 0o600).catch(() => undefined);
}

export async function readHostDiscovery(
  options: HostDiscoveryReadOptions = {},
): Promise<HostDiscoveryState> {
  const runDir = options.runDir ?? getDefaultHostDiscoveryRunDir();
  const filePath = getHostDiscoveryPath(runDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return { status: "inactive" };
    throw error;
  }

  if (!isLocalHostDiscoveryRecord(parsed)) {
    return { status: "inactive" };
  }

  const pidExists = options.pidExists ?? defaultPidExists;
  let reason: string | undefined;
  if (!pidExists(parsed.pid)) {
    reason = "pid_not_running";
  } else if (parsed.launchMode !== "user-service") {
    // A supervised user-service lease belongs to the stable supervisor and
    // intentionally stays discoverable while its child Host restarts, so its
    // endpoint may be briefly down. Every other record must answer /health as
    // this Host; a reused pid does not keep a dead endpoint discoverable.
    const probe = await probeOrStale(
      parsed,
      options.probeHost ?? probeHostDiscoveryEndpoint,
    );
    if (!probe.live) {
      if (isStaleProbeReason(probe.reason)) {
        reason = probe.reason;
      } else {
        // Keep a live pid's record discoverable when the probe could not
        // decide. The next Host write repeats the probe under the same rule.
        discoveryLog.warn("host.discovery_unresponsive", {
          code: "HOST_DISCOVERY_UNRESPONSIVE",
          hostId: parsed.hostId,
          pid: parsed.pid,
          endpoint: parsed.endpoint,
          reason: probe.reason,
        });
        return { status: "active", record: parsed };
      }
    }
  }
  if (reason !== undefined) {
    discoveryLog.warn(
      "host.discovery_stale_record",
      staleRecordContext(parsed, reason),
    );
    await removeHostDiscovery(parsed.hostId, { runDir });
    return { status: "inactive" };
  }

  return { status: "active", record: parsed };
}

export async function removeHostDiscovery(
  hostId: string,
  options: HostDiscoveryWriteOptions = {},
): Promise<void> {
  const runDir = options.runDir ?? getDefaultHostDiscoveryRunDir();
  const filePath = getHostDiscoveryPath(runDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }

  if (!isLocalHostDiscoveryRecord(parsed) || parsed.hostId !== hostId) return;
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    throw new HostDiscoveryError(
      "HOST_DISCOVERY_CLEANUP_FAILED",
      `Failed to remove the local host discovery record at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function defaultPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EPERM",
    );
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT",
  );
}

export async function canReadHostDiscovery(runDir?: string): Promise<boolean> {
  try {
    await access(getHostDiscoveryPath(runDir), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
