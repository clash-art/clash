import {
  resolveRuntimeConfig,
  type RuntimeCapabilities,
} from "@clash/shared-runtime";

/**
 * The Node adapter's capability declaration. Upper layers read these values
 * and never learn which adapter produced them; overrides only replace the
 * hosted defaults that differ here.
 */
export function nodeRuntimeCapabilities(): RuntimeCapabilities {
  return resolveRuntimeConfig({
    mode: "hosted",
    capabilities: {
      host: {
        voiceInput: "available",
        localAudio: "unavailable",
      },
    },
  }).capabilities;
}
