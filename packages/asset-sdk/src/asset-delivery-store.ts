/**
 * Storage port used by a standalone capability endpoint.
 *
 * The endpoint deals in private locators returned by a Resource Registry, but
 * it never knows whether those locators address R2, S3, a filesystem, or a
 * self-hosted object store. Adapters own conversion to Web Streams.
 */
export interface AssetDeliveryByteRange {
  offset: number;
  length: number;
}

export interface AssetDeliveryStoredObject {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType?: string;
}

export interface AssetDeliveryMultipartSession {
  /** Caller-generated opaque ID; never sufficient authorization by itself. */
  uploadId: string;
  target: {
    /** Private authenticated Project/replica/Resource or Document identity. */
    identity: string;
    locator: string;
    digest: string;
    byteLength: number;
    contentType?: string;
  };
}

export interface AssetDeliveryMultipartStore {
  begin(session: AssetDeliveryMultipartSession): Promise<void>;
  part(
    session: AssetDeliveryMultipartSession,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<void>;
  /** Revalidate current admission/references after verification, before publication. */
  complete(
    session: AssetDeliveryMultipartSession,
    beforePublish: () => Promise<void>,
  ): Promise<void>;
  abort(session: AssetDeliveryMultipartSession): Promise<void>;
}

export interface AssetDeliveryStore {
  /** Optional resumable private staging adapter; never falls back to whole-object buffering. */
  multipart?: AssetDeliveryMultipartStore;
  head(locator: string):
    | Promise<
        | {
            size: number;
            contentType?: string;
          }
        | undefined
      >
    | {
        size: number;
        contentType?: string;
      }
    | undefined;
  get(
    locator: string,
    range?: AssetDeliveryByteRange,
  ):
    | Promise<AssetDeliveryStoredObject | undefined>
    | AssetDeliveryStoredObject
    | undefined;
  put(
    locator: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<void> | void;
}
