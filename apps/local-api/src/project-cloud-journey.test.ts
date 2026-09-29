import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCloudAccounts } from "./cloud-accounts.js";
import { projectCloudJourney } from "./project-cloud-journey.js";
import type { ProjectCloudAdmission } from "@clash/shared-types";
it("keeps the project bound to its service and opens Web only after all planes are ready for its account", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "clash-cloud-journey-"));
  try {
    const accounts = createCloudAccounts(dataDir);
    await accounts.save("https://bound.example", {
      token: "secret",
      user: { id: "u", name: "User", email: "u@example.test" },
    });
    await accounts.select("https://other.example");
    const admission: ProjectCloudAdmission = {
      schemaVersion: 1,
      projectId: "p",
      localReplicaId: "r",
      tenantId: "t",
      userId: "u",
      syncBaseUrl: "https://bound.example",
      status: "pending",
      capabilities: { canvas: true, projectMetadata: true, resources: true },
      admittedAt: null,
      updatedAt: new Date().toISOString(),
      lastError: null,
    };
    expect(await projectCloudJourney(dataDir, admission)).toMatchObject({
      serviceUrl: "https://bound.example",
      authenticated: true,
      webUrl: null,
    });
    const ready = await projectCloudJourney(dataDir, {
      ...admission,
      status: "ready",
    });
    expect(new URL(ready.webUrl!).origin).toBe("https://bound.example");
    expect(
      (
        await projectCloudJourney(dataDir, {
          ...admission,
          status: "ready",
          capabilities: { ...admission.capabilities, resources: false },
        })
      ).webUrl,
    ).toBeNull();
    await accounts.save("https://bound.example", {
      token: "other-secret",
      user: { id: "other", name: "Other", email: "other@example.test" },
    });
    expect(
      await projectCloudJourney(dataDir, { ...admission, status: "ready" }),
    ).toMatchObject({ authenticated: false, webUrl: null });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
