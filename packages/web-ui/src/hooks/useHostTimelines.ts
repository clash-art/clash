import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoroDoc } from "loro-crdt";
import { createTimelineClient, type ObservedProjectTimeline, type ProjectHostHttpRequest } from "@clash/shared-runtime";
import {
  PROJECT_GENERATORS_CONTAINER, projectTimelineReadToken, validateAgentObservation,
  hostMutationRejected, hostMutationSucceeded,
  type ProjectTimeline, type ProjectTimelineMutationResult, type HostMutationRecord,
  type CreateTimelineOnCanvasInput,
} from "@clash/shared-types";
import { runtimeApiUrl } from "../lib/runtimeConfig";

// Mutations are never automatically retried after an ambiguous network failure.
const runtimeRequest: ProjectHostHttpRequest = (path, init) => fetch(runtimeApiUrl(path), { credentials: "include", ...init });
type WriteOptions = { ifMatch?: string; actorClientType?: string };

export function useHostTimelines(options: {
  projectId: string; doc: LoroDoc | null; canvasId?: string; connected?: boolean;
  onMutation?: (record: HostMutationRecord) => void; request?: ProjectHostHttpRequest;
}) {
  const { projectId, doc, canvasId = "main", connected, request = runtimeRequest } = options;
  const onMutation = useRef(options.onMutation);
  onMutation.current = options.onMutation;
  const state = useMemo(() => ({
    client: createTimelineClient({ projectId, request }), active: true, serial: 0,
    observations: [] as ObservedProjectTimeline[],
  }), [projectId, request]);
  const current = useRef(state);
  current.current = state;
  const [snapshot, setSnapshot] = useState({ owner: state, timelines: [] as ProjectTimeline[], error: null as string | null });
  const publish = useCallback((observations: ObservedProjectTimeline[]) => {
    if (!state.active || current.current !== state) return;
    state.serial++;
    state.observations = observations;
    setSnapshot({ owner: state, timelines: observations.map((item) => item.timeline), error: null });
  }, [state]);
  const report = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (state.active && current.current === state) setSnapshot((previous) => ({ owner: state, timelines: previous.owner === state ? previous.timelines : [], error: message }));
    return message;
  }, [state]);
  const refresh = useCallback(async () => {
    const serial = ++state.serial;
    try {
      const observations = await state.client.list();
      if (serial === state.serial) publish(observations);
    } catch (error) { if (serial === state.serial) report(error); }
  }, [state, publish, report]);

  useEffect(() => {
    state.active = true;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = doc?.getMap(PROJECT_GENERATORS_CONTAINER).subscribe(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; void refresh(); }, 30);
    });
    return () => { state.active = false; if (timer !== undefined) clearTimeout(timer); unsubscribe?.(); };
  }, [doc, state, refresh, connected]);

  const observe = useCallback((id: string, write?: WriteOptions) => {
    const observed = state.observations.find((item) => item.timeline.id === id);
    if (!observed) throw new Error(`Timeline ${id} has not been read from the Host`);
    const version = projectTimelineReadToken(observed.timeline);
    if (write?.ifMatch && write.ifMatch !== version && write.ifMatch !== observed.readToken) throw new Error("STALE_READ: Timeline changed after it was read. Read it again before saving.");
    const guard = validateAgentObservation({ actorClientType: write?.actorClientType, operation: "applying Timeline state",
      observedVersion: write?.ifMatch ? version : undefined, currentVersion: version });
    if (!guard.ok) throw new Error(guard.error);
    return observed;
  }, [state]);
  const mutate = useCallback(async (action: () => Promise<ObservedProjectTimeline>): Promise<ProjectTimelineMutationResult> => {
    const serial = ++state.serial;
    try {
      const observed = await action();
      const needsRefresh = state.serial !== serial;
      publish([...state.observations.filter((item) => item.timeline.id !== observed.timeline.id), observed]);
      if (needsRefresh) void refresh();
      return { ok: true, timeline: observed.timeline };
    } catch (error) { return { ok: false, error: report(error) }; }
  }, [state, publish, refresh, report]);

  const createTimeline = useCallback((input: { id: string; name: string; state: unknown }) => mutate(() => state.client.create(input)), [state, mutate]);
  const createTimelineOnCanvas = useCallback((input: Omit<CreateTimelineOnCanvasInput, "canvasId"> & { canvasId?: string }) => mutate(() => state.client.create({
    id: input.id, name: input.name, state: input.state,
    placement: { canvasId: input.canvasId ?? canvasId, actionNodeId: input.actionNodeId, position: input.position },
  })), [state, mutate, canvasId]);
  const attachTimeline = useCallback((input: { timelineId: string; canvasId?: string; actionNodeId: string; position?: { x: number; y: number } }) => mutate(() => state.client.attach(observe(input.timelineId), {
    canvasId: input.canvasId ?? canvasId, actionNodeId: input.actionNodeId, position: input.position,
  })), [state, mutate, observe, canvasId]);
  const detachTimeline = useCallback((id: string) => mutate(() => state.client.detach(observe(id))), [state, mutate, observe]);
  const deleteTimeline = useCallback(async (id: string, ifMatch?: string) => {
    ++state.serial;
    try {
      await state.client.remove(observe(id, { ifMatch }));
      publish(state.observations.filter((item) => item.timeline.id !== id));
      return { ok: true as const, timelineId: id };
    } catch (error) { return { ok: false as const, error: report(error) }; }
  }, [state, observe, publish, report]);
  const applyTimelineState = useCallback(async (id: string, dsl: unknown, write?: WriteOptions): Promise<ProjectTimeline | false> => {
    const before = state.observations.find((item) => item.timeline.id === id);
    const envelope = { operation: "timeline_apply" as const, entity: { kind: "timeline" as const, id }, expectedReadToken: write?.ifMatch,
      ...(before ? { beforeReadToken: projectTimelineReadToken(before.timeline) } : {}) };
    const result = await mutate(() => state.client.apply(observe(id, write), dsl));
    onMutation.current?.(result.ok ? hostMutationSucceeded(envelope, { resultEntityId: id, afterReadToken: projectTimelineReadToken(result.timeline) }) : hostMutationRejected(envelope, result.error));
    return result.ok ? result.timeline : false;
  }, [state, mutate, observe]);
  const requestTimelineRender = useCallback(async (id: string, actor: { actorUserId: string; actorAgentId?: string }) => {
    try { return { ok: true as const, ...await state.client.render(observe(id), actor.actorAgentId) }; }
    catch (error) { return { ok: false as const, error: report(error) }; }
  }, [state, observe, report]);

  return {
    timelines: snapshot.owner === state ? snapshot.timelines : [],
    timelineError: snapshot.owner === state ? snapshot.error : null,
    refresh, createTimeline, createTimelineOnCanvas, attachTimeline, detachTimeline,
    deleteTimeline, applyTimelineState, requestTimelineRender,
  };
}
