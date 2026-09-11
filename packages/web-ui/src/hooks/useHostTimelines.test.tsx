// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { LoroDoc } from "loro-crdt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectTimelineReadToken, type ProjectTimeline } from "@clash/shared-types";
import { useHostTimelines } from "./useHostTimelines";

afterEach(cleanup);
const timeline: ProjectTimeline = { id: "native-cut", name: "Native cut", owner: { kind: "project" }, revisionId: "host-original", state: { tracks: [] } };

describe("Host Timeline state", () => {
  it("sends creation, ownership changes, and deletion to the same Host authority", async () => {
    const created = { ...timeline, owner: { kind: "canvas-action" as const, canvasId: "shots", actionNodeId: "editor" } };
    const request = vi.fn().mockResolvedValueOnce(Response.json({ timelines: [], versions: {} }))
      .mockResolvedValueOnce(Response.json({ timeline: created, readToken: "created-receipt" }))
      .mockResolvedValueOnce(Response.json({ timeline, readToken: "detached-receipt" }))
      .mockResolvedValueOnce(Response.json({ timeline: created, readToken: "attached-receipt" }))
      .mockResolvedValueOnce(Response.json({ deleted: true, timelineId: timeline.id }));
    const doc = new LoroDoc();
    const { result } = renderHook(() => useHostTimelines({ projectId: "project", canvasId: "shots", doc, request }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await act(async () => { expect((await result.current.createTimelineOnCanvas({ id: timeline.id, name: timeline.name, state: timeline.state, actionNodeId: "editor" })).ok).toBe(true); });
    expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({ action: "create_timeline", placement: { canvasId: "shots", actionNodeId: "editor" } });
    expect(result.current.timelines).toEqual([created]);
    await act(async () => { expect((await result.current.detachTimeline(timeline.id)).ok).toBe(true); });
    expect(result.current.timelines).toEqual([timeline]);
    await act(async () => { expect((await result.current.attachTimeline({ timelineId: timeline.id, actionNodeId: "editor" })).ok).toBe(true); });
    await act(async () => { expect((await result.current.deleteTimeline(timeline.id)).ok).toBe(true); });
    expect(result.current.timelines).toEqual([]);
    expect(JSON.parse(request.mock.calls.at(-1)![1].body)).toMatchObject({ action: "delete_timeline", ifMatch: "attached-receipt" });
    expect(doc.getMap("timelines").size).toBe(0);
  });

  it("rejects an agent write without its observation and retains the acknowledged Timeline", async () => {
    const request = vi.fn(async () => Response.json({ timelines: [timeline], versions: { [timeline.id]: "receipt" } }));
    const onMutation = vi.fn();
    const { result } = renderHook(() => useHostTimelines({ projectId: "project", doc: null, request, onMutation }));
    await waitFor(() => expect(result.current.timelines).toEqual([timeline]));
    await act(async () => { expect(await result.current.applyTimelineState(timeline.id, {}, { actorClientType: "agent" })).toBe(false); });
    expect(request).toHaveBeenCalledOnce();
    expect(onMutation).toHaveBeenCalledWith(expect.objectContaining({ operation: "timeline_apply", accepted: false, beforeReadToken: projectTimelineReadToken(timeline) }));
    expect(result.current.timelines).toEqual([timeline]);
  });
  it("reads native projections and only accepts edits after a Host acknowledgement", async () => {
    const doc = new LoroDoc();
    let accept!: (response: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(Response.json({ timelines: [timeline], versions: { [timeline.id]: "receipt-before" } }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { accept = resolve; }));
    const { result } = renderHook(() => useHostTimelines({ projectId: "project", doc, request }));
    await waitFor(() => expect(result.current.timelines).toEqual([timeline]));
    const updated = { ...timeline, revisionId: "host-accepted", state: { tracks: [], durationInFrames: 72 } };
    let saving!: Promise<ProjectTimeline | false>;
    act(() => { saving = result.current.applyTimelineState(timeline.id, updated.state, { ifMatch: projectTimelineReadToken(timeline) }); });
    expect(result.current.timelines).toEqual([timeline]);
    await act(async () => { accept(Response.json({ timeline: updated, readToken: "receipt-after" })); expect(await saving).toEqual(updated); });
    expect(result.current.timelines).toEqual([updated]);
    expect(doc.getMap("timelines").size).toBe(0);
    expect(JSON.parse(request.mock.calls[1]![1].body)).toMatchObject({ action: "update_timeline_state", ifMatch: "receipt-before" });
    await act(async () => { expect(await result.current.applyTimelineState(timeline.id, {}, { ifMatch: projectTimelineReadToken(timeline) })).toBe(false); });
    expect(result.current.timelines).toEqual([updated]);
  });

  it("does not overwrite an accepted edit with an older list response", async () => {
    let finishRefresh!: (response: Response) => void;
    const updated = { ...timeline, revisionId: "accepted" };
    const request = vi.fn().mockResolvedValueOnce(Response.json({ timelines: [timeline], versions: { [timeline.id]: "before" } }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishRefresh = resolve; }))
      .mockResolvedValueOnce(Response.json({ timeline: updated, readToken: "after" }));
    const { result } = renderHook(() => useHostTimelines({ projectId: "project", doc: null, request }));
    await waitFor(() => expect(result.current.timelines).toEqual([timeline]));
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.refresh(); });
    await act(async () => { await result.current.applyTimelineState(timeline.id, updated.state); });
    await act(async () => { finishRefresh(Response.json({ timelines: [timeline], versions: { [timeline.id]: "before" } })); await refreshing; });
    expect(result.current.timelines).toEqual([updated]);
  });

  it("subscribes to native Generator changes and exposes read failures", async () => {
    const doc = new LoroDoc();
    const request = vi.fn().mockResolvedValueOnce(Response.json({ timelines: [], versions: {} }))
      .mockResolvedValueOnce(Response.json({ error: "Migration conflict" }, { status: 409 }));
    const { result } = renderHook(() => useHostTimelines({ projectId: "project", doc, request }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    act(() => { doc.getMap("projectGenerators").set("changed", {}); doc.commit(); });
    await waitFor(() => expect(result.current.timelineError).toContain("Migration conflict"));
  });
});
