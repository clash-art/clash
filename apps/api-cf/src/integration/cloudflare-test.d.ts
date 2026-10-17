import type { Env as AppEnv } from "../config";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS?: unknown;
      CONTRACT_SAMPLE_VIDEO_BASE64?: string;
    }
  }
}

export {};
