import { createHostLazyModule } from "./host-lazy-module.js";

/**
 * The libvips image codec, imported on the first thumbnail, poster or waveform instead of at Host
 * startup. Shared so every image path waits on the same single import.
 */
export const loadSharp = createHostLazyModule(
  "sharp",
  async () => (await import("sharp")).default,
);
