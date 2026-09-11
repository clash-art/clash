/** A catalog describes operations offered by its serving Host, not authority to install arbitrary code. */
export type MarketplaceInstallation =
  | { kind: "executable-plugin"; packageId: string; pluginId: string }
  | { kind: "skill"; skillId: string };

export interface MarketplaceInstallableItem {
  id: string;
  type?: unknown;
  runtime?: unknown;
  packageId?: unknown;
  builtIn?: unknown;
  installation?: unknown;
}

/** Validate a server-issued operation against this item's identity and product kind. */
export function marketplaceInstallation(
  item: MarketplaceInstallableItem,
): MarketplaceInstallation | undefined {
  if (
    !item.installation ||
    typeof item.installation !== "object" ||
    item.builtIn === true
  )
    return undefined;
  const target = item.installation as Record<string, unknown>;
  if (
    target.kind === "executable-plugin" &&
    item.type === "plugin" &&
    item.runtime === "local" &&
    typeof item.packageId === "string" &&
    item.packageId.trim() &&
    target.packageId === item.packageId &&
    target.pluginId === item.id
  ) {
    return {
      kind: "executable-plugin",
      packageId: item.packageId,
      pluginId: item.id,
    };
  }
  if (
    target.kind === "skill" &&
    item.type === "skill" &&
    target.skillId === item.id
  )
    return { kind: "skill", skillId: item.id };
  return undefined;
}

/** Host adapters derive this from their actual installed ports; remote catalog fields cannot opt in. */
export function withMarketplaceInstallation<
  T extends MarketplaceInstallableItem,
>(
  item: T,
  available: { executablePlugins: boolean; skills: boolean },
): Omit<T, "installation"> & {
  id: string;
  installation?: MarketplaceInstallation;
} {
  const { installation: _untrusted, ...value } = item;
  const candidate =
    available.executablePlugins && item.type === "plugin"
      ? {
          kind: "executable-plugin",
          packageId: item.packageId,
          pluginId: item.id,
        }
      : available.skills && item.type === "skill"
        ? { kind: "skill", skillId: item.id }
        : undefined;
  const installation = marketplaceInstallation({
    ...item,
    installation: candidate,
  });
  return { ...value, id: item.id, ...(installation ? { installation } : {}) };
}
