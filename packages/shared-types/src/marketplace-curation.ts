/**
 * Ops curation overlay for the skill/plugin marketplace.
 *
 * The git catalog remains identity and install truth. Overlay rows only change
 * what product surfaces feature, hide, reorder, or retitle for display.
 * Empty overlay is an identity transform (today's code defaults still apply
 * at the feed selector).
 */

export type MarketplaceCurationKind = "skill" | "plugin";

export interface MarketplaceCurationRow {
  kind: MarketplaceCurationKind;
  itemId: string;
  featured: boolean;
  hidden: boolean;
  sortOrder: number | null;
  titleOverride: string | null;
  descriptionOverride: string | null;
  updatedAt?: number;
  updatedBy?: string | null;
}

export type MarketplaceCatalogItem = Record<string, unknown> & {
  id: string;
  type?: unknown;
  title?: unknown;
  name?: unknown;
  description?: unknown;
};

export interface ApplyMarketplaceCurationResult<T extends MarketplaceCatalogItem> {
  items: T[];
  /** Featured ids in overlay sort order, then any remaining featured without sort. */
  featuredIds: string[];
}

function asKind(value: unknown): MarketplaceCurationKind | null {
  return value === "skill" || value === "plugin" ? value : null;
}

/** Normalize untrusted JSON/D1 rows into curation rows. Drops invalid entries. */
export function normalizeMarketplaceCurationRows(
  input: unknown,
): MarketplaceCurationRow[] {
  if (!Array.isArray(input)) return [];
  const out: MarketplaceCurationRow[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const kind =
      asKind(row.kind) ??
      asKind(row.item_kind) ??
      asKind(row.itemKind);
    const itemId =
      typeof row.itemId === "string"
        ? row.itemId
        : typeof row.item_id === "string"
          ? row.item_id
          : typeof row.id === "string"
            ? row.id
            : "";
    if (!kind || !itemId.trim()) continue;
    const featured = row.featured === true || row.featured === 1;
    const hidden = row.hidden === true || row.hidden === 1;
    const sortRaw = row.sortOrder ?? row.sort_order;
    const sortOrder =
      typeof sortRaw === "number" && Number.isFinite(sortRaw)
        ? sortRaw
        : null;
    const titleOverride =
      typeof row.titleOverride === "string"
        ? row.titleOverride
        : typeof row.title_override === "string"
          ? row.title_override
          : null;
    const descriptionOverride =
      typeof row.descriptionOverride === "string"
        ? row.descriptionOverride
        : typeof row.description_override === "string"
          ? row.description_override
          : null;
    out.push({
      kind,
      itemId: itemId.trim(),
      featured,
      hidden,
      sortOrder,
      titleOverride,
      descriptionOverride,
      updatedAt:
        typeof row.updatedAt === "number"
          ? row.updatedAt
          : typeof row.updated_at === "number"
            ? row.updated_at
            : undefined,
      updatedBy:
        typeof row.updatedBy === "string"
          ? row.updatedBy
          : typeof row.updated_by === "string"
            ? row.updated_by
            : null,
    });
  }
  return out;
}

function itemKind(item: MarketplaceCatalogItem): MarketplaceCurationKind | null {
  if (item.type === "skill" || item.type === "plugin") return item.type;
  return null;
}

/**
 * Apply overlay to a catalog slice. Hidden items are removed. Title/description
 * overrides replace display fields when non-empty. Featured ids are returned
 * sorted by sort_order ascending (nulls last), stable by item id.
 */
export function applyMarketplaceCurationOverlay<
  T extends MarketplaceCatalogItem,
>(
  items: readonly T[],
  overlay: readonly MarketplaceCurationRow[],
): ApplyMarketplaceCurationResult<T> {
  if (overlay.length === 0) {
    return { items: [...items], featuredIds: [] };
  }
  const byKey = new Map(
    overlay.map((row) => [`${row.kind}:${row.itemId}`, row] as const),
  );
  const next: T[] = [];
  const featured: MarketplaceCurationRow[] = [];

  for (const item of items) {
    const kind = itemKind(item);
    const row = kind ? byKey.get(`${kind}:${item.id}`) : undefined;
    if (row?.hidden) continue;
    if (!row) {
      next.push(item);
      continue;
    }
    let patched: T = item;
    if (row.titleOverride && row.titleOverride.trim()) {
      patched = {
        ...patched,
        title: row.titleOverride,
        ...(typeof patched.name === "string" ? { name: row.titleOverride } : {}),
      };
    }
    if (row.descriptionOverride && row.descriptionOverride.trim()) {
      patched = { ...patched, description: row.descriptionOverride };
    }
    next.push(patched);
    if (row.featured) featured.push(row);
  }

  featured.sort((a, b) => {
    const ao = a.sortOrder;
    const bo = b.sortOrder;
    if (ao == null && bo == null) return a.itemId.localeCompare(b.itemId);
    if (ao == null) return 1;
    if (bo == null) return -1;
    if (ao !== bo) return ao - bo;
    return a.itemId.localeCompare(b.itemId);
  });

  return { items: next, featuredIds: featured.map((row) => row.itemId) };
}

/** Whether overlay opts into featured control (vs code defaults). Hide-only overlays do not. */
export function overlayControlsFeatured(
  overlay: readonly MarketplaceCurationRow[],
): boolean {
  return overlay.some((row) => row.featured || row.sortOrder != null);
}
