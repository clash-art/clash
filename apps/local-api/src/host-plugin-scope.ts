import { HostSkillInstallationsSchema, type HostInstallScope } from "@clash/shared-types";
import type { ClashUserConfigStore } from "./user-config.js";

/** Host-owned availability; package bytes and saved project documents remain shared. */
export function createHostPluginScopes(store: ClashUserConfigStore) {
  const read = async () => HostSkillInstallationsSchema.parse(await store.getSection("plugin_installations") ?? {});
  return {
    async get(id: string): Promise<HostInstallScope> {
      return (await read())[id] ?? { scope: "global" };
    },
    async set(id: string, scope: HostInstallScope) {
      await store.updateSection("plugin_installations", current => ({
        ...HostSkillInstallationsSchema.parse(current ?? {}), [id]: scope,
      }));
    },
    async allows(id: string, projectId?: string) {
      const scope = (await read())[id];
      return !scope || scope.scope === "global" || !!projectId && scope.projectIds.includes(projectId);
    },
  };
}
