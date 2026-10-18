import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useSearchParams } from "react-router";
import ProjectEditor from "@clash/web-ui/components/ProjectEditor";
import { dispatchDesktopTabConnection } from "@clash/web-ui/lib/desktopTabs";
import { createLogger } from "../lib/logger";
import { runtimeFetch } from "@clash/web-ui/lib/runtimeConfig";

export { ErrorBoundary } from "../root";

const projectOpenLog = createLogger("project-open");

/** A project open that takes longer than this is logged while still pending. */
export const PROJECT_OPEN_SLOW_MS = 5_000;
/**
 * A project open fails with a coded error after this long instead of leaving
 * the "Opening…" state on screen with nothing in the logs.
 */
export const PROJECT_OPEN_TIMEOUT_MS = 30_000;

export class ProjectOpenError extends Error {
  constructor(
    readonly code: "PROJECT_OPEN_TIMEOUT" | "PROJECT_OPEN_HOST_UNREACHABLE",
    message: string,
  ) {
    super(message);
    this.name = "ProjectOpenError";
  }
}

export async function loader({ params, request }: LoaderFunctionArgs) {
  const id = params.id!;
  const startedAt = performance.now();
  const elapsedMs = () => Math.round(performance.now() - startedAt);
  const timeout = new AbortController();
  const slowTimer = setTimeout(() => {
    projectOpenLog.warn("project.open_slow", {
      projectId: id,
      elapsedMs: elapsedMs(),
      phase: "host_request",
    });
  }, PROJECT_OPEN_SLOW_MS);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      timeout.abort();
      reject(
        new ProjectOpenError(
          "PROJECT_OPEN_TIMEOUT",
          `The local Host did not return this project within ${PROJECT_OPEN_TIMEOUT_MS / 1000} s. Try again; if it keeps happening, restart Clash and send the logs.`,
        ),
      );
    }, PROJECT_OPEN_TIMEOUT_MS);
  });
  const signal = request?.signal
    ? AbortSignal.any([request.signal, timeout.signal])
    : timeout.signal;
  try {
    let projRes: Response;
    try {
      projRes = await Promise.race([
        runtimeFetch(`/api/v1/projects/${encodeURIComponent(id)}`, {
          credentials: "include",
          signal,
        }),
        timedOut,
      ]);
    } catch (error) {
      if (request?.signal?.aborted) throw error;
      dispatchDesktopTabConnection({
        path: `/projects/${id}`,
        connection: "disconnected",
      });
      const failure =
        error instanceof ProjectOpenError
          ? error
          : new ProjectOpenError(
              "PROJECT_OPEN_HOST_UNREACHABLE",
              `The local Host could not be reached to open this project (${error instanceof Error ? error.message : String(error)}). Try again; if it keeps happening, restart Clash.`,
            );
      projectOpenLog.error("project.open_failed", {
        projectId: id,
        code: failure.code,
        elapsedMs: elapsedMs(),
      });
      throw failure;
    }

    if (projRes.status === 401) throw redirect("/login");
    if (!projRes.ok) {
      projectOpenLog.error("project.open_failed", {
        projectId: id,
        code: `HTTP_${projRes.status}`,
        elapsedMs: elapsedMs(),
      });
    }
    if (projRes.status === 404) throw new Response("Project not found", { status: 404 });
    if (!projRes.ok) {
      throw new Response(`Failed to load project (${projRes.status})`, {
        status: projRes.status,
      });
    }

    const project = (await Promise.race([projRes.json(), timedOut])) as unknown;
    if (elapsedMs() >= PROJECT_OPEN_SLOW_MS) {
      projectOpenLog.warn("project.open_slow_completed", {
        projectId: id,
        elapsedMs: elapsedMs(),
      });
    }
    return { project };
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(timeoutTimer);
    timedOut.catch(() => undefined);
  }
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
