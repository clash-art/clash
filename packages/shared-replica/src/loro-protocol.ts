import { LoroDoc, VersionVector } from "loro-crdt";
import {
  CrdtType,
  MAX_MESSAGE_SIZE,
  MessageType,
  UpdateStatusCode,
  bytesToHex,
  decode,
  encode,
  type DocUpdate,
  type DocUpdateFragment,
  type DocUpdateFragmentHeader,
  type HexString,
  type ProtocolMessage,
} from "loro-protocol";

export {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  decode,
  encode,
} from "loro-protocol";
export type { HexString } from "loro-protocol";

const MAX_FRAGMENT_BATCH_BYTES = 64 * 1024 * 1024;
const FRAGMENT_TIMEOUT_MS = 10_000;
const OUTBOUND_FRAGMENT_BYTES = 240 * 1024;

export function createLoroProtocolBatchId(): HexString {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function encodeLoroProtocolUpdateFrames(
  roomId: string,
  batchId: HexString,
  updates: Uint8Array[],
): Uint8Array[] {
  try {
    return [
      encode({
        type: MessageType.DocUpdate,
        crdt: CrdtType.Loro,
        roomId,
        batchId,
        updates,
      }),
    ];
  } catch (error) {
    const totalBytes = updates.reduce(
      (total, update) => total + update.byteLength,
      0,
    );
    if (totalBytes <= MAX_MESSAGE_SIZE / 2) throw error;
  }

  const frames: Uint8Array[] = [];
  updates.forEach((update, updateIndex) => {
    const updateBatchId =
      updateIndex === 0 ? batchId : createLoroProtocolBatchId();
    const fragmentCount = Math.ceil(
      update.byteLength / OUTBOUND_FRAGMENT_BYTES,
    );
    frames.push(
      encode({
        type: MessageType.DocUpdateFragmentHeader,
        crdt: CrdtType.Loro,
        roomId,
        batchId: updateBatchId,
        fragmentCount,
        totalSizeBytes: update.byteLength,
      }),
    );
    for (let index = 0; index < fragmentCount; index++) {
      frames.push(
        encode({
          type: MessageType.DocUpdateFragment,
          crdt: CrdtType.Loro,
          roomId,
          batchId: updateBatchId,
          index,
          fragment: update.subarray(
            index * OUTBOUND_FRAGMENT_BYTES,
            Math.min((index + 1) * OUTBOUND_FRAGMENT_BYTES, update.byteLength),
          ),
        }),
      );
    }
  });
  return frames;
}

function exactBytes(value: Uint8Array): Uint8Array {
  return value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
    ? value
    : value.slice();
}

export interface LoroProtocolServerSessionOptions {
  roomId: string;
  doc(): LoroDoc;
  /** Must durably append and apply all updates before resolving. */
  commit(batchId: HexString, updates: Uint8Array[]): Promise<void>;
  send(frame: Uint8Array): void | Promise<void>;
  broadcast?(batchId: HexString, updates: Uint8Array[]): void | Promise<void>;
  permission?: "read" | "write";
  /** Used when a hibernated server revives an already-authenticated socket. */
  assumeJoined?: boolean;
}

export interface LoroProtocolClientSessionOptions {
  roomId: string;
  doc: LoroDoc;
  send(frame: Uint8Array): void | Promise<void>;
  /** Lets a durable local host append/apply the update before protocol ACK. */
  commit?(batchId: HexString, updates: Uint8Array[]): Promise<void>;
  /** Browser replicas use this; server-to-server links publish committed events explicitly. */
  subscribeLocalUpdates?: boolean;
  onJoined?(permission: "read" | "write"): void;
  onError?(error: Error): void;
  onUpdateRejected?(
    batchId: HexString,
    status: UpdateStatusCode,
    updates: Uint8Array[],
  ): void;
}

interface FragmentBatch {
  header: DocUpdateFragmentHeader;
  fragments: Map<number, Uint8Array>;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Transport-neutral server side of the official Loro room protocol.
 * Authentication remains the responsibility of the HTTP/WebSocket host.
 */
export class LoroProtocolServerSession {
  private joined: boolean;
  private readonly fragments = new Map<HexString, FragmentBatch>();

  constructor(private readonly options: LoroProtocolServerSessionOptions) {
    this.joined = options.assumeJoined ?? false;
  }

  async receive(frame: Uint8Array): Promise<void> {
    const message = decode(frame);
    if (
      message.crdt !== CrdtType.Loro ||
      message.roomId !== this.options.roomId
    ) {
      throw new Error("Loro protocol room does not match this replica host");
    }
    await this.handle(message);
  }

  destroy(): void {
    for (const batch of this.fragments.values()) clearTimeout(batch.timeout);
    this.fragments.clear();
  }

  private async handle(message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case MessageType.JoinRequest:
        await this.join(message.version);
        return;
      case MessageType.DocUpdate:
        await this.commit(message);
        return;
      case MessageType.DocUpdateFragmentHeader:
        await this.startFragments(message);
        return;
      case MessageType.DocUpdateFragment:
        await this.addFragment(message);
        return;
      case MessageType.Leave:
        this.joined = false;
        return;
      case MessageType.Ack:
      case MessageType.RoomError:
        return;
      case MessageType.JoinResponseOk:
      case MessageType.JoinError:
        throw new Error("Server received a client-only Loro protocol message");
    }
  }

  private async join(clientVersionBytes: Uint8Array): Promise<void> {
    const doc = this.options.doc();
    const version = doc.version();
    try {
      await this.options.send(
        encode({
          type: MessageType.JoinResponseOk,
          crdt: CrdtType.Loro,
          roomId: this.options.roomId,
          permission: this.options.permission ?? "write",
          version: version.encode(),
        }),
      );
      this.joined = true;

      let update: Uint8Array;
      if (clientVersionBytes.byteLength === 0) {
        update = doc.export({ mode: "snapshot" });
      } else {
        const clientVersion = VersionVector.decode(clientVersionBytes);
        try {
          update = doc.export({ mode: "update", from: clientVersion });
        } finally {
          clientVersion.free();
        }
      }
      if (update.byteLength > 0) {
        await this.sendUpdates(createLoroProtocolBatchId(), [update]);
      }
    } finally {
      version.free();
    }
  }

  private async commit(message: DocUpdate): Promise<void> {
    if (!this.joined || (this.options.permission ?? "write") !== "write") {
      await this.ack(message.batchId, UpdateStatusCode.PermissionDenied);
      return;
    }
    if (
      message.updates.some(
        (update) => update.byteLength > MAX_FRAGMENT_BATCH_BYTES,
      )
    ) {
      await this.ack(message.batchId, UpdateStatusCode.PayloadTooLarge);
      return;
    }
    try {
      await this.options.commit(
        message.batchId,
        message.updates.map(exactBytes),
      );
    } catch {
      await this.ack(message.batchId, UpdateStatusCode.AppError);
      return;
    }

    let ackFailed = false;
    let ackError: unknown;
    try {
      await this.ack(message.batchId, UpdateStatusCode.Ok);
    } catch (error) {
      ackFailed = true;
      ackError = error;
    }
    await this.options.broadcast?.(message.batchId, message.updates);
    if (ackFailed) throw ackError;
  }

  private async startFragments(
    message: DocUpdateFragmentHeader,
  ): Promise<void> {
    const previous = this.fragments.get(message.batchId);
    if (previous) clearTimeout(previous.timeout);
    if (
      message.fragmentCount <= 0 ||
      message.totalSizeBytes <= 0 ||
      message.totalSizeBytes > MAX_FRAGMENT_BATCH_BYTES
    ) {
      await this.ack(message.batchId, UpdateStatusCode.PayloadTooLarge);
      return;
    }
    const timeout = setTimeout(() => {
      this.fragments.delete(message.batchId);
      void this.ack(message.batchId, UpdateStatusCode.FragmentTimeout);
    }, FRAGMENT_TIMEOUT_MS);
    this.fragments.set(message.batchId, {
      header: message,
      fragments: new Map(),
      timeout,
    });
  }

  private async addFragment(message: DocUpdateFragment): Promise<void> {
    const batch = this.fragments.get(message.batchId);
    if (
      !batch ||
      message.index < 0 ||
      message.index >= batch.header.fragmentCount
    ) {
      await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
      return;
    }
    batch.fragments.set(message.index, exactBytes(message.fragment));
    if (batch.fragments.size !== batch.header.fragmentCount) return;

    clearTimeout(batch.timeout);
    this.fragments.delete(message.batchId);
    const update = new Uint8Array(batch.header.totalSizeBytes);
    let offset = 0;
    for (let index = 0; index < batch.header.fragmentCount; index++) {
      const fragment = batch.fragments.get(index);
      if (!fragment || offset + fragment.byteLength > update.byteLength) {
        await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
        return;
      }
      update.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (offset !== update.byteLength) {
      await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
      return;
    }
    await this.commit({
      type: MessageType.DocUpdate,
      crdt: CrdtType.Loro,
      roomId: this.options.roomId,
      batchId: message.batchId,
      updates: [update],
    });
  }

  private async ack(refId: HexString, status: UpdateStatusCode): Promise<void> {
    await this.options.send(
      encode({
        type: MessageType.Ack,
        crdt: CrdtType.Loro,
        roomId: this.options.roomId,
        refId,
        status,
      }),
    );
  }

  private async sendUpdates(
    batchId: HexString,
    updates: Uint8Array[],
  ): Promise<void> {
    for (const frame of encodeLoroProtocolUpdateFrames(
      this.options.roomId,
      batchId,
      updates,
    )) {
      await this.options.send(frame);
    }
  }
}

/**
 * Transport-neutral client side of the official Loro room protocol.
 *
 * Re-running join() after reconnect uses the local VersionVector, so changes
 * committed while offline are uploaded after the server reports its version.
 */
export class LoroProtocolClientSession {
  private joined = false;
  private recoveryRequired = false;
  private permission: "read" | "write" = "read";
  private unsubscribeLocalUpdates: (() => void) | undefined;
  private readonly pending = new Map<HexString, Uint8Array[]>();
  private readonly fragments = new Map<HexString, FragmentBatch>();

  constructor(private readonly options: LoroProtocolClientSessionOptions) {}

  join(auth = new Uint8Array()): void {
    if (this.recoveryRequired) {
      this.options.onError?.(new Error("Recover the rejected local replica before starting a new sync session."));
      return;
    }
    this.joined = false;
    const version = this.options.doc.version();
    try {
      this.dispatch(
        encode({
          type: MessageType.JoinRequest,
          crdt: CrdtType.Loro,
          roomId: this.options.roomId,
          auth,
          version: version.encode(),
        }),
      );
    } finally {
      version.free();
    }
  }

  async receive(frame: Uint8Array): Promise<void> {
    const message = decode(frame);
    if (
      message.crdt !== CrdtType.Loro ||
      message.roomId !== this.options.roomId
    ) {
      throw new Error("Loro protocol room does not match this replica client");
    }
    await this.handle(message);
  }

  /** Sends a durably accepted update that was imported by another local peer. */
  sendExternalUpdate(update: Uint8Array): boolean {
    if (!this.joined || this.permission !== "write") return false;
    this.sendUpdates([exactBytes(update)]);
    return true;
  }

  isJoined(): boolean {
    return this.joined;
  }

  destroy(): void {
    this.joined = false;
    this.unsubscribeLocalUpdates?.();
    this.unsubscribeLocalUpdates = undefined;
    for (const batch of this.fragments.values()) clearTimeout(batch.timeout);
    this.fragments.clear();
    this.pending.clear();
  }

  private async handle(message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case MessageType.JoinResponseOk:
        await this.finishJoin(message.permission, message.version);
        return;
      case MessageType.JoinError:
      case MessageType.RoomError:
        this.joined = false;
        this.options.onError?.(new Error(message.message));
        return;
      case MessageType.DocUpdate:
        await this.importUpdate(message);
        return;
      case MessageType.DocUpdateFragmentHeader:
        await this.startFragments(message);
        return;
      case MessageType.DocUpdateFragment:
        await this.addFragment(message);
        return;
      case MessageType.Ack:
        this.finishPending(message.refId, message.status);
        return;
      case MessageType.Leave:
        this.joined = false;
        return;
      case MessageType.JoinRequest:
        throw new Error("Client received a server-only Loro protocol message");
    }
  }

  private async finishJoin(
    permission: "read" | "write",
    serverVersionBytes: Uint8Array,
  ): Promise<void> {
    if (this.recoveryRequired) return;
    this.permission = permission;
    this.joined = true;
    this.subscribeToLocalUpdates();

    if (permission === "write") {
      const serverVersion = VersionVector.decode(serverVersionBytes);
      try {
        const missing = this.options.doc.export({
          mode: "update",
          from: serverVersion,
        });
        if (missing.byteLength > 0) this.sendUpdates([missing]);
      } finally {
        serverVersion.free();
      }
    }
    this.options.onJoined?.(permission);
  }

  private subscribeToLocalUpdates(): void {
    if (
      this.options.subscribeLocalUpdates === false ||
      this.unsubscribeLocalUpdates
    ) {
      return;
    }
    this.unsubscribeLocalUpdates = this.options.doc.subscribeLocalUpdates(
      (update: Uint8Array) => {
        if (!this.joined || this.permission !== "write") return;
        this.sendUpdates([exactBytes(update)]);
      },
    );
  }

  private async importUpdate(message: DocUpdate): Promise<void> {
    if (
      message.updates.some(
        (update) => update.byteLength > MAX_FRAGMENT_BATCH_BYTES,
      )
    ) {
      await this.ack(message.batchId, UpdateStatusCode.PayloadTooLarge);
      return;
    }
    const updates = message.updates.map(exactBytes);
    if (this.options.commit) {
      try {
        await this.options.commit(message.batchId, updates);
      } catch (error) {
        try {
          await this.ack(message.batchId, UpdateStatusCode.AppError);
        } finally {
          this.options.onError?.(
            error instanceof Error
              ? error
              : new Error("Replica durability callback failed"),
          );
        }
        return;
      }
      await this.ack(message.batchId, UpdateStatusCode.Ok);
      return;
    }
    try {
      if (updates.length > 0) {
        this.options.doc.importBatch(updates);
      }
      await this.ack(message.batchId, UpdateStatusCode.Ok);
    } catch (error) {
      await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
      this.options.onError?.(
        error instanceof Error ? error : new Error("Invalid Loro update"),
      );
    }
  }

  private async startFragments(
    message: DocUpdateFragmentHeader,
  ): Promise<void> {
    const previous = this.fragments.get(message.batchId);
    if (previous) clearTimeout(previous.timeout);
    if (
      message.fragmentCount <= 0 ||
      message.totalSizeBytes <= 0 ||
      message.totalSizeBytes > MAX_FRAGMENT_BATCH_BYTES
    ) {
      await this.ack(message.batchId, UpdateStatusCode.PayloadTooLarge);
      return;
    }
    const timeout = setTimeout(() => {
      this.fragments.delete(message.batchId);
      void this.ack(message.batchId, UpdateStatusCode.FragmentTimeout);
    }, FRAGMENT_TIMEOUT_MS);
    this.fragments.set(message.batchId, {
      header: message,
      fragments: new Map(),
      timeout,
    });
  }

  private async addFragment(message: DocUpdateFragment): Promise<void> {
    const batch = this.fragments.get(message.batchId);
    if (
      !batch ||
      message.index < 0 ||
      message.index >= batch.header.fragmentCount
    ) {
      await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
      return;
    }
    batch.fragments.set(message.index, exactBytes(message.fragment));
    if (batch.fragments.size !== batch.header.fragmentCount) return;

    clearTimeout(batch.timeout);
    this.fragments.delete(message.batchId);
    const update = new Uint8Array(batch.header.totalSizeBytes);
    let offset = 0;
    for (let index = 0; index < batch.header.fragmentCount; index++) {
      const fragment = batch.fragments.get(index);
      if (!fragment || offset + fragment.byteLength > update.byteLength) {
        await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
        return;
      }
      update.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (offset !== update.byteLength) {
      await this.ack(message.batchId, UpdateStatusCode.InvalidUpdate);
      return;
    }
    await this.importUpdate({
      type: MessageType.DocUpdate,
      crdt: CrdtType.Loro,
      roomId: this.options.roomId,
      batchId: message.batchId,
      updates: [update],
    });
  }

  private finishPending(refId: HexString, status: UpdateStatusCode): void {
    const updates = this.pending.get(refId);
    if (!updates) return;
    this.pending.delete(refId);
    if (status !== UpdateStatusCode.Ok) {
      // Later local operations can depend on the rejected CRDT operation ids.
      // Preserve the document for recovery, but never keep publishing that chain.
      this.recoveryRequired = true;
      this.joined = false;
      this.unsubscribeLocalUpdates?.();
      this.unsubscribeLocalUpdates = undefined;
      this.options.onUpdateRejected?.(refId, status, updates);
    }
  }

  private sendUpdates(updates: Uint8Array[]): void {
    const batchId = createLoroProtocolBatchId();
    this.pending.set(batchId, updates);
    for (const frame of encodeLoroProtocolUpdateFrames(
      this.options.roomId,
      batchId,
      updates,
    )) {
      this.dispatch(frame);
    }
  }

  private dispatch(frame: Uint8Array): void {
    try {
      const result = this.options.send(frame);
      if (result instanceof Promise) {
        void result.catch((error) => this.reportSendError(error));
      }
    } catch (error) {
      this.reportSendError(error);
    }
  }

  private reportSendError(error: unknown): void {
    this.options.onError?.(
      error instanceof Error ? error : new Error("Loro transport send failed"),
    );
  }

  private async ack(refId: HexString, status: UpdateStatusCode): Promise<void> {
    await this.options.send(
      encode({
        type: MessageType.Ack,
        crdt: CrdtType.Loro,
        roomId: this.options.roomId,
        refId,
        status,
      }),
    );
  }
}
