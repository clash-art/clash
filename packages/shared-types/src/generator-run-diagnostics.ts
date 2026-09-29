import { z } from "zod";
import { ExecutablePluginFailureCodeSchema } from "./executable-plugin.js";

/** Host read diagnostics only. Never persisted in the Project Run request/outcome. */
export const GeneratorRunDiagnosticsSchema = z
  .object({
    failures: z.array(
      z
        .object({
          outputSlot: z.string().trim().min(1),
          code: ExecutablePluginFailureCodeSchema,
          phase: z.enum([
            "queued",
            "submitting",
            "polling",
            "finalizing",
            "succeeded",
            "failed",
          ]),
          retryable: z.boolean(),
          message: z.string().trim().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type GeneratorRunDiagnostics = z.infer<
  typeof GeneratorRunDiagnosticsSchema
>;
