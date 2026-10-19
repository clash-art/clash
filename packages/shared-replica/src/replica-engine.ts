export interface ReplicaEvent<TUpdate, TMetadata = unknown> {
  id: string;
  update: TUpdate;
  metadata?: TMetadata;
}

export interface StoredReplicaEvent<
  TUpdate,
  TMetadata = unknown,
> extends ReplicaEvent<TUpdate, TMetadata> {
  /** Monotonic durability cursor. CRDT versions remain adapter-owned. */
  cursor: number;
}

export interface EventLogPort<TUpdate, TMetadata = unknown> {
  append(event: ReplicaEvent<TUpdate, TMetadata>): Promise<{
    appended: boolean;
    event: StoredReplicaEvent<TUpdate, TMetadata>;
  }>;
  readAfter(cursor: number): Promise<StoredReplicaEvent<TUpdate, TMetadata>[]>;
  /** Remove events at or below cursor. Implementations may retain more. */
  truncateThrough(cursor: number): Promise<void>;
}

export interface ReplicaCheckpoint<TCheckpoint> {
  cursor: number;
  data: TCheckpoint;
}

export interface CheckpointPort<TCheckpoint> {
  load(): Promise<ReplicaCheckpoint<TCheckpoint> | null>;
  save(checkpoint: ReplicaCheckpoint<TCheckpoint>): Promise<void>;
}

export interface StateAdapter<TState, TUpdate, TCheckpoint> {
  create(): TState | Promise<TState>;
  restore(checkpoint: TCheckpoint): TState | Promise<TState>;
  /** Must reject invalid data without mutating state. */
  validate(state: TState, update: TUpdate): void | Promise<void>;
  apply(state: TState, update: TUpdate): void | Promise<void>;
  checkpoint(state: TState): TCheckpoint | Promise<TCheckpoint>;
}

export interface FanoutPort<TUpdate, TMetadata = unknown> {
  publish(event: StoredReplicaEvent<TUpdate, TMetadata>): void | Promise<void>;
}

/** A reconnecting replica-to-replica transport (for example local host → cloud). */
export interface ReplicaLinkPort<TUpdate> {
  start(): void | Promise<void>;
  publish(update: TUpdate): void | Promise<void>;
  close(): void | Promise<void>;
}

export type ReplicaWork =
  | { kind: "checkpoint"; throughCursor: number }
  | { kind: "projection"; name: string; throughCursor: number };

export interface WorkSchedulerPort {
  /** Requests are at-least-once and should be durably coalesced by kind/name. */
  request(work: ReplicaWork): void | Promise<void>;
}

export interface ProjectionPort<TUpdate, TMetadata = unknown> {
  name: string;
  loadCursor(): Promise<number>;
  /** Must be idempotent because apply and saveCursor are not one transaction. */
  apply(events: StoredReplicaEvent<TUpdate, TMetadata>[]): void | Promise<void>;
  saveCursor(cursor: number): Promise<void>;
}

export interface CheckpointPolicyInput<TUpdate, TMetadata = unknown> {
  cursor: number;
  eventsSinceCheckpoint: number;
  event: StoredReplicaEvent<TUpdate, TMetadata>;
}

export interface ReplicaEngineOptions<
  TState,
  TUpdate,
  TCheckpoint,
  TMetadata = unknown,
> {
  adapter: StateAdapter<TState, TUpdate, TCheckpoint>;
  eventLog: EventLogPort<TUpdate, TMetadata>;
  checkpoints: CheckpointPort<TCheckpoint>;
  fanout?: FanoutPort<TUpdate, TMetadata>;
  scheduler?: WorkSchedulerPort;
  projections?: ProjectionPort<TUpdate, TMetadata>[];
  checkpointPolicy?: (
    input: CheckpointPolicyInput<TUpdate, TMetadata>,
  ) => boolean;
}

export class ReplicaEngine<TState, TUpdate, TCheckpoint, TMetadata = unknown> {
  private operationQueue: Promise<void> = Promise.resolve();
  private eventsSinceCheckpoint = 0;
  private readonly projectionByName: Map<
    string,
    ProjectionPort<TUpdate, TMetadata>
  >;

