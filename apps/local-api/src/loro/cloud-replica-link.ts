import { hostname } from "node:os";
import { CursorCloudReplicaLink } from "./cursor-cloud-replica-link.js";
import WebSocket, { type RawData } from "ws";
import type { LoroDoc } from "loro-crdt";
import type { ReplicaLinkPort } from "@clash/replica";
import {
  classifySyncError,
  type SyncErrorClassification,
} from "@clash/shared-types";
import {
  LoroProtocolClientSession,
  type HexString,
} from "@clash/replica/loro-protocol";

export interface ReplicaLinkSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): this;
  send(data: Uint8Array): void;
  close(): void;
}

export type ReplicaLinkSocketFactory = (
  url: string,
  headers: Record<string, string>,
) => ReplicaLinkSocket;

export interface LoroCloudReplicaLinkOptions {
  baseUrl: string;
  projectId: string;
  token?: string;
  doc(): LoroDoc;
  /** Must append and apply cloud updates to the local replica before resolving. */
  commit(batchId: HexString, updates: Uint8Array[]): Promise<void>;
  createSocket?: ReplicaLinkSocketFactory;
  /** Fires only after the official protocol JoinResponse makes the link writable. */
  onJoined?(): void;
  /** Paired with onJoined when that joined socket closes. */
  onDisconnected?(): void;
  onError?(error: Error): void;
  /**
   * The cloud refused this link in a way retrying cannot fix (token expired or
   * revoked: close 1008, upgrade/discovery 401/403). The link stops
   * reconnecting until start() is called again after the credentials change.
   */
  onActionRequired?(classification: SyncErrorClassification, error: Error): void;
}

/** Raised (via onError) when the link stops retrying and needs the user. */
export class CloudReplicaLinkActionRequiredError extends Error {
  constructor(readonly classification: SyncErrorClassification, message: string) {
    super(message);
    this.name = "CloudReplicaLinkActionRequiredError";
  }
}

const UPGRADE_STATUS = /(?:Unexpected server response|Upgrade HTTP):? (\d{3})/u;

