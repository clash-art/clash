import { expect, it } from "vitest";
import {
  marketplaceInstallation,
  withMarketplaceInstallation,
} from "./marketplace-installation";

it("derives operations from serving Host ports and exact catalog identities", () => {
  const plugin = {
    id: "example",
    packageId: "package.example",
    type: "plugin",
    runtime: "local",
  };
  const installed = withMarketplaceInstallation(plugin, {
    executablePlugins: true,
    skills: false,
  });
  expect(marketplaceInstallation(installed)).toMatchObject({
    packageId: plugin.packageId,
    pluginId: plugin.id,
  });
  expect(
    marketplaceInstallation({ ...installed, id: "another" }),
  ).toBeUndefined();
  expect(
    marketplaceInstallation({ ...installed, runtime: "worker" }),
  ).toBeUndefined();
  expect(
    marketplaceInstallation({ ...installed, builtIn: true }),
  ).toBeUndefined();
  expect(
    withMarketplaceInstallation(installed, {
      executablePlugins: false,
      skills: false,
    }),
  ).not.toHaveProperty("installation");
  expect(
    withMarketplaceInstallation(
      { ...installed, type: "action" },
      { executablePlugins: true, skills: true },
    ),
  ).not.toHaveProperty("installation");
});
it("keeps skills distinct from executable packages", () => {
  const skill = { id: "guide", type: "skill" };
  expect(
    withMarketplaceInstallation(skill, {
      executablePlugins: true,
      skills: false,
    }),
  ).not.toHaveProperty("installation");
  const enabled = withMarketplaceInstallation(skill, {
    executablePlugins: false,
    skills: true,
  });
  expect(marketplaceInstallation(enabled)).toMatchObject({ skillId: skill.id });
  expect(
    marketplaceInstallation({
      ...enabled,
      installation: { kind: "skill", skillId: "different" },
    }),
  ).toBeUndefined();
});
