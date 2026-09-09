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

export interface AssetDeliveryStore {
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
