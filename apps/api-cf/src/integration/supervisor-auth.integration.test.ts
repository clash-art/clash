import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { SignJWT } from "jose";
import { LoroDoc } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupervisorAgent } from "../agents/supervisor";

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).endsWith("/api/better-auth/get-session"))
      return Response.json(null);
    throw new Error("Unexpected outbound request in authorization test");
  });
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const project = crypto.randomUUID(),
    owner = crypto.randomUUID();
  const room = `${project}:conversation`;
  await env.DB.prepare(
    "INSERT INTO project(id, owner_id, name) VALUES (?, ?, ?)",
  )
    .bind(project, owner, "Authorization test")
    .run();
  const bearer = `clsh_${crypto.randomUUID()}`;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  await env.DB.prepare(
    "INSERT INTO api_token(id,user_id,name,token_hash,token_prefix) VALUES (?,?,?,?,?)",
  )
    .bind(project, owner, "test", hash, "clsh_test")
    .run();
  const jwt = await new SignJWT({ projectId: project })
    .setSubject(owner)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  const stub = env.SUPERVISOR.get(env.SUPERVISOR.idFromName(room));
  const request = (suffix = "", token?: string, upgrade = false) =>
    new Request(`https://clash.test/agents/supervisor/${room}${suffix}`, {
      headers: {
        "x-partykit-room": room,
        "x-partykit-namespace": "SUPERVISOR",
        "x-user-id": owner,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(upgrade ? { Upgrade: "websocket" } : {}),
      },
    });
  return {
    project,
    owner,
    stub,
    request,
    bearer,
    jwt,
    async cleanup() {
      await env.DB.prepare("DELETE FROM api_token WHERE id = ?")
        .bind(project)
        .run();
      await env.DB.prepare("DELETE FROM project WHERE id = ?")
        .bind(project)
        .run();
    },
  };
}

describe("Supervisor authorization before framework protocol effects", () => {
  it("imports the real ProjectRoom snapshot on its internal WebSocket", async () => {
    const f = await fixture();
    const source = new LoroDoc();
    source
      .getMap("nodes")
      .set("retained-node", {
        type: "text",
        data: { label: "Shared project content" },
      });
    try {
      const room = env.ROOM.get(env.ROOM.idFromName(f.project));
      const write = await room.fetch(
        new Request(`https://internal/loro/${f.project}/updates`, {
          method: "POST",
          headers: {
            "x-internal-loro": "true",
            "x-loro-project-id": f.project,
          },
          body: source.export({ mode: "snapshot" }),
        }),
      );
      expect(write.status).toBe(204);
      await f.stub.fetch(f.request("/get-messages", f.jwt));
      const node = await runInDurableObject(f.stub, async (instance) => {
        // Inspect the real internal transport without invoking a paid model or
        // adding a test-only hook to the production Durable Object.
        const supervisor = instance as unknown as {
          connectToRoom(projectId: string): Promise<void>;
          doc: LoroDoc;
          roomWs: WebSocket | null;
        };
        try {
          await supervisor.connectToRoom(f.project);
          return supervisor.doc.getMap("nodes").get("retained-node");
        } finally {
          supervisor.roomWs?.close();
        }
      });
      expect(node).toEqual({
        type: "text",
        data: { label: "Shared project content" },
      });
    } finally {
      source.free();
      await f.cleanup();
    }
  });
  it("rejects unauthenticated direct HTTP and WebSocket calls despite forged identity", async () => {
    const f = await fixture();
    try {
      expect((await f.stub.fetch(f.request("/get-messages"))).status).toBe(401);
      expect((await f.stub.fetch(f.request("", undefined, true))).status).toBe(
        401,
      );
      expect(
        (await f.stub.fetch(f.request("/get-messages", f.jwt))).status,
      ).toBe(200);
      const other = await fixture();
      try {
        expect(
          (await f.stub.fetch(other.request("/get-messages", other.jwt)))
            .status,
        ).toBe(401);
      } finally {
        await other.cleanup();
      }
    } finally {
      await f.cleanup();
    }
  });

  it("revoking a connected API token prevents the framework from clearing persisted chat", async () => {
    const f = await fixture();
    let socket: WebSocket | undefined;
    try {
      const response = await f.stub.fetch(f.request("", f.bearer, true));
      expect(response.status).toBe(101);
      socket = response.webSocket!;
      socket.accept();
      const messages = [
        {
          id: "retained",
          role: "user",
          parts: [{ type: "text", text: "Keep this history" }],
        },
      ];
      socket.send(JSON.stringify({ type: "cf_agent_chat_messages", messages }));
      await vi.waitFor(async () => {
        const read = await f.stub.fetch(f.request("/get-messages", f.jwt));
        expect(await read.json()).toEqual(messages);
      });
      await evictDurableObject(f.stub);
      const closed = new Promise<number>((resolve) =>
        socket!.addEventListener("close", (event) => resolve(event.code)),
      );
      await env.DB.prepare("DELETE FROM api_token WHERE id = ?")
        .bind(f.project)
        .run();
      socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
      expect(
        await Promise.race([
          closed,
          new Promise((resolve) =>
            setTimeout(() => resolve("not closed"), 1500),
          ),
        ]),
      ).toBe(1008);
      expect(
        await (await f.stub.fetch(f.request("/get-messages", f.jwt))).json(),
      ).toEqual(messages);
    } finally {
      socket?.close();
      await f.cleanup();
    }
  });

  it("does not broadcast new private data to a connection after its project is deleted", async () => {
    const f = await fixture();
    let socket: WebSocket | undefined;
    try {
      const response = await f.stub.fetch(f.request("", f.bearer, true));
      socket = response.webSocket!;
      socket.accept();
      const received: unknown[] = [];
      socket.addEventListener("message", (event) => {
        received.push(event.data);
      });
      const closed = new Promise<number>((resolve) =>
        socket!.addEventListener("close", (event) => resolve(event.code)),
      );
      await env.DB.prepare("UPDATE project SET deleted_at = 1 WHERE id = ?")
        .bind(f.project)
        .run();
      await runInDurableObject(
        f.stub as DurableObjectStub<SupervisorAgent>,
        async (instance) => {
          instance.broadcast("private-after-delete");
        },
      );
      expect(
        await Promise.race([
          closed,
          new Promise((resolve) =>
            setTimeout(() => resolve("not closed"), 1500),
          ),
        ]),
      ).toBe(1008);
      expect(received).not.toContain("private-after-delete");
    } finally {
      socket?.close();
      await f.cleanup();
    }
  });
});