  private constructor(
    private state: TState,
    private currentCursor: number,
    private readonly options: ReplicaEngineOptions<
      TState,
      TUpdate,
      TCheckpoint,
      TMetadata
    >,
  ) {
    this.projectionByName = new Map(
      (options.projections ?? []).map((projection) => [
        projection.name,
        projection,
      ]),
    );
  }

  static async open<TState, TUpdate, TCheckpoint, TMetadata = unknown>(
    options: ReplicaEngineOptions<TState, TUpdate, TCheckpoint, TMetadata>,
  ): Promise<ReplicaEngine<TState, TUpdate, TCheckpoint, TMetadata>> {
    const checkpoint = await options.checkpoints.load();
    const state = checkpoint
      ? await options.adapter.restore(checkpoint.data)
      : await options.adapter.create();
    let cursor = checkpoint?.cursor ?? 0;
    const tail = await options.eventLog.readAfter(cursor);
    for (const event of tail) {
      await options.adapter.apply(state, event.update);
      cursor = Math.max(cursor, event.cursor);
    }
    const engine = new ReplicaEngine(state, cursor, options);
    engine.eventsSinceCheckpoint = tail.length;
    return engine;
  }

  get cursor(): number {
    return this.currentCursor;
  }

  read<TResult>(read: (state: TState) => TResult): TResult {
    return read(this.state);
  }

  submit(
    event: ReplicaEvent<TUpdate, TMetadata>,
    options?: {
      /**
       * The caller already applied this update through the adapter (for example
       * a live document at least as advanced as this replica), so the extra
       * state-free validation pass can be skipped.
       */
      prevalidated?: boolean;
    },
  ): Promise<{
    appended: boolean;
    event: StoredReplicaEvent<TUpdate, TMetadata>;
  }> {
    return this.enqueue(async () => {
      if (!options?.prevalidated) {
        await this.options.adapter.validate(this.state, event.update);
      }
      const result = await this.options.eventLog.append(event);
      if (!result.appended) return result;

      await this.options.adapter.apply(this.state, result.event.update);
      this.currentCursor = Math.max(this.currentCursor, result.event.cursor);
      this.eventsSinceCheckpoint += 1;

      await this.options.fanout?.publish(result.event);
      for (const projection of this.projectionByName.values()) {
        await this.options.scheduler?.request({
          kind: "projection",
          name: projection.name,
          throughCursor: this.currentCursor,
        });
      }
      if (
        this.options.checkpointPolicy?.({
          cursor: this.currentCursor,
          eventsSinceCheckpoint: this.eventsSinceCheckpoint,
          event: result.event,
        })
      ) {
        await this.options.scheduler?.request({
          kind: "checkpoint",
          throughCursor: this.currentCursor,
        });
      }
      return result;
    });
  }

  checkpoint(): Promise<ReplicaCheckpoint<TCheckpoint>> {
    return this.enqueue(async () => {
      const checkpoint = {
        cursor: this.currentCursor,
        data: await this.options.adapter.checkpoint(this.state),
      };
      await this.options.checkpoints.save(checkpoint);

      let retentionFloor = checkpoint.cursor;
      for (const projection of this.projectionByName.values()) {
        retentionFloor = Math.min(
          retentionFloor,
          await projection.loadCursor(),
        );
      }
      await this.options.eventLog.truncateThrough(retentionFloor);
      this.eventsSinceCheckpoint = 0;
      return checkpoint;
    });
  }

  project(name: string): Promise<number> {
    return this.enqueue(async () => {
      const projection = this.projectionByName.get(name);
      if (!projection) throw new Error(`Unknown projection: ${name}`);
      const cursor = await projection.loadCursor();
      const events = await this.options.eventLog.readAfter(cursor);
      if (events.length === 0) return cursor;
      await projection.apply(events);
      const throughCursor = events.at(-1)!.cursor;
      await projection.saveCursor(throughCursor);
      return throughCursor;
    });
  }

  private enqueue<TResult>(
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const run = this.operationQueue.then(operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
