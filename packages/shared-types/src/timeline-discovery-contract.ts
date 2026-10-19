import { lazySchema } from "./lazy-schema.js";
import { z } from "zod";

export const TIMELINE_DISCOVERY_VIEWS = ["authoring", "full"] as const;

export let TimelineDiscoveryViewSchema = lazySchema(() => (
z.enum(
  TIMELINE_DISCOVERY_VIEWS,
)
), (real) => { TimelineDiscoveryViewSchema = real; });

export type TimelineDiscoveryView = z.infer<
  typeof TimelineDiscoveryViewSchema
>;
