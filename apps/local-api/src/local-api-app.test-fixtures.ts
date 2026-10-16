import { createLocalApiApp, drainLocalApiAppBackgroundWork } from "./app.js";
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

/**
 * Route tests must drain background poster/waveform jobs and post-response
 * work, such as the Project metadata mirror, before deleting their store.
 */
export function managedLocalApiApps() {
  const ownedRepresentations: LocalAssetRepresentationService[] = [];
  const apps: ReturnType<typeof createLocalApiApp>[] = [];
  const track = (app: ReturnType<typeof createLocalApiApp>) => {
    apps.push(app);
    return app;
  };
  return {
    createApp(options: Parameters<typeof createLocalApiApp>[0]) {
      if (options.assetRepresentations) return track(createLocalApiApp(options));
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
      return track(
        createLocalApiApp({
          ...options,
          assetInspection,
          assetRepresentations,
        }),
      );
    },
    async close() {
      await Promise.all(apps.splice(0).map(drainLocalApiAppBackgroundWork));
      await Promise.all(
        ownedRepresentations.splice(0).map((service) => service.close()),
      );
    },
  };
}
