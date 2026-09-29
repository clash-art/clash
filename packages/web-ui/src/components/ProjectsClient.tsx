import { useEffect, useState } from "react";
import { createProject } from "@clash/web-ui/lib/clientActions";
import ProjectCard from "./ProjectCard";
import ProjectCreateTile from "./ProjectCreateTile";
import { AppPage, AppPageHeader } from "./AppPage";

interface ProjectsClientProps {
  projects: any[]; // Using relaxed type to accommodate Drizzle result with assets
}

export default function ProjectsClient({ projects }: ProjectsClientProps) {
  const [projectList, setProjectList] = useState(projects || []);
  useEffect(() => setProjectList(projects || []), [projects]);
  const isEmpty = projectList.length === 0;

  return (
    <div className="clash-dashboard-shell min-h-screen">
      <AppPage width="wide">
        <AppPageHeader
          title="Projects"
          description="Open a canvas or start a new one."
        />

        {/* Projects Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <ProjectCreateTile
            ariaLabel="Create a new project"
            empty={isEmpty}
            onCreate={async (projectName) => {
              await createProject(projectName, { startFromPrompt: false });
            }}
          />

          {projectList.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onArchived={(projectId) =>
                setProjectList((current) =>
                  current.filter((item) => item.id !== projectId),
                )
              }
            />
          ))}
        </div>
      </AppPage>
    </div>
  );
}
