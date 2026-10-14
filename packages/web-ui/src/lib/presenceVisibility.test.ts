import { describe, expect, it } from "vitest";
import type { PresenceClient } from "@clash/shared-types";
import { visiblePresenceClients } from "./presenceVisibility";

const clients: PresenceClient[] = [
  {
    id: "window-self",
    clientType: "browser",
    kind: "human",
    userId: "ann",
    name: "Ann",
  },
  {
    id: "window-other",
    clientType: "browser",
    kind: "human",
    userId: "ann",
    name: "Ann",
  },
  { id: "agent", clientType: "cli", kind: "agent", userId: "ann", name: "Ann" },
  {
    id: "remote",
    clientType: "browser",
    kind: "human",
    userId: "bob",
    name: "Bob",
  },
];

describe("visiblePresenceClients", () => {
  it("hides only this connection and keeps the same user's other sessions", () => {
    expect(
      visiblePresenceClients(clients, "window-self").map((client) => client.id),
    ).toEqual(["window-other", "agent", "remote"]);
  });

  it("hides nothing until the server has named this connection", () => {
    expect(visiblePresenceClients(clients, undefined)).toEqual(clients);
  });
});
