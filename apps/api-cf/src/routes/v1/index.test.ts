import { describe, expect, it } from "vitest";

import { v1Routes } from "./index";

describe("hosted v1 Asset boundary", () => {
  it.each([
    ["GET", "/assets"],
    ["POST", "/assets"],
    ["POST", "/assets/batch"],
    ["GET", "/assets/legacy-asset"],
    ["PATCH", "/assets/legacy-asset/cover"],
    ["DELETE", "/assets/legacy-asset/ref?projectId=legacy-project"],
  ])("does not expose legacy %s %s", async (method, path) => {
    const response = await v1Routes.request(path, { method });

    expect(response.status).toBe(404);
  });
});

describe("hosted v1 identity boundary", () => {
  it.each([
    ["GET", "/projects"],
    ["POST", "/projects"],
    ["GET", "/projects/project-1"],
    ["POST", "/projects/project-1/cloud-admission"],
    ["GET", "/projects/project-1/cloud-admission?localReplicaId=replica-1"],
    ["GET", "/sessions?projectId=project-1"],
  ])("answers 401 to unauthenticated %s %s", async (method, path) => {
    const response = await v1Routes.request(path, { method });

    expect(response.status).toBe(401);
  });
});
