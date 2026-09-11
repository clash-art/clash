import {
  ProjectTimelineEnvelopeSchema,
  type ProjectHostCommand,
  type ProjectTimeline,
} from "@clash/shared-types";
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

/** Browser-safe projection client for the existing native Timeline Host commands. */
export function createTimelineClient(options: {
  projectId: string;
  request: ProjectHostHttpRequest;
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
    async render(observed: ObservedProjectTimeline, actorAgentId?: string) {
      const body = await command({ action: "request_timeline_render", timelineId: observed.timeline.id,
        actorClientType: "browser", ifMatch: observed.readToken, ...(actorAgentId ? { actorAgentId } : {}) });
      if (body.submitted !== true || typeof body.actionRunId !== "string" || typeof body.renderNodeId !== "string") throw new Error("Timeline render submission was not acknowledged");
      return { actionRunId: body.actionRunId, renderNodeId: body.renderNodeId };
    },
  };
}
