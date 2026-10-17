/**
 * In-process Host context for an executable Action invocation.
 *
 * The plugin sees promoted bytes for a pinned reference and writes outputs
 * through the same R2 broker the Durable Run stages from. It never receives an
 * R2 key, a provider credential or a signed delivery URL.
 */
import type { ExecutorContextOverrides } from "@clash/action-sdk/browser";
import type { DurableRunIdentity } from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginReference } from "@clash/shared-types/executable-plugin";

import type { Env } from "../../config";
import { getAssetsByIds } from "../../services/assets";
import { createGenerationOutputBroker } from "../output";
import { brokerUploadContext } from "./output-upload";

export function createCloudActionExecutorContext(
  env: Env,
  run: DurableRunIdentity,
  projectId: string,
  userId: string,
): ExecutorContextOverrides {
  const broker = createGenerationOutputBroker(env.R2_BUCKET, run, projectId);

  const { upload, asset } = brokerUploadContext(broker, "Action");

  async function reference(reference: ExecutablePluginReference) {
    if ("text" in reference) {
      return { form: "text" as const, text: reference.text.value };
    }
    if ("document" in reference) {
      throw new Error(
        "Hosted Action execution cannot resolve a Document reference yet.",
      );
    }
    const [asset] = await getAssetsByIds(
      env.DB,
      [reference.asset.assetId],
      userId,
    );
    if (!asset) {
      throw new Error(
        `Action reference ${reference.slot}#${reference.index} is unavailable.`,
      );
    }
    const object = await env.R2_BUCKET.get(asset.srcR2Key);
    if (!object) {
      throw new Error(
        `Action reference ${reference.slot}#${reference.index} bytes are missing.`,
      );
    }
    const mediaType =
      object.httpMetadata?.contentType ??
      (typeof asset.metadata?.contentType === "string"
        ? asset.metadata.contentType
        : undefined) ??
      reference.asset.mediaType;
    return {
      form: "bytes" as const,
      bytes: new Uint8Array(await object.arrayBuffer()),
      kind: reference.asset.kind,
      ...(mediaType ? { mediaType } : {}),
    };
  }

  return {
    upload,
    asset,
    reference,
  };
}
