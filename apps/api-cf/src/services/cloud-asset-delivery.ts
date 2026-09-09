import {
  createAssetDeliveryPort,
  createHmacAssetDeliverySigner,
  verifyHmacAssetDeliveryCapability,
  type AssetDeliveryAuthorizer,
  type AssetDeliveryPort,
  type AssetDeliverySigner,
} from "@clash/asset-sdk/delivery";

import type { Env } from "../config";
import { requireSecret } from "./require-secret";

export interface CloudAssetDeliveryOptions {
  /** Product authorization runs before a capability is minted. */
  authorize: AssetDeliveryAuthorizer["authorize"];
  /** Standalone API origin serving `/assets/capability/*`. */
  origin?: string;
  signer?: AssetDeliverySigner;
  now?: () => number;
  readTtlSeconds?: number;
  uploadTtlSeconds?: number;
}

function standaloneOrigin(env: Env, configured?: string): string {
  const origin = configured ?? env.WORKER_PUBLIC_URL ?? env.MEDIA_GATEWAY_URL;
  if (!origin?.trim()) {
    throw new Error(
      "Cloud Asset delivery requires WORKER_PUBLIC_URL, MEDIA_GATEWAY_URL, or an explicit origin.",
    );
  }
  return origin;
}

export function createCloudAssetDeliveryPort(
  env: Env,
  options: CloudAssetDeliveryOptions,
): AssetDeliveryPort {
  const now = options.now ?? Date.now;
  const signer =
    options.signer ??
    createHmacAssetDeliverySigner({
      secret: requireSecret(
        env,
        "JWT_SECRET",
        env.JWT_SECRET,
        "dev-asset-delivery-secret",
      ),
      origin: standaloneOrigin(env, options.origin),
      now,
    });
  return createAssetDeliveryPort({
    signer,
    authorize: options.authorize,
    now,
    ...(options.readTtlSeconds === undefined
      ? {}
      : { readTtlSeconds: options.readTtlSeconds }),
    ...(options.uploadTtlSeconds === undefined
      ? {}
      : { uploadTtlSeconds: options.uploadTtlSeconds }),
  });
}

export function verifyCloudAssetDeliveryCapability(
  env: Pick<Env, "ENVIRONMENT" | "JWT_SECRET">,
  token: string,
  now?: () => number,
) {
  return verifyHmacAssetDeliveryCapability({
    secret: requireSecret(
      env,
      "JWT_SECRET",
      env.JWT_SECRET,
      "dev-asset-delivery-secret",
    ),
    token,
    ...(now ? { now } : {}),
  });
}
