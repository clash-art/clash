import { describe, expect, it } from "vitest";
import { ProjectHostCommandSchema } from "./project-host-command.js";

describe("ProjectHostCommandSchema", () => {
  it("accepts a scoped Canvas read", () => {
    expect(
      ProjectHostCommandSchema.parse({
        action: "get",
        canvasId: "shots",
        nodeId: "node-1",
      }),
    ).toEqual({ action: "get", canvasId: "shots", nodeId: "node-1" });
  });

  it("accepts Canvas move observations for host-side CAS", () => {
    expect(
      ProjectHostCommandSchema.parse({
        action: "move",
        canvasId: "shots",
        nodeId: "node-1",
        position: { x: 120, y: 80 },
        actorClientType: "agent",
        observedVersion: "node-v1:1234",
        ifMatch: "node-v1:1234:receipt:signed",
      }),
    ).toEqual({
      action: "move",
      canvasId: "shots",
      nodeId: "node-1",
      position: { x: 120, y: 80 },
      actorClientType: "agent",
      observedVersion: "node-v1:1234",
      ifMatch: "node-v1:1234:receipt:signed",
    });
  });

  it("recognizes MCP as a first-class peer client identity", () => {
    expect(
      ProjectHostCommandSchema.parse({
        action: "update",
        nodeId: "node-1",
        label: "Revised",
        actorClientType: "mcp",
        ifMatch: "node-v1:receipt:signed",
      }).actorClientType,
    ).toBe("mcp");
  });

  it("keeps Canvas add strict and host-owned", () => {
    expect(ProjectHostCommandSchema.parse({
      action: "add",
      type: "image_gen",
      label: "Hero",
      prompt: "Create a portrait",
      params: { seed: 42, guidance: 3.5, transparent: false },
      actorClientType: "mcp",
    })).toMatchObject({ action: "add", type: "image_gen", label: "Hero" });

    expect(ProjectHostCommandSchema.parse({
      action: "add",
      type: "model_gen",
      label: "Statue",
      prompt: "Create a 3D statue",
    })).toMatchObject({ action: "add", type: "model_gen", label: "Statue" });

    expect(ProjectHostCommandSchema.parse({
      action: "add",
      type: "image",
      label: "Deep-space otter",
      assetId: "asset-otter",
    })).toMatchObject({
      action: "add",
      type: "image",
      label: "Deep-space otter",
      assetId: "asset-otter",
    });

    expect(ProjectHostCommandSchema.parse({
      action: "add",
      type: "html_motion",
      label: "Lower Third",
      content: "<!doctype html><title>x</title>",
      actorClientType: "agent",
    })).toMatchObject({
      action: "add",
      type: "html_motion",
      label: "Lower Third",
    });

    expect(ProjectHostCommandSchema.parse({
      action: "add",
      type: "remotion",
      label: "Title Card",
      content: "export const Title = () => null;",
    })).toMatchObject({ action: "add", type: "remotion", label: "Title Card" });

    for (const command of [
      { action: "add", type: "unknown", label: "Bad" },
      { action: "add", type: "text", label: "Bad", data: { actorUserId: "spoofed" } },
      { action: "add", type: "text", label: "Bad", actor: { actorUserId: "spoofed" } },
      { action: "add", type: "image_gen", label: "Bad", params: { seed: Infinity } },
    ]) {
      expect(ProjectHostCommandSchema.safeParse(command).success).toBe(false);
    }
  });

  it("types MCP read proofs for Canvas execution and composition mutations", () => {
    for (const value of [
      {
        action: "execute",
        nodeId: "action-1",
        actorClientType: "mcp",
        ifMatch: "node-receipt",
      },
      {
        action: "update_timeline_state",
        timelineId: "cut-1",
        state: { tracks: [] },
        actorClientType: "mcp",
        ifMatch: "timeline-receipt",
      },
      {
        action: "capture_director_stage",
        stageId: "stage-1",
        frames: [{ label: "opening", timeSeconds: 0, aspectRatio: "16:9" }],
        longEdge: 1920,
        actorClientType: "mcp",
        ifMatch: "stage-receipt",
      },
    ]) expect(ProjectHostCommandSchema.safeParse(value).success).toBe(true);
  });

  it("lets the host allocate composition ownership identities and default Director state", () => {
    expect(ProjectHostCommandSchema.parse({
      action: "attach_timeline",
      timelineId: "cut-1",
      canvasId: "main",
      actorClientType: "mcp",
      ifMatch: "timeline-receipt",
    })).not.toHaveProperty("actionNodeId");
    expect(ProjectHostCommandSchema.parse({
      action: "create_director_stage",
      stageId: "stage-1",
      name: "Blocking",
    })).not.toHaveProperty("state");
  });

  it("rejects incomplete and unknown commands", () => {
    expect(ProjectHostCommandSchema.safeParse({ action: "get" }).success).toBe(
      false,
    );
    expect(
      ProjectHostCommandSchema.safeParse({ action: "direct_project_room" })
        .success,
    ).toBe(false);
  });
});
