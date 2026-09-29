import { useEffect, useState } from "react";
import type { HostInstallScope } from "@clash/shared-types";
import type { RegistryItem } from "../lib/clientActions";
import { marketplaceInstallPlugin, marketplacePluginScope } from "../lib/clientActions";
import { PluginInstallScopeDialog } from "./PluginInstallScopeDialog";
import { Button } from "./ui/button";
import { InlineAlert } from "./ui/feedback";

export function PluginInstallControl({ item, installed: initialInstalled, projectId, onChanged }: {
  item: RegistryItem; installed: boolean; projectId?: string; onChanged?: () => void;
}) {
  const [installed, setInstalled] = useState(initialInstalled);
  const [scope, setScope] = useState<HostInstallScope | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!initialInstalled) { setScope(projectId ? { scope: "projects", projectIds: [projectId] } : { scope: "global" }); return; }
    void marketplacePluginScope(item).then(value => { if (active) setScope(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [item, initialInstalled, projectId]);
  const enabled = scope?.scope === "global" || scope?.scope === "projects" && !!projectId && scope.projectIds.includes(projectId);
  const save = async (next: HostInstallScope) => {
    await marketplaceInstallPlugin(item, next);
    setInstalled(true); setScope(next); onChanged?.();
  };
  return <div className="flex flex-col items-start gap-2">
    {installed && scope ? <span className="text-xs text-content-muted">{scope.scope === "global" ? "All projects" : projectId ? enabled ? "Installed in this project" : "Not installed in this project" : `${scope.projectIds.length} selected projects`}</span> : null}
    <div className="flex gap-2">
      <Button size="sm" disabled={!scope} onClick={() => setOpen(true)}>{installed ? "Manage installation" : "Install"}</Button>
      {installed && projectId && scope?.scope === "projects" && !enabled ? <Button size="sm" onClick={() => void save({ scope: "projects", projectIds: [...scope.projectIds, projectId] }).catch(cause => setError(String(cause)))}>Install in this project</Button> : null}
    </div>
    {error ? <InlineAlert tone="error" title={error} /> : null}
    {open && scope ? <PluginInstallScopeDialog initial={scope} onClose={() => setOpen(false)} onSave={save} /> : null}
  </div>;
}
