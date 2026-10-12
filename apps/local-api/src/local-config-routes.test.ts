import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HostMutationRecord } from "@clash/shared-types";

import {
  LocalConfigError,
  mountLocalConfigRoutes,
  type LocalConfigAuthority,
  type LocalConfigGuard,
  type LocalConfigResource,
  type LocalConfigSnapshot,
} from "./local-config-routes.js";

function memoryResource() {
  let snapshot: LocalConfigSnapshot<{ value: string }> = {
    view: { value: "a" },
    updatedAt: "v1",
  };
  const hooks: string[] = [];
  const resource: LocalConfigResource<{ value: string }> = {
    id: "example",
    async read() {
      return snapshot;
    },
    async update(body) {
      if (typeof body.value !== "string")
        throw new LocalConfigError("value must be a string");
      snapshot = { view: { value: body.value }, updatedAt: "v2" };
    },
    async afterUpdate() {
      hooks.push(snapshot.view.value);
    },
  };
  return { resource, hooks };
}

function authority(guard: (envelope: { operation: string; entity: { kind: string; id: string } }) => LocalConfigGuard) {
  const audits: Array<{ mutation: HostMutationRecord; reason: string }> = [];
  const value: LocalConfigAuthority = {
    readToken: (id, snapshot) => `${id}@${snapshot.updatedAt}`,
    guardMutation: ({ id, operation }) =>
      guard({ operation, entity: { kind: "local-config", id } }),
    async audit(mutation, _actor, reason) {
      audits.push({ mutation, reason });
    },
  };
  return { value, audits };
}

const unguarded = (envelope: { operation: string; entity: { kind: string; id: string } }): LocalConfigGuard => ({
  kind: "unguarded",
  envelope,
});

function patch(app: Hono, body: unknown) {
  return app.request("/api/v1/local/example", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mountLocalConfigRoutes", () => {
  it("serves the view with a read token", async () => {
    const app = new Hono();
    mountLocalConfigRoutes(app, memoryResource().resource, authority(unguarded).value);
    const response = await app.request("/api/v1/local/example");
    expect(await response.json()).toEqual({ value: "a", readToken: "example@v1" });
  });

  it("updates, audits, then runs the post-update hook", async () => {
    const app = new Hono();
    const { resource, hooks } = memoryResource();
    const { value, audits } = authority(unguarded);
    mountLocalConfigRoutes(app, resource, value);

    const response = await patch(app, { value: "b" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: "b",
      readToken: "example@v2",
      mutation: {
        operation: "local_example_config_update",
        accepted: true,
        resultEntityId: "example",
      },
    });
    expect(audits.map((entry) => entry.reason)).toEqual([
      "local example config update",
    ]);
    expect(hooks).toEqual(["b"]);
  });

  it("returns a fresh receipt only for guarded writes", async () => {
    const app = new Hono();
    mountLocalConfigRoutes(
      app,
      memoryResource().resource,
      authority((envelope) => ({ kind: "guarded", envelope })).value,
    );
    const body = (await (await patch(app, { value: "b" })).json()) as {
      mutation: HostMutationRecord;
    };
    expect(body.mutation.afterReadToken).toBe("example@v2");
  });

  it("maps a LocalConfigError to its status without auditing", async () => {
    const app = new Hono();
    const { resource, hooks } = memoryResource();
    const { value, audits } = authority(unguarded);
    mountLocalConfigRoutes(app, resource, value);

    const response = await patch(app, { value: 1 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "value must be a string",
      mutation: { accepted: false },
    });
    expect(audits).toHaveLength(0);
    expect(hooks).toHaveLength(0);
  });

  it("rejects a stale read proof with 409 before updating", async () => {
    const app = new Hono();
    const { resource } = memoryResource();
    const rejected: LocalConfigGuard = {
      kind: "rejected",
      error: "stale",
      mutation: {
        operation: "local_example_config_update",
        entity: { kind: "local-config", id: "example" },
        accepted: false,
        error: "stale",
      },
    };
    mountLocalConfigRoutes(app, resource, authority(() => rejected).value);

    const response = await patch(app, { value: "b" });
    expect(response.status).toBe(409);
    expect((await resource.read()).view.value).toBe("a");
  });
});
