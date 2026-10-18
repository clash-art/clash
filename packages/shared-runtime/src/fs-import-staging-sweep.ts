/**
 * Abandoned chunked-import staging on a filesystem store (the Node adapter and the local Host).
 *
 * Two kinds of leftovers: finished-but-never-finalized objects, and multipart uploads whose parts
 * arrived but which never completed. Both are swept by the same adapter-neutral sweep.
 */
import {
  sweepAndReportProjectAssetImportStaging,
  type ProjectAssetImportStagingSweepLog,
} from "./cloud-project-host/project-asset-import-sessions.js";
import type { FsAssetDeliveryStore } from "./fs-asset-delivery-store.js";

export function sweepFsProjectAssetImportStaging(
  store: FsAssetDeliveryStore,
  log: ProjectAssetImportStagingSweepLog,
  now: () => number = Date.now,
): Promise<void> {
  return sweepAndReportProjectAssetImportStaging(
    {
      objects: { now, list: () => store.list(), delete: (locator) => store.delete(locator) },
      uploads: {
        now,
        list: () => store.listUploads(),
        delete: (locator) => store.deleteUpload(locator),
      },
    },
    log,
  );
}
