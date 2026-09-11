import { ProviderExecutionError } from "@clash/action-sdk/executable-failure";
import { Buffer } from "node:buffer";
import type { DurableProviderStep } from "@clash/shared-runtime/durable-run-engine";
import type {
  ExecutablePluginAssetHandle,
  ExecutablePluginJsonValue,
} from "@clash/shared-types/executable-plugin";
import type { Env } from "../config";
import type { GenerationParams } from "./params";
import type { GenerationOutputBroker } from "./output";

/** Invocation-scoped IO. No journal, Workflow retries, D1 publication or Loro mutation. */
export class GenerationContext {
  constructor(
    public readonly params: GenerationParams,
    public readonly env: Env,
    private readonly broker: GenerationOutputBroker,
    private readonly coverBroker?: GenerationOutputBroker,
  ) {}
  get tag() {
    return { taskId: this.params.taskId, nodeId: this.params.nodeId };
  }
  /** Read an R2 object and return as base64 (native C++ via Buffer). */
  async readR2Base64(
    key: string,
  ): Promise<{ bytesBase64Encoded: string; mimeType: string }> {
    const obj = await this.env.R2_BUCKET.get(key);
    if (!obj) throw new Error(`R2 object not found: ${key}`);
    const mimeType =
      obj.httpMetadata?.contentType || "application/octet-stream";
    const buf = await obj.arrayBuffer();
    return {
      bytesBase64Encoded: Buffer.from(buf).toString("base64"),
      mimeType,
    };
  }

  /** Read R2 object as `data:` URI (for models that accept data URLs). */
  async readR2DataUri(key: string): Promise<string> {
    const { bytesBase64Encoded, mimeType } = await this.readR2Base64(key);
    return `data:${mimeType};base64,${bytesBase64Encoded}`;
  }

  async uploadBytes(
    data: Uint8Array | ArrayBuffer,
    mimeType: string,
  ): Promise<ExecutablePluginAssetHandle> {
    const kind =
      this.params.type === "image_gen"
        ? "image"
        : this.params.type === "audio_gen"
          ? "audio"
          : "video";
    try {
      return await this.broker.store(
        data instanceof Uint8Array ? data : new Uint8Array(data),
        mimeType,
        kind,
      );
    } catch (error) {
      throw new ProviderExecutionError({
        code: "output_persistence_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        requestState: "accepted",
      });
    }
  }
  async uploadFromUrl(
    url: string,
    mimeType: string,
  ): Promise<ExecutablePluginAssetHandle> {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(
          `Provider output download failed: HTTP ${response.status}`,
        );
      return await this.uploadBytes(await response.arrayBuffer(), mimeType);
    } catch (error) {
      throw new ProviderExecutionError({
        code: "output_persistence_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
        requestState: "accepted",
      });
    }
  }
  async completedVideo(
    url: string,
    mediaType: string,
    details: { duration?: number; coverImageUrl?: string },
  ): Promise<DurableProviderStep> {
    const asset = await this.uploadFromUrl(url, mediaType);
    let cover: ExecutablePluginAssetHandle | undefined;
    if (details.coverImageUrl && this.coverBroker) {
      try {
        const response = await fetch(details.coverImageUrl);
        if (response.ok)
          cover = await this.coverBroker.store(
            new Uint8Array(await response.arrayBuffer()),
            "image/jpeg",
            "image",
          );
      } catch {
        /* Provider covers were best-effort; the stage probe remains the fallback. */
      }
    }
    return this.completedMedia(asset, {
      ...(typeof details.duration === "number"
        ? { durationMs: Math.round(details.duration * 1000) }
        : {}),
      ...(cover
        ? { cover: cover as unknown as ExecutablePluginJsonValue }
        : {}),
    });
  }
  completedMedia(
    asset: ExecutablePluginAssetHandle,
    hints?: ExecutablePluginJsonValue,
  ): DurableProviderStep {
    return {
      status: "completed",
      outputs: [
        { slot: "output", kind: "asset", asset },
        ...(hints
          ? [{ slot: "projection", kind: "value" as const, value: hints }]
          : []),
      ],
    };
  }
  completedValue(updates: ExecutablePluginJsonValue): DurableProviderStep {
    return {
      status: "completed",
      outputs: [{ slot: "output", kind: "value", value: updates }],
    };
  }
  accepted(
    token: ExecutablePluginJsonValue,
    retryAfterMs = 5000,
  ): DurableProviderStep {
    return { status: "accepted", pollState: token, retryAfterMs };
  }
}
