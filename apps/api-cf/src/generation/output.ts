import { z } from "zod";
import {
  durableRunIdempotencyKey,
  type DurableRunIdentity,
} from "@clash/shared-runtime/durable-run-engine";
import type { ExecutablePluginAssetHandle } from "@clash/shared-types/executable-plugin";

const ReceiptSchema = z
  .object({
    projectId: z.string(),
    idempotencyKey: z.string(),
    assetId: z.string(),
    storageKey: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteLength: z.number().int().positive(),
    mediaType: z.string(),
    kind: z.enum(["image", "video", "audio"]),
  })
  .strict();
export type GenerationOutputReceipt = z.infer<typeof ReceiptSchema>;
export interface GenerationOutputBroker {
  store(
    bytes: Uint8Array,
    mediaType: string,
    kind: GenerationOutputReceipt["kind"],
  ): Promise<ExecutablePluginAssetHandle>;
  resolve(
    handle: ExecutablePluginAssetHandle,
  ): Promise<GenerationOutputReceipt>;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Owner-private consumer CAS. The first durable receipt wins for the run/slot.
 * Media handles identify that receipt, never an R2 key or an expiring vendor URL. */
export function createGenerationOutputBroker(
  bucket: R2Bucket,
  identity: DurableRunIdentity,
  projectId: string,
): GenerationOutputBroker {
  const idempotencyKey = durableRunIdempotencyKey(identity);
  const scope = sha256(
    new TextEncoder().encode(JSON.stringify([projectId, idempotencyKey])),
  );
  const receiptKey = scope.then((id) => `generation/receipts/${id}.json`);
  const assetId = scope.then((id) => `cloud-output-${id}`);
  const read = async () => {
    const object = await bucket.get(await receiptKey);
    if (!object) throw new Error("Generation output receipt is missing.");
    const receipt = ReceiptSchema.parse(await object.json());
    if (
      receipt.projectId !== projectId ||
      receipt.idempotencyKey !== idempotencyKey ||
      receipt.assetId !== (await assetId)
    ) {
      throw new Error("Generation output receipt identity conflict.");
    }
    return receipt;
  };
  return {
    async store(bytes, mediaType, kind) {
      const digest = await sha256(bytes);
      const storageKey = `generation/bytes/${await scope}/${digest}`;
      await bucket.put(storageKey, bytes as Uint8Array<ArrayBuffer>, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: mediaType },
      });
      const candidate = ReceiptSchema.parse({
        projectId,
        idempotencyKey,
        assetId: await assetId,
        storageKey,
        sha256: digest,
        byteLength: bytes.byteLength,
        mediaType,
        kind,
      });
      await bucket.put(await receiptKey, JSON.stringify(candidate), {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      });
      const winner = await read();
      const handle = {
        assetId: winner.assetId,
        uri: `clash-asset://${winner.assetId}`,
        kind: winner.kind,
        mediaType: winner.mediaType,
      };
      await this.resolve(handle);
      return handle;
    },
    async resolve(handle) {
      const receipt = await read();
      if (
        handle.assetId !== receipt.assetId ||
        handle.uri !== `clash-asset://${receipt.assetId}` ||
        handle.kind !== receipt.kind ||
        handle.mediaType !== receipt.mediaType
      ) {
        throw new Error("Generation output handle does not match its receipt.");
      }
      const object = await bucket.get(receipt.storageKey);
      if (!object) throw new Error("Generation output bytes are missing.");
      if (object.size !== receipt.byteLength)
        throw new Error("Generation output byte length mismatch.");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (
        bytes.byteLength !== receipt.byteLength ||
        (await sha256(bytes)) !== receipt.sha256
      ) {
        throw new Error("Generation output digest mismatch.");
      }
      return receipt;
    },
  };
}