function cloudRoomUrl(baseUrl: string, projectId: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("Cloud replica URL must use http(s) or ws(s)");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/sync/${encodeURIComponent(projectId)}`;
  url.searchParams.set("protocol", "loro-v1");
  return url.toString();
}

function bytesFromRawData(data: RawData | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data as ArrayBuffer);
}

/** Node transport adapter. Replica semantics remain in @clash/replica. */
export class LoroCloudReplicaLink implements ReplicaLinkPort<Uint8Array> {
  private socket: ReplicaLinkSocket | undefined;
  private session: LoroProtocolClientSession | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retry = 0;
  private stopped = true;
  private cursorLink: CursorCloudReplicaLink | undefined;
  private discovery: AbortController | undefined;
  private transport: "unknown" | "loro" | "cursor" = "unknown";
  private blocked: SyncErrorClassification | undefined;

  /** Set when the link stopped retrying because the user must act. */
  get actionRequired(): SyncErrorClassification | undefined {
    return this.blocked;
  }

  constructor(private readonly options: LoroCloudReplicaLinkOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.blocked = undefined;
    this.connect();
  }

  publish(update: Uint8Array): void {
    // If disconnected, no volatile queue is needed: join() compares VersionVectors
    // and sends every operation the cloud is missing after reconnect.
    if (this.cursorLink) this.cursorLink.publish(update);
    else this.session?.sendExternalUpdate(update);
  }

  close(): void | Promise<void> {
    this.stopped = true;
    this.discovery?.abort();
    const cursorClosed = this.cursorLink?.close();
    this.cursorLink = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.session?.destroy();
    this.session = undefined;
    this.socket?.close();
    this.socket = undefined;
    return cursorClosed;
  }

  private connect(): void {
    if (this.stopped) return;
    if (!this.options.createSocket && this.transport !== "loro") {
      void this.discoverTransport();
      return;
    }
    const headers: Record<string, string> = this.options.token
      ? { authorization: `Bearer ${this.options.token}` }
      : {};
    headers["x-client-type"] = "cli";
    headers["x-device-name"] = encodeURIComponent(`Clash Host · ${hostname()}`);
    const socket = (this.options.createSocket ?? defaultSocketFactory)(
      cloudRoomUrl(this.options.baseUrl, this.options.projectId),
      headers,
    );
    this.socket = socket;
    let joined = false;
    const session = new LoroProtocolClientSession({
      roomId: this.options.projectId,
      doc: this.options.doc(),
      send: (frame) => {
        // A socket may leave OPEN after an update was durably imported but
        // before its ACK is sent. That is a transport disconnect, not an
        // application failure; the next VersionVector join reconciles it.
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(frame);
      },
      subscribeLocalUpdates: false,
      commit: this.options.commit,
      onJoined: () => {
        this.retry = 0;
        joined = true;
        this.options.onJoined?.();
      },
      onError: (error) => this.report(error),
      onUpdateRejected: (_batchId, status) => {
        this.report(
          new Error(`Cloud rejected Loro update with status ${status}`),
        );
      },
    });
    this.session = session;

    socket.on("open", () => session.join());
    socket.on("message", (data: RawData, isBinary = true) => {
      if (!isBinary) return;
      void session.receive(bytesFromRawData(data)).catch((error) => {
        this.report(error instanceof Error ? error : new Error(String(error)));
      });
    });
    let upgradeStatus: number | undefined;
    socket.on("error", (error: Error) => {
      const status = UPGRADE_STATUS.exec(error?.message ?? "")?.[1];
      if (status) upgradeStatus = Number(status);
      this.report(error);
    });
    socket.on("close", (code?: number) => {
      session.destroy();
      if (joined) {
        joined = false;
        this.options.onDisconnected?.();
      }
      if (this.session === session) this.session = undefined;
      if (this.socket === socket) this.socket = undefined;
      const classification = classifySyncError(
        upgradeStatus !== undefined
          ? { httpStatus: upgradeStatus }
          : { wsCloseCode: typeof code === "number" ? code : 1006 },
      );
      if (classification.policy.retry === "none") {
        this.block(
          classification,
          upgradeStatus !== undefined
            ? `Cloud refused the sync connection (HTTP ${upgradeStatus})`
            : `Cloud closed the sync connection (${code})`,
        );
        return;
      }
      this.scheduleReconnect();
    });
  }

  private async discoverTransport(): Promise<void> {
    const url = new URL(this.options.baseUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/api/v1/projects/${encodeURIComponent(this.options.projectId)}/replica`;
    const controller = new AbortController();
    this.discovery = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        headers: this.options.token
          ? { authorization: `Bearer ${this.options.token}` }
          : {},
        signal: controller.signal,
      });
      if (this.stopped || this.discovery !== controller) return;
      if (
        response.status === 404 ||
        response.status === 405 ||
        response.status === 426
      ) {
        this.transport = "loro";
        this.connect();
        return;
      }
      if (response.status === 401 || response.status === 403) {
        this.block(
          classifySyncError({ httpStatus: response.status }),
          `Cloud replica discovery ${response.status}`,
        );
        return;
      }
      if (!response.ok)
        throw Error(`Cloud replica discovery ${response.status}`);
      const profile = (await response.json()) as { protocol?: string };
      if (profile.protocol !== "loro-streams-v1")
        throw Error("Unsupported replica protocol");
      if (this.stopped || this.discovery !== controller) return;
      this.transport = "cursor";
      this.cursorLink = new CursorCloudReplicaLink(this.options, url.href);
      this.cursorLink.start();
    } catch (error) {
      if (!this.stopped && this.discovery === controller) {
        this.report(error instanceof Error ? error : Error(String(error)));
        this.scheduleReconnect();
      }
    } finally {
      clearTimeout(timeout);
      if (this.discovery === controller) this.discovery = undefined;
    }
  }

  private block(classification: SyncErrorClassification, message: string): void {
    if (this.stopped || this.blocked) return;
    this.blocked = classification;
    // Stop like close(), but keep the reason so callers can surface it.
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const error = new CloudReplicaLinkActionRequiredError(classification, message);
    this.report(error);
    this.options.onActionRequired?.(classification, error);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(500 * 1.5 ** this.retry++, 5_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private report(error: Error): void {
    if (this.options.onError) this.options.onError(error);
    else console.error("[local-sync] cloud replica link failed", error);
  }
}

function defaultSocketFactory(
  url: string,
  headers: Record<string, string>,
): ReplicaLinkSocket {
  return new WebSocket(url, { headers });
}
