import { lazySchema } from "../lazy-schema.js";
import { z } from "zod";
import { AssetKindSchema } from "../assets.js";

export let ActionFamilySchema = lazySchema(() => (
z.enum(["generate", "edit", "custom"])
), (real) => { ActionFamilySchema = real; });
export type ActionFamily = z.infer<typeof ActionFamilySchema>;

export let ActionOperationSpecSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  outputKind: AssetKindSchema,
})
), (real) => { ActionOperationSpecSchema = real; });
export type ActionOperationSpec = z.infer<typeof ActionOperationSpecSchema>;

/** Serializable discovery contract. Runtime functions never live in a spec. */
export let ActionSpecSchema = lazySchema(() => (
z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  family: ActionFamilySchema,
  inputKinds: z.array(AssetKindSchema).min(1),
  operations: z.array(ActionOperationSpecSchema).min(1),
})
), (real) => { ActionSpecSchema = real; });
export type ActionSpec = z.infer<typeof ActionSpecSchema>;

export let ActionInvocationModeSchema = lazySchema(() => (
z.enum(["explicit", "implicit"])
), (real) => { ActionInvocationModeSchema = real; });
export type ActionInvocationMode = z.infer<typeof ActionInvocationModeSchema>;

export let ActionSurfaceSchema = lazySchema(() => (
z.enum(["canvas", "asset-preview"])
), (real) => { ActionSurfaceSchema = real; });
export type ActionSurface = z.infer<typeof ActionSurfaceSchema>;

export const ACTION_INVOCATION_MODE = {
  Explicit: "explicit",
  Implicit: "implicit",
} as const satisfies Record<string, ActionInvocationMode>;

export function invocationModeForSurface(
  surface: ActionSurface,
): ActionInvocationMode {
  return surface === "canvas"
    ? ACTION_INVOCATION_MODE.Explicit
    : ACTION_INVOCATION_MODE.Implicit;
}
