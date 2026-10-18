import { Suspense, useCallback } from "react";
import { Await } from "react-router";
import type { Project } from "@clash/web-ui/lib/types";
import { createProject } from "@clash/web-ui/lib/clientActions";
import type { RegistryItem } from "@clash/web-ui/lib/clientActions";
import HomeMarketplaceRecommendations from "./HomeMarketplaceRecommendations";
import HomeOperations from "./HomeOperations";
import RecentProjects from "./RecentProjects";
import { AppPage } from "./AppPage";
import { useOptionalDashboardComposer } from "./DashboardComposerContext";

interface HomePageClientProps {
  /**
   * A pending list streams in: the Dashboard renders at once and the recent
   * projects rail says it is loading instead of holding the whole page.
   */
  initialProjects: Project[] | Promise<Project[]>;
  marketplaceFeed?: {
    featuredPlugins: RegistryItem[];
    installedActionIds: string[];
    installedPluginIds: string[];
    installedSkillIds: string[];
  };
}

export default function HomePageClient({
  initialProjects,
  marketplaceFeed = {
    featuredPlugins: [],
    installedActionIds: [],
    installedPluginIds: [],
    installedSkillIds: [],
  },
}: HomePageClientProps) {
  const composer = useOptionalDashboardComposer();
  const handleCreateProject = useCallback(async (projectName: string) => {
    await createProject(projectName, { startFromPrompt: false });
  }, []);

  const renderRecentProjects = (projects: Project[], loading = false) => (
    <RecentProjects
      projects={projects}
      loading={loading}
      onCreateProject={handleCreateProject}
      composerProjectReferenceId={composer?.references.project?.id ?? null}
      onAddProjectReference={composer?.addProjectReference}
    />
  );

  return (
    <div className="clash-home-page min-h-full bg-warm-page text-content-primary">
      <AppPage className="clash-home-section-stack">
        {Array.isArray(initialProjects) ? (
          renderRecentProjects(initialProjects)
        ) : (
          <Suspense fallback={renderRecentProjects([], true)}>
            <Await resolve={initialProjects}>
              {(projects: Project[]) => renderRecentProjects(projects)}
            </Await>
          </Suspense>
        )}
        <HomeOperations />
        <HomeMarketplaceRecommendations {...marketplaceFeed} />
      </AppPage>
    </div>
  );
}
