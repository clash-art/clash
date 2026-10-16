import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { SignJWT } from "jose";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  UpdateStatusCode,
  encode,
  decode,
} from "loro-protocol";
import type {
  AwarenessBroadcastMessage,
  PresenceMessage,
} from "@clash/shared-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { contentHash } from "../services/project-content";
import { SNAPSHOT_KEY, NEXT_SEQ_KEY } from "../loro/storage";

const sockets: WebSocket[] = [];
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
    if (String(request).includes("/get-session")) return Response.json(null);
    throw new Error("Unexpected external request");
  });
});
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  vi.restoreAllMocks();
});

async function fixture() {
  const projectId = crypto.randomUUID(),
    userId = crypto.randomUUID(),
    token = `clsh_${crypto.randomUUID().replaceAll("-", "")}`;
  const tokenHash = await contentHash(token);
  await env.DB.prepare(
    "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      projectId,
      "WebSocket auth fixture",
      userId,
      userId,
      Date.now(),
      Date.now(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      userId,
      "integration",
      tokenHash,
      token.slice(0, 10),
      Date.now(),
    )
    .run();
  const app = createApp();
  const room = env.ROOM.get(env.ROOM.idFromName(projectId));
  const request = (
    headers: HeadersInit = {},
    path = projectId,
    protocol = "loro-v1",
  ) =>
    app.request(
      `https://clash.test/sync/${path}?protocol=${protocol}`,
      {
        headers: {
          Upgrade: "websocket",
          ...Object.fromEntries(new Headers(headers)),
        },
      },
      env,
    );
  return { projectId, userId, token, tokenHash, room, request };
}
function messages(socket: WebSocket) {
  const frames: ReturnType<typeof decode>[] = [];
  const waiters: Array<(value: ReturnType<typeof decode>) => void> = [];
  socket.addEventListener("message", (event) => {
    void (async () => {
      if (typeof event.data === "string") return;
      const bytes =
        event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : (event.data as ArrayBuffer);
      const decoded = decode(new Uint8Array(bytes));
      const waiter = waiters.shift();
      if (waiter) waiter(decoded);
      else frames.push(decoded);
    })();
  });
  return async () => {
    if (frames.length) return frames.shift()!;
    return new Promise<ReturnType<typeof decode>>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("No protocol response")),
        5000,
      );
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
}
async function connect(
  f: Awaited<ReturnType<typeof fixture>>,
  headers: HeadersInit = { Authorization: `Bearer ${f.token}` },
) {
  const response = await f.request(headers);
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  sockets.push(socket);
  const next = messages(socket);
  const doc = new LoroDoc(),
    version = doc.version();
  socket.send(
    encode({
      type: MessageType.JoinRequest,
      crdt: CrdtType.Loro,
      roomId: f.projectId,
      auth: new Uint8Array(),
      version: version.encode(),
    }),
  );
  version.free();
  doc.free();
  expect(await next()).toMatchObject({
    type: MessageType.JoinResponseOk,
    permission: "write",
  });
  return { socket, next };
}
async function persisted(room: DurableObjectStub, key: string) {
  return runInDurableObject(room, async (_instance, state) =>
    state.storage.get(key),
  );
}

it("denies public anonymous, forged internal and foreign-owner upgrades before ProjectRoom persistence", async () => {
  const owner = await fixture(),
    other = await fixture();
  const rejectedHeaders: HeadersInit[] = [
    {},
    { "x-internal-agent": "true", "x-user-id": owner.userId },
    { Authorization: "Bearer clsh_invalid" },
    { Authorization: `Bearer ${other.token}` },
  ];
  for (const headers of rejectedHeaders) {
    expect((await owner.request(headers)).status).toBe(401);
  }
  expect(await persisted(owner.room, "projectId")).toBeUndefined();
  expect(await persisted(owner.room, SNAPSHOT_KEY)).toBeUndefined();
});

it("allows owner protocol writes but rejects an established socket after its API credential is revoked", async () => {
  const f = await fixture();
  const connected = await connect(f);
  const source = new LoroDoc();
  source.getMap("auth-fixture").set("allowed", true);
  source.commit();
  connected.socket.send(
    encode({
      type: MessageType.DocUpdate,
      crdt: CrdtType.Loro,
      roomId: f.projectId,
      batchId: "0x0000000000000021",
      updates: [source.export({ mode: "snapshot" })],
    }),
  );
  let frame = await connected.next();
  while (frame.type !== MessageType.Ack) frame = await connected.next();
  expect(frame).toMatchObject({
    type: MessageType.Ack,
    status: UpdateStatusCode.Ok,
  });
  const before = await persisted(f.room, NEXT_SEQ_KEY);
  await env.DB.prepare("DELETE FROM api_token WHERE token_hash = ?")
    .bind(f.tokenHash)
    .run();
  await evictDurableObject(f.room);
  const closed = waitForClose(connected.socket);
  source.getMap("auth-fixture").set("forbidden", true);
  source.commit();
  connected.socket.send(
    encode({
      type: MessageType.DocUpdate,
      crdt: CrdtType.Loro,
      roomId: f.projectId,
      batchId: "0x0000000000000022",
      updates: [source.export({ mode: "snapshot" })],
    }),
  );
  expect((await closed).code).toBe(1008);
  expect(await persisted(f.room, NEXT_SEQ_KEY)).toBe(before);
  expect((await f.request({ Authorization: `Bearer ${f.token}` })).status).toBe(
    401,
  );
  source.free();
});

