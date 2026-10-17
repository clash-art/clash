/**
 * The one answer for a Project Host capability an adapter does not offer:
 * 501 COMMAND_UNAVAILABLE. Never 404: a 404 is indistinguishable from a
 * missing adapter route, which is how the #179-#182 gaps stayed hidden.
 */
export function projectHostCapabilityUnavailable(capability: string): {
  status: 501;
  body: { error: string; code: "COMMAND_UNAVAILABLE"; capability: string };
} {
  return {
    status: 501,
    body: {
      error: `${capability} is not available on this server.`,
      code: "COMMAND_UNAVAILABLE",
      capability,
    },
  };
}
