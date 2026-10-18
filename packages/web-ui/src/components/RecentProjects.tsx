import { useCallback, useLayoutEffect, useRef, useState } from "react";
import ProjectCard from "./ProjectCard";
import ProjectCreateTile from "./ProjectCreateTile";
import { HomeSectionActionLink, HomeSectionHeader } from "./HomeSectionHeader";
import type { ProjectReference } from "./dashboardComposerReferences";

interface RecentProjectsProps {
  projects: any[]; // Relaxed type to accept Drizzle result with assets
  onCreateProject: (projectName: string) => void | Promise<void>;
  composerProjectReferenceId?: string | null;
  onAddProjectReference?: (project: ProjectReference) => void;
  /** The project list is still being read from the Host. */
  loading?: boolean;
}
export default function RecentProjects({
  projects,
  onCreateProject,
  composerProjectReferenceId = null,
  onAddProjectReference,
  loading = false,
}: RecentProjectsProps) {
  const [archivedProjectIds, setArchivedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const projectList = (projects || [])
    .filter((project) => !archivedProjectIds.has(project.id))
    .slice(0, 5);
  const railRef = useRef<HTMLDivElement>(null);
  const [edgeCues, setEdgeCues] = useState({ left: false, right: false });
  const updateEdgeCues = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScrollLeft = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const next = {
      left: rail.scrollLeft > 1,
      right: rail.scrollLeft < maxScrollLeft - 1,
    };
    setEdgeCues((current) =>
      current.left === next.left && current.right === next.right
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    updateEdgeCues();
    window.addEventListener("resize", updateEdgeCues);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateEdgeCues);
    if (railRef.current) observer?.observe(railRef.current);
    return () => {
      window.removeEventListener("resize", updateEdgeCues);
      observer?.disconnect();
    };
  }, [projectList.length, updateEdgeCues]);

  return (
    <section
      aria-labelledby="recent-projects-heading"
      className="clash-home-section clash-recent-projects"
    >
      <HomeSectionHeader
        id="recent-projects-heading"
        title="Recently viewed"
        alignWithChrome
        action={
          <div className="flex items-center gap-1">
            <ProjectCreateTile
              ariaLabel="Start a new project"
              presentation="header-action"
              onCreate={onCreateProject}
            />
            <HomeSectionActionLink to="/projects">
              See all
            </HomeSectionActionLink>
          </div>
        }
      />

      <div
        data-slot="recent-project-rail-shell"
        data-can-scroll-left={String(edgeCues.left)}
        data-can-scroll-right={String(edgeCues.right)}
        className="clash-recent-project-rail-shell"
      >
        <div
          ref={railRef}
          data-slot="recent-project-rail"
          aria-label="Recently viewed projects"
          className="clash-recent-project-grid"
          aria-busy={loading || undefined}
          onScroll={updateEdgeCues}
        >
          {loading ? (
            <p
              role="status"
              data-slot="recent-projects-loading"
              className="flex min-h-24 items-center px-1 text-sm text-content-secondary"
            >
              Loading projects…
            </p>
          ) : null}
          {projectList.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              composerProjectReferenceId={composerProjectReferenceId}
              onAddProjectReference={onAddProjectReference}
              onArchived={(projectId) =>
                setArchivedProjectIds((current) => {
                  const next = new Set(current);
                  next.add(projectId);
                  return next;
                })
              }
            />
          ))}
          <ProjectCreateTile
            ariaLabel="Create a new project from the recent projects rail"
            onCreate={onCreateProject}
          />
        </div>
      </div>
    </section>
  );
}
