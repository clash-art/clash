import { useEffect, useState } from "react";
import type { HostInstallScope } from "@clash/shared-types";
import { listProjects } from "../lib/clientActions";
import { Dialog } from "./ui/dialog";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { InlineAlert } from "./ui/feedback";

export function PluginInstallScopeDialog({ initial, onClose, onSave }: {
  initial: HostInstallScope;
  onClose: () => void;
  onSave: (scope: HostInstallScope) => Promise<void>;
}) {
  const [scope, setScope] = useState(initial.scope);
  const [ids, setIds] = useState(initial.scope === "projects" ? initial.projectIds : []);
  const [projects, setProjects] = useState<Array<{id: string; name: string}>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void listProjects().then(value => { if (active) setProjects(value); }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setPending(true); setError(null);
    try { await onSave(scope === "global" ? { scope } : { scope, projectIds: ids }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <Dialog open onClose={() => { if (!pending) onClose(); }} title="Install to" size="md">
    <RadioGroup value={scope} onValueChange={value => setScope(value as "global" | "projects")} aria-label="Installation scope" disabled={pending}>
      <RadioGroupItem value="global">All projects <span className="block text-xs text-content-muted">Including future projects</span></RadioGroupItem>
      <RadioGroupItem value="projects">Selected projects</RadioGroupItem>
    </RadioGroup>
    {scope === "projects" ? <div className="my-3 max-h-64 overflow-y-auto space-y-2">
      {projects.map(project => <label key={project.id} className="flex items-center gap-2 text-sm">
        <Checkbox checked={ids.includes(project.id)} disabled={pending} onCheckedChange={checked => setIds(old => checked ? [...old, project.id] : old.filter(id => id !== project.id))} />
        {project.name}
      </label>)}
      {projects.length === 0 ? <p className="text-sm text-content-muted">No projects available.</p> : null}
    </div> : null}
    {error ? <InlineAlert tone="error" title={error} className="mt-3" /> : null}
    <div className="mt-4 flex justify-end gap-2"><Button onClick={onClose} disabled={pending}>Cancel</Button><Button variant="primary" disabled={pending || scope === "projects" && ids.length === 0} onClick={() => void save()}>{pending ? "Saving…" : "Save"}</Button></div>
  </Dialog>;
}
