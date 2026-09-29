import { marketplaceInstallation } from "@clash/shared-types/marketplace-installation";
import { useEffect, useState } from "react";
import { fetchRegistry, listLocalPlugins, listInstalledSkills, type RegistryItem } from "../lib/clientActions";
import { PluginInstallControl } from "./PluginInstallControl";
import { InlineAlert } from "./ui/feedback";

export function SettingsPlugins({ projectId }: { projectId?: string }) {
  const [data, setData] = useState<{items: RegistryItem[]; installed: Set<string>; others: string[]} | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([fetchRegistry(), listLocalPlugins(), listInstalledSkills()]).then(([registry, packages, skills]) => {
      if (!active) return;
      const installed = new Set(packages.filter(item => !item.drifted).map(item => item.id));
      for (const skill of skills) installed.add(skill.skillId);
      setData({ items: [...registry.plugins, ...registry.skills], installed, others: packages.filter(item => !registry.plugins.some(entry => entry.id === item.id)).map(item => item.id) });
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  return <section>
    <h2 className="text-lg font-semibold">Plugins</h2>
    <p className="mt-1 text-sm text-content-muted">{projectId ? "Manage plugins for this project and their installation scope." : "Manage installed plugins and choose which projects can use them."}</p>
    {error ? <InlineAlert tone="error" title={error} /> : !data ? <p role="status">Loading plugins…</p> : <div className="mt-4 divide-y divide-border">
      {[...data.items].sort((a,b) => Number(data.installed.has(b.id)) - Number(data.installed.has(a.id))).map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div><h3 className="text-sm font-medium">{item.name}</h3><p className="text-xs text-content-muted">{item.description}</p></div>
        {marketplaceInstallation(item) ? <PluginInstallControl item={item} installed={data.installed.has(item.id)} projectId={projectId} /> : <span className="text-xs text-content-muted">{data.installed.has(item.id) ? "Installed · Host package" : "Unavailable"}</span>}
      </div>)}
      {data.others.map(id => <div key={id} className="py-3 text-sm">{id}<span className="ml-2 text-xs text-content-muted">Installed · Host package</span></div>)}
    </div>}
  </section>;
}
