import { readMetadataBody } from "@clash/shared-runtime";
import { defaultLocalApiDataDir } from "@clash/shared-runtime/local-paths";

/** Read-only compatibility for existing manifest/Timeline metadata bodies. */
export async function readAssetMetadataBody(options: {
  contentHash: string;
  dataDir?: string;
}): Promise<unknown> {
  return readMetadataBody({
    dataDir: options.dataDir ?? defaultLocalApiDataDir(),
    contentHash: options.contentHash,
  });
}
