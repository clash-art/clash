import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import ProjectEditor from "@clash/web-ui/components/ProjectEditor";
import { dispatchDesktopTabConnection } from "@clash/web-ui/lib/desktopTabs";
import { runtimeFetch } from "@clash/web-ui/lib/runtimeConfig";

export { ErrorBoundary } from "../root";

export async function loader({ params }: LoaderFunctionArgs) {
  const id = params.id!;
  let projRes: Response;
  try {
    projRes = await runtimeFetch(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      { credentials: "include" },
    );
  } catch (error) {
    dispatchDesktopTabConnection({
      path: `/projects/${id}`,
      connection: "disconnected",
    });
    throw error;
  }

  if (projRes.status === 401) throw redirect("/login");
  if (projRes.status === 404) throw new Response("Project not found", { status: 404 });
  if (!projRes.ok) {
    throw new Response(`Failed to load project (${projRes.status})`, {
      status: projRes.status,
    });
  }

  const project = (await projRes.json()) as unknown;
  return { project };
}

export default function ProjectRoute() {
  const { project } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const prompt = searchParams.get("prompt") ?? undefined;
  const thread = searchParams.get("thread") ?? undefined;
  return (
    <ProjectEditor
      key={(project as { id: string }).id}
      project={project as any}
      initialPrompt={prompt}
      initialThreadId={thread}
    />
  );
}
