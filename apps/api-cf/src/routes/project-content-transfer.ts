import {
  PROJECT_CLOUD_CONTENT_PART_BYTES,
  readBoundedContent,
  assertContentTransferSize,
  type AssetDeliveryStore,
} from "@clash/asset-sdk/delivery";
import { MultipartContentError } from "../services/project-content-multipart";

type Session = Parameters<
  NonNullable<AssetDeliveryStore["multipart"]>["begin"]
>[0];

export async function handleMultipartContent(
  request: Request,
  store: AssetDeliveryStore,
  target: Session["target"],
  beforePublish: () => Promise<void>,
): Promise<Response | undefined> {
  const url = new URL(request.url),
    operation = url.searchParams.get("upload");
  if (!operation) return undefined;
  if (!["begin", "part", "complete", "abort"].includes(operation))
    throw new MultipartContentError(400, "Invalid multipart upload operation");
  if (!store.multipart)
    throw new MultipartContentError(
      501,
      "This content store does not support multipart uploads",
    );
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const session = { uploadId, target };
  if (operation === "part") {
    const declared = request.headers.get("content-length");
    if (declared !== null)
      assertContentTransferSize(
        Number(declared),
        PROJECT_CLOUD_CONTENT_PART_BYTES,
      );
    const bytes = await readBoundedContent(request.body, {
      maxBytes: PROJECT_CLOUD_CONTENT_PART_BYTES,
    });
    await beforePublish();
    await store.multipart.part(
      session,
      Number(url.searchParams.get("partNumber")),
      bytes,
    );
  } else {
    const bytes = await readBoundedContent(request.body, { maxBytes: 1024 });
    if (bytes.length)
      throw new MultipartContentError(
        400,
        "Multipart control requests have no body",
      );
    if (operation === "begin") {
      await store.multipart.begin(session);
      return Response.json({
        uploadId,
        partSize: PROJECT_CLOUD_CONTENT_PART_BYTES,
      });
    }
    if (operation === "complete")
      await store.multipart.complete(session, beforePublish);
    if (operation === "abort") await store.multipart.abort(session);
  }
  return new Response(null, { status: 204 });
}

/** Headers can reject known oversized objects. Actual-byte mismatch after response
 * start errors the stream; the receiving Host must finish integrity verification. */
export function exactLengthContentStream(
  body: ReadableStream<Uint8Array>,
  expectedLength: number,
): ReadableStream<Uint8Array> {
  let length = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        length += bytes.length;
        if (length > expectedLength)
          throw new Error("Cloud content length mismatch");
        controller.enqueue(bytes);
      },
      flush() {
        if (length !== expectedLength)
          throw new Error("Cloud content length mismatch");
      },
    }),
  );
}
