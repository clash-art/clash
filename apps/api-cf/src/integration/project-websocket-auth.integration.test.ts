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

it.each(["deleted", "expired"])(
  "rechecks a %s D1 session despite cached Better Auth responses",
  async (state) => {
    const f = await fixture(),
      sessionId = crypto.randomUUID(),
      expiresAt = Date.now() + 60_000;
    await env.DB.prepare(
      "INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        sessionId,
        crypto.randomUUID(),
        f.userId,
        expiresAt,
        Date.now(),
        Date.now(),
      )
      .run();
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      if (!String(input).includes("/get-session"))
        throw new Error("Unexpected external request");
      return Response.json({
        session: {
          id: sessionId,
          expiresAt: new Date(expiresAt).toISOString(),
        },
        user: { id: f.userId },
      });
    });
    const connected = await connect(f, {
      cookie: "better-auth.session_token=session-fixture",
    });
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
    expect(
      (await f.request({ cookie: "better-auth.session_token=session-fixture" }))
        .status,
    ).toBe(401);
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
