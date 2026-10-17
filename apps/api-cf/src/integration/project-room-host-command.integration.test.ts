/**
 * ProjectRoom `host-command` (issue #180) in workerd: commands run in the
 * room's serial write queue on a fork, persist before answering, fan out to
 * connected editors (#168), and re-check project ownership inside the queue.
 */
import { env, evictDurableObject } from "cloudflare:test";
import { LoroDoc } from "loro-crdt";
import {
  CrdtType,
  MessageType,
  decode,
  encode,
} from "loro-protocol";
import { describe, expect, it } from "vitest";

const stub = (projectId: string) => env.ROOM.get(env.ROOM.idFromName(projectId));

async function seedProject(projectId: string, ownerId: string) {
  await env.DB.prepare(
    "INSERT INTO project (id, name, owner_id, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(projectId, "Host command", ownerId, ownerId, Date.now(), Date.now())
    .run();
}

async function hostCommand(
  projectId: string,
  userId: string,
  command: Record<string, unknown>,
) {
  const response = await stub(projectId).fetch(
    new Request(`https://room/loro/${projectId}/host-command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-loro": "true",
        "x-loro-project-id": projectId,
      },
      body: JSON.stringify({ userId, command }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function snapshotVersion(projectId: string): Promise<string> {
  const response = await stub(projectId).fetch(
    new Request(`https://room/loro/${projectId}/snapshot`, {
      headers: { "x-internal-loro": "true", "x-loro-project-id": projectId },
    }),
  );
  const doc = new LoroDoc();
  doc.import(new Uint8Array(await response.arrayBuffer()));
  return JSON.stringify([...doc.oplogVersion().toJSON()].sort());
}

async function connect(projectId: string) {
  const response = await stub(projectId).fetch(
    new Request(`https://room/sync/${projectId}?protocol=loro-v1`, {
      headers: { Upgrade: "websocket", "x-internal-agent": "true" },
    }),
  );
  const socket = response.webSocket!;
  socket.accept();
  socket.binaryType = "arraybuffer";
  const frames: ReturnType<typeof decode>[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string")
      frames.push(decode(new Uint8Array(event.data as ArrayBuffer)));
  });
  const version = new LoroDoc().version();
  socket.send(
    encode({
      type: MessageType.JoinRequest,
      crdt: CrdtType.Loro,
      roomId: projectId,
      auth: new Uint8Array(),
      version: version.encode(),
    }),
  );
  const until = async (match: (frame: ReturnType<typeof decode>) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const found = frames.find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for a ProjectRoom frame");
  };
  await until((frame) => frame.type === MessageType.JoinResponseOk);
  return { socket, until };
}

describe("ProjectRoom host-command", () => {
  it("persists a created Timeline and broadcasts it to connected editors", async () => {
    const projectId = crypto.randomUUID(),
      owner = crypto.randomUUID();
    await seedProject(projectId, owner);
    const editor = await connect(projectId);
    const created = await hostCommand(projectId, owner, {
      action: "create_timeline",
      timelineId: "tl-fanout",
      name: "Fan-out",
      state: { tracks: [] },
    });
    expect(created.status).toBe(200);
    expect(created.body.timeline).toMatchObject({ id: "tl-fanout", name: "Fan-out" });
    expect(created.body.readToken).toEqual(expect.any(String));

    // The editor's replica converges on the Timeline from broadcast frames alone.
    const replica = new LoroDoc();
    await editor.until((frame) => {
      if (frame.type !== MessageType.DocUpdate) return false;
      replica.importBatch(frame.updates);
      return JSON.stringify(replica.toJSON()).includes("tl-fanout");
    });
    editor.socket.close();

    // A fresh room instance loads the Timeline from storage.
    await evictDurableObject(stub(projectId));
    const listed = await hostCommand(projectId, owner, { action: "list_timelines" });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain("tl-fanout");
  });

  it("rejects a stale readToken with 409 and leaves the document unchanged", async () => {
    const projectId = crypto.randomUUID(),
      owner = crypto.randomUUID();
    await seedProject(projectId, owner);
    const created = await hostCommand(projectId, owner, {
      action: "create_timeline",
      timelineId: "tl-stale",
      name: "Stale",
      state: { tracks: [] },
    });
    const applied = await hostCommand(projectId, owner, {
      action: "update_timeline_state",
      timelineId: "tl-stale",
      state: { tracks: [], fps: 30 },
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
    expect(applied.status).toBe(200);
    const before = await snapshotVersion(projectId);
    const stale = await hostCommand(projectId, owner, {
      action: "update_timeline_state",
      timelineId: "tl-stale",
      state: { tracks: [], fps: 25 },
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
    expect(stale.status).toBe(409);
    expect(await snapshotVersion(projectId)).toBe(before);
  });

  it("queues a render for the RENDER_CONTAINER pipeline and 404s for a project the caller does not own", async () => {
    const projectId = crypto.randomUUID(),
      owner = crypto.randomUUID();
    await seedProject(projectId, owner);
    const created = await hostCommand(projectId, owner, {
      action: "create_timeline",
      timelineId: "tl-owner",
      name: "Owner",
      state: {
        tracks: [
          {
            id: "track",
            items: [
              {
                id: "title",
                type: "text",
                text: "Render me",
                from: 0,
                durationInFrames: 30,
              },
            ],
          },
        ],
      },
    });
    const render = await hostCommand(projectId, owner, {
      action: "request_timeline_render",
      timelineId: "tl-owner",
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
    expect(render).toMatchObject({
      status: 200,
      body: { submitted: true },
    });
    expect(render.body.renderNodeId).toEqual(expect.any(String));
    expect(render.body.actionRunId).toEqual(
      `timeline-render:${render.body.renderNodeId}`,
    );

    const intruder = await hostCommand(projectId, crypto.randomUUID(), {
      action: "delete_timeline",
      timelineId: "tl-owner",
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
    expect(intruder).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });

    await env.DB.prepare("UPDATE project SET deleted_at = ? WHERE id = ?")
      .bind(Date.now(), projectId)
      .run();
    const afterDelete = await hostCommand(projectId, owner, {
      action: "delete_timeline",
      timelineId: "tl-owner",
      actorClientType: "browser",
      ifMatch: created.body.readToken,
    });
    expect(afterDelete).toMatchObject({ status: 404, body: { code: "PROJECT_NOT_FOUND" } });
  });
});
