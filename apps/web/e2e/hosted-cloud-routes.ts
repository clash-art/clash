// Route facts the hosted cloud smoke depends on, kept free of side effects so
// the Web unit suite can check them against the real router and ErrorBoundary.

/** The signed-in project editor route (`projects/:id` in app/router.tsx). */
export function projectRoutePath(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

// Heading of the root ErrorBoundary, plus React Router's own unmatched-URL
// detail. Either one means the SPA answered 200 but rendered no real surface.
const ROUTE_ERROR_MARKERS = ["Clash could not finish this view", "No route matches"];

/** Returns the route-error marker found in a page's visible text, if any. */
export function findRouteError(pageText: string): string | null {
  return ROUTE_ERROR_MARKERS.find((marker) => pageText.includes(marker)) ?? null;
}
