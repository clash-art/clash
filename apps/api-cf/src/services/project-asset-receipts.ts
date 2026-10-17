/**
 * Project Asset read receipts for api-cf: HMAC-SHA256/base64url over the
 * shared receipt message, the same algorithm and encoding as api-node, so a
 * receipt issued by a REST read verifies inside ProjectRoom.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { projectAssetReceiptMessage } from "@clash/shared-runtime/cloud-project-host/project-assets";
import { requireSecret } from "./require-secret";

type ReceiptEnv = { ENVIRONMENT: string; JWT_SECRET?: string };

export function signProjectAssetReceipt(
  env: ReceiptEnv,
  userId: string,
  projectId: string,
  version: string,
): string {
  const secret = requireSecret(
    env,
    "JWT_SECRET",
    env.JWT_SECRET,
    "dev-asset-delivery-secret",
  );
  return createHmac("sha256", secret)
    .update(projectAssetReceiptMessage(userId, projectId, version))
    .digest("base64url");
}

export function verifyProjectAssetReceipt(
  env: ReceiptEnv,
  userId: string,
  projectId: string,
  version: string,
  receipt: string,
): boolean {
  const expected = Buffer.from(
    signProjectAssetReceipt(env, userId, projectId, version),
  );
  const given = Buffer.from(receipt);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
