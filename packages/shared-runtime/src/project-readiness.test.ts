import { describe, expect, it } from "vitest";
import {
  buildProjectStatus,
  projectCollaborationStatus,
} from "./project-status.js";

const admission = {
  schemaVersion: 1,
  projectId: "selected",
  tenantId: "tenant",
  userId: "owner",
  localReplicaId: "this-host",
  syncBaseUrl: "https://cloud.example.com",
  status: "ready",
  capabilities: { canvas: true, projectMetadata: true, resources: true },
  admittedAt: "2026-09-04T00:00:00Z",
  updatedAt: "2026-09-04T00:00:00Z",
  lastError: null,
};
const capabilities = {
  canvas: true,
  asset_metadata: true,
  revision_content: true,
  project_metadata: true,
};
const status = (state: Record<string, unknown>) =>
  buildProjectStatus(
    { projectId: "selected", source: "explicit" },
    { clashRoot: "/tmp/clash", replicationState: state },
  ).collaboration;

describe("project readiness authority", () => {
  it.each(["cloud-sync", "shared"])(
    "does not grant Web or Share from global %s configuration",
    (mode) => {
      const result = projectCollaborationStatus(mode, { capabilities });
      expect(result.webOpenable).toBe(false);
      expect(result.actions.shareProject.allowed).toBe(false);
      expect(result.actions.runLocalAgent.allowed).toBe(true);
    },
  );

  it.each([undefined, "pending", "syncing", "failed", "local-only"])(
    "fails closed for %s admission",
    (state) => {
      const result = status({
        mode: "cloud-sync",
        localReplicaId: "this-host",
        capabilities,
        admission: state
          ? {
              ...admission,
              status: state,
              lastError: state === "failed" ? "offline" : null,
            }
          : null,
      });
      expect(result.webOpenable).toBe(false);
      expect(result.actions.shareProject.allowed).toBe(false);
      expect(result.actions.runLocalAgent.allowed).toBe(true);
      if (state === "failed" || state === "syncing")
        expect(result.syncReadiness.status).toBe(state);
    },
  );

  it.each([{ projectId: "other" }, { localReplicaId: "other-host" }])(
    "rejects another project's or replica's readiness: %j",
    (wrongIdentity) => {
      const result = status({
        mode: "cloud-sync",
        localReplicaId: "this-host",
        admission: { ...admission, ...wrongIdentity },
      });
      expect(result.webOpenable).toBe(false);
      expect(result.actions.shareProject.allowed).toBe(false);
    },
  );

  it("accepts this project's verified readiness independently of global switches", () => {
    const result = status({
      mode: "local-only",
      localReplicaId: "this-host",
      admission,
    });
    expect(result.webOpenable).toBe(true);
    expect(result.actions.shareProject.allowed).toBe(true);
  });
});
