import {
  ProjectTimelineEnvelopeSchema,
  type ProjectHostCommand,
  type ProjectTimeline,
  type TimelineRenderFallbackReason,
} from "@clash/shared-types";

export type { TimelineRenderFallbackReason };
import {
  sendProjectHostCommand,
  type ProjectHostHttpRequest,
  type ProjectHostResponse,
} from "./project-host-http.js";

/** Keep this observation with the editor's draft, not in a mutable latest-token cache. */
export interface ObservedProjectTimeline {
  timeline: ProjectTimeline;
  readToken: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Timeline Host response");
  }
  return value as Record<string, unknown>;
}

function observation(value: unknown, token: unknown): ObservedProjectTimeline {
  const raw = record(value);
  if (typeof raw.id !== "string" || !raw.id || typeof raw.revisionId !== "string" || !raw.revisionId) {
    throw new Error("Timeline response is missing its identity or revision");
  }
  if (typeof token !== "string" || !token) {
    throw new Error("Timeline response is missing its observation");
  }
  const envelope = ProjectTimelineEnvelopeSchema.parse({
    name: raw.name, owner: raw.owner, state: raw.state,
  });
  return {
    timeline: { id: raw.id, revisionId: raw.revisionId, ...envelope },
    readToken: token,
  };
}

/** What a Timeline render request returns, whichever executor ran it. */
export interface TimelineRenderReceipt {
  actionRunId: string;
  renderNodeId: string;
  /** Absent on a plain Host submission, which never chose a browser path. */
  renderPath?: "browser" | "host";
  fallback?: {
    reason: TimelineRenderFallbackReason;
    message: string;
  };
  publicationRetried?: {
    firstError: string;
  };
}

/**
 * In-flight state of one render request. Progress is path-neutral: an
 * executor that can report it does; the Host-backed default simply never
 * calls `onProgress` and finishes with the persisted render node.
 */
export interface TimelineRenderExecution {
  signal: AbortSignal;
  onProgress(progress: number): void;
}

/**
 * Executes `render()`. The default asks the Host (`request_timeline_render`);
 * a composition root may bind another executor, which owns its own fallback
 * to `submit`, the Host request. A cancelled execution rejects with the
 * caller's `AbortSignal` reason and must not call `submit`.
 */
export type TimelineRenderExecutor = (
  input: {
    projectId: string;
    observed: ObservedProjectTimeline;
    actorAgentId?: string;
    submit(): Promise<TimelineRenderReceipt>;
  } & TimelineRenderExecution,
) => Promise<TimelineRenderReceipt>;

/** Browser-safe projection client for the existing native Timeline Host commands. */
export function createTimelineClient(options: {
  projectId: string;
  request: ProjectHostHttpRequest;
  renderExecutor?: TimelineRenderExecutor;
}) {
  const command = async (input: ProjectHostCommand): Promise<ProjectHostResponse> => {
    const body = await sendProjectHostCommand({ ...options, command: input });
    if (body.error) throw new Error(body.error);
    return body;
  };
  const mutate = async (input: ProjectHostCommand): Promise<ObservedProjectTimeline> => {
    const body = await command(input);
    return observation(body.timeline, body.readToken);
  };
  return {
    async list(): Promise<ObservedProjectTimeline[]> {
      const body = await command({ action: "list_timelines" });
      if (!Array.isArray(body.timelines)) throw new Error("Invalid Timeline list response");
      const versions = record(body.versions);
      return body.timelines.map((value) => {
        const raw = record(value);
        return observation(raw, versions[String(raw.id)]);
      });
    },
    create(input: { id: string; name: string; state: unknown; placement?: { canvasId: string; actionNodeId: string; position?: { x: number; y: number } } }) {
      return mutate({ action: "create_timeline", timelineId: input.id, name: input.name, state: input.state, ...(input.placement ? { placement: input.placement } : {}) });
    },
    apply(observed: ObservedProjectTimeline, state: unknown) {
      return mutate({
        action: "update_timeline_state", timelineId: observed.timeline.id, state,
        actorClientType: "browser", ifMatch: observed.readToken,
      });
    },
    attach(observed: ObservedProjectTimeline, input: {
      canvasId: string; actionNodeId: string; position?: { x: number; y: number };
    }) {
      return mutate({
        action: "attach_timeline", timelineId: observed.timeline.id, ...input,
        actorClientType: "browser", ifMatch: observed.readToken,
      });
    },
    detach(observed: ObservedProjectTimeline) {
      return mutate({
        action: "detach_timeline", timelineId: observed.timeline.id,
        actorClientType: "browser", ifMatch: observed.readToken,
      });
    },
    async remove(observed: ObservedProjectTimeline) {
      const body = await command({ action: "delete_timeline", timelineId: observed.timeline.id,
        actorClientType: "browser", ifMatch: observed.readToken });
      if (body.deleted !== true || body.timelineId !== observed.timeline.id) throw new Error("Timeline deletion was not acknowledged");
    },
    render(observed: ObservedProjectTimeline, actorAgentId?: string, execution?: TimelineRenderExecution): Promise<TimelineRenderReceipt> {
      const submit = async () => {
        const body = await command({ action: "request_timeline_render", timelineId: observed.timeline.id,
          actorClientType: "browser", ifMatch: observed.readToken, ...(actorAgentId ? { actorAgentId } : {}) });
        if (body.submitted !== true || typeof body.actionRunId !== "string" || typeof body.renderNodeId !== "string") throw new Error("Timeline render submission was not acknowledged");
        return { actionRunId: body.actionRunId, renderNodeId: body.renderNodeId };
      };
      if (!options.renderExecutor) return submit();
      const fallbackController = execution ? undefined : new AbortController();
      return options.renderExecutor({
        projectId: options.projectId,
        observed,
        ...(actorAgentId ? { actorAgentId } : {}),
        signal: execution?.signal ?? fallbackController!.signal,
        onProgress: execution?.onProgress ?? (() => undefined),
        submit,
      });
    },
  };
}
