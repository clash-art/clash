import { useCallback, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  SettingsSurface,
  isSettingsSection,
  readLastSettingsSection,
  writeLastSettingsSection,
} from "@clash/web-ui/components/SettingsSurface";
import type { SettingsSection } from "@clash/web-ui/components/SettingsClient";
import {
  readProviderOAuthReturn,
  withoutProviderOAuthReturn,
} from "@clash/web-ui/lib/provider-authorization";

export default function SettingsRoute() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("project");
  const returnTo = searchParams.get("returnTo");
  const projectPath = projectId ? `/projects/${encodeURIComponent(projectId)}` : null;
  const backToProject = projectPath && returnTo && (returnTo === projectPath || returnTo.startsWith(`${projectPath}?`)) ? returnTo : projectPath;
  const sectionParam = searchParams.get("section");
  const active: SettingsSection = isSettingsSection(sectionParam)
    ? sectionParam
    : readLastSettingsSection() ?? "agents";

  useEffect(() => {
    writeLastSettingsSection(active);
    if (sectionParam === active) return;
    setSearchParams((next) => {
      next.set("section", active);
      return next;
    }, { replace: true });
  }, [active, sectionParam, setSearchParams]);

  // A provider's web redirect lands here once; drop it from the address after it is shown so a
  // reload does not report it again.
  const searchKey = searchParams.toString();
  const providerOAuthReturn = useMemo(
    () => readProviderOAuthReturn(new URLSearchParams(searchKey)),
    [searchKey],
  );
  const handleProviderOAuthReturnHandled = useCallback(() => {
    setSearchParams((next) => withoutProviderOAuthReturn(next), { replace: true });
  }, [setSearchParams]);

  const handleActiveChange = useCallback(
    (section: SettingsSection) => {
      writeLastSettingsSection(section);
      setSearchParams((next) => {
        next.set("section", section);
        return next;
      }, { replace: true });
    },
    [setSearchParams],
  );

  return (
    <main className="h-full min-h-[100dvh] w-full overflow-hidden bg-warm-page text-slate-950 dark:text-slate-50 md:min-h-full">
      <SettingsSurface projectId={projectId ?? undefined} active={active} onActiveChange={handleActiveChange} variant="page" onClose={backToProject ? () => navigate(backToProject) : undefined} providerOAuthReturn={providerOAuthReturn} onProviderOAuthReturnHandled={handleProviderOAuthReturnHandled} />
    </main>
  );
}
