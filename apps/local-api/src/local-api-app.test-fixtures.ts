import { createLocalApiApp } from "./app.js";
import {
  createLocalAssetInspectionService,
  createLocalFfprobeAssetInspector,
} from "./local-asset-inspections.js";
import {
  createLocalAssetRepresentationService,
  type LocalAssetRepresentationService,
} from "./local-asset-representations.js";
import { localFfprobePath } from "./local-media-binaries.js";
import { clashHomeForLocalDataDir } from "./local-paths.js";

/** Route tests must drain background poster/waveform jobs before deleting their store. */
export function managedLocalApiApps() {
  const ownedRepresentations: LocalAssetRepresentationService[] = [];
  return {
    createApp(options: Parameters<typeof createLocalApiApp>[0]) {
      if (options.assetRepresentations) return createLocalApiApp(options);
      const clashRoot = clashHomeForLocalDataDir(
        options.dataDir,
        options.clashRoot,
      );
      const ffprobePath = localFfprobePath();
      const assetInspection =
        options.assetInspection ??
        createLocalAssetInspectionService({
          dataDir: options.dataDir,
          clashRoot,
          inspectResource:
            options.inspectAssetResource ??
            (ffprobePath
              ? createLocalFfprobeAssetInspector({ ffprobePath })
              : undefined),
        });
      const assetRepresentations = createLocalAssetRepresentationService({
        dataDir: options.dataDir,
        clashRoot,
        assetInspection,
      });
      ownedRepresentations.push(assetRepresentations);
      return createLocalApiApp({
        ...options,
        assetInspection,
        assetRepresentations,
      });
    },
    async close() {
      await Promise.all(
        ownedRepresentations.splice(0).map((service) => service.close()),
      );
    },
  };
}
