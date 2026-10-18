import { createHash } from "node:crypto";
import type { ReplicaLinkPort } from "@clash/replica";
import { createReplicaStreamClient } from "@clash/replica/replica-stream-client";
import { classifySyncError } from "@clash/shared-types";
import {
  CloudReplicaLinkActionRequiredError,
  type LoroCloudReplicaLinkOptions,
} from "./cloud-replica-link.ts";

/** HTTP status of a replica stream failure, if the server answered one. */
function failureStatus(error: unknown): number | undefined {
  const value = error as { status?: unknown; error?: { status?: unknown } } | null;
  const status = value?.status ?? value?.error?.status;
  return typeof status === "number" ? status : undefined;
}
/** Loro belongs to the local Host. The remote endpoint only stores/replays bytes. */
export class CursorCloudReplicaLink implements ReplicaLinkPort<Uint8Array> {
  private cursor: string | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private uploads: Promise<void> = Promise.resolve();
  private client: ReturnType<typeof createReplicaStreamClient> | undefined;
  constructor(
    private readonly options: LoroCloudReplicaLinkOptions,
    private readonly url: string,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  publish(update: Uint8Array) {
    const bytes = update.slice();
    const client = this.client;
    this.uploads = this.uploads
      .then(async () => {
        if (client && client === this.client && !this.stopped)
          await client.append(this.id(bytes), bytes);
      })
      .catch((error) => {
        if (client === this.client) this.failed(error);
      });
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    await this.client?.close();
    this.client = undefined;
  }
  private id(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex");
  }
  private failed(error: unknown) {
    if (this.stopped) return;
    const status = failureStatus(error);
    if (status === 401 || status === 403) {
      // Revoked or expired credential / lost access: retrying cannot succeed.
      // Stop and ask the user, like the WebSocket link does on 1008.
      this.stopped = true;
      clearTimeout(this.retry);
      this.retry = undefined;
      const old = this.client;
      this.client = undefined;
      void old?.close();
      const classification = classifySyncError({ httpStatus: status });
      const code = (error as { code?: unknown }).code;
      const blocked = new CloudReplicaLinkActionRequiredError(
        classification,
        `Cloud replica ${status}${typeof code === "string" ? ` ${code}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.options.onError?.(blocked);
      this.options.onDisconnected?.();
      this.options.onActionRequired?.(classification, blocked);
      return;
    }
    this.options.onError?.(
      error instanceof Error ? error : Error(String(error)),
    );
    this.options.onDisconnected?.();
    const old = this.client;
    this.client = undefined;
    void old?.close();
    if (!this.retry)
      this.retry = setTimeout(() => {
        this.retry = undefined;
        if (!this.stopped) this.connect();
      }, 1000);
    this.retry.unref();
  }
  private connect() {
    // Re-export local durable state on a new connection to recover uploads lost while offline.
    // Content-derived IDs make retries stable. No cloud document is constructed here.
    const local = this.options.doc().export({ mode: "snapshot" });
    const client = createReplicaStreamClient({
      url: this.url,
      headers: this.options.token
        ? { authorization: `Bearer ${this.options.token}` }
        : {},
      loadCursor: async () => this.cursor,
      apply: async (record) => {
        if (record.data.length) {
          const hash = createHash("sha256");
          for (const bytes of record.data) {
            hash.update(String(bytes.length) + ":");
            hash.update(bytes);
          }
          const hex = hash.digest("hex").slice(0, 16);
          await this.options.commit(`0x${hex}`, record.data);
        }
        this.cursor = record.cursor;
      },
      onReady: () => {
        if (this.client !== client || this.stopped) return;
        void client
          .append(this.id(local), local)
          .then(() => {
            if (this.client === client) {
              this.options.onJoined?.();
            }
          })
          .catch((error) => {
            if (client === this.client) this.failed(error);
          });
      },
      onDisconnected: this.options.onDisconnected,
      onError: (error) => this.failed(error),
    });
    this.client = client;
    void client.start().catch((error) => {
      if (client === this.client) this.failed(error);
    });
  }
}
