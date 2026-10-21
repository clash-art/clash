/**
 * Admin list filters live in the URL (`?tenant=` plus one parameter per
 * filter), so a filtered view reloads and links as itself.
 */

export function filtersFromSearch<Key extends string>(
  search: URLSearchParams,
  keys: readonly Key[],
): Partial<Record<Key, string>> {
  const filters: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const value = search.get(key)?.trim();
    if (value) filters[key] = value;
  }
  return filters;
}

/** Filters as search params: `tenantId` becomes `?tenant=`, empty values are dropped. */
export function searchFromFilters(filters: object): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters as Record<string, string | number | undefined>)) {
    if (value === undefined || value === "") continue;
    search.set(key === "tenantId" ? "tenant" : key, String(value));
  }
  return search;
}
