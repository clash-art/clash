import { describe, expect, it } from "vitest";
import {
  revalidateProjectConnection,
  type AuthResult,
  type ProjectAuthorizationStore,
} from "./project-authorization";

const HOUR = 60 * 60 * 1000;

function store(
  overrides: Partial<ProjectAuthorizationStore> = {},
): ProjectAuthorizationStore {
  return {
    readProject: async () => ({ ownerId: "u", deletedAt: null }),
    readApiToken: async () => ({ userId: "u" }),
    touchApiToken: async () => {},
    readSession: async () => ({ userId: "u", expiresAt: Date.now() + HOUR }),
    ...overrides,
  };
}

const session = (): AuthResult => ({
  userId: "u",
  projectId: "p",
  authorization: {
    kind: "session",
    sessionId: "s",
    expiresAt: Date.now() + HOUR,
  },
});
const apiToken = (): AuthResult => ({
  userId: "u",
  projectId: "p",
  authorization: { kind: "api-token", tokenHash: "h" },
});
const unavailable = () => Promise.reject(new Error("D1_ERROR: network connection lost"));

describe("revalidateProjectConnection", () => {
  it("resolves true for a current owner and credential", async () => {
    await expect(revalidateProjectConnection({ store: store() }, session())).resolves.toBe(true);
    await expect(revalidateProjectConnection({ store: store() }, apiToken())).resolves.toBe(true);
  });

  it("rejects, rather than reporting revocation, when the store fails", async () => {
    await expect(
      revalidateProjectConnection({ store: store({ readProject: unavailable }) }, session()),
    ).rejects.toThrow("D1_ERROR");
    await expect(
      revalidateProjectConnection({ store: store({ readSession: unavailable }) }, session()),
    ).rejects.toThrow("D1_ERROR");
    await expect(
      revalidateProjectConnection({ store: store({ readApiToken: unavailable }) }, apiToken()),
    ).rejects.toThrow("D1_ERROR");
  });

  it("resolves false for real denials", async () => {
    const denied = [
      [store({ readProject: async () => null }), session()],
      [store({ readProject: async () => ({ ownerId: "other", deletedAt: null }) }), session()],
      [store({ readProject: async () => ({ ownerId: "u", deletedAt: Date.now() }) }), session()],
      [store({ readSession: async () => null }), session()],
      [store({ readSession: async () => ({ userId: "other", expiresAt: Date.now() + HOUR }) }), session()],
      [store({ readSession: async () => ({ userId: "u", expiresAt: Date.now() - 1 }) }), session()],
      [store(), { ...session(), authorization: { kind: "session", sessionId: "s", expiresAt: Date.now() - 1 } }],
      [store(), { ...session(), authorization: { kind: "jwt", expiresAt: Date.now() - 1 } }],
      [store({ readApiToken: async () => null }), apiToken()],
      [store({ readApiToken: async () => ({ userId: "other" }) }), apiToken()],
    ] as const;
    for (const [authority, identity] of denied)
      await expect(revalidateProjectConnection({ store: authority }, identity)).resolves.toBe(false);
  });

  it("admits a deleted Project only under the allowDeleted policy", async () => {
    const deleted = store({ readProject: async () => ({ ownerId: "u", deletedAt: Date.now() }) });
    await expect(
      revalidateProjectConnection({ store: deleted }, session(), { allowDeleted: true }),
    ).resolves.toBe(true);
  });
});
