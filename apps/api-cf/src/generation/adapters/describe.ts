import type { GenerationAdapter } from "../adapter";
/** Historical no-op: do not report an output that was never produced. */
export const describeAdapter: GenerationAdapter = {
  name: "describe",
  async submit() {
    return {
      status: "failed",
      error: {
        code: "invalid_request",
        message:
          "Hosted description generation is unavailable; use the supported visual understanding operation.",
        retryable: false,
        requestState: "rejected",
      },
    };
  },
};
