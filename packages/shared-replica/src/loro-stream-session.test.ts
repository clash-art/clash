import { beforeEach, expect, it, vi } from "vitest";
import { LoroDoc } from "loro-crdt";
const transport = vi.hoisted(() => ({
  append: vi.fn(),
  close: vi.fn(),
  start: vi.fn(),
  options: undefined as any,
}));
vi.mock("./replica-stream-client.ts", () => ({
  createReplicaStreamClient: (options: unknown) => {
    transport.options = options;
    return transport;
  },
}));
import { createLoroStreamSession } from "./loro-stream-session.ts";
beforeEach(() => {
  vi.clearAllMocks();
  transport.start.mockResolvedValue(undefined);
  transport.append.mockResolvedValue("offset");
  transport.close.mockResolvedValue(undefined);
});
it("uploads existing offline work, streams new edits, imports remote updates and unsubscribes on close", async () => {
  const doc = new LoroDoc(),
    remote = new LoroDoc();
  doc.getMap("notes").set("draft", "offline");
  doc.commit();
  const session = createLoroStreamSession({
    doc,
    url: "http://localhost/replica",
  });
  await session.start();
  remote.import(transport.append.mock.calls[0][1]);
  expect(remote.getMap("notes").get("draft")).toBe("offline");
  doc.getMap("notes").set("draft", "online");
  doc.commit();
  await vi.waitFor(() => {
    for (const [, bytes] of transport.append.mock.calls) remote.import(bytes);
    expect(remote.getMap("notes").get("draft")).toBe("online");
  });
  remote.getMap("notes").set("reply", "from another browser");
  remote.commit();
  await transport.options.apply({
    kind: "update",
    cursor: "offset",
    data: [remote.export({ mode: "snapshot" })],
  });
  expect(doc.getMap("notes").get("reply")).toBe("from another browser");
  await session.close();
  transport.append.mockClear();
  doc.getMap("notes").set("draft", "closed");
  doc.commit();
  await Promise.resolve();
  expect(transport.append).not.toHaveBeenCalled();
});
it("reports rejected append without declaring the session ready or dropping local edits", async () => {
  const doc = new LoroDoc();
  const error = vi.fn(),
    ready = vi.fn();
  doc.getMap("notes").set("draft", "keep me");
  doc.commit();
  transport.append.mockRejectedValue(Error("offline"));
  const session = createLoroStreamSession({
    doc,
    url: "http://localhost/replica",
    onError: error,
    onReady: ready,
  });
  await session.start();
  expect(error).toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  expect(doc.getMap("notes").get("draft")).toBe("keep me");
  await session.close();
});
