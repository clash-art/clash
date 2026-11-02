import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { resolveProjectStatus } from "./projects";

let clashRoot = "";

beforeEach(async () => {
  clashRoot = await mkdtemp(join(tmpdir(), "clash-cli-remote-state-"));
  await mkdir(join(clashRoot, "run"));
  await writeFile(
    join(clashRoot, "run", "host.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      dataSchemaVersion: 1,
      hostId: "host",
      endpoint: "http://127.0.0.1:49321",
      pid: process.pid,
      launchMode: "user-service",
      startedBy: "cli",
      profile: "prod",
      startedAt: "2026-09-04T00:00:00Z",
      updatedAt: "2026-09-04T00:00:00Z",
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(clashRoot, { recursive: true, force: true });
});

function hostAnswers(projectId: string, remoteState?: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            projectId,
            syncMode: "cloud-sync",
            collaboration: { mode: "synced", actions: {} },
            ...(remoteState ? { remoteState } : {}),
          }),
        ),
    ),
  );
}

const options = () => ({ project: "selected", clashRoot, env: {} });

it("shows the Host's coded cloud link error and next retry in project status", async () => {
  const remoteState = {
    type: "project.remote-state",
    projectId: "selected",
    state: "unavailable",
    code: "CLOUD_LINK_HANDSHAKE_TIMEOUT",
    retryAt: "2026-11-02T00:00:30.000Z",
  };
  hostAnswers("selected", remoteState);
  const status = await resolveProjectStatus(options());
  expect(status.remoteState).toEqual(remoteState);
});

it("reports no cloud problem when the Host reports none", async () => {
  hostAnswers("selected");
  const status = await resolveProjectStatus(options());
  expect(status.remoteState).toBeUndefined();
});

it("ignores a link state answered for a different Project", async () => {
  hostAnswers("different", { state: "unavailable" });
  const status = await resolveProjectStatus(options());
  expect(status.remoteState).toBeUndefined();
});
