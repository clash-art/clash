import { withMarketplaceInstallation } from "@clash/shared-types/marketplace-installation";
import { Hono } from "hono";
import type { Env } from "../config";
import firstPartyRegistry from "../../../../skills/registry.json";

const REGISTRY_URL =
  "https://raw.githubusercontent.com/clash-community/awesome-actions/main/registry.json";

interface RegistryData {
  version: number;
  marketplaceSemantics?: Record<string, unknown>;
  /** Historical remote field, never an executable installation contract. */
  actions?: Array<Record<string, unknown>>;
  plugins?: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown> & { id?: unknown }>;
  systemCapabilities?: Array<Record<string, unknown>>;
  thirdPartyReferences?: Array<Record<string, unknown>>;
}

const FIRST_PARTY = firstPartyRegistry as RegistryData;
function readOnlySkill(skill: RegistryData["skills"][number]) {
  return withMarketplaceInstallation(
    { ...skill, id: typeof skill.id === "string" ? skill.id : "" },
    { executablePlugins: false, skills: false },
  );
}

function isRegistryData(value: unknown): value is RegistryData {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<RegistryData>;
  return Array.isArray(maybe.skills);
}

function mergeRegistry(remote: RegistryData | null): RegistryData {
  if (!remote)
    return {
      ...FIRST_PARTY,
      actions: [],
      plugins: [],
      skills: FIRST_PARTY.skills.map(readOnlySkill),
    };

  const seenSkillIds = new Set<string>();
  const skills = [...FIRST_PARTY.skills];
  for (const skill of skills) {
    if (typeof skill.id === "string") seenSkillIds.add(skill.id);
  }
  for (const skill of remote.skills) {
    const id = typeof skill.id === "string" ? skill.id : null;
    if (id && seenSkillIds.has(id)) continue;
    if (id) seenSkillIds.add(id);
    skills.push(skill);
  }

  return {
    version: 1,
    marketplaceSemantics: FIRST_PARTY.marketplaceSemantics,
    actions: [],
    plugins: [],
    skills: skills.map(readOnlySkill),
    systemCapabilities: FIRST_PARTY.systemCapabilities,
    thirdPartyReferences: FIRST_PARTY.thirdPartyReferences,
  };
}

export const marketplaceRoutes = new Hono<{ Bindings: Env }>();

marketplaceRoutes.get("/registry", async (c) => {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) return c.json(mergeRegistry(null));
    const remote = await res.json();
    return c.json(mergeRegistry(isRegistryData(remote) ? remote : null));
  } catch {
    return c.json(mergeRegistry(null));
  }
});
