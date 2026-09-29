import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { initializeClashWorkspace } from "./workspace-init";

describe("initializeClashWorkspace", () => {
  it("retries Host registration with the preserved marker identity after a failed request", async () => {
    const workspace = join(tmpdir(), `clash-init-registration-${process.pid}-${Date.now()}`);
    await mkdir(workspace);
    const requests: string[] = [];
    let unavailable = true;
    const request = async (path: string, init?: RequestInit) => {
      requests.push(path);
      expect(init?.method).toBe("POST");
      return unavailable ? Response.json({ error: "Host unavailable" }, { status: 503 }) : Response.json({});
    };
    await expect(initializeClashWorkspace({ cwd: workspace, request })).rejects.toThrow(/Host unavailable/);
    const marker = await readFile(join(workspace, ".clash/project.toml"), "utf8");
    unavailable = false;
    const result = await initializeClashWorkspace({ cwd: workspace, request });
    expect(result.reused).toBe(true);
    expect(requests).toEqual([
      `/api/v1/projects/${result.projectId}/initialize`,
      `/api/v1/projects/${result.projectId}/initialize`,
    ]);
    expect(await readFile(result.markerPath, "utf8")).toBe(marker);
    await expect(initializeClashWorkspace({ cwd: workspace, projectId: "conflicting-project", request }))
      .rejects.toThrow(/already bound/);
    expect(requests).toHaveLength(2);
  });
  it("creates the canonical managed project marker used by CLI and MCP", async () => {
    const workspace = join(
      tmpdir(),
      `clash-shared-workspace-init-${process.pid}-${Date.now()}`,
    );
    await mkdir(workspace);

    const result = await initializeClashWorkspace({
      cwd: workspace,
      projectId: "native-stdio-project",
    });

    expect(result).toMatchObject({
      projectId: "native-stdio-project",
      markerPath: join(workspace, ".clash", "project.toml"),
      reused: false,
    });
    expect(result.workspaceId).toMatch(/^managed:[a-f0-9]{16}$/);
    expect(await readFile(result.markerPath, "utf8")).toBe([
      "schema_version = 1",
      'project_id = "native-stdio-project"',
      `workspace_id = ${JSON.stringify(result.workspaceId)}`,
      'store = "managed"',
      "",
    ].join("\n"));
  });

  it("reuses an existing compatible marker instead of rebinding the workspace", async () => {
    const workspace = join(
      tmpdir(),
      `clash-shared-workspace-reuse-${process.pid}-${Date.now()}`,
    );
    await mkdir(workspace);
    const created = await initializeClashWorkspace({ cwd: workspace, projectId: "stable-project" });
    const before = await readFile(created.markerPath, "utf8");

    const reused = await initializeClashWorkspace({ cwd: workspace, projectId: "stable-project" });

    expect(reused).toEqual({ ...created, reused: true });
    expect(await readFile(created.markerPath, "utf8")).toBe(before);
  });

  it("fails closed when initialization would rebind an existing workspace", async () => {
    const workspace = join(
      tmpdir(),
      `clash-shared-workspace-conflict-${process.pid}-${Date.now()}`,
    );
    await mkdir(workspace);
    const created = await initializeClashWorkspace({ cwd: workspace, projectId: "project-a" });
    const before = await readFile(created.markerPath, "utf8");

    await expect(initializeClashWorkspace({ cwd: workspace, projectId: "project-b" }))
      .rejects.toThrow(/already bound.*project-a.*project-b/i);
    expect(await readFile(created.markerPath, "utf8")).toBe(before);
  });
});
