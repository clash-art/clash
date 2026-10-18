import { Hono } from "hono";
import {
  ExecutablePluginManifestSchema,
  HostInstallScopeSchema,
  type HostInstallScope,
} from "@clash/shared-types";
import {
  marketplaceInstallation,
  withMarketplaceInstallation,
} from "@clash/shared-types/marketplace-installation";

type Item = Record<string, unknown> & { id: string };
type PluginItem = Item & { packageId: string };
export interface LocalMarketplaceOptions {
  marketplaceActions?: Item[];
  marketplaceSkills?: Item[];
  marketplacePlugins?: PluginItem[];
  marketplaceFeed?: Item[];
  /** Lazily resolve plugins whose availability is known only after Host listen. */
  resolveMarketplacePlugins?: () => Promise<PluginItem[]>;
  /** Lazily resolve featured entries from the same post-listen availability gate. */
  resolveMarketplaceFeed?: () => Promise<Item[]>;
  installMarketplacePlugin?: (
    packageId: string,
    installation?: HostInstallScope,
  ) => Promise<Record<string, unknown>>;
  getPluginInstallScope?: (id: string) => Promise<HostInstallScope>;
  validateInstallProjects?: (ids: string[]) => Promise<boolean>;
  uninstallMarketplacePlugin?: (id: string) => Promise<void>;
  installMarketplaceSkill?: (
    id: string,
    installation?: HostInstallScope,
  ) => Promise<Record<string, unknown>>;
  uninstallMarketplaceSkill?: (id: string) => Promise<void>;
  listInstalledMarketplaceSkills?: () => Promise<
    Array<Record<string, unknown>>
  >;
  uninstallMarketplaceAction?: (id: string) => Promise<void>;
  reconcileSkillProjects?: () => Promise<void>;
  readInstalledPlugin?: (id: string) => Promise<object>;
}
export function legacyActionInstallRetired() {
  return Response.json(
    {
      code: "LEGACY_ACTION_INSTALL_RETIRED",
      error:
        "Worker Action installation is retired. Install an executable plugin through the supported Local Host marketplace.",
    },
    { status: 410 },
  );
}
/** HTTP/catalog adapter over existing skill installation and receipt-validating executable packages. */
export function createLocalMarketplaceRoutes(options: LocalMarketplaceOptions) {
  const app = new Hono();
  app.onError((error, c) => {
    const immutable =
      "code" in error && error.code === "BUILTIN_PLUGIN_IMMUTABLE";
    return c.json(
      {
        code: immutable ? error.code : "MARKETPLACE_OPERATION_FAILED",
        error: error.message,
      },
      immutable ? 409 : 500,
    );
  });
  const available = {
    executablePlugins: Boolean(
      options.installMarketplacePlugin && options.readInstalledPlugin,
    ),
    skills: Boolean(
      options.installMarketplaceSkill && options.listInstalledMarketplaceSkills,
    ),
  };
  const describe = (item: Item) => withMarketplaceInstallation(item, available);
  const resolvePlugins = async () =>
    options.resolveMarketplacePlugins
      ? await options.resolveMarketplacePlugins()
      : options.marketplacePlugins ?? [];
  const resolveFeed = async () =>
    options.resolveMarketplaceFeed
      ? await options.resolveMarketplaceFeed()
      : options.marketplaceFeed ?? [];
  const plugin = async (packageId: string) =>
    (await resolvePlugins()).find(
      (item) =>
        item.packageId === packageId &&
        item.type === "plugin" &&
        item.runtime === "local",
    );
  const skill = (id: string) =>
    options.marketplaceSkills?.find(
      (item) => item.id === id && item.type === "skill",
    );
  app.get("/api/marketplace/registry", async (c) => {
    const plugins = await resolvePlugins();
    return c.json({
      version: 1,
      actions: (options.marketplaceActions ?? []).map(describe),
      skills: (options.marketplaceSkills ?? []).map(describe),
      plugins: plugins.map(describe),
    });
  });
  app.get("/api/marketplace/feed", async (c) => {
    const plugins = await resolvePlugins();
    const feed = await resolveFeed();
    return c.json({
      version: 1,
      featuredPlugins: feed.map((item) => {
        // A featured card may not manufacture installability outside the serving catalog.
        const catalog =
          item.type === "plugin"
            ? plugins
            : item.type === "skill"
              ? options.marketplaceSkills
              : options.marketplaceActions;
        const admitted = catalog?.find(
          (candidate) =>
            candidate.id === item.id && candidate.type === item.type,
        );
        return admitted
          ? describe(admitted)
          : withMarketplaceInstallation(item, {
              executablePlugins: false,
              skills: false,
            });
      }),
    });
  });
  app.post(
    "/api/marketplace/actions/:packageId/install",
    legacyActionInstallRetired,
  );
  if (options.uninstallMarketplaceAction)
    app.delete("/api/marketplace/actions/:packageId/install", async (c) => {
      const item = options.marketplaceActions?.find(
        (candidate) => candidate.packageId === c.req.param("packageId"),
      );
      if (!item) return c.json({ error: "Unknown historical Action" }, 404);
      await options.uninstallMarketplaceAction!(item.id);
      return new Response(null, { status: 204 });
    });
  app.get("/api/marketplace/plugins/:packageId/install", async (c) => {
    const item = await plugin(c.req.param("packageId"));
    if (!item) return c.json({ error: "Unknown local marketplace plugin" }, 404);
    return c.json(await options.getPluginInstallScope?.(item.id) ?? { scope: "global" });
  });
  app.post("/api/marketplace/plugins/:packageId/install", async (c) => {
    const item = await plugin(c.req.param("packageId"));
    if (!item)
      return c.json({ error: "Unknown local marketplace plugin" }, 404);
    if (!marketplaceInstallation(describe(item)))
      return c.json(
        {
          code: "MARKETPLACE_INSTALL_UNSUPPORTED",
          error: "This Host does not offer installation for this plugin.",
        },
        409,
      );
    const raw = await c.req.text();
    let installation: HostInstallScope = { scope: "global" };
    if (raw.trim()) {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return c.json({ error: "Invalid installation scope" }, 400); }
      const parsed = HostInstallScopeSchema.safeParse(value);
      if (!parsed.success) return c.json({ error: "Invalid installation scope" }, 400);
      installation = parsed.data;
    }
    if (installation.scope === "projects" && (!options.validateInstallProjects || !await options.validateInstallProjects(installation.projectIds))) {
      return c.json({ error: "Choose existing projects" }, 400);
    }
    if (raw.trim()) await options.installMarketplacePlugin!(item.packageId, installation);
    else await options.installMarketplacePlugin!(item.packageId);
    const active = (await options.readInstalledPlugin!(item.id)) as {
      id?: unknown;
      version?: unknown;
      manifest?: unknown;
    };
    const manifest = ExecutablePluginManifestSchema.parse(active.manifest);
    if (
      active.id !== item.id ||
      manifest.id !== item.id ||
      active.version !== manifest.version
    )
      throw new Error("Active plugin does not match the requested package.");
    return c.json({
      id: item.id,
      packageId: item.packageId,
      version: manifest.version,
      installed: true,
    });
  });
  if (options.uninstallMarketplacePlugin)
    app.delete("/api/marketplace/plugins/:packageId/install", async (c) => {
      const item = await plugin(c.req.param("packageId"));
      if (!item)
        return c.json({ error: "Unknown local marketplace plugin" }, 404);
      await options.uninstallMarketplacePlugin!(item.id);
      return new Response(null, { status: 204 });
    });
  app.get("/api/marketplace/skills/:skillId/install", async c => {
    const id = c.req.param("skillId");
    if (!skill(id)) return c.json({ error: "Unknown skill plugin" }, 404);
    const record = (await options.listInstalledMarketplaceSkills?.() ?? []).find(item => item.skillId === id);
    return c.json(record?.installation ?? { scope: "global" });
  });
  app.post("/api/marketplace/skills/:skillId/install", async (c) => {
    const id = c.req.param("skillId"),
      item = skill(id);
    if (!item) return c.json({ error: "Unknown local marketplace skill" }, 404);
    if (!marketplaceInstallation(describe(item)))
      return c.json(
        {
          code: "MARKETPLACE_INSTALL_UNSUPPORTED",
          error: "This Host does not offer installation for this skill.",
        },
        409,
      );
    const raw = await c.req.text();
    let scope: HostInstallScope | undefined;
    if (raw.trim()) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        return c.json({ error: "Invalid installation scope" }, 400);
      }
      const parsed = HostInstallScopeSchema.safeParse(value);
      if (!parsed.success)
        return c.json(
          { error: "Invalid installation scope", details: parsed.error.issues },
          400,
        );
      scope = parsed.data;
    }
    if (scope?.scope === "projects" && (!options.validateInstallProjects || !await options.validateInstallProjects(scope.projectIds))) return c.json({ error: "Choose existing projects" }, 400);
    const result = scope
      ? await options.installMarketplaceSkill!(id, scope)
      : await options.installMarketplaceSkill!(id);
    await options.reconcileSkillProjects?.();
    const installed = (await options.listInstalledMarketplaceSkills!()).find(
      (record) => record.skillId === id,
    );
    if (!installed)
      throw new Error("Host could not find the installed skill and its files.");
    return c.json({ ...result, skillId: id, installed: true });
  });
  if (options.uninstallMarketplaceSkill)
    app.delete("/api/marketplace/skills/:skillId/install", async (c) => {
      const id = c.req.param("skillId");
      if (!skill(id))
        return c.json({ error: "Unknown local marketplace skill" }, 404);
      await options.uninstallMarketplaceSkill!(id);
      await options.reconcileSkillProjects?.();
      return new Response(null, { status: 204 });
    });
  return app;
}
