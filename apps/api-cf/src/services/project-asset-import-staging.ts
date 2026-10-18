import {
  PROJECT_ASSET_IMPORT_STAGING_PREFIX,
  sweepAndReportProjectAssetImportStaging,
  type ProjectAssetImportStagingEntry,
  type ProjectAssetImportStagingSweepLog,
} from "@clash/shared-runtime/cloud-project-host/project-asset-import-sessions";

/** Every staged object under the import namespace, one R2 page at a time. */
export async function* listProjectAssetImportStaging(
  bucket: R2Bucket,
): AsyncGenerator<ProjectAssetImportStagingEntry> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: PROJECT_ASSET_IMPORT_STAGING_PREFIX,
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects)
      yield { locator: object.key, createdAt: object.uploaded.getTime() };
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Wire the adapter's R2 bucket into the adapter-agnostic sweep and report it. */
export function sweepProjectAssetImportStagingBucket(
  bucket: R2Bucket,
  log: ProjectAssetImportStagingSweepLog,
  now: () => number = Date.now,
): Promise<void> {
  // Unfinished R2 multipart uploads are aborted by cleanupProjectContentUploads; this covers
  // staged objects whose finalize never came.
  return sweepAndReportProjectAssetImportStaging(
    {
      objects: {
        now,
        list: () => listProjectAssetImportStaging(bucket),
        delete: (locator) => bucket.delete(locator),
      },
    },
    log,
  );
}
