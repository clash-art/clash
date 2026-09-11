import { z } from "zod";

/** Host-owned installation scope; project working-tree links are projections. */
export const HostInstallScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }).strict(),
  z
    .object({
      scope: z.literal("projects"),
      projectIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type HostInstallScope = z.infer<typeof HostInstallScopeSchema>;
export const HostSkillInstallationsSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  HostInstallScopeSchema,
);
