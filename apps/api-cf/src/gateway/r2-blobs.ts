/**
 * gateway-core `blobs` over the Worker's R2 bucket (`R2_BUCKET`, the same
 * binding assets use). Gateway keys carry their own prefix
 * (`gateway-retention/` for retained bodies), so no other sweeper touches
 * them. R2 failures are GatewayErrors (GATEWAY_INTERNAL), never silent.
 */
import { GatewayError, type GatewayBlobPort } from "@clash/gateway-core";

/** The subset of R2Bucket the port uses; R2Bucket satisfies it. */
export interface GatewayBlobBucket {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
}

const failed = (op: string, cause: unknown) =>
  new GatewayError("GATEWAY_INTERNAL", { details: { port: "blobs", op }, cause });

export function createR2GatewayBlobPort(bucket: GatewayBlobBucket): GatewayBlobPort {
  return {
    async put(key, blob) {
      try {
        await bucket.put(key, blob.body, blob.contentType ? { httpMetadata: { contentType: blob.contentType } } : {});
      } catch (cause) {
        throw failed("put", cause);
      }
    },
    async get(key) {
      try {
        const object = await bucket.get(key);
        if (!object) return null;
        const contentType = object.httpMetadata?.contentType;
        return { body: new Uint8Array(await object.arrayBuffer()), ...(contentType ? { contentType } : {}) };
      } catch (cause) {
        throw failed("get", cause);
      }
    },
    async delete(key) {
      try {
        await bucket.delete(key);
      } catch (cause) {
        throw failed("delete", cause);
      }
    },
  };
}
