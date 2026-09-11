import { describe, expect, it, vi } from "vitest";
import { ProjectHostHttpError, sendProjectHostCommand } from "./browser.js";

describe("browser Project Host transport", () => {
  it("uses a caller-owned runtime request and preserves the observed revision", async () => {
    const value = { timeline: { id: "cut", revisionId: "revision-next" } };
    const request = vi.fn(async () => Response.json(value));
    const command = {
      action: "update_timeline_state" as const,
      timelineId: "cut",
      state: { tracks: [] },
      actorClientType: "browser" as const,
      ifMatch: "observed-before-edit",
    };
    expect(await sendProjectHostCommand({
      projectId: "project/one", command, request,
    })).toEqual(value);
    expect(request).toHaveBeenCalledWith(
      "/api/v1/projects/project%2Fone/host-command",
      expect.objectContaining({ method: "POST", body: JSON.stringify(command) }),
    );
  });

  it("keeps a stale-write rejection intact without retrying a mutation", async () => {
    const body = { code: "STALE_READ", error: "Read the Timeline again" };
    const request = vi.fn(async () => Response.json(body, { status: 409 }));
    const pending = sendProjectHostCommand({
      projectId: "project", request,
      command: { action: "update_timeline_state", timelineId: "cut", state: {}, ifMatch: "old" },
    });
    await expect(pending).rejects.toMatchObject({
      name: "ProjectHostHttpError", status: 409, body,
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves non-JSON gateway errors for diagnosis", async () => {
    const request = async () => new Response("Host restarting", { status: 503 });
    await expect(sendProjectHostCommand({
      projectId: "project", request, command: { action: "list_timelines" },
    })).rejects.toMatchObject({ status: 503, body: "Host restarting" });
  });

  it("rejects a non-object success response instead of returning an unusable value", async () => {
    const request = async () => new Response("<html>login</html>");
    await expect(sendProjectHostCommand({
      projectId: "project", request, command: { action: "list_timelines" },
    })).rejects.toBeInstanceOf(ProjectHostHttpError);
  });
});
