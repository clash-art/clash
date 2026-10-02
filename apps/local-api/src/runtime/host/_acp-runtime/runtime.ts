import { createHash } from "node:crypto";
import type { AcpForkPoint } from "@clash/shared-types";
import { AcpRuntimeImpl as SharedRuntime } from "@openma/common/acp-runtime";
import type { AgentSpec, SessionOptions, Spawner } from "@openma/common/acp-runtime";

interface LegacyModels {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
}

/** Compatibility for adapters returning the retired ACP models field. The SDK
 * strips that field, while configOptions can contain synthetic current models.
 * Observe the original catalog without changing bytes or the shared lifecycle. */
export class AcpRuntimeImpl extends SharedRuntime {
  private readonly catalogs: WeakMap<AgentSpec, { models?: LegacyModels }>;

  private readonly forkPoints: WeakMap<AgentSpec, AcpForkPoint>;

  constructor(spawner: Spawner) {
    const forkPoints = new WeakMap<AgentSpec, AcpForkPoint>();
    const catalogs = new WeakMap<AgentSpec, { models?: LegacyModels }>();
    super({
      async spawn(spec) {
        const child = await spawner.spawn(spec);
        const catalog: { models?: LegacyModels } = {};
        catalogs.set(spec, catalog);
        const decoder = new TextDecoder();
        let pending = "";
        return {
          ...child,
          stdin: forkPoints.has(spec)
            ? withForkPoint(child.stdin, forkPoints.get(spec)!)
            : child.stdin,
          stdout: child.stdout.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                if (catalog.models) {
                  controller.enqueue(chunk);
                  return;
                }
                pending += decoder.decode(chunk, { stream: true });
                let end: number;
                while ((end = pending.indexOf("\n")) >= 0) {
                  const line = pending.slice(0, end);
                  pending = pending.slice(end + 1);
                  try {
                    const models = JSON.parse(line)?.result?.models;
                    if (
                      models &&
                      typeof models.currentModelId === "string" &&
                      Array.isArray(models.availableModels) &&
                      models.availableModels.every(
                        (model: { modelId?: unknown; name?: unknown } | null) =>
                          model &&
                          typeof model.modelId === "string" &&
                          typeof model.name === "string",
                      )
                    ) {
                      catalog.models = models;
                    }
                  } catch {
                    /* The SDK owns malformed-frame handling. */
                  }
                }
                controller.enqueue(chunk);
              },
            }),
          ),
        };
      },
    });
    this.catalogs = catalogs;
    this.forkPoints = forkPoints;
  }

  /**
   * Record a fork point for the next session started from `spec`.
   * The runtime injects it into the session/fork request before sending it to
   * the agent; other initialization remains normal. Call this before `start()`.
   */
  declareForkPoint(spec: AgentSpec, forkPoint: AcpForkPoint): void {
    this.forkPoints.set(spec, forkPoint);
  }

  /**
   * Compatibility shim for older agents that emit the legacy `models` field in
   * initialize. Web UI and Desktop use this to seed the model picker before any
   * `config_option_update` arrives; the Host does not persist the catalog.
   */
  getLegacyCatalogModels(spec: AgentSpec): LegacyModels | undefined {
    return this.catalogs.get(spec)?.models;
  }
}

function withForkPoint(
  target: WritableStream<Uint8Array>,
  point: AcpForkPoint,
): WritableStream<Uint8Array> {
  const writer = target.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return new WritableStream({
    async write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        let line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.method === "session/fork") {
            message.params._meta = {
              ...message.params._meta,
              jetbrains: {
                air: {
                  fork: {
                    version: 1,
                    messageId: point.messageId,
                    messageFingerprint: `sha256:${createHash("sha256").update(point.messageText, "utf8").digest("hex")}`,
                    messageOccurrence: point.messageOccurrence,
                  },
                },
              },
            };
            line = JSON.stringify(message);
          }
        } catch {
          /* Pass through invalid JSON; the SDK owns error handling. */
        }
        await writer.write(encoder.encode(line + "\n"));
      }
    },
    async close() {
      if (pending) throw new Error("Incomplete ACP request frame");
      await writer.close();
    },
    abort(reason) {
      return writer.abort(reason);
    },
  });
}
