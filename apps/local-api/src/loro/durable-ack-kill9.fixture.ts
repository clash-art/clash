/**
 * Child process for the kill -9 durability test.
 *
 * Opens a real file-backed Project room, applies one peer edit, prints `acked`
 * only after `receive()` has persisted it, then waits to be SIGKILLed. The
 * parent reopens the same data directory and proves the acknowledged edit is
 * still there.
 */
import { LoroDoc } from "loro-crdt";

import { LocalLoroRoom } from "../sync.js";

const [dataDir, projectId] = process.argv.slice(2);
if (!dataDir || !projectId) {
  throw new Error("usage: durable-ack-kill9.fixture.ts <dataDir> <projectId>");
}

const room = await LocalLoroRoom.open({
  dataDir,
  projectId,
  workflowProcessor: null,
});
const peer = room.addPeer(() => {});
const client = new LoroDoc();
client.getMap("nodes").set("kill9-node", {
  id: "kill9-node",
  type: "text",
  canvasId: "main",
  data: { status: "completed", label: "acknowledged across SIGKILL" },
});
client.commit();
await room.receive(peer, client.export({ mode: "snapshot" }));
process.stdout.write("acked\n");
setInterval(() => {}, 1_000);
