/**
 * Every Durable Run owner the Cloudflare adapter journals and recovers.
 *
 * Admission, Workflow coordinator selection and cron recovery share this one
 * list. An owner string is identity, not a routing hint: it must never be
 * derived from a request body or Project state.
 */
export const HOSTED_GENERATION_OWNER = "api-cf:generation" as const;
export const EXECUTABLE_ACTION_OWNER = "api-cf:executable" as const;

export const CLOUD_DURABLE_RUN_OWNERS = [
  HOSTED_GENERATION_OWNER,
  EXECUTABLE_ACTION_OWNER,
] as const;

export type CloudDurableRunOwner = (typeof CLOUD_DURABLE_RUN_OWNERS)[number];
