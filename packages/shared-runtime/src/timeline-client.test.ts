import { describe, expect, it, vi } from "vitest";
import type { ProjectTimeline } from "@clash/shared-types";
import { createTimelineClient } from "./browser.js";

const timeline: ProjectTimeline = {
  id: "cut", name: "Cut", revisionId: "revision-before-edit",
  owner: { kind: "project" }, state: { tracks: [] },
};

describe("native Timeline client", () => {
  it("applies against the snapshot the editor read, even after another list completes", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ timelines: [timeline], versions: { cut: "receipt-before" } }))
      .mockResolvedValueOnce(Response.json({ timelines: [{ ...timeline, revisionId: "other-edit" }], versions: { cut: "receipt-other" } }))
      .mockResolvedValueOnce(Response.json({ code: "STALE_READ", error: "Read again" }, { status: 409 }));
    const client = createTimelineClient({ projectId: "project", request });
    const [observed] = await client.list();
    await client.list();
    await expect(client.apply(observed!, { tracks: [] })).rejects.toMatchObject({ status: 409 });
    const command = JSON.parse(request.mock.calls.at(-1)![1].body);
    expect(command.ifMatch).toBe(observed!.readToken);
    expect(command.actorClientType).toBe("browser");
  });

  it("rotates the returned observation only after the Host accepts an edit", async () => {
    const updated = { ...timeline, revisionId: "accepted-edit" };
    const request = vi.fn(async () => Response.json({ timeline: updated, readToken: "accepted-receipt" }));
    const client = createTimelineClient({ projectId: "project", request });
    const observed = { timeline, readToken: "before" };
    expect(await client.apply(observed, updated.state)).toEqual({ timeline: updated, readToken: "accepted-receipt" });
    expect(observed).toEqual({ timeline, readToken: "before" });
  });

  it("rejects reads lacking concurrency evidence", async () => {
    const client = createTimelineClient({
      projectId: "project", request: async () => Response.json({ timelines: [timeline], versions: {} }),
    });
    await expect(client.list()).rejects.toThrow(/observation/i);
  });

  it("does not turn a product error in an HTTP success into an empty list", async () => {
    const client = createTimelineClient({
      projectId: "project", request: async () => Response.json({ error: "Timeline plugin is not installed" }),
    });
    await expect(client.list()).rejects.toThrow("Timeline plugin is not installed");
  });
});
