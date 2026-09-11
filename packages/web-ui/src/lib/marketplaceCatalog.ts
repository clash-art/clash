import { marketplaceInstallation } from "@clash/shared-types/marketplace-installation";
import type { RegistryItem } from "./clientActions";

/** Treat absent or inconsistent Host operation descriptors as read-only catalog entries. */
export function normalizeMarketplaceItems(
  value: unknown,
  fallbackType?: RegistryItem["type"],
): RegistryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      !entry.id.trim()
    )
      return [];
    const type = entry.type ?? fallbackType;
    if (type !== "action" && type !== "skill" && type !== "plugin") return [];
    const { installation: _untrusted, ...fields } = entry;
    const item: RegistryItem = {
      ...fields,
      type,
      name:
        typeof entry.name === "string"
          ? entry.name
          : typeof entry.title === "string"
            ? entry.title
            : entry.id,
    };
    const installation = marketplaceInstallation({
      ...item,
      installation: entry.installation,
    });
    return [{ ...item, ...(installation ? { installation } : {}) }];
  });
}