function waitForClose(socket: WebSocket) {
  return new Promise<CloseEvent>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Revoked socket remained open")),
      3000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timer);
        resolve(event);
      },
      { once: true },
    );
  });
}

/** A cookie as the browser holds it: Better Auth's own HMAC-signed session
 * token, issued for the secret this Worker is configured with. */
async function sessionCookie(userId: string, expiresAt: number) {
  const sessionId = crypto.randomUUID(),
    token = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      userId,
      "Session fixture",
      `${userId}@clash.test`,
      1,
      Date.now(),
      Date.now(),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(sessionId, token, userId, expiresAt, Date.now(), Date.now())
    .run();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(
      (env as unknown as { BETTER_AUTH_SECRET: string }).BETTER_AUTH_SECRET,
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
      ),
    ),
  );
  return {
    sessionId,
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`,
  };
}

// The Web gateway forwards the browser's /sync upgrade over a service binding,
// so the request URL is the public Web origin. The cookie must be validated
// without any outbound request: the beforeEach fetch spy throws on one.
it("admits a browser session cookie on /sync without an outbound session lookup", async () => {
  const f = await fixture();
  const { cookie } = await sessionCookie(f.userId, Date.now() + 60_000);
  // connect() asserts the 101 upgrade and a write-permission join.
  await connect(f, { cookie });
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect((await f.request({ cookie: `${cookie}tampered` })).status).toBe(401);
});

/** Sideband frames are JSON text; binary frames are CRDT protocol. */
function nextSideband<T extends { type: string }>(
  socket: WebSocket,
  type: T["type"],
  accept: (frame: T) => boolean = () => true,
) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`No ${type} frame`)),
      5000,
    );
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data);
      if (frame.type !== type || !accept(frame)) return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
}
const nextPresence = (socket: WebSocket, clientCount = 1) =>
  nextSideband<PresenceMessage>(
    socket,
    "presence",
    (frame) => frame.clients.length >= clientCount,
  );

// #102: an API token's label is not a person. The fixture token is named
// "integration"; presence must carry the owning user's display name instead.
it("labels token-authenticated presence with the user's name, not the token name", async () => {
  const f = await fixture();
  // Inserts the users row ("Session fixture") the token's user_id points at.
  await sessionCookie(f.userId, Date.now() + 60_000);
  const first = await connect(f);
  const presence = nextPresence(first.socket, 2);
  await connect(f, {
    Authorization: `Bearer ${f.token}`,
    "x-client-type": "cli",
  });
  const { clients } = await presence;
  expect(clients.map((client) => client.clientType).sort()).toEqual([
    "browser",
    "cli",
  ]);
  for (const client of clients) {
    expect(client.userId).toBe(f.userId);
    expect(client.name).toBe("Session fixture");
  }
});

// #102: a user's other windows and agents are peers. `kind` comes from the
// credential that admitted the socket, and each socket learns its own id so it
// hides only itself.
it("stamps presence and awareness per connection with a server-derived kind", async () => {
  const f = await fixture();
  const { cookie } = await sessionCookie(f.userId, Date.now() + 60_000);
  const browser = await connect(f, { cookie });
  const agent = await connect(f, {
    Authorization: `Bearer ${f.token}`,
    "x-client-type": "cli",
  });
  const frames = [
    nextPresence(browser.socket, 3),
    nextPresence(agent.socket, 3),
  ];
  // A token that declares no client type is still not a person.
  await connect(f);
  const [toBrowser, toAgent] = await Promise.all(frames);

  expect(toAgent.clients).toEqual(toBrowser.clients);
  expect(new Set(toBrowser.clients.map((client) => client.id)).size).toBe(3);
  expect(toBrowser.selfClientId).not.toBe(toAgent.selfClientId);
  const self = (frame: PresenceMessage) =>
    frame.clients.find((client) => client.id === frame.selfClientId);
  expect(self(toBrowser)).toMatchObject({ clientType: "browser", kind: "human" });
  expect(self(toAgent)).toMatchObject({ clientType: "cli", kind: "agent" });
  const undeclared = toBrowser.clients.find(
    (client) =>
      client.id !== toBrowser.selfClientId &&
      client.id !== toAgent.selfClientId,
  );
  expect(undeclared).toMatchObject({ clientType: "browser", kind: "agent" });
  for (const client of toBrowser.clients) {
    expect(client.userId).toBe(f.userId);
    expect(client.name).toBe("Session fixture");
  }

  const awareness = nextSideband<AwarenessBroadcastMessage>(
    browser.socket,
    "awareness.broadcast",
    (frame) => frame.users.length > 0,
  );
  const update = { cursor: { x: 120, y: 80 }, selectedNodeIds: ["node-1"] };
  agent.socket.send(JSON.stringify({ type: "awareness.update", ...update }));
  // The same user's agent is a peer of the browser; the browser is not its own.
  expect((await awareness).users).toEqual([
    {
      clientId: toAgent.selfClientId,
      userId: f.userId,
      userName: "Session fixture",
      kind: "agent",
      ...update,
    },
  ]);
});

it.each(["deleted", "expired"])(
  "rechecks a %s D1 session on an admitted socket",
  async (state) => {
    const f = await fixture();
    const { sessionId, cookie } = await sessionCookie(
      f.userId,
      Date.now() + 60_000,
    );
    const connected = await connect(f, { cookie });
    if (state === "deleted") {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(sessionId)
        .run();
    } else {
      await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
        .bind(Date.now() - 1, sessionId)
        .run();
    }
    const closed = waitForClose(connected.socket);
    connected.socket.send("ping");
    expect((await closed).code).toBe(1008);
    expect((await f.request({ cookie })).status).toBe(401);
  },
);

it("does not deliver legacy raw broadcasts to a revoked idle observer", async () => {
  const f = await fixture();
  const response = await f.request(
    { Authorization: `Bearer ${f.token}` },
    f.projectId,
    "legacy",
  );
  expect(response.status).toBe(101);
  const observer = response.webSocket!;
  observer.accept();
  sockets.push(observer);
  const initial = await new Promise<ArrayBuffer>((resolve) =>
    observer.addEventListener(
      "message",
      (event) => {
        if (typeof event.data !== "string")
          void (async () =>
            resolve(
              event.data instanceof Blob
                ? await event.data.arrayBuffer()
                : event.data,
            ))();
      },
      { once: true },
    ),
  );
  const replica = new LoroDoc();
  replica.import(new Uint8Array(initial));
  // A second credential belongs to the same owner and remains valid.
  const writerToken = `clsh_${crypto.randomUUID()}`;
  await env.DB.prepare(
    "INSERT INTO api_token (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      f.userId,
      "writer",
      await contentHash(writerToken),
      writerToken.slice(0, 10),
      Date.now(),
    )
    .run();
  const writerResponse = await f.request(
    { Authorization: `Bearer ${writerToken}` },
    f.projectId,
    "legacy",
  );
  expect(writerResponse.status).toBe(101);
  const writer = writerResponse.webSocket!;
  writer.accept();
  sockets.push(writer);
  // Flush prior presence delivery before observing post-revocation traffic.
  await runInDurableObject(f.room, async () => {});
  await env.DB.prepare("DELETE FROM api_token WHERE token_hash = ?")
    .bind(f.tokenHash)
    .run();
  const received: unknown[] = [];
  observer.addEventListener("message", (event) => received.push(event.data));
  const closed = waitForClose(observer);
  replica.getMap("auth-fixture").set("private-after-revocation", true);
  replica.commit();
  writer.send(replica.export({ mode: "snapshot" }));
  expect((await closed).code).toBe(1008);
  expect(received).toEqual([]);
  replica.free();
});

it("rejects wrong DO identity, expired or wrong-project JWT and deleted projects without initializing a room", async () => {
  const f = await fixture(),
    other = await fixture();
  const makeJWT = (projectId: string, exp: number) =>
    new SignJWT({ sub: f.userId, projectId })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(env.JWT_SECRET));
  for (const token of [
    await makeJWT(f.projectId, Math.floor(Date.now() / 1000) - 1),
    await makeJWT(other.projectId, Math.floor(Date.now() / 1000) + 60),
  ]) {
    expect((await f.request({ Authorization: `Bearer ${token}` })).status).toBe(
      401,
    );
  }
  expect(
    (
      await other.room.fetch(`https://internal/sync/${f.projectId}`, {
        headers: { Upgrade: "websocket", Authorization: `Bearer ${f.token}` },
      })
    ).status,
  ).toBe(401);
  expect(await persisted(other.room, "projectId")).toBeUndefined();
  await env.DB.prepare("UPDATE project SET deleted_at = ? WHERE id = ?")
    .bind(Date.now(), f.projectId)
    .run();
  expect((await f.request({ Authorization: `Bearer ${f.token}` })).status).toBe(
    401,
  );
  expect(await persisted(f.room, "projectId")).toBeUndefined();
});

it("expires an established JWT connection before its next protocol command", async () => {
  const f = await fixture(),
    expiresAt = Math.floor(Date.now() / 1000) + 2;
  const token = await new SignJWT({ sub: f.userId, projectId: f.projectId })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  const connected = await connect(f, { Authorization: `Bearer ${token}` });
  await new Promise((resolve) =>
    setTimeout(resolve, expiresAt * 1000 - Date.now() + 20),
  );
  const closed = waitForClose(connected.socket);
  connected.socket.send("ping");
  expect((await closed).code).toBe(1008);
});
