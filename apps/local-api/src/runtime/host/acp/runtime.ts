import { createHash } from "node:crypto";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpForkPoint } from "@clash/shared-types";
import {
  AcpRuntimeImpl as SharedRuntime,
  type AgentSpec,
  type SessionOptions,
  type Spawner,
} from "@openma/common/acp-runtime";

interface LegacyModels {
  currentModelId: string;
  availableModels: Array<{ modelId: string; name: string }>;
}

export interface ClashAcpStartOptions extends SessionOptions {
  forkPoint?: AcpForkPoint;
  /** Merged into the initialize request. v0.6.0 builds client capabilities
   * internally and has no host overlay slot. */
  clientCapabilities?: ClientCapabilities;
}

/** Clash adapter over `@openma/common` `AcpRuntimeImpl`. It does not
 * reimplement session lifecycle. It only observes the legacy models catalog
 * the SDK strips, forwards an inclusive fork boundary through
 * `sessionRequestMeta`, and merges host capability flags into initialize. */
export class AcpRuntimeImpl extends SharedRuntime {
  private readonly catalogs: WeakMap<AgentSpec, { models?: LegacyModels }>;

  private readonly capabilityOverlays: WeakMap<AgentSpec, ClientCapabilities>;

  constructor(spawner: Spawner) {
    const catalogs = new WeakMap<AgentSpec, { models?: LegacyModels }>();
    const capabilityOverlays = new WeakMap<AgentSpec, ClientCapabilities>();
    super({
      async spawn(spec) {
        const child = await spawner.spawn(spec);
        const catalog: { models?: LegacyModels } = {};
        catalogs.set(spec, catalog);
        const overlay = capabilityOverlays.get(spec);
        return {
          ...child,
          stdin: overlay ? withCapabilityOverlay(child.stdin, overlay) : child.stdin,
          stdout: observeLegacyModels(child.stdout, catalog),
        };
      },
    });
    this.catalogs = catalogs;
    this.capabilityOverlays = capabilityOverlays;
  }

  override async start(options: ClashAcpStartOptions) {
    const { forkPoint, clientCapabilities, ...rest } = options;
    if (clientCapabilities) this.capabilityOverlays.set(options.agent, clientCapabilities);
    else this.capabilityOverlays.delete(options.agent);
    const sessionRequestMeta = forkPoint
      ? {
          ...(rest.sessionRequestMeta ?? {}),
          jetbrains: {
            air: {
              fork: {
                version: 1,
                messageId: forkPoint.messageId,
                messageFingerprint: `sha256:${createHash("sha256").update(forkPoint.messageText, "utf8").digest("hex")}`,
                messageOccurrence: forkPoint.messageOccurrence,
              },
            },
          },
        }
      : rest.sessionRequestMeta;
    const session = await super.start({
      ...rest,
      ...(sessionRequestMeta ? { sessionRequestMeta } : {}),
    });
    return Object.assign(session, { models: this.catalogs.get(options.agent)?.models });
  }
}

function observeLegacyModels(
  source: ReadableStream<Uint8Array>,
  catalog: { models?: LegacyModels },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let pending = "";
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!catalog.models) {
          pending += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            const models = legacyModelsFromLine(line);
            if (models) catalog.models = models;
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function legacyModelsFromLine(line: string): LegacyModels | undefined {
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
      return models;
    }
  } catch {
    /* The SDK owns malformed-frame handling. */
  }
  return undefined;
}

function withCapabilityOverlay(
  target: WritableStream<Uint8Array>,
  overlay: ClientCapabilities,
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
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        await writer.write(encoder.encode(rewriteInitialize(line, overlay) + "\n"));
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

function rewriteInitialize(line: string, overlay: ClientCapabilities): string {
  try {
    const message = JSON.parse(line) as {
      method?: unknown;
      params?: { clientCapabilities?: ClientCapabilities };
    };
    if (message.method !== "initialize" || !message.params) return line;
    message.params.clientCapabilities = mergeClientCapabilities(
      message.params.clientCapabilities,
      overlay,
    );
    return JSON.stringify(message);
  } catch {
    return line;
  }
}

function mergeClientCapabilities(
  base: ClientCapabilities | undefined,
  extra: ClientCapabilities,
): ClientCapabilities {
  const left = base ?? {};
  const leftSession = left.session as { configOptions?: Record<string, unknown> } | undefined;
  const rightSession = extra.session as { configOptions?: Record<string, unknown> } | undefined;
  const leftAuth = left.auth as { _meta?: Record<string, unknown> } | undefined;
  const rightAuth = extra.auth as { _meta?: Record<string, unknown> } | undefined;
  return {
    ...left,
    ...extra,
    ...(left.fs || extra.fs ? { fs: { ...left.fs, ...extra.fs } } : {}),
    ...(leftSession || rightSession
      ? {
          session: {
            ...(leftSession ?? {}),
            ...(rightSession ?? {}),
            ...(leftSession?.configOptions || rightSession?.configOptions
              ? {
                  configOptions: {
                    ...(leftSession?.configOptions ?? {}),
                    ...(rightSession?.configOptions ?? {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(leftAuth || rightAuth
      ? {
          auth: {
            ...(leftAuth ?? {}),
            ...(rightAuth ?? {}),
            ...(leftAuth?._meta || rightAuth?._meta
              ? { _meta: { ...(leftAuth?._meta ?? {}), ...(rightAuth?._meta ?? {}) } }
              : {}),
          },
        }
      : {}),
    ...(left._meta || extra._meta
      ? { _meta: { ...(left._meta ?? {}), ...(extra._meta ?? {}) } }
      : {}),
  };
}
