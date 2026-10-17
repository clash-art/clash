/**
 * Startup CPU (#161): the Worker entry must export Durable Object classes
 * synchronously, but evaluating their implementation modules (shared-types
 * zod schemas, Loro, the AI SDK, MCP, ajv, …) costs ~100 ms on every isolate
 * start, including isolates that only serve stateless requests.
 *
 * These thin classes are what the entry exports. Each one constructs the real
 * Durable Object on its first event (with the same ctx/env) and forwards the
 * runtime entry points to it. Callers only reach these objects through
 * `stub.fetch()`, so the forwarded surface is the complete contract. Neither
 * implementation does input-gated work in its constructor (partyserver
 * initializes inside `fetch`), so constructing on first event preserves
 * ordering: the dynamic `import()` of a bundled module settles in microtasks,
 * before the runtime can deliver another event.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../config";

type DurableObjectImpl = Pick<
  DurableObject<Env>,
  "fetch" | "alarm" | "webSocketMessage" | "webSocketClose" | "webSocketError"
>;
type DurableObjectImplClass = new (
  ctx: DurableObjectState,
  env: Env,
) => DurableObjectImpl;

abstract class LazyDurableObject extends DurableObject<Env> {
  #impl: Promise<DurableObjectImpl> | undefined;

  protected abstract load(): Promise<DurableObjectImplClass>;

  #instance(): Promise<DurableObjectImpl> {
    return (this.#impl ??= this.load().then(
      (Impl) => new Impl(this.ctx, this.env),
      (error: unknown) => {
        // A failed load must not wedge the object; the next event retries,
        // as it would after a throwing constructor.
        this.#impl = undefined;
        throw error;
      },
    ));
  }

  override async fetch(request: Request): Promise<Response> {
    return (await this.#instance()).fetch!(request);
  }

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await (await this.#instance()).alarm?.(alarmInfo);
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await (await this.#instance()).webSocketMessage?.(ws, message);
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    await (await this.#instance()).webSocketClose?.(ws, code, reason, wasClean);
  }

  override async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await (await this.#instance()).webSocketError?.(ws, error);
  }
}

export class ProjectRoom extends LazyDurableObject {
  protected load() {
    return import("./project-room").then((m) => m.ProjectRoom);
  }
}

export class SupervisorAgent extends LazyDurableObject {
  protected load() {
    return import("./supervisor").then(
      (m) => m.SupervisorAgent as unknown as DurableObjectImplClass,
    );
  }
}
