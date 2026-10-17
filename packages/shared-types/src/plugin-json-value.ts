import { z } from "zod";

/** JSON values accepted at the versioned executable-plugin and Generator boundary. */
export type ExecutablePluginJsonValue =
  | null
  | boolean
  | number
  | string
  | ExecutablePluginJsonValue[]
  | { [key: string]: ExecutablePluginJsonValue };

export const ExecutablePluginJsonValueSchema: z.ZodType<ExecutablePluginJsonValue> =
  z.lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number().finite(),
      z.string(),
      z.array(ExecutablePluginJsonValueSchema),
      z.record(z.string(), ExecutablePluginJsonValueSchema),
    ]),
  );
