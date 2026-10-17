/**
 * The one way an in-process plugin's output reaches the run-scoped R2 broker,
 * shared by the provider-route and Action contexts of the Cloudflare adapter.
 */
import type { ExecutorContextOverrides } from "@clash/action-sdk/browser";
import type { ExecutablePluginOutput } from "@clash/shared-types/executable-plugin";

import { outputPersistenceFailure } from "../context";
import type { createGenerationOutputBroker } from "../output";

type Broker = ReturnType<typeof createGenerationOutputBroker>;

export interface BrokerUploadRequest {
  slot: string;
  kind: "image" | "video" | "audio" | "model";
  mediaType?: string;
  bytes?: Uint8Array;
  url?: string;
}

function defaultMediaType(kind: "image" | "video" | "audio"): string {
  if (kind === "image") return "image/png";
  if (kind === "video") return "video/mp4";
  return "audio/mpeg";
}

/** `label` names the caller in errors ("Plugin", "Action"). */
export function brokerUploadContext(
  broker: Broker,
  label: string,
): Required<Pick<ExecutorContextOverrides, "upload" | "asset">> {
  async function upload(
    request: BrokerUploadRequest,
  ): Promise<ExecutablePluginOutput> {
    if (request.kind === "model") {
      throw new Error(`Hosted ${label} execution cannot stage a model output.`);
    }
    const kind = request.kind;
    if (!request.bytes && !request.url) {
      throw new Error(
        `${label} upload for slot ${request.slot} carried neither bytes nor a URL.`,
      );
    }
    try {
      let bytes = request.bytes;
      let mediaType = request.mediaType ?? defaultMediaType(kind);
      if (!bytes) {
        const response = await fetch(request.url!);
        if (!response.ok) {
          throw new Error(
            `Provider output download failed: HTTP ${response.status}`,
          );
        }
        mediaType =
          request.mediaType ??
          response.headers.get("content-type") ??
          defaultMediaType(kind);
        bytes = new Uint8Array(await response.arrayBuffer());
      }
      return {
        slot: request.slot,
        kind: "asset",
        asset: await broker.store(bytes, mediaType, kind),
      };
    } catch (error) {
      // The plugin already ran (or the provider accepted the work), so this
      // retries persistence and never resubmits.
      throw outputPersistenceFailure(error);
    }
  }
  return {
    upload,
    async asset(request) {
      const bytes = request.dataBase64
        ? Uint8Array.from(atob(request.dataBase64), (c) => c.charCodeAt(0))
        : undefined;
      return upload({
        slot: request.slot,
        kind: request.kind,
        ...(request.mediaType ? { mediaType: request.mediaType } : {}),
        ...(bytes ? { bytes } : {}),
        ...(request.url ? { url: request.url } : {}),
      });
    },
  };
}
